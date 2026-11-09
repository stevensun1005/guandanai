"""Offline endgame residual student on the frozen section-68 PIMC rows (plan A, development code).

Model: q(s, a) = c(s, a) + f(s, a). c is the frozen champion 017 (never trained; its values are
precomputed once). f is a second 567->512x5->1 tanh MLP whose hidden layers are copied from the
champion and whose OUTPUT layer is zero, so q == champion exactly at step 0.

Labels are the section-68 PIMC means of exact signed round points (+-1/+-2/+-3) over 8 sampled
worlds; nothing else (no tempo, trick, bomb or partner proxy) enters the loss.

Per decision d with best label y*: keep set M_d = {i : y* - y_i < 0.25} (within about 2 of 8 worlds
of the best), reject set N_d = the rest.
  silent decision (N_d empty):  L_d = mean_i f_i^2
  informative decision:          L_d = mean_{M_d} f_i^2 + mean_{N_d} max(0, m + q_i - min_{M_d} q_j)^2
with m = 0.125. The batch loss is the mean of L_d over sampled DECISIONS. So f stays zero (the
champion's ordering is kept) unless the labels clearly say a move is worse than every kept move.

Data: section-68 shards s{slot}-{n}.{x.i8,y.f32,json} (read-only). A new decision starts at row i
when x[i, :513] != x[i-1, :513] or row i-1 is the pass row (x[i-1, 513:] all zero; pass is always
the last candidate). Per-shard decision counts must equal the json stats.decisions or the run
aborts. Slots 0-5 train, slot 6 validates (disjoint seed blocks).

Validation metrics on slot 6 are descriptive only; the run exports only the final step, never a
selected checkpoint.

  python ai/danMCai/endgame/residual-learner.py --shards <dir> --champion <onnx> --out <dir>
      [--steps 6000] [--seed 1] [--batch-decisions 256] [--max-shards-per-slot N]
"""

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
from residual_export import fused_onnx, save_residual, zero_output_residual  # noqa: E402
from value_net import FEATURES, STATE, ValueNet, load_onnx_weights, sha256  # noqa: E402

KEEP_GAP = 0.25
MARGIN = 0.125
# Labels are means over <= 8 worlds of integers; a tiny tolerance keeps exact 0.25 gaps rejected.
GAP_TOLERANCE = 1e-6


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temporary.replace(path)


# ----------------------------------------------------------------------------- data


def decision_starts(x):
    """Row indices where a new decision starts (see module docstring)."""
    n = len(x)
    if n == 0:
        return np.zeros(0, np.int64)
    new = np.zeros(n, bool)
    new[0] = True
    if n > 1:
        state_changed = np.any(x[1:, :STATE] != x[:-1, :STATE], axis=1)
        previous_pass = ~np.any(x[:-1, STATE:] != 0, axis=1)
        new[1:] = state_changed | previous_pass
    return np.flatnonzero(new).astype(np.int64)


def keep_mask(y, starts):
    """Per-row keep flag and per-decision informative flag (non-empty reject set)."""
    lengths = np.diff(np.append(starts, len(y)))
    best = np.maximum.reduceat(y.astype(np.float64), starts)
    gap = np.repeat(best, lengths) - y.astype(np.float64)
    keep = gap < KEEP_GAP - GAP_TOLERANCE
    informative = np.add.reduceat((~keep).astype(np.int64), starts) > 0
    return keep, informative


def shard_slot(name):
    return int(name.split("-", 1)[0][1:])


def shard_names(directory, slots, max_per_slot=0):
    names = []
    for slot in slots:
        found = sorted(p.name[:-5] for p in Path(directory).glob(f"s{slot}-*.json"))
        names += found[:max_per_slot] if max_per_slot > 0 else found
    return names


