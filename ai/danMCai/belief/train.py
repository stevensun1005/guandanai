"""Hand-inference network trainer (feature versions belief-v1 and belief-v3).

Predicts, for each of the 54 faces, the probability that an unseen copy sits with each of the three
other relative seats (next, partner, previous), from the mover's public-view features
(features.mjs). The supervised target is the true location of the unseen copies in champion
self-play (generate.mjs); it models hidden information and is not a reward or proxy.

Network: features -> standardize -> 512 -> ReLU -> 512 -> ReLU -> 54*3 logits, plus a fixed prior
log(hand count of the seat). The last layer starts at zero, so the untrained network is exactly the
uniform baseline (p_s proportional to remaining hand counts) and seats that are out get ~0.

Loss: per-copy cross-entropy, -sum_{face,seat} y[face,seat] log p[face,seat] / sum y, i.e. the
cross-entropy of each face weighted by its number of unseen copies; faces with no unseen copy
contribute nothing.

Validation is split by seed (never by row), so no round is in both sets. Reported: validation
per-copy log-loss and top-1 seat accuracy (ties share credit) of the model vs the uniform baseline.
Only the final network is exported (no best-checkpoint selection).

The feature version and width come from the data's run.json (generate.mjs --features=v1|v3; all
directories must agree). It is written to train-report.json (featureVersion, features) and to the
ONNX metadata_props, which sampler.mjs / metrics.mjs / midgame-search.mjs use to build the matching
input (default v1 when a report has none). The counts block sits at the same offset in v1 and v3
(v3 extends v1), so the uniform prior is unchanged; v3's per-face denial blocks join the suit
permutation through the run's faceBlocks.

    python ai/danMCai/belief/train.py --data=<gen dir>[,<gen dir>...] --out=<dir>
        [--minutes=5] [--val-mod=10] [--batch=1024] [--lr=1e-3] [--hidden=512] [--device=mps]
"""

import argparse
import hashlib
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import onnx
import torch
from onnx import TensorProto, helper, numpy_helper

FACES, SEATS = 54, 3
TARGETS = FACES * SEATS
EPS = 1e-30


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_shards(directories, with_runs=False):
    """Concatenate generate.mjs blocks: (x uint8 [N,F], y uint8 [N,162], m uint32 [N,4], run meta).

    Rows are copied into arrays allocated once (no list-then-concatenate double peak). Every row's
    seed must lie inside its block's seed range (catches seeds wrapped by a narrower meta type).
    With with_runs=True the run.json of every directory is returned as a fifth value.
    """
    runs, blocks = [], []
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
        for block in sorted(directory.glob("b*.json")):
            blocks.append((directory / block.stem, json.loads(block.read_text())))
    if not runs or not blocks:
        raise ValueError("No data")
    f = runs[0]["features"]
    total = sum(info["rows"] for _, info in blocks)
    x = np.empty((total, f), np.uint8)
    y = np.empty((total, TARGETS), np.uint8)
    m = np.empty((total, 4), np.uint32)
    at = 0
    for stem, info in blocks:
        n = info["rows"]
        if info["features"] != f:
            raise ValueError(f"Block {stem} has a different feature width")
        xb = np.fromfile(f"{stem}.x.u8", np.uint8)
        yb = np.fromfile(f"{stem}.y.u8", np.uint8)
        mb = np.fromfile(f"{stem}.m.u32", np.uint32)
        if xb.size != n * f or yb.size != n * TARGETS or mb.size != n * 4:
            raise ValueError(f"Truncated block {stem}")
        mb = mb.reshape(n, 4)
        lo, hi = info.get("seeds", (None, None))
        if lo is not None and n and ((mb[:, 0] < lo).any() or (mb[:, 0] > hi).any()):
            raise ValueError(f"Block {stem} rows carry seeds outside its range {lo}..{hi}")
        x[at : at + n] = xb.reshape(n, f)
        y[at : at + n] = yb.reshape(n, TARGETS)
        m[at : at + n] = mb
        at += n
    return (x, y, m, runs[0], runs) if with_runs else (x, y, m, runs[0])


def split_by_seed(meta, val_mod=10, val_seeds=None):
    """Boolean validation mask by seed (whole rounds only)."""
    seeds = meta[:, 0].astype(np.int64)
    if val_seeds is not None:
        return (seeds >= val_seeds[0]) & (seeds <= val_seeds[1])
    return seeds % val_mod == 0


