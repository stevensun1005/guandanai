"""Two-head tribute specialist. Targets are centered full-round counterfactual level points."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto
import torch

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
sys.path.insert(0, str(ROOT / "ai/danMCai/training/continuous"))
from learner import learner_device, write_json  # noqa: E402

FEATURES = 389


class TributeNet(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.layers = torch.nn.ModuleList(
            [torch.nn.Linear(389, 256), torch.nn.Linear(256, 128), torch.nn.Linear(128, 2)]
        )

    def forward(self, x):
        for layer in self.layers[:-1]:
            x = torch.tanh(layer(x))
        return self.layers[-1](x)


def export(net, path):
    nodes = []
    initializers = []
    previous = "features"
    for i, layer in enumerate(net.layers):
        initializers += [
            numpy_helper.from_array(layer.weight.detach().cpu().numpy().T.copy(), f"w{i}"),
            numpy_helper.from_array(layer.bias.detach().cpu().numpy().copy(), f"b{i}"),
        ]
        last = i == len(net.layers) - 1
        linear = "values" if last else f"linear{i}"
        nodes.append(helper.make_node("Gemm", [previous, f"w{i}", f"b{i}"], [linear]))
        if not last:
            previous = f"h{i}"
            nodes.append(helper.make_node("Tanh", [linear], [previous]))
    graph = helper.make_graph(
        nodes,
        "GuandanTributeSpecialist",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["batch", FEATURES])],
        [helper.make_tensor_value_info("values", TensorProto.FLOAT, ["batch", 2])],
        initializers,
    )
    model = helper.make_model(
        graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI"
    )
    model.ir_version = 8
    onnx.checker.check_model(model)
    temporary = str(path) + ".tmp"
    onnx.save(model, temporary)
    os.replace(temporary, path)
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_groups(run, split, max_rows=200000):
    expected_protocol = hashlib.sha256((run / "protocol.json").read_bytes()).hexdigest()
    groups = []
    total = 0
    for meta_file in sorted((run / "data" / split).glob("*.json"), reverse=True):
        meta = json.loads(meta_file.read_text())
        if meta.get("protocolSHA") != expected_protocol:
            raise ValueError("Dataset protocol mismatch")
        n = int(meta["rows"])
        stem = meta_file.with_suffix("")
        xb = Path(str(stem) + ".x.i8").read_bytes()
        yb = Path(str(stem) + ".y.f32").read_bytes()
        if (
            hashlib.sha256(xb).hexdigest() != meta["xSHA256"]
            or hashlib.sha256(yb).hexdigest() != meta["ySHA256"]
        ):
            raise ValueError("Dataset checksum mismatch")
        x = np.frombuffer(xb, np.int8).reshape(n, FEATURES)
        raw = np.frombuffer(yb, "<f4").copy()
        if raw.size != n or not np.isfinite(raw).all() or meta["head"] not in (0, 1):
            raise ValueError("Invalid dataset")
        groups.append({"x": x, "raw": raw, "y": raw - raw.mean(), "meta": meta})
        total += n
        if total >= max_rows:
            break
    return groups


def development(net, groups, device):
    sums = [0.0, 0.0]
    counts = [0, 0]
    mse = 0.0
    with torch.no_grad():
        for g in groups:
            head = g["meta"]["head"]
            v = net(torch.from_numpy(g["x"].astype(np.float32)).to(device))[:, head].cpu().numpy()
            chosen = int(np.argmax(v))
            baseline = g["meta"]["baseline"]
            if float(np.max(v) - np.min(v)) < 1e-6:
                chosen = baseline
            sums[head] += float(g["raw"][chosen] - g["raw"][baseline])
            counts[head] += 1
            mse += float(np.mean((v - g["y"]) ** 2))
    gains = [sums[i] / counts[i] if counts[i] else None for i in (0, 1)]
    return {"groups": counts, "meanCounterfactualGain": gains, "mse": mse / max(1, len(groups))}


def fit(run, device_name="cuda:0", epochs=20):
    run = Path(run)
    protocol = json.loads((run / "protocol.json").read_text())
    protocol_sha = hashlib.sha256((run / "protocol.json").read_bytes()).hexdigest()
    deadline = float(protocol["deadlineEpochSeconds"])
    device = learner_device(device_name)
    torch.set_num_threads(1)
    torch.manual_seed(20261106)
    train = load_groups(run, "train")
    dev = load_groups(run, "development", 50000)
    if len(train) < 8 or len(dev) < 4:
        return {
            "stage": "waiting-for-data",
            "trainingGroups": len(train),
            "developmentGroups": len(dev),
        }
    x = np.concatenate([g["x"] for g in train])
    y = np.concatenate([g["y"] for g in train])
    heads = np.concatenate([np.full(len(g["x"]), g["meta"]["head"], np.int64) for g in train])
    weights = np.concatenate([np.full(len(g["x"]), 1 / len(g["x"]), np.float32) for g in train])
    folder = run / "learner"
    folder.mkdir(exist_ok=True)
    checkpoint = folder / "latest.pt"
    net = TributeNet().to(device)
    optimizer = torch.optim.Adam(net.parameters(), lr=3e-4)
    step = 0
    if checkpoint.exists():
        saved = torch.load(checkpoint, map_location="cpu", weights_only=True)
        if saved.get("protocolSHA256") != protocol_sha:
            raise ValueError("Checkpoint protocol mismatch")
        net.load_state_dict(saved["model"])
        optimizer.load_state_dict(saved["optimizer"])
        step = saved["step"]
    first_step = step
    started = time.monotonic()
    loss_value = None
    for _ in range(epochs):
        for _batch in range(max(1, (len(x) + 1023) // 1024)):
            # Each random minibatch is independent; sample all groups without exploding float32 RAM.
            if time.time() >= deadline:
                break
            while (run / "PAUSE_TRAINER").exists() and time.time() < deadline:
                time.sleep(1)
            if time.time() >= deadline:
                break
            ix = np.random.default_rng(20261106 + step).integers(0, len(x), size=min(1024, len(x)))
            features = torch.from_numpy(x[ix].astype(np.float32)).to(device)
            goal = torch.from_numpy(y[ix]).to(device)
            h = torch.from_numpy(heads[ix]).to(device)
            w = torch.from_numpy(weights[ix]).to(device)
            prediction = net(features).gather(1, h[:, None]).squeeze(1)
            loss = ((prediction - goal) ** 2 * w).sum() / w.sum()
            if not torch.isfinite(loss):
                raise ValueError("Non-finite specialist loss")
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            optimizer.step()
            step += 1
            loss_value = float(loss.detach().cpu())
        if time.time() >= deadline:
            break
    measured = development(net, dev, device)
    old_score = None
    best = folder / "best.pt"
    if best.exists():
        previous = TributeNet().to(device)
        previous.load_state_dict(torch.load(best, map_location="cpu", weights_only=True)["model"])
        old_score = development(previous, dev, device)
        del previous

    def score(m):
        values = m["meanCounterfactualGain"]
        return (
            (min(values), sum(values), -m["mse"])
            if all(v is not None for v in values)
            else (-1e9, -1e9, -1e9)
        )

    accepted = old_score is None or score(measured) > score(old_score)
    saved = {
        "model": net.state_dict(),
        "optimizer": optimizer.state_dict(),
        "step": step,
        "protocolSHA256": protocol_sha,
    }
    torch.save(saved, str(checkpoint) + ".tmp")
    os.replace(str(checkpoint) + ".tmp", checkpoint)
    if accepted:
        torch.save({"model": net.state_dict(), "step": step}, str(best) + ".tmp")
        os.replace(str(best) + ".tmp", best)
        sha = export(net, folder / "best.onnx")
        write_json(
            folder / "best.json",
            {
                "version": f"tribute-v{step:09d}",
                "step": step,
                "sha256": sha,
                "file": "best.onnx",
                "development": measured,
                "protocolSHA256": hashlib.sha256((run / "protocol.json").read_bytes()).hexdigest(),
            },
        )
    result = {
        "stage": "trained",
        "device": str(device),
        "deviceName": torch.cuda.get_device_name(device) if device.type == "cuda" else str(device),
        "parameters": sum(p.numel() for p in net.parameters()),
        "step": step,
        "newUpdates": step - first_step,
        "trainingGroups": len(train),
        "trainingRows": len(x),
        "developmentGroups": len(dev),
        "development": measured,
        "bestUpdated": accepted,
        "loss": loss_value,
        "elapsedSeconds": time.monotonic() - started,
    }
    write_json(folder / "status.json", result)
    return result


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--run", required=True)
    p.add_argument("--device", default="cuda:0")
    p.add_argument("--epochs", type=int, default=20)
    a = p.parse_args()
    print(json.dumps(fit(a.run, a.device, a.epochs)))
