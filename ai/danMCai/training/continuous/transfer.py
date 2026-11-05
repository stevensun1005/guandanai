"""Portable, checksummed snapshots. Never edits a source run or installs an environment."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import time
import zipfile


def digest(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def safe_path(name):
    p = PurePosixPath(name)
    if (
        not name
        or not p.parts
        or p.as_posix() != name
        or name.endswith("/")
        or p.is_absolute()
        or ".." in p.parts
        or "\\" in name
        or ":" in name
    ):
        raise ValueError(f"Unsafe snapshot path: {name}")
    return p


def verify(directory):
    directory = Path(directory).resolve()
    manifest = read(directory / "manifest.json")
    if manifest.get("schema") != 1:
        raise ValueError("Unsupported snapshot schema")
    actual = {
        p.relative_to(directory).as_posix()
        for p in directory.rglob("*")
        if p.is_file() or p.is_symlink()
    }
    if actual != {"manifest.json", *manifest["files"]}:
        raise ValueError("Unexpected snapshot files or links")
    for name, entry in manifest["files"].items():
        path = directory.joinpath(*safe_path(name).parts)
        if path.is_symlink() or not path.resolve().is_relative_to(directory):
            raise ValueError("Snapshot links are not allowed")
        if path.stat().st_size != entry["bytes"] or digest(path) != entry["sha256"]:
            raise ValueError(f"Snapshot checksum mismatch: {name}")
    return manifest


def pack(run, frozen_source, output):
    run, frozen_source, output = map(lambda p: Path(p).resolve(), (run, frozen_source, output))
    if output.exists() or output.with_suffix(output.suffix + ".tmp").exists():
        raise FileExistsError("Choose a new archive name; snapshots are immutable")
    if output.is_relative_to(run):
        raise ValueError("Archive must be outside its source run")
    status = read(run / "status.json")
    if not status.get("stoppedAt") or status.get("running"):
        raise ValueError("Stop the source supervisor cleanly before packing")
    if read(run / "learner/status.json").get("state") != "stopped":
        raise ValueError("Source learner has not stopped")
    config = read(run / "config.json")
    for name, expected in config["sourceSHA256"].items():
        data = (frozen_source / name).read_bytes().replace(b"\r\n", b"\n")
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Frozen source mismatch: {name}")
    latest, champion = read(run / "models/latest.json"), read(run / "champion/champion.json")
    if digest(run / "models" / latest["file"]) != latest["sha256"]:
        raise ValueError("Latest model checksum mismatch")
    if digest(run / "champion/champion.onnx") != champion["sha256"]:
        raise ValueError("Champion checksum mismatch")
    if not (run / "learner/checkpoint.pt").is_file():
        raise ValueError("Optimizer checkpoint missing")
    files = {
        "windows-gpu-main/" + p.relative_to(run).as_posix(): p
        for p in sorted(run.rglob("*"))
        if p.is_file()
    }
    files.update({"frozen-source/" + name: frozen_source / name for name in config["sourceSHA256"]})
    manifest = {
        "schema": 1,
        "kind": "training-transfer",
        "createdAtUTC": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceRun": "windows-gpu-main",
        "latest": latest,
        "champion": champion,
        "sourceStopReason": status.get("stopReason"),
        "sourceElapsedSeconds": status.get("elapsedSeconds"),
        "files": {},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".tmp")
    with zipfile.ZipFile(
        temporary, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=1
    ) as archive:
        for name, path in files.items():
            if path.is_symlink():
                raise ValueError("Source file links are not allowed")
            before = path.stat()
            entry = {"bytes": before.st_size, "sha256": digest(path), "mtime": before.st_mtime}
            archive.write(path, name)
            if digest(path) != entry["sha256"] or path.stat().st_mtime != before.st_mtime:
                raise ValueError(f"Source changed while packing: {name}")
            manifest["files"][name] = entry
        archive.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
    os.replace(temporary, output)
    output.with_suffix(output.suffix + ".sha256").write_text(
        digest(output) + "  " + output.name + "\n", encoding="utf-8"
    )
    return {
        "archive": str(output),
        "bytes": output.stat().st_size,
        "sha256": digest(output),
        "files": len(files),
        "uncompressedBytes": sum(e["bytes"] for e in manifest["files"].values()),
        "latest": latest["version"],
        "champion": champion["version"],
    }


def unpack(archive_path, destination):
    archive_path, destination = Path(archive_path), Path(destination).resolve()
    expected = archive_path.with_suffix(archive_path.suffix + ".sha256").read_text().split()[0]
    if digest(archive_path) != expected:
        raise ValueError("Archive checksum mismatch")
    if destination.exists():
        raise FileExistsError("Extraction destination must be new")
    with zipfile.ZipFile(archive_path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != {"manifest.json", *manifest["files"]}:
            raise ValueError("Unexpected or duplicate archive entries")
        if sum(i.file_size for i in archive.infolist()) > 25 * 1024**3:
            raise ValueError("Snapshot exceeds 25 GiB extraction budget")
        for info in archive.infolist():
            safe_path(info.filename)
            if stat.S_ISLNK(info.external_attr >> 16):
                raise ValueError("Archive links are not allowed")
        destination.mkdir(parents=True)
        archive.extractall(destination)
    verified = verify(destination)
    for name, entry in verified["files"].items():
        os.utime(destination / name, (entry["mtime"], entry["mtime"]))
    return {"snapshot": str(destination), "verifiedFiles": len(verified["files"])}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="command", required=True)
    p = subs.add_parser("pack")
    p.add_argument("--run", required=True)
    p.add_argument("--frozen-source", required=True)
    p.add_argument("--output", required=True)
    p = subs.add_parser("unpack")
    p.add_argument("--archive", required=True)
    p.add_argument("--destination", required=True)
    p = subs.add_parser("verify")
    p.add_argument("--snapshot", required=True)
    args = parser.parse_args()
    if args.command == "pack":
        result = pack(args.run, args.frozen_source, args.output)
    elif args.command == "unpack":
        result = unpack(args.archive, args.destination)
    else:
        result = {"verifiedFiles": len(verify(args.snapshot)["files"])}
    print(json.dumps(result))
