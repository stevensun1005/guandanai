"""Reject incomplete or incompatible frozen-representation training data."""

import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import onnx
from onnx import numpy_helper

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT))
from ai.local.reference.numpy_engine import PolicyNetwork  # noqa: E402
from policy_features import POLICY_EXTRA_FEATURES  # noqa: E402


def _sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _backbone(graph):
    producers = {name: node for node in graph.node for name in node.output}
    initializers = {tensor.name: tensor for tensor in graph.initializer}
    nodes, tensors, inputs = {}, {}, set()

    def visit(name):
        if name in initializers:
            tensors[name] = initializers[name].SerializeToString()
        elif name in producers:
            node = producers[name]
            key = tuple(node.output)
            if key in nodes:
                return
            nodes[key] = node.SerializeToString()
            for dependency in node.input:
                visit(dependency)
        else:
            inputs.add(name)

    if "hidden4" not in producers:
        raise ValueError("Teacher has no frozen hidden4 representation")
    visit("hidden4")
    return nodes, tensors, inputs


def _verify_checkpoint(base):
    arrays = {tensor.name: numpy_helper.to_array(tensor) for tensor in base.graph.initializer}
    checkpoint = PolicyNetwork(ROOT / "ai/local/models/baseline/policy.ckpt")
    expected = {
        "state_weight": checkpoint.layers[0][0][:513],
        "action_weight": checkpoint.layers[0][0][513:],
        "first_bias": checkpoint.layers[0][1],
    }
    for index, (weight, bias) in enumerate(checkpoint.layers[1:], start=1):
        expected[f"w{index}"] = weight
        expected[f"b{index}"] = bias
    for name, value in expected.items():
        if name not in arrays or not np.array_equal(arrays[name], value):
            raise ValueError(f"Base ONNX/checkpoint mismatch: {name}")


def validate_seed_ranges(metadata_list):
    """Each dataset must contain independent deals, including across iterations."""
    ranges = []
    for metadata in metadata_list:
        seed = metadata["config"]["seed"]
        end = seed + metadata["games"]
        if any(
            seed < previous_end and previous_seed < end for previous_seed, previous_end in ranges
        ):
            raise ValueError("Dataset deal-seed ranges overlap")
        ranges.append((seed, end))


def validate_dataset(directory):
    """Return (read-only rows, metadata) after checking provenance and completion."""
    path = Path(directory)
    metadata = json.loads((path / "metadata.json").read_text(encoding="utf-8"))
    rollout = json.loads((path / "rollout.json").read_text(encoding="utf-8"))
    width = 512 + POLICY_EXTRA_FEATURES
    rows_count, games = metadata.get("rows"), metadata.get("games")
    if (
        metadata.get("version") != 1
        or metadata.get("features") != width
        or metadata.get("rowFloats") != width + 3
        or type(rows_count) is not int
        or rows_count < 1
        or type(games) is not int
        or games < 1
    ):
        raise ValueError("Invalid dataset dimensions or counts")
    config = metadata.get("config", {})
    seed = config.get("seed")
    if (
        rollout.get("status") != "complete"
        or rollout.get("games") != games
        or rollout.get("completedGames") != games
        or rollout.get("decisions") != rows_count
        or type(seed) is not int
        or seed < 0
        or rollout.get("seed") != seed
        or rollout.get("seedRange") != [seed, seed + games - 1]
        or config.get("options", {}).get("games") != games
    ):
        raise ValueError("Incomplete or inconsistent rollout manifest")
    base_path = ROOT / "ai/local/models/baseline/policy.onnx"
    base_sha = _sha(base_path)
    if metadata.get("basePolicySHA256") != base_sha:
        raise ValueError("Dataset base-policy hash differs from installed base")
    if metadata.get("extraFeaturesSHA256") != _sha(ROOT / "ai/local/training/policy_features.py"):
        raise ValueError("Dataset extra-feature encoding hash differs")
    teacher_path = Path(metadata["model"])
    if not teacher_path.is_absolute():
        teacher_path = ROOT / teacher_path
    teacher_sha = _sha(teacher_path)
    if metadata.get("modelSHA256") != teacher_sha or rollout.get("modelSHA256") != teacher_sha:
        raise ValueError("Dataset teacher-model hash differs")
    base = onnx.load(base_path)
    _verify_checkpoint(base)
    if _backbone(onnx.load(teacher_path).graph) != _backbone(base.graph):
        raise ValueError("Teacher frozen backbone differs from installed base")
    data_path = path / "transitions.f32"
    if data_path.stat().st_size != rows_count * (width + 3) * 4:
        raise ValueError("Dataset byte count does not match metadata")
    rows = np.memmap(data_path, dtype="<f4", mode="r", shape=(rows_count, width + 3))
    for first in range(0, rows_count, 8192):
        chunk = rows[first : first + 8192]
        if not np.isfinite(chunk).all():
            raise ValueError("Dataset contains nonfinite values")
        if np.any(np.abs(chunk[:, :512]) > 1.000001):
            raise ValueError("Frozen tanh features are outside their range")
        labels = np.abs(chunk[:, width])
        if not np.any(
            np.isclose(labels[:, None], [1.1, 1.2, 1.3], atol=1e-6, rtol=0), axis=1
        ).all():
            raise ValueError("Invalid terminal team returns")
        episodes, seats = chunk[:, width + 1], chunk[:, width + 2]
        if (
            np.any(episodes != np.floor(episodes))
            or np.any(episodes < 0)
            or np.any(episodes >= games)
            or np.any(seats != np.floor(seats))
            or np.any(seats < 0)
            or np.any(seats > 3)
        ):
            raise ValueError("Invalid episode or seat identifiers")
    return rows, metadata