class Dataset:
    """Concatenated rows of some shards, grouped into decisions."""

    def __init__(self, directory, names):
        directory = Path(directory)
        metas = []
        for name in names:
            meta = json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
            if meta.get("labels") != "pimc-mean":
                raise ValueError(f"{name}: unexpected label kind {meta.get('labels')}")
            if "slot" in meta and int(meta["slot"]) != shard_slot(name):
                raise ValueError(f"{name}: manifest slot {meta['slot']} does not match the file name")
            metas.append(meta)
        total = sum(int(m["rows"]) for m in metas)
        self.x = np.empty((total, FEATURES), np.int8)
        self.y = np.empty(total, np.float32)
        starts, at = [], 0
        self.shards = []
        for name, meta in zip(names, metas):
            y = np.fromfile(directory / f"{name}.y.f32", np.float32)
            x = np.fromfile(directory / f"{name}.x.i8", np.int8)
            if len(y) != int(meta["rows"]) or x.size != len(y) * FEATURES:
                raise ValueError(f"{name}: row count mismatch with its manifest")
            x = x.reshape(len(y), FEATURES)
            if not (np.isfinite(y).all() and (np.abs(y) <= 3).all()):
                raise ValueError(f"{name}: labels outside signed round points [-3, 3]")
            local = decision_starts(x)
            expected = int(meta["stats"]["decisions"])
            if len(local) != expected:
                raise ValueError(f"{name}: grouped {len(local)} decisions, manifest says {expected}")
            self.x[at : at + len(y)] = x
            self.y[at : at + len(y)] = y
            starts.append(local + at)
            seeds = meta.get("seeds")
            self.shards.append({"name": name, "rows": len(y), "decisions": expected, "seeds": seeds})
            at += len(y)
        self.starts = np.concatenate(starts) if starts else np.zeros(0, np.int64)
        self.lengths = np.diff(np.append(self.starts, total)).astype(np.int64)
        self.keep, self.informative = keep_mask(self.y, self.starts) if total else (
            np.zeros(0, bool),
            np.zeros(0, bool),
        )
        self.decision_of_row = np.repeat(np.arange(len(self.starts)), self.lengths)
        self.c = None

    @property
    def rows(self):
        return len(self.y)

    @property
    def decisions(self):
        return len(self.starts)

    def rows_of(self, decisions):
        """Row indices and per-row batch segment ids of the given decisions."""
        lengths = self.lengths[decisions]
        total = int(lengths.sum())
        segment = np.repeat(np.arange(len(decisions)), lengths)
        offsets = np.repeat(self.starts[decisions] - np.concatenate(([0], np.cumsum(lengths)[:-1])), lengths)
        return offsets + np.arange(total), segment


def forward_rows(net, x, device, chunk=65536):
    out = np.empty(len(x), np.float32)
    with torch.no_grad():
        for start in range(0, len(x), chunk):
            rows = torch.from_numpy(x[start : start + chunk].astype(np.float32)).to(device)
            out[start : start + len(rows)] = net(rows).cpu().numpy()
    return out


# ----------------------------------------------------------------------------- loss


def residual_loss(f, c, keep, segment, informative, decisions, margin=MARGIN, keep_weight=1.0):
    """Mean over decisions of the grouped keep/reject loss; returns (loss, parts) tensors.

    f, c: per-row residual and frozen champion values; keep: per-row bool; segment: per-row
    decision index in [0, decisions); informative: per-decision bool (reject set non-empty).
    """
    q = c + f
    keep_f = keep.to(f.dtype)
    reject_f = 1.0 - keep_f
    zeros = torch.zeros(decisions, device=f.device, dtype=f.dtype)
    keep_count = zeros.index_add(0, segment, keep_f)
    reject_count = zeros.index_add(0, segment, reject_f)
    keep_term = zeros.index_add(0, segment, keep_f * f * f) / keep_count.clamp_min(1.0)
    inf = torch.full((decisions,), float("inf"), device=f.device, dtype=f.dtype)
    kept_q = torch.where(keep, q, torch.full_like(q, float("inf")))
    floor = inf.scatter_reduce(0, segment, kept_q, reduce="amin", include_self=True)
    # Rows of silent decisions have reject weight 0; floor is finite whenever a decision exists.
    hinge = torch.relu(margin + q - floor[segment]) * reject_f
    reject_term = zeros.index_add(0, segment, hinge * hinge) / reject_count.clamp_min(1.0)
    reject_term = torch.where(informative, reject_term, torch.zeros_like(reject_term))
    per_decision = keep_weight * keep_term + reject_term
    active = ((hinge > 0) & (reject_f > 0)).sum()
    return per_decision.mean(), {
        "keep": keep_term.mean(),
        "reject": reject_term.sum() / informative.sum().clamp_min(1),
        "activeHinges": active,
        "rejectRows": reject_f.sum(),
    }