class BeliefNet(torch.nn.Module):
    def __init__(self, features, counts_offset, mean, scale, hidden=512, dropout=0.0, input_dropout=0.0):
        super().__init__()
        self.counts_offset = counts_offset
        self.drop = torch.nn.Dropout(dropout)
        self.input_drop = torch.nn.Dropout(input_dropout)
        self.register_buffer("mean", torch.as_tensor(mean, dtype=torch.float32))
        self.register_buffer("scale", torch.as_tensor(scale, dtype=torch.float32))
        self.l1 = torch.nn.Linear(features, hidden)
        self.l2 = torch.nn.Linear(hidden, hidden)
        self.l3 = torch.nn.Linear(hidden, TARGETS)
        torch.nn.init.zeros_(self.l3.weight)
        torch.nn.init.zeros_(self.l3.bias)

    def prior(self, x):
        counts = x[:, self.counts_offset + 1 : self.counts_offset + 4]
        return torch.log(counts + EPS).unsqueeze(1)

    def forward(self, x):
        """Log probabilities [batch, 54, 3] from raw (unstandardized) float features."""
        h = self.drop(torch.relu(self.l1(self.input_drop((x - self.mean) * self.scale))))
        h = self.drop(torch.relu(self.l2(h)))
        logits = self.l3(h).view(-1, FACES, SEATS) + self.prior(x)
        return torch.log_softmax(logits, dim=2)


def uniform_log_probs(x, counts_offset):
    counts = x[:, counts_offset + 1 : counts_offset + 4]
    p = counts / counts.sum(dim=1, keepdim=True).clamp_min(1)
    return torch.log(p + EPS).unsqueeze(1).expand(-1, FACES, SEATS)


def load_initial_onnx(net, file):
    """Warm start every learned tensor AND its original input normalization; Adam stays new."""
    model = onnx.load(file)
    arrays = {t.name: numpy_helper.to_array(t).copy() for t in model.graph.initializer}
    metadata = {p.key: p.value for p in model.metadata_props}
    if metadata.get("featureVersion", "belief-v1") != "belief-v1" or net.l1.in_features != 1238:
        raise ValueError("Warm start currently requires the unchanged belief-v1 interface")
    state = {"mean": "mean", "scale": "scale", "l1.weight": "w1", "l1.bias": "b1",
             "l2.weight": "w2", "l2.bias": "b2", "l3.weight": "w3", "l3.bias": "b3"}
    tensors = {key: torch.from_numpy(arrays[name]) for key, name in state.items()}
    if arrays["count_start"].item() != net.counts_offset + 1:
        raise ValueError("Warm-start hand-count prior differs")
    net.load_state_dict(tensors, strict=True)
    return sha256(file)


def copy_loss(log_probs, y):
    """Per-copy cross-entropy; faces without unseen copies are masked by y = 0."""
    y = y.view(-1, FACES, SEATS)
    return -(y * log_probs).sum() / y.sum().clamp_min(1)


def top1_hits(log_probs, y):
    """Copies whose true seat is the predicted argmax; ties share credit equally."""
    y = y.view(-1, FACES, SEATS)
    best = log_probs.max(dim=2, keepdim=True).values
    winners = (log_probs >= best - 1e-6).float()
    winners = winners / winners.sum(dim=2, keepdim=True)
    return (y * winners).sum()


@torch.no_grad()
def evaluate(net, x, y, counts_offset, device, batch=8192):
    was_training = net.training
    net.eval()
    totals = dict(copies=0.0, model_nll=0.0, uniform_nll=0.0, model_hits=0.0, uniform_hits=0.0)
    for i in range(0, len(x), batch):
        xb = torch.as_tensor(x[i : i + batch], dtype=torch.float32, device=device)
        yb = torch.as_tensor(y[i : i + batch], dtype=torch.float32, device=device)
        lp, lu = net(xb), uniform_log_probs(xb, counts_offset)
        copies = yb.sum().item()
        totals["copies"] += copies
        totals["model_nll"] += copy_loss(lp, yb).item() * copies
        totals["uniform_nll"] += copy_loss(lu, yb).item() * copies
        totals["model_hits"] += top1_hits(lp, yb).item()
        totals["uniform_hits"] += top1_hits(lu, yb).item()
    net.train(was_training)
    c = max(totals["copies"], 1)
    return {
        "rows": int(len(x)),
        "unseenCopies": int(totals["copies"]),
        "modelLogLossPerCopy": totals["model_nll"] / c,
        "uniformLogLossPerCopy": totals["uniform_nll"] / c,
        "modelTop1": totals["model_hits"] / c,
        "uniformTop1": totals["uniform_hits"] / c,
    }


