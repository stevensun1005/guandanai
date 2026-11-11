"""Window 4, V2a: belief v2a trainer wrapper (PLAN section 5 row V2a). Development, not acceptance.

Reuses ai/danMCai/belief/train.py (imported from the frozen checkout given by --train-py; not
modified, not copied): load-shard checks, split_by_seed, standardization, suit permutations,
BeliefNet, copy_loss, evaluate and export_onnx are train.py's own functions, and the training loop
below is train.py's train() loop line for line (same rng calls in the same order, same AdamW, same
loss, same eval cadence). Three things are added, none of which changes the math of a step:

  1. --cap-rows: whole generate.mjs blocks are taken from the --data directories IN THE ORDER GIVEN
     (each directory's blocks in seed order) until the next block would pass the cap (PLAN: "capped
     at 4 M rows in RAM"); validation stays split by seed (seed % val-mod == 0), never by row;
  2. the loop also ends at --deadline-epoch or when a --stop-files file exists (window-4 STOP); the
     final network is then evaluated and exported as train.py does, and the report says why it
     ended (stopReason) and how many steps it made;
  3. after export, validation log loss per unseen copy BY BAND (cards on table, meta column 3) for
     v2a, belief v1 (--v1-pt, the deployed 16d76783... network's torch weights) and the uniform
     baseline on the same held-out rows (V2a/train.json "byBand").

The structure head of PLAN row V2a (natural-bomb count / longest-sequence class per hidden seat) is
NOT trained: train.py has no such head, and this window adds no trainer code; the report says so.

Report: <out>/train-report.json in train.py's format (dataProtocols lists every input directory's
full seed range, so metrics.mjs refuses any overlapping seed) plus the fields above; --summary gets
the same object. Progress: one JSON line per evaluation ("step": n) in --log (dashboard 'train').
"""

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch

BANDS = [(21, 40), (41, 60), (61, 80), (81, 108)]