def cosine_lr(step, steps, start, end):
    if steps <= 1:
        return start
    return end + 0.5 * (start - end) * (1 + math.cos(math.pi * min(step, steps) / steps))


# ----------------------------------------------------------------------------- metrics


def decision_metrics(data, q):
    """Descriptive validation metrics of greedy choices argmax_i q_i (ties: first index, as in JS)."""
    c = data.c
    n = data.decisions
    pick_q = np.empty(n, np.int64)
    pick_c = np.empty(n, np.int64)
    for d in range(n):  # decisions are short (median ~6 rows); a loop is clear and fast enough
        s, e = data.starts[d], data.starts[d] + data.lengths[d]
        pick_q[d] = s + int(np.argmax(q[s:e]))
        pick_c[d] = s + int(np.argmax(c[s:e]))
    best = np.maximum.reduceat(data.y.astype(np.float64), data.starts)
    regret_q = best - data.y[pick_q]
    regret_c = best - data.y[pick_c]
    info = data.informative
    silent = ~info
    champion_ok = data.keep[pick_c]
    same = pick_q == pick_c

    def rate(mask, values):
        return float(values[mask].mean()) if mask.any() else None

    return {
        "decisions": int(n),
        "informative": int(info.sum()),
        "silent": int(silent.sum()),
        "informativeArgmaxInKeep": {"champion": rate(info, data.keep[pick_c]), "student": rate(info, data.keep[pick_q])},
        "sameAsChampionWhenChampionInKeep": rate(info & champion_ok, same),
        "sameAsChampionOnSilent": rate(silent, same),
        "differsFromChampion": float((~same).mean()) if n else None,
        "meanLabelRegret": {"champion": rate(np.ones(n, bool), regret_c), "student": rate(np.ones(n, bool), regret_q)},
        "meanLabelRegretInformative": {"champion": rate(info, regret_c), "student": rate(info, regret_q)},
        "note": "Descriptive only, slot-6 PIMC labels; never a gate or a checkpoint selector.",
    }


def validation_loss(data, f_values, device):
    segment = torch.from_numpy(data.decision_of_row).to(device)
    loss, parts = residual_loss(
        torch.from_numpy(f_values).to(device),
        torch.from_numpy(data.c).to(device),
        torch.from_numpy(data.keep).to(device),
        segment,
        torch.from_numpy(data.informative).to(device),
        data.decisions,
    )
    return {"loss": float(loss), "keep": float(parts["keep"]), "reject": float(parts["reject"])}


def evaluate(data, residual, device):
    f_values = forward_rows(residual, data.x, device)
    return {**decision_metrics(data, data.c + f_values), "objective": validation_loss(data, f_values, device)}


# ----------------------------------------------------------------------------- training


def pick_device(name):
    if name == "auto":
        return torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    device = torch.device(name)
    if device.type == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("Apple MPS requested but unavailable")
    return device


def seeds_overlap(a, b):
    """True when any [first, last] deal-seed range of shards a intersects one of shards b."""
    ranges = lambda shards: [s["seeds"] for s in shards if s.get("seeds")]
    return any(x[0] <= y[1] and y[0] <= x[1] for x in ranges(a) for y in ranges(b))


SOURCES = [
    Path(__file__).resolve(),
    ROOT / "training" / "continuous" / "residual_export.py",
    ROOT / "training" / "continuous" / "value_net.py",
]
OUTPUTS = ("summary.json", "residual.npz", "fused.onnx", "STOP")