def export_onnx(net, path, feature_version="belief-v1"):
    """features [batch, F] float32 -> probs [batch, 54, 3]; same math as BeliefNet.forward.

    The feature version and width are stored as ONNX metadata_props (featureVersion, features).
    """
    net = net.cpu().eval()
    f = net.l1.in_features
    c0 = net.counts_offset
    t = lambda a: a.detach().cpu().numpy().astype(np.float32)
    init = [
        numpy_helper.from_array(t(net.mean), "mean"),
        numpy_helper.from_array(t(net.scale), "scale"),
        numpy_helper.from_array(t(net.l1.weight), "w1"),
        numpy_helper.from_array(t(net.l1.bias), "b1"),
        numpy_helper.from_array(t(net.l2.weight), "w2"),
        numpy_helper.from_array(t(net.l2.bias), "b2"),
        numpy_helper.from_array(t(net.l3.weight), "w3"),
        numpy_helper.from_array(t(net.l3.bias), "b3"),
        numpy_helper.from_array(np.array([-1, FACES, SEATS], np.int64), "shape"),
        numpy_helper.from_array(np.array([c0 + 1], np.int64), "count_start"),
        numpy_helper.from_array(np.array([c0 + 4], np.int64), "count_end"),
        numpy_helper.from_array(np.array([1], np.int64), "axis1"),
        numpy_helper.from_array(np.array(EPS, np.float32), "eps"),
    ]
    nodes = [
        helper.make_node("Sub", ["features", "mean"], ["centered"]),
        helper.make_node("Mul", ["centered", "scale"], ["standard"]),
        helper.make_node("Gemm", ["standard", "w1", "b1"], ["z1"], transB=1),
        helper.make_node("Relu", ["z1"], ["h1"]),
        helper.make_node("Gemm", ["h1", "w2", "b2"], ["z2"], transB=1),
        helper.make_node("Relu", ["z2"], ["h2"]),
        helper.make_node("Gemm", ["h2", "w3", "b3"], ["flat"], transB=1),
        helper.make_node("Reshape", ["flat", "shape"], ["logits"]),
        helper.make_node("Slice", ["features", "count_start", "count_end", "axis1"], ["counts"]),
        helper.make_node("Add", ["counts", "eps"], ["counts_eps"]),
        helper.make_node("Log", ["counts_eps"], ["prior2"]),
        helper.make_node("Unsqueeze", ["prior2", "axis1"], ["prior"]),
        helper.make_node("Add", ["logits", "prior"], ["scores"]),
        helper.make_node("Softmax", ["scores"], ["probs"], axis=2),
    ]
    graph = helper.make_graph(
        nodes,
        "GuandanBeliefV3" if feature_version == "belief-v3" else "GuandanBeliefV1",
        [helper.make_tensor_value_info("features", TensorProto.FLOAT, ["batch", f])],
        [helper.make_tensor_value_info("probs", TensorProto.FLOAT, ["batch", FACES, SEATS])],
        init,
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)], producer_name="GuandanAI")
    model.ir_version = 8
    helper.set_model_props(model, {"featureVersion": str(feature_version), "features": str(f)})
    onnx.checker.check_model(model)
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    onnx.save(model, temporary)
    os.replace(temporary, path)
    return sha256(path)


def face_blocks_of(run):
    """Start offsets of the 54-face blocks: run["faceBlocks"] (v3 and later) or the v1 blocks."""
    if run.get("faceBlocks"):
        return [int(b) for b in run["faceBlocks"]]
    layout = run["layout"]
    return [layout["own"][0], layout["unseen"][0]] + [layout["played"][0] + FACES * r for r in range(SEATS)]