def load_train_module(path):
    spec = importlib.util.spec_from_file_location("belief_train", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def log_line(path, obj):
    line = json.dumps(obj)
    print(line, flush=True)
    if path:
        with open(path, "a") as f:
            f.write(line + "\n")


def select_blocks(directories, cap_rows, max_blocks_per_dir=0):
    """Whole blocks, directories in the given order, each in seed order, until the cap."""
    runs, chosen, used = [], [], []
    total, full = 0, False
    for directory in directories:
        directory = Path(directory)
        meta = json.loads((directory / "run.json").read_text())
        if runs and (meta["featureVersion"], meta["features"], meta["layout"]) != (
            runs[0]["featureVersion"],
            runs[0]["features"],
            runs[0]["layout"],
        ):
            raise ValueError("Data directories use different feature layouts")
        runs.append(meta)
        rows = blocks = 0
        seeds = None
        for k, block in enumerate(sorted(directory.glob("b*.json"))):
            if full or (max_blocks_per_dir and k >= max_blocks_per_dir):
                break
            info = json.loads(block.read_text())
            if cap_rows and total + info["rows"] > cap_rows:
                full = True
                break
            chosen.append((directory / block.stem, info))
            total += info["rows"]
            rows += info["rows"]
            blocks += 1
            lo, hi = info["seeds"]
            seeds = [lo, hi] if seeds is None else [min(seeds[0], lo), max(seeds[1], hi)]
        used.append({"dir": str(directory.resolve()), "blocks": blocks, "rows": rows, "seedsUsed": seeds,
                     "runSeeds": meta.get("seeds"), "band": meta.get("band"), "every": meta.get("every")})
    if not chosen:
        raise ValueError("No data")
    return runs, chosen, used, total


def load_blocks(chosen, features, targets):
    """train.py load_shards on the chosen blocks (same checks, arrays allocated once)."""
    total = sum(info["rows"] for _, info in chosen)
    x = np.empty((total, features), np.uint8)
    y = np.empty((total, targets), np.uint8)
    m = np.empty((total, 4), np.uint32)
    at = 0
    for stem, info in chosen:
        n = info["rows"]
        if info["features"] != features:
            raise ValueError(f"Block {stem} has a different feature width")
        xb = np.fromfile(f"{stem}.x.u8", np.uint8)
        yb = np.fromfile(f"{stem}.y.u8", np.uint8)
        mb = np.fromfile(f"{stem}.m.u32", np.uint32)
        if xb.size != n * features or yb.size != n * targets or mb.size != n * 4:
            raise ValueError(f"Truncated block {stem}")
        mb = mb.reshape(n, 4)
        lo, hi = info.get("seeds", (None, None))
        if lo is not None and n and ((mb[:, 0] < lo).any() or (mb[:, 0] > hi).any()):
            raise ValueError(f"Block {stem} rows carry seeds outside its range {lo}..{hi}")
        x[at : at + n] = xb.reshape(n, features)
        y[at : at + n] = yb.reshape(n, targets)
        m[at : at + n] = mb
        at += n
    return x, y, m


def stopped(files):
    return any(os.path.exists(f) for f in files)


def train(args, T):
    t_load = time.time()
    stop_files = [f for f in (args.stop_files or "").split(",") if f]
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    directories = [d for d in args.data.split(",") if d]
    runs, chosen, used, total = select_blocks(directories, args.cap_rows, args.max_blocks_per_dir)
    run = runs[0]
    log_line(args.log, {"phase": "load", "rowsSelected": total, "blocks": len(chosen), "dirs": used})
    x, y, meta = load_blocks(chosen, run["features"], T.TARGETS)
    counts_offset = run["layout"]["counts"][0]
    val = T.split_by_seed(meta, args.val_mod, None)
    train_idx, val_idx = np.flatnonzero(~val), np.flatnonzero(val)
    if not len(train_idx) or not len(val_idx):
        raise ValueError("Empty train or validation split")
    if np.intersect1d(meta[train_idx, 0], meta[val_idx, 0]).size:
        raise AssertionError("Seed leakage between train and validation")
    device = torch.device(args.device if args.device != "mps" or torch.backends.mps.is_available() else "cpu")
    if args.require_device and str(device) != args.require_device:
        raise RuntimeError(f"device {device} != required {args.require_device}")
    mean, scale = T.standardization(x, train_idx)
    feature_version = run.get("featureVersion", "belief-v1")
    face_blocks = T.face_blocks_of(run)
    x_maps, y_maps = (
        T.suit_permutations(run["layout"], x.shape[1], face_blocks) if args.augment_suits else (None, None)
    )
    if x_maps is not None:  # symmetrize so every relabelled deal is standardized alike
        mean, scale = mean[x_maps].mean(axis=0), scale[x_maps].mean(axis=0)
    net = T.BeliefNet(x.shape[1], counts_offset, mean, scale, args.hidden, args.dropout, args.input_dropout).to(device)
    net.train()
    optimizer = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    xv, yv = x[val_idx], y[val_idx]
    initial = T.evaluate(net, xv, yv, counts_offset, device)
    history = [{"step": 0, "seconds": 0.0, **initial}]
    log_line(args.log, {"phase": "ready", "loadSeconds": time.time() - t_load, "device": str(device),
                        "trainRows": int(len(train_idx)), "valRows": int(len(val_idx)), **history[0]})
    deadline = time.time() + args.minutes * 60
    if args.deadline_epoch:
        deadline = min(deadline, args.deadline_epoch)
    start, step, rows_seen, ema = time.time(), 0, 0, None
    stop_reason = None
    while True:
        if not (time.time() < deadline):
            stop_reason = "deadline" if args.deadline_epoch and time.time() >= args.deadline_epoch else "minutes"
            break
        if args.max_steps > 0 and step >= args.max_steps:
            stop_reason = "maxSteps"
            break
        if step % 50 == 0 and stopped(stop_files):
            stop_reason = "stopFile"
            break
        batch = rng.choice(train_idx, size=min(args.batch, len(train_idx)), replace=False)
        xn, yn = x[batch], y[batch]
        if x_maps is not None:
            k = rng.integers(0, len(x_maps), len(batch))
            xn = np.take_along_axis(xn, x_maps[k], axis=1)
            yn = np.take_along_axis(yn, y_maps[k], axis=1)
        xb = torch.as_tensor(xn, dtype=torch.float32, device=device)
        yb = torch.as_tensor(yn, dtype=torch.float32, device=device)
        loss = T.copy_loss(net(xb), yb)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        step += 1
        rows_seen += len(batch)
        ema = loss.item() if ema is None else 0.98 * ema + 0.02 * loss.item()
        if step % args.eval_every == 0:
            entry = {"step": step, "seconds": time.time() - start, "trainLossEMA": ema}
            entry.update(T.evaluate(net, xv, yv, counts_offset, device))
            history.append(entry)
            log_line(args.log, entry)
    seconds = time.time() - start
    final = T.evaluate(net, xv, yv, counts_offset, device)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    net.eval()
    torch.save({"state": net.state_dict(), "counts_offset": counts_offset, "hidden": args.hidden}, out / "belief.pt")
    onnx_sha = T.export_onnx(net, out / "belief.onnx", feature_version)
    log_line(args.log, {"phase": "exported", "steps": step, "stopReason": stop_reason, "onnxSHA256": onnx_sha})

    # by band (cards on table) on the same held-out rows: v2a, v1, uniform
    by_band, v1_info = {}, None
    v1 = None
    if args.v1_pt and os.path.exists(args.v1_pt):
        ck = torch.load(args.v1_pt, map_location="cpu")
        v1 = T.BeliefNet(x.shape[1], ck["counts_offset"], np.zeros(x.shape[1], np.float32),
                         np.ones(x.shape[1], np.float32), ck["hidden"])
        v1.load_state_dict(ck["state"])
        v1 = v1.to(device).eval()
        v1_info = {"pt": str(Path(args.v1_pt).resolve()), "sha256": T.sha256(args.v1_pt), "hidden": ck["hidden"],
                   "note": "belief v1 = window-1 H/model (ONNX 16d76783...); v2a's validation rows are held out "
                           "from v1 too (H/data seed%10==0 = v1's own validation seeds; data-v2 and S4a never seen by v1)"}
    cards = meta[val_idx, 3].astype(np.int64)
    for lo, hi in BANDS + [(0, 999)]:
        mask = (cards >= lo) & (cards <= hi)
        key = "all" if lo == 0 else f"{lo}-{hi}"
        if not mask.any():
            by_band[key] = {"rows": 0}
            continue
        e2 = T.evaluate(net, xv[mask], yv[mask], counts_offset, device)
        entry = {"rows": e2["rows"], "unseenCopies": e2["unseenCopies"],
                 "v2aLogLossPerCopy": e2["modelLogLossPerCopy"], "uniformLogLossPerCopy": e2["uniformLogLossPerCopy"],
                 "v2aTop1": e2["modelTop1"], "uniformTop1": e2["uniformTop1"]}
        if v1 is not None:
            e1 = T.evaluate(v1, xv[mask], yv[mask], counts_offset, device)
            entry.update({"v1LogLossPerCopy": e1["modelLogLossPerCopy"], "v1Top1": e1["modelTop1"],
                          "v2aMinusV1": e2["modelLogLossPerCopy"] - e1["modelLogLossPerCopy"]})
        by_band[key] = entry
    report = {
        "featureVersion": feature_version,
        "features": int(x.shape[1]),
        "faceBlocks": face_blocks,
        "data": [str(Path(d).resolve()) for d in directories],
        "dataProtocols": [
            {k: r[k] for k in ("seeds", "band", "every", "temperature", "championSHA256") if k in r} for r in runs
        ],
        "dataUsed": used,
        "capRows": args.cap_rows,
        "rowsLoaded": int(len(x)),
        "split": {"valSeeds": None, "valMod": args.val_mod},
        "trainRows": int(len(train_idx)),
        "trainSeeds": int(np.unique(meta[train_idx, 0]).size),
        "valSeeds": int(np.unique(meta[val_idx, 0]).size),
        "hyper": {
            "hidden": args.hidden,
            "batch": args.batch,
            "lr": args.lr,
            "weightDecay": args.weight_decay,
            "dropout": args.dropout,
            "inputDropout": args.input_dropout,
            "augmentSuits": bool(args.augment_suits),
            "maxSteps": args.max_steps,
            "minutes": args.minutes,
            "seed": args.seed,
            "device": str(device),
        },
        "steps": step,
        "stopReason": stop_reason,
        "trainSeconds": seconds,
        "loadAndSetupSeconds": start - t_load,
        "rowsPerSecond": rows_seen / seconds if seconds else None,
        "epochs": rows_seen / len(train_idx),
        "initialValidation": initial,
        "finalValidation": final,
        "byBand": by_band,
        "v1Reference": v1_info,
        "structureHead": "not trained: ai/danMCai/belief/train.py has no structure head and window 4 adds no trainer code",
        "history": history,
        "onnx": str((out / "belief.onnx").resolve()),
        "onnxSHA256": onnx_sha,
        "trainPy": {"path": str(Path(args.train_py).resolve()), "sha256": T.sha256(args.train_py)},
        "wrapper": {"path": str(Path(__file__).resolve()), "sha256": T.sha256(__file__)},
        "note": "Validation rows are whole held-out seeds (seed % valMod == 0) of the same generation runs; final "
                "network only (no best-checkpoint selection). Development reading, not acceptance.",
    }
    (out / "train-report.json").write_text(json.dumps(report, indent=2))
    if args.summary:
        Path(args.summary).write_text(json.dumps(report, indent=2))
    print(json.dumps({k: report[k] for k in ("steps", "stopReason", "trainSeconds", "epochs", "onnxSHA256")}), flush=True)
    return report


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--train-py", required=True)
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--cap-rows", type=int, default=0)
    p.add_argument("--max-blocks-per-dir", type=int, default=0)
    p.add_argument("--minutes", type=float, default=60)
    p.add_argument("--deadline-epoch", type=float, default=0)
    p.add_argument("--stop-files", default="")
    p.add_argument("--max-steps", type=int, default=0)
    p.add_argument("--val-mod", type=int, default=10)
    p.add_argument("--batch", type=int, default=1024)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--weight-decay", type=float, default=0.01)
    p.add_argument("--hidden", type=int, default=512)
    p.add_argument("--dropout", type=float, default=0.3)
    p.add_argument("--input-dropout", type=float, default=0.1)
    p.add_argument("--augment-suits", type=int, default=1)
    p.add_argument("--eval-every", type=int, default=500)
    p.add_argument("--seed", type=int, default=20261112)
    p.add_argument("--device", default="mps")
    p.add_argument("--require-device", default="")
    p.add_argument("--v1-pt", default="")
    p.add_argument("--log", default="")
    p.add_argument("--summary", default="")
    return p.parse_args(argv)


if __name__ == "__main__":
    a = parse(sys.argv[1:])
    train(a, load_train_module(a.train_py))
