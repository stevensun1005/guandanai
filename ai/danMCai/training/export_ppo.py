"""Export a frozen proposal and learned actor, leaving global top-K to the caller."""

import argparse
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

from ppo_learning import ROOT, file_sha, load_actor


def export_ppo(checkpoint, destination):
    checkpoint, destination = Path(checkpoint).resolve(), Path(destination).resolve()
    weights, config, actor = load_actor(checkpoint)
    if config.get("features") != 565:
        raise ValueError(
            "Full-match checkpoints require the match-aware export path; legacy export is not compatible"
        )
    proposal = Path(config["proposalPath"]).resolve()
    for path, expected in (
        (proposal, config["proposalSHA256"]),
        (ROOT / "ai/danMCai/training/policy_features.py", config["featuresSHA256"]),
        (ROOT / "ai/danMCai/reference/numpy_engine.py", config["referenceEncoderSHA256"]),
    ):
        if file_sha(path) != expected:
            raise ValueError(f"PPO source changed: {path.name}")
    model = onnx.load(proposal)
    existing_outputs = {item.name for item in model.graph.output}
    if "values" not in existing_outputs or "policy_logits" in existing_outputs:
        raise ValueError("Expected one unexported proposal policy")
    if "hidden4" not in {output for node in model.graph.node for output in node.output}:
        raise ValueError("Proposal has no frozen hidden4 representation")
    if "extras" not in {item.name for item in model.graph.input}:
        model.graph.input.append(
            helper.make_tensor_value_info("extras", TensorProto.FLOAT, ["batch", 53])
        )
    initializers = {
        "ppo_w0": weights["actor_w0"],
        "ppo_b0": weights["actor_b0"],
        "ppo_w1": weights["actor_w1"],
        "ppo_b1": weights["actor_b1"],
        "ppo_temperature": np.array([config["temperature"]], dtype=np.float32),
    }
    model.graph.initializer.extend(
        numpy_helper.from_array(value, name) for name, value in initializers.items()
    )
    model.graph.node.extend(
        [
            helper.make_node("Concat", ["hidden4", "extras"], ["ppo_features"], axis=1),
            helper.make_node("Gemm", ["ppo_features", "ppo_w0", "ppo_b0"], ["ppo_linear0"]),
            helper.make_node("Tanh", ["ppo_linear0"], ["ppo_hidden"]),
            helper.make_node("Gemm", ["ppo_hidden", "ppo_w1", "ppo_b1"], ["ppo_actor"]),
            helper.make_node("Div", ["values", "ppo_temperature"], ["ppo_reference"]),
            helper.make_node("Add", ["ppo_reference", "ppo_actor"], ["policy_logits"]),
        ]
    )
    model.graph.output.append(
        helper.make_tensor_value_info("policy_logits", TensorProto.FLOAT, ["batch", 1])
    )
    contract = {
        "schema": 1,
        "policyKind": "frozen-proposal-ppo",
        "k": config["k"],
        "temperature": config["temperature"],
        "policySHA256": actor["policySHA256"],
        "actorSHA256": file_sha(checkpoint),
        "proposalSHA256": config["proposalSHA256"],
        "featuresSHA256": config["featuresSHA256"],
        "referenceEncoderSHA256": config["referenceEncoderSHA256"],
        "outputs": {
            "values": "unchanged frozen proposal scores",
            "policy_logits": "values / temperature + actor(hidden4, extras)",
        },
        "selection": "Accumulate every batch. Stable global descending values, first min(k, actions), then log-softmax selected policy_logits; other actions -1e9.",
        "afterFirstFinish": "Return unchanged values when any public remaining count is zero.",
    }
    helper.set_model_props(model, {"guandan.policy": json.dumps(contract, sort_keys=True)})
    model.graph.name = "GuanDanProposalAndActor"
    onnx.checker.check_model(model)
    destination.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, destination)
    report = {
        **contract,
        "checkpoint": str(checkpoint),
        "proposal": str(proposal),
        "file": str(destination),
        "sha256": file_sha(destination),
        "bytes": destination.stat().st_size,
    }
    destination.with_suffix(".meta.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkpoint")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(export_ppo(args.checkpoint, args.output)))


if __name__ == "__main__":
    main()