def suit_permutations(layout, features, face_blocks=None):
    """Index maps for the 6 permutations of the non-heart suits (spade, club, diamond).

    Champion face index: (rank - 2) * 4 + slot with slot 0 = hearts, 1 = spades, 2 = clubs,
    3 = diamonds; 52/53 are jokers. Hearts carry the wild level card, the other three suits are
    interchangeable under the rules, so a permutation of their slots applied to every 54-face block
    (own, unseen, faces played per seat) and to the target relabels the deal into another legal one.
    Shape buckets carry no suit and stay fixed. The champion that generated the data is not
    constrained to be suit-symmetric (its inputs keep suits, and ties break by candidate order), so
    on champion self-play the augmentation is a symmetry prior, not an exact identity: any
    suit-specific habit of the champion is averaged out rather than learned.
    """
    import itertools

    face_maps = []
    for perm in itertools.permutations((1, 2, 3)):
        slot = {0: 0, 1: perm[0], 2: perm[1], 3: perm[2]}
        face_maps.append(np.array([f if f >= 52 else (f // 4) * 4 + slot[f % 4] for f in range(FACES)]))
    blocks = face_blocks if face_blocks is not None else face_blocks_of({"layout": layout})
    x_maps, y_maps = [], []
    for fm in face_maps:
        xm = np.arange(features)
        for start in blocks:
            xm[start + fm] = start + np.arange(FACES)
        ym = np.empty(TARGETS, np.int64)
        for f in range(FACES):
            ym[fm[f] * SEATS : fm[f] * SEATS + SEATS] = np.arange(f * SEATS, f * SEATS + SEATS)
        x_maps.append(xm)
        y_maps.append(ym)
    return np.stack(x_maps), np.stack(y_maps)


def standardization(x, rows=None, chunk=65536):
    """Per-feature mean and 1/max(std, 1) over `rows` of uint8 x, accumulated in float64 chunks.

    np.std on the whole matrix would materialize a float64 copy (8 bytes per feature per row,
    about 15 GB at 1.5M rows); chunking keeps the extra memory to one chunk.
    """
    rows = np.arange(len(x)) if rows is None else np.asarray(rows)
    if not len(rows):
        raise ValueError("No rows to standardize")
    total = np.zeros(x.shape[1], np.float64)
    squares = np.zeros(x.shape[1], np.float64)
    for i in range(0, len(rows), chunk):
        block = x[rows[i : i + chunk]].astype(np.float64)
        total += block.sum(axis=0)
        squares += np.square(block).sum(axis=0)
    mean = total / len(rows)
    std = np.sqrt(np.maximum(squares / len(rows) - mean * mean, 0.0))
    return mean.astype(np.float32), (1.0 / np.maximum(std, 1.0)).astype(np.float32)


def train(args):
    if args.threads:
        torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    directories = [d for d in args.data.split(",") if d]
    x, y, meta, run, runs = load_shards(directories, with_runs=True)
    counts_offset = run["layout"]["counts"][0]
    val_seeds = None
    if args.val_seeds:
        a, b = (int(s.replace(",", "").replace("_", "")) for s in args.val_seeds.split(".."))
        val_seeds = (a, b)
    val = split_by_seed(meta, args.val_mod, val_seeds)
    train_idx, val_idx = np.flatnonzero(~val), np.flatnonzero(val)
    if not len(train_idx) or not len(val_idx):
        raise ValueError("Empty train or validation split")
    if np.intersect1d(meta[train_idx, 0], meta[val_idx, 0]).size:
        raise AssertionError("Seed leakage between train and validation")
    device = torch.device(args.device if args.device != "mps" or torch.backends.mps.is_available() else "cpu")
    mean, scale = standardization(x, train_idx)
    feature_version = run.get("featureVersion", "belief-v1")
    face_blocks = face_blocks_of(run)
    x_maps, y_maps = (
        suit_permutations(run["layout"], x.shape[1], face_blocks) if args.augment_suits else (None, None)
    )
    if x_maps is not None:  # symmetrize so every relabelled deal is standardized alike
        mean, scale = mean[x_maps].mean(axis=0), scale[x_maps].mean(axis=0)
    net = BeliefNet(x.shape[1], counts_offset, mean, scale, args.hidden, args.dropout, args.input_dropout).to(device)
    initial_sha = load_initial_onnx(net, args.initial_onnx) if args.initial_onnx else None
    net.train()
    optimizer = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    xv, yv = x[val_idx], y[val_idx]
    initial = evaluate(net, xv, yv, counts_offset, device)
    history = [{"step": 0, "seconds": 0.0, **initial}]
    deadline = time.time() + args.minutes * 60
    if args.deadline:
        deadline = min(deadline, datetime.fromisoformat(args.deadline.replace("Z", "+00:00")).timestamp())
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stop_files = [Path(p) for p in args.stop_file.split(",") if p]
    max_steps = args.max_steps
    if args.epochs > 0:
        epoch_steps = int(np.ceil(args.epochs * len(train_idx) / min(args.batch, len(train_idx))))
        max_steps = min(max_steps, epoch_steps) if max_steps > 0 else epoch_steps
    def status(phase):
        value = {"pid": os.getpid(), "phase": phase, "step": step, "device": str(device),
                 "rowsSeen": rows_seen, "trainRows": len(train_idx), "maxSteps": max_steps,
                 "initialONNXSHA256": initial_sha, "trainLossEMA": ema,
                 "updatedAtUTC": datetime.now().astimezone().isoformat()}
        temporary = out / "status.json.tmp"
        temporary.write_text(json.dumps(value), encoding="utf-8")
        for attempt in range(20):
            try:
                os.replace(temporary, out / "status.json")
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.025)
    start, step, rows_seen, ema = time.time(), 0, 0, None
    status("training")
    while time.time() < deadline and (max_steps <= 0 or step < max_steps) and not any(p.exists() for p in stop_files):
        while args.pause_file and Path(args.pause_file).exists() and time.time() < deadline and not any(p.exists() for p in stop_files):
            status("memory-paused")
            time.sleep(1)
        if time.time() >= deadline or any(p.exists() for p in stop_files):
            break
        batch = rng.choice(train_idx, size=min(args.batch, len(train_idx)), replace=False)
        xn, yn = x[batch], y[batch]
        if x_maps is not None:
            k = rng.integers(0, len(x_maps), len(batch))
            xn = np.take_along_axis(xn, x_maps[k], axis=1)
            yn = np.take_along_axis(yn, y_maps[k], axis=1)
        xb = torch.as_tensor(xn, dtype=torch.float32, device=device)
        yb = torch.as_tensor(yn, dtype=torch.float32, device=device)
        loss = copy_loss(net(xb), yb)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        step += 1
        rows_seen += len(batch)
        ema = loss.item() if ema is None else 0.98 * ema + 0.02 * loss.item()
        if step % args.eval_every == 0:
            entry = {"step": step, "seconds": time.time() - start, "trainLossEMA": ema}
            entry.update(evaluate(net, xv, yv, counts_offset, device))
            history.append(entry)
            print(json.dumps(entry), flush=True)
        if step % 25 == 0:
            status("training")
    seconds = time.time() - start
    final = evaluate(net, xv, yv, counts_offset, device)
    torch.save({"state": net.state_dict(), "optimizer": optimizer.state_dict(), "step": step,
                "counts_offset": counts_offset, "hidden": args.hidden,
                "initialONNXSHA256": initial_sha}, out / "checkpoint.pt")
    net.eval()
    torch.save({"state": net.state_dict(), "counts_offset": counts_offset, "hidden": args.hidden}, out / "belief.pt")
    onnx_sha = export_onnx(net, out / "belief.onnx", feature_version)
    report = {
        "featureVersion": feature_version,
        "features": int(x.shape[1]),
        "faceBlocks": face_blocks,
        "data": [str(Path(d).resolve()) for d in directories],
        "dataProtocols": [
            {k: r[k] for k in ("seeds", "band", "every", "temperature", "championSHA256") if k in r} for r in runs
        ],
        "split": {"valSeeds": val_seeds, "valMod": None if val_seeds else args.val_mod},
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
        "initialONNXSHA256": initial_sha,
        "newAdam": bool(initial_sha),
        "effectiveMaxSteps": max_steps,
        "stopReason": "stop-file" if any(p.exists() for p in stop_files) else "deadline" if time.time() >= deadline else "fixed-epochs-or-steps",
        "trainSeconds": seconds,
        "rowsPerSecond": rows_seen / seconds if seconds else None,
        "epochs": rows_seen / len(train_idx),
        "initialValidation": initial,
        "finalValidation": final,
        "history": history,
        "onnx": str((out / "belief.onnx").resolve()),
        "onnxSHA256": onnx_sha,
        "note": "Validation rows are whole held-out seeds of the same generation run; final network only.",
    }
    (out / "train-report.json").write_text(json.dumps(report, indent=2))
    status("complete")
    print(json.dumps({k: report[k] for k in ("steps", "trainSeconds", "rowsPerSecond", "epochs", "finalValidation", "onnxSHA256")}, indent=2))
    return report


def parse(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--minutes", type=float, default=5)
    p.add_argument("--max-steps", type=int, default=0)
    p.add_argument("--val-mod", type=int, default=10)
    p.add_argument("--val-seeds", default=None)
    p.add_argument("--batch", type=int, default=1024)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--hidden", type=int, default=512)
    p.add_argument("--dropout", type=float, default=0.0)
    p.add_argument("--input-dropout", type=float, default=0.0)
    p.add_argument("--augment-suits", type=int, default=1)
    p.add_argument("--eval-every", type=int, default=500)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="mps")
    p.add_argument("--initial-onnx")
    p.add_argument("--epochs", type=float, default=0)
    p.add_argument("--threads", type=int, default=0)
    p.add_argument("--deadline")
    p.add_argument("--stop-file", default="")
    p.add_argument("--pause-file", default="")
    return p.parse_args(argv)


if __name__ == "__main__":
    train(parse(sys.argv[1:]))
