"""Explicit protocol migration of a NEW checkpoint copy; never edits parent data/weights."""

import argparse
import hashlib
import json
from pathlib import Path
import torch


def inherit(run):
    run = Path(run)
    raw = (run / "protocol.json").read_bytes()
    protocol = json.loads(raw)
    lineage = protocol["lineage"]
    parent = Path(lineage["parentRun"])
    data = (parent / "learner/latest.pt").read_bytes()
    if hashlib.sha256(data).hexdigest() != lineage["checkpointSHA256"]:
        raise ValueError("Parent checkpoint changed")
    saved = torch.load(parent / "learner/latest.pt", map_location="cpu", weights_only=True)
    if saved["protocolSHA256"] != lineage["parentProtocolSHA256"]:
        raise ValueError("Parent checkpoint protocol mismatch")
    saved["inheritedProtocolSHA256"] = saved["protocolSHA256"]
    saved["protocolSHA256"] = hashlib.sha256(raw).hexdigest()
    (run / "learner").mkdir(exist_ok=True)
    with (run / "learner/latest.pt").open("xb") as f:
        torch.save(saved, f)
    restored = torch.load(run / "learner/latest.pt", map_location="cpu", weights_only=True)

    def same(a, b):
        if isinstance(a, torch.Tensor):
            return torch.equal(a, b)
        if isinstance(a, dict):
            return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
        if isinstance(a, (list, tuple)):
            return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
        return a == b

    if not same(saved, restored):
        raise ValueError("Checkpoint migration roundtrip mismatch")
    result = {
        "inheritedStep": saved["step"],
        "parentCheckpointSHA256": lineage["checkpointSHA256"],
        "allModelAndOptimizerTensorsPreserved": True,
        "parentDataImported": False,
    }
    (run / "inheritance.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True)
    print(json.dumps(inherit(parser.parse_args().run)))