def git_commit():
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def train(args):
    started = time.time()
    out = Path(args.out)
    # Never overwrite an earlier run's evidence; a stale STOP would also export a step-0 residual
    # over the stopped run's final step.
    existing = [name for name in OUTPUTS if (out / name).exists()]
    if existing:
        raise SystemExit(f"{out} already holds {', '.join(existing)}; use a new output directory")
    out.mkdir(parents=True, exist_ok=True)
    device = pick_device(args.device)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    rng = np.random.default_rng(args.seed)
    champion_sha = sha256(args.champion)
    if args.expect_champion_sha256 and champion_sha != args.expect_champion_sha256:
        raise SystemExit(f"Champion SHA-256 {champion_sha} != expected {args.expect_champion_sha256}")
    champion_weights = load_onnx_weights(args.champion)
    champion = ValueNet(champion_weights).to(device).eval()
    for p in champion.parameters():
        p.requires_grad_(False)
    residual = ValueNet(zero_output_residual(champion_weights)).to(device)

    train_slots = [int(s) for s in args.train_slots.split(",")]
    val_slots = [int(s) for s in args.val_slots.split(",")]
    if set(train_slots) & set(val_slots):
        raise SystemExit("Training and validation slots overlap")
    train_data = Dataset(args.shards, shard_names(args.shards, train_slots, args.max_shards_per_slot))
    val_data = Dataset(args.shards, shard_names(args.shards, val_slots, args.max_shards_per_slot))
    if not train_data.decisions or not val_data.decisions:
        raise SystemExit("No training or validation decisions")
    if seeds_overlap(train_data.shards, val_data.shards):
        raise SystemExit("Training and validation deal seeds overlap")
    loaded = time.time()
    for data in (train_data, val_data):
        data.c = forward_rows(champion, data.x, device)

    summary = {
        "schema": "danmcai-endgame-residual-v1",
        "purpose": "Offline endgame residual student (plan A); development, not acceptance.",
        "objective": "PIMC mean of exact signed round points; keep set y*-y<0.25, margin hinge on reject set",
        "commit": git_commit(),
        "sources": {path.name: sha256(path) for path in SOURCES},
        "champion": {"file": str(Path(args.champion).resolve()), "sha256": champion_sha},
        "config": {
            "steps": args.steps,
            "seed": args.seed,
            "batchDecisions": args.batch_decisions,
            "learningRate": [args.lr, args.lr_end],
            "schedule": "cosine",
            "gradClip": 1.0,
            "keepGap": KEEP_GAP,
            "margin": MARGIN,
            "keepWeight": args.keep_weight,
            "device": str(device),
            "trainSlots": train_slots,
            "validationSlots": val_slots,
            "maxShardsPerSlot": args.max_shards_per_slot,
        },
        "data": {
            "shardsDir": str(Path(args.shards).resolve()),
            "train": {
                "shards": len(train_data.shards),
                "rows": train_data.rows,
                "decisions": train_data.decisions,
                "informative": int(train_data.informative.sum()),
                "names": [s["name"] for s in train_data.shards],
            },
            "validation": {
                "shards": len(val_data.shards),
                "rows": val_data.rows,
                "decisions": val_data.decisions,
                "informative": int(val_data.informative.sum()),
                "names": [s["name"] for s in val_data.shards],
            },
            "decisionCountsMatchManifests": True,
            "dealSeedsDisjoint": True,
        },
        "validation": {"step0": evaluate(val_data, residual, device)},
        "losses": [],
    }
    write_json(out / "summary.json", {**summary, "state": "training"})

    optimizer = torch.optim.Adam(residual.parameters(), lr=args.lr)
    c_all = torch.from_numpy(train_data.c)
    keep_all = torch.from_numpy(train_data.keep)
    info_all = torch.from_numpy(train_data.informative)
    window = {"loss": 0.0, "keep": 0.0, "reject": 0.0, "active": 0, "rejectRows": 0, "n": 0}
    stop_reason = "steps"
    step = 0
    while step < args.steps:
        if (out / "STOP").exists():
            stop_reason = "STOP"
            break
        if args.deadline and time.time() >= args.deadline:
            stop_reason = "deadline"
            break
        lr = cosine_lr(step, args.steps, args.lr, args.lr_end)
        for group in optimizer.param_groups:
            group["lr"] = lr
        decisions = rng.integers(0, train_data.decisions, args.batch_decisions)
        rows, segment = train_data.rows_of(decisions)
        x = torch.from_numpy(train_data.x[rows].astype(np.float32)).to(device)
        f = residual(x)
        loss, parts = residual_loss(
            f,
            c_all[rows].to(device),
            keep_all[rows].to(device),
            torch.from_numpy(segment).to(device),
            info_all[decisions].to(device),
            len(decisions),
            keep_weight=args.keep_weight,
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(residual.parameters(), 1.0)
        optimizer.step()
        step += 1
        window["loss"] += float(loss.detach())
        window["keep"] += float(parts["keep"].detach())
        window["reject"] += float(parts["reject"].detach())
        window["active"] += int(parts["activeHinges"])
        window["rejectRows"] += int(parts["rejectRows"])
        window["n"] += 1
        if step % args.log_every == 0 or step == args.steps:
            n = window["n"]
            entry = {
                "step": step,
                "lr": lr,
                "loss": window["loss"] / n,
                "keep": window["keep"] / n,
                "reject": window["reject"] / n,
                "activeHingeShare": window["active"] / max(window["rejectRows"], 1),
                "elapsedSeconds": round(time.time() - started, 1),
            }
            summary["losses"].append(entry)
            print(json.dumps(entry), flush=True)
            window = {k: 0 for k in window}
            if args.val_every and step % args.val_every == 0 and step < args.steps:
                summary["validation"][f"step{step}"] = evaluate(val_data, residual, device)
            write_json(out / "summary.json", {**summary, "state": "training", "step": step})

    residual.eval()
    final = residual.weights()
    residual_sha = save_residual(final, out / "residual.npz", champion_sha256=champion_sha)
    fused_sha = fused_onnx(champion_weights, final, out / "fused.onnx")
    summary["validation"]["final"] = evaluate(val_data, residual, device)
    summary.update(
        {
            "state": "finished",
            "step": step,
            "stopReason": stop_reason,
            "export": {
                "selection": "final step only (no checkpoint selection)",
                "residual": {"file": "residual.npz", "sha256": residual_sha},
                "fused": {"file": "fused.onnx", "sha256": fused_sha, "contract": "state[1,513], actions[batch,54] -> values[batch,1]"},
            },
            "timing": {
                "loadSeconds": round(loaded - started, 1),
                "totalSeconds": round(time.time() - started, 1),
            },
        }
    )
    write_json(out / "summary.json", summary)
    return summary


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shards", required=True)
    parser.add_argument("--champion", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--expect-champion-sha256")
    parser.add_argument("--steps", type=int, default=6000)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--batch-decisions", type=int, default=256)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--lr-end", type=float, default=5e-6)
    parser.add_argument("--train-slots", default="0,1,2,3,4,5")
    parser.add_argument("--val-slots", default="6")
    parser.add_argument("--max-shards-per-slot", type=int, default=0, help="0 = all (smoke runs use a few)")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--log-every", type=int, default=100)
    parser.add_argument("--val-every", type=int, default=0, help="descriptive curve only; 0 = start and end")
    parser.add_argument("--deadline", type=float, default=0, help="Unix time; stop and export the final step")
    parser.add_argument("--keep-weight", type=float, default=1.0, help="weight of the stay-at-champion term (1 = original spec)")
    return parser.parse_args(argv)


if __name__ == "__main__":
    result = train(parse())
    print(json.dumps({"final": result["validation"]["final"], "export": result["export"]}, indent=2))
