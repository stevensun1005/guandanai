"""Archive experimental weight files by SHA-256; buffers and default deployment stay separate."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import zipfile


def archive(workspace, output, manifest, download):
    inventory = {}
    skipped = []
    for path in sorted((workspace / "work/learning").rglob("*")):
        if (
            not path.is_file()
            or path.suffix not in {".onnx", ".npz"}
            or path.name == "behavior.npz"
        ):
            continue
        # A writer may have created a checkpoint but not yet finished its training report.
        if path.parent.name == "model" and not (path.parent / "training.json").exists():
            skipped.append(path.relative_to(workspace).as_posix())
            continue
        before = path.stat()
        with path.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            skipped.append(path.relative_to(workspace).as_posix())
            continue
        item = inventory.setdefault(
            digest,
            {
                "sha256": digest,
                "bytes": after.st_size,
                "archiveEntry": digest + path.suffix,
                "locations": [],
                "source": str(path),
            },
        )
        item["locations"].append(path.relative_to(workspace).as_posix())
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as pack:
        for item in inventory.values():
            pack.write(item["source"], item["archiveEntry"])
    with output.open("rb") as stream:
        pack_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    data = {
        "schema": 1,
        "observedUTC": datetime.now(timezone.utc).isoformat(),
        "classification": "Archived experimental artifacts, including rejected and smoke checkpoints; not proof of improvement",
        "archive": {
            "filename": output.name,
            "bytes": output.stat().st_size,
            "sha256": pack_hash,
            "download": download,
        },
        "uniqueFiles": len(inventory),
        "locations": sum(len(i["locations"]) for i in inventory.values()),
        "artifacts": [{k: v for k, v in i.items() if k != "source"} for i in inventory.values()],
        "excludedWhileIncomplete": skipped,
        "scope": "Weight files only. Raw training buffers and duplicate serialized rollout behavior checkpoints are not bundled.",
    }
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {k: v for k, v in data.items() if k not in ["artifacts", "excludedWhileIncomplete"]}
        ),
        flush=True,
    )


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--workspace", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--download", required=True)
    a = p.parse_args()
    archive(a.workspace.resolve(), a.output.resolve(), a.manifest.resolve(), a.download)
