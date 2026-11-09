"""Distill the belief-world midgame search into a residual on the frozen champion (development code).

Model (as ai/danMCai/endgame/residual-learner.py): q(s, a) = c(s, a) + f(s, a). c is the frozen
champion 017 and is never trained; f is a second 567->512x5->1 tanh MLP whose hidden layers are
copied from the champion and whose OUTPUT layer is zero, so q == champion exactly at step 0.

Data: blocks b<start>.{x.i8,y.f32,c.f32,w.i8,f.u8,json} written by
ai/danMCai/belief/distill-generate.mjs (read-only). Rows are the candidates the search evaluated at a
searched decision (champion top-k plus pass). y = mean rollout signed round points over the belief
worlds, c = champion Q, w = worlds where the candidate beat minus lost to the champion move,
f bit0 = champion move, bit1 = move the search chose. The target is the search's CHOICE (bit1),
which is a function of signed-round-point rollout values only (net-d rule below); no tempo, trick,
bomb or partner proxy enters the loss. y and w are used only to re-verify that rule and for
descriptive metrics.

Search rule at play time (midgame-search.mjs netChoice, re-checked on every loaded decision): keep
the champion move h unless some candidate r has w_r >= net and y_r > y_h; among the allowed
candidates (always including h) take the highest y, ties within 1e-9 broken by the champion's Q.

Loss. Per decision d with rows i (n_d of them), q_i = c_i + f_i, search choice s, champion move h,
O_d = max_{j != s} q_j:
  deviation decision (s != h):  L_d = K * mean_i f_i^2 + A * max(0, m  + O_d - q_s)^2
  agreement decision (s == h):  L_d = K * mean_i f_i^2 + B * max(0, m0 + O_d - q_s)^2
Batch loss = mean of L_d over the sampled decisions (uniform over decisions, with replacement).
Defaults K = keepWeight 10 (the value preregistered for plan A), m = 0.125, A = deviationWeight 1,
m0 = championMargin 0.01, B = championWeight 1. At step 0 f = 0, so the agreement hinge is active
only where the champion's own lead over the next searched move is below m0; the deviation hinge
pushes the search's choice above every other searched move by m. With f only moving where a hinge
is active, f stays near zero (the champion's ordering) everywhere else.
Trade-off (one deviation decision in isolation, the champion move h being the strongest other move,
f_s = +t and f_h = -t): the optimum is t = A (G + m) / (K / n_d + 2A) with champion gap
G = c_h - c_s, so argmax q flips to s only when G < 2 A m n_d / K; with the defaults and
n_d ~ 4.3 that is G < ~0.11 (median deviation gap in window-1 data ~0.20). Generalisation across
decisions changes this, but raising --deviation-weight A (or lowering K) reproduces larger gaps.

Grouping: residual-learner decision_starts (a new decision when x[:, :513] changes or the previous
row is a pass row); per block the count must equal json stats.decisions, every decision must have
>= 2 rows and exactly one champion and one chosen row, and the chosen row must equal the net-d rule
recomputed from (y, w, c). Any violation aborts the run.

Split by block: a block is validation when (seeds[0] // blockSeeds) % valModulo == valRemainder
(default every 10th block); block seed ranges must be pairwise disjoint across all data dirs.
Only blocks whose .json exists are read (the generator renames the manifest into place last), so a
directory that another job is still filling can be read safely; the block list is fixed at start.

Validation metrics are descriptive only; the run exports only the final step (no selection).

  python ai/danMCai/belief/distill-learner.py --data <dir> [--data <dir2>] --champion <onnx>
      --out <new dir> [--steps 6000] [--seed 1] [--batch-decisions 256] [--max-blocks N]
      [--deadline <unix>] [--stop-file <path>]
"""

import argparse
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "training" / "continuous"))
from residual_export import fused_onnx, save_residual, zero_output_residual  # noqa: E402
from value_net import FEATURES, STATE, ValueNet, load_onnx_weights, sha256  # noqa: E402

_spec = importlib.util.spec_from_file_location("residual_learner", ROOT / "endgame" / "residual-learner.py")
residual_learner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(residual_learner)
decision_starts = residual_learner.decision_starts
forward_rows = residual_learner.forward_rows
cosine_lr = residual_learner.cosine_lr
pick_device = residual_learner.pick_device
write_json = residual_learner.write_json
git_commit = residual_learner.git_commit

LABELS = "belief-search-rollout-mean"
PROTOCOL_VERSION = "belief-search-distill-v1"
FLAG_CHAMPION = 1
FLAG_CHOSEN = 2
TIE = 1e-9
FILES = {"x": ("x.i8", np.int8), "y": ("y.f32", np.float32), "c": ("c.f32", np.float32),
         "w": ("w.i8", np.int8), "f": ("f.u8", np.uint8)}
NEG = -1e9  # finite "minus infinity" for masked maxima (keeps gradients free of inf * 0)


# ----------------------------------------------------------------------------- search rule


def first_per_decision(mask, decision_of_row, decisions):
    """Row index of the first True row of every decision (every decision must have one)."""
    rows = np.flatnonzero(mask)
    ids, first = np.unique(decision_of_row[rows], return_index=True)
    if len(ids) != decisions:
        raise ValueError("A decision has no row satisfying the mask")
    return rows[first]


def search_choice(y, w, c, champion, starts, net):
    """Rows chosen by the net-d rule (midgame-search.mjs netChoice) per decision.

    champion: per-decision champion row. Returns per-decision chosen row indices.
    """
    n = len(y)
    lengths = np.diff(np.append(starts, n))
    decision_of_row = np.repeat(np.arange(len(starts)), lengths)
    y = y.astype(np.float64)
    is_champion = np.zeros(n, bool)
    is_champion[champion] = True
    y_champion = np.repeat(y[champion], lengths)
    if net > 0:
        allowed = is_champion | ((w.astype(np.int64) >= net) & (y > y_champion + TIE))
    else:
        allowed = np.ones(n, bool)
    top = np.maximum.reduceat(np.where(allowed, y, -np.inf), starts)
    tied = allowed & (y >= np.repeat(top, lengths) - TIE)
    best_c = np.maximum.reduceat(np.where(tied, c.astype(np.float64), -np.inf), starts)
    pick = tied & (c.astype(np.float64) == np.repeat(best_c, lengths))
    return first_per_decision(pick, decision_of_row, len(starts))


# ----------------------------------------------------------------------------- data


def list_blocks(directories, max_blocks=0):
    """[(directory, name, start)] of blocks whose manifest exists, sorted by first seed."""
    blocks = []
    for directory in directories:
        for path in Path(directory).glob("b*.json"):
            stem = path.name[:-5]
            if stem[1:].isdigit():
                blocks.append((Path(directory), stem, int(stem[1:])))
    blocks.sort(key=lambda b: (b[2], str(b[0])))
    return blocks[:max_blocks] if max_blocks > 0 else blocks


def split_blocks(metas, modulo, remainder):
    """Indices of training and validation blocks; seed ranges must be pairwise disjoint."""
    ranges = sorted((int(m["seeds"][0]), int(m["seeds"][1]), i) for i, m in enumerate(metas))
    for (a0, a1, _), (b0, b1, _) in zip(ranges, ranges[1:]):
        if b0 <= a1:
            raise ValueError(f"Block seed ranges overlap: [{a0}, {a1}] and [{b0}, {b1}]")
    train, val = [], []
    for i, m in enumerate(metas):
        first, last = int(m["seeds"][0]), int(m["seeds"][1])
        span = last - first + 1
        (val if (first // span) % modulo == remainder else train).append(i)
    return train, val


def read_block(directory, name):
    """Arrays and manifest of one block plus a digest of its six files (read once)."""
    digest = hashlib.sha256()
    raw = (directory / f"{name}.json").read_bytes()
    digest.update(hashlib.sha256(raw).digest())
    meta = json.loads(raw)
    arrays = {}
    for key, (suffix, dtype) in FILES.items():
        data = (directory / f"{name}.{suffix}").read_bytes()
        digest.update(hashlib.sha256(data).digest())
        arrays[key] = np.frombuffer(data, dtype)
    return meta, arrays, digest.hexdigest()


def check_meta(name, meta, champion_sha):
    if meta.get("labels") != LABELS or meta.get("protocolVersion") != PROTOCOL_VERSION:
        raise ValueError(f"{name}: unexpected label kind {meta.get('labels')} / {meta.get('protocolVersion')}")
    if int(meta.get("features", 0)) != FEATURES:
        raise ValueError(f"{name}: features {meta.get('features')} != {FEATURES}")
    if champion_sha and meta.get("championSHA256") != champion_sha:
        raise ValueError(f"{name}: generated with champion {meta.get('championSHA256')}, not {champion_sha}")


class Dataset:
    """Rows of some blocks, grouped into decisions, with the search choice re-verified."""

    def __init__(self, blocks, champion_sha=None):
        loaded = []
        for directory, name in blocks:
            meta, arrays, digest = read_block(directory, name)
            check_meta(name, meta, champion_sha)
            loaded.append((directory, name, meta, digest))
        total = sum(int(m["rows"]) for _, _, m, _ in loaded)
        self.x = np.empty((total, FEATURES), np.int8)
        self.y = np.empty(total, np.float32)
        self.c = np.empty(total, np.float32)
        self.w = np.empty(total, np.int8)
        self.f = np.empty(total, np.uint8)
        starts, at, self.blocks = [], 0, []
        for directory, name, meta, digest in loaded:
            _, arrays, again = read_block(directory, name)
            if again != digest:
                raise ValueError(f"{name}: changed while loading")
            rows = int(meta["rows"])
            if arrays["x"].size != rows * FEATURES or any(len(arrays[k]) != rows for k in "ycwf"):
                raise ValueError(f"{name}: row count mismatch with its manifest")
            x = arrays["x"].reshape(rows, FEATURES)
            y, c, w, f = arrays["y"], arrays["c"], arrays["w"], arrays["f"]
            worlds = int(meta.get("settings", {}).get("worlds", 127))
            if not (np.isfinite(y).all() and (np.abs(y) <= 3).all()):
                raise ValueError(f"{name}: search values outside signed round points [-3, 3]")
            if not np.isfinite(c).all() or (np.abs(w.astype(np.int64)) > worlds).any() or (f > 3).any():
                raise ValueError(f"{name}: invalid champion Q, win/loss or flag column")
            local = decision_starts(x)
            expected = int(meta["stats"]["decisions"])
            if len(local) != expected:
                raise ValueError(f"{name}: grouped {len(local)} decisions, manifest says {expected}")
            lengths = np.diff(np.append(local, rows))
            if len(local) and lengths.min() < 2:
                raise ValueError(f"{name}: a searched decision has fewer than two candidates")
            for bit, label in ((FLAG_CHAMPION, "champion"), (FLAG_CHOSEN, "chosen")):
                counts = np.add.reduceat((f & bit).astype(np.int64) // bit, local) if len(local) else []
                if len(local) and not (np.asarray(counts) == 1).all():
                    raise ValueError(f"{name}: a decision does not have exactly one {label} row")
            if len(local):
                decision_of_row = np.repeat(np.arange(len(local)), lengths)
                champion = first_per_decision((f & FLAG_CHAMPION) > 0, decision_of_row, len(local))
                chosen = first_per_decision((f & FLAG_CHOSEN) > 0, decision_of_row, len(local))
                # The champion flag must be the first argmax of the stored champion Q (JS argmax), so
                # bit0, c and (via champion_check) x are row-aligned.
                top_c = np.repeat(np.maximum.reduceat(c, local), lengths)
                if not np.array_equal(first_per_decision(c == top_c, decision_of_row, len(local)), champion):
                    raise ValueError(f"{name}: champion flag is not the argmax of the stored champion Q")
                net = int(meta.get("settings", {}).get("net", 2))
                rule = search_choice(y, w, c, champion, local, net)
                if not np.array_equal(rule, chosen):
                    bad = int((rule != chosen).sum())
                    raise ValueError(f"{name}: {bad} chosen rows differ from the net-{net} search rule")
            sl = slice(at, at + rows)
            self.x[sl], self.y[sl], self.c[sl], self.w[sl], self.f[sl] = x, y, c, w, f
            starts.append(local + at)
            self.blocks.append({
                "dir": str(directory), "name": name, "seeds": meta.get("seeds"), "rows": rows,
                "decisions": expected, "sha256": digest, "beliefSHA256": meta.get("beliefSHA256"),
            })
            at += rows
        self.starts = np.concatenate(starts).astype(np.int64) if starts else np.zeros(0, np.int64)
        self.lengths = np.diff(np.append(self.starts, total)).astype(np.int64)
        self.decision_of_row = np.repeat(np.arange(len(self.starts)), self.lengths)
        n = len(self.starts)
        if n:
            self.champion = first_per_decision((self.f & FLAG_CHAMPION) > 0, self.decision_of_row, n)
            self.chosen = first_per_decision((self.f & FLAG_CHOSEN) > 0, self.decision_of_row, n)
        else:
            self.champion = self.chosen = np.zeros(0, np.int64)
        self.deviation = self.chosen != self.champion
        self.chosen_row = (self.f & FLAG_CHOSEN) > 0

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

    def describe(self):
        return {
            "blocks": len(self.blocks), "rows": self.rows, "decisions": self.decisions,
            "searchDeviations": int(self.deviation.sum()),
            "names": [b["name"] for b in self.blocks],
            "seedRanges": [b["seeds"] for b in self.blocks],
            "blockSHA256": {b["name"]: b["sha256"] for b in self.blocks},
            "beliefSHA256": sorted({str(b["beliefSHA256"]) for b in self.blocks}),
        }


# ----------------------------------------------------------------------------- loss


def distill_loss(f, c, chosen, segment, deviation, decisions, keep_weight=10.0, margin=0.125,
                 champion_margin=0.01, deviation_weight=1.0, champion_weight=1.0):
    """Mean over decisions of L_d (module docstring); returns (loss, parts).

    f, c: per-row residual and frozen champion Q; chosen: per-row bool (search choice, one per
    decision); segment: per-row decision id in [0, decisions); deviation: per-decision bool.
    """
    q = c + f
    zeros = torch.zeros(decisions, device=f.device, dtype=f.dtype)
    count = zeros.index_add(0, segment, torch.ones_like(f))
    keep = zeros.index_add(0, segment, f * f) / count.clamp_min(1.0)
    q_chosen = zeros.index_add(0, segment, torch.where(chosen, q, torch.zeros_like(q)))
    others = torch.where(chosen, torch.full_like(q, NEG), q)
    other_max = torch.full((decisions,), NEG, device=f.device, dtype=f.dtype).scatter_reduce(
        0, segment, others, reduce="amax", include_self=True
    )
    m = torch.where(deviation, torch.full_like(zeros, margin), torch.full_like(zeros, champion_margin))
    weight = torch.where(deviation, torch.full_like(zeros, deviation_weight), torch.full_like(zeros, champion_weight))
    hinge = torch.relu(m + other_max - q_chosen)
    per_decision = keep_weight * keep + weight * hinge * hinge
    dev = deviation.to(f.dtype)
    agree = 1.0 - dev
    return per_decision.mean(), {
        "keep": keep.mean(),
        "deviationHinge": (hinge * hinge * dev).sum() / dev.sum().clamp_min(1.0),
        "championHinge": (hinge * hinge * agree).sum() / agree.sum().clamp_min(1.0),
        "deviationActive": ((hinge > 0) & deviation).sum(),
        "championActive": ((hinge > 0) & ~deviation).sum(),
        "deviations": deviation.sum(),
    }


# ----------------------------------------------------------------------------- metrics


def greedy_rows(q, data):
    """Per-decision row of argmax q (first index on ties, as the JS argmax)."""
    top = np.maximum.reduceat(q, data.starts)
    return first_per_decision(q == np.repeat(top, data.lengths), data.decision_of_row, data.decisions)


def decision_metrics(data, q):
    pick = greedy_rows(q, data)
    dev = data.deviation
    agree = ~dev
    student_dev = pick != data.champion
    y = data.y.astype(np.float64)
    gain = y[pick] - y[data.champion]
    search_gain = y[data.chosen] - y[data.champion]

    def rate(mask, values):
        return float(values[mask].mean()) if mask.any() else None

    n = data.decisions
    return {
        "decisions": int(n),
        "searchDeviations": int(dev.sum()),
        "matchesSearchOnDeviation": rate(dev, pick == data.chosen),
        "matchesSearchOnAgreement": rate(agree, pick == data.chosen),
        "matchesSearchOverall": rate(np.ones(n, bool), pick == data.chosen),
        "agreesWithChampion": rate(np.ones(n, bool), ~student_dev),
        "studentDeviates": rate(np.ones(n, bool), student_dev),
        "studentDeviationsMatchingSearch": rate(student_dev, pick == data.chosen),
        "meanInSearchGain": {"student": rate(np.ones(n, bool), gain), "search": rate(np.ones(n, bool), search_gain)},
        "note": "Descriptive only, validation blocks; in-search gain = rollout mean of the picked move minus the "
                "champion move's (the search's own estimate). Never a gate or a checkpoint selector.",
    }


def validation_loss(data, f_values, device, loss_args):
    loss, parts = distill_loss(
        torch.from_numpy(f_values).to(device),
        torch.from_numpy(data.c).to(device),
        torch.from_numpy(data.chosen_row).to(device),
        torch.from_numpy(data.decision_of_row).to(device),
        torch.from_numpy(data.deviation).to(device),
        data.decisions,
        **loss_args,
    )
    return {
        "loss": float(loss), "keep": float(parts["keep"]), "deviationHinge": float(parts["deviationHinge"]),
        "championHinge": float(parts["championHinge"]),
        "deviationActive": int(parts["deviationActive"]), "championActive": int(parts["championActive"]),
    }


def evaluate(data, residual, device, loss_args):
    f_values = forward_rows(residual, data.x, device)
    return {
        **decision_metrics(data, data.c + f_values),
        "meanAbsResidual": float(np.abs(f_values).mean()),
        "objective": validation_loss(data, f_values, device, loss_args),
    }


def champion_check(data, champion, device, rng, rows=4096):
    """Max |torch champion - stored c| on a random row sample (proves the champion file matches)."""
    if not data.rows:
        return 0.0
    sample = np.sort(rng.choice(data.rows, min(rows, data.rows), replace=False))
    return float(np.abs(forward_rows(champion, data.x[sample], device) - data.c[sample]).max())


def fused_check(path, data, residual, device, decisions=64):
    """Max |fused ONNX - (stored c + f)| over the first validation decisions (champion I/O contract)."""
    import onnxruntime as ort

    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    worst = 0.0
    for d in range(min(decisions, data.decisions)):
        s, e = data.starts[d], data.starts[d] + data.lengths[d]
        x = data.x[s:e].astype(np.float32)
        out = session.run(["values"], {"state": x[:1, :STATE], "actions": x[:, STATE:]})[0][:, 0]
        f = forward_rows(residual, data.x[s:e], device)
        worst = max(worst, float(np.abs(out - (data.c[s:e] + f)).max()))
    return worst


# ----------------------------------------------------------------------------- training


SOURCES = [
    Path(__file__).resolve(),
    ROOT / "endgame" / "residual-learner.py",
    ROOT / "training" / "continuous" / "residual_export.py",
    ROOT / "training" / "continuous" / "value_net.py",
]


def train(args):
    started = time.time()
    out = Path(args.out)
    if out.exists() and (not out.is_dir() or any(out.iterdir())):
        raise SystemExit(f"{out} is not an empty directory; use a new output directory")
    if args.steps < 0 or args.batch_decisions < 1 or args.val_modulo < 2 or not 0 <= args.val_remainder < args.val_modulo:
        raise SystemExit("Invalid --steps, --batch-decisions or validation split")
    champion_sha = sha256(args.champion)
    if args.expect_champion_sha256 and champion_sha != args.expect_champion_sha256:
        raise SystemExit(f"Champion SHA-256 {champion_sha} != expected {args.expect_champion_sha256}")
    blocks = list_blocks(args.data, args.max_blocks)
    if not blocks:
        raise SystemExit("No completed blocks in the data directories")
    metas = [json.loads((d / f"{n}.json").read_text(encoding="utf-8")) for d, n, _ in blocks]
    try:
        train_idx, val_idx = split_blocks(metas, args.val_modulo, args.val_remainder)
    except ValueError as error:
        raise SystemExit(str(error))
    if not train_idx or not val_idx:
        raise SystemExit("No training or validation blocks under this split")
    stop_files = [out / "STOP"] + ([Path(args.stop_file)] if args.stop_file else [])
    # A stale STOP or a passed deadline would otherwise "finish" with a step-0 residual (= the
    # champion) under a trained-run summary; refuse before writing anything.
    if any(p.exists() for p in stop_files):
        raise SystemExit(f"A STOP file already exists ({', '.join(str(p) for p in stop_files if p.exists())}); not starting")
    if args.deadline and time.time() >= args.deadline:
        raise SystemExit("--deadline has already passed; not starting")
    out.mkdir(parents=True, exist_ok=True)
    device = pick_device(args.device)
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    rng = np.random.default_rng(args.seed)

    train_data = Dataset([blocks[i][:2] for i in train_idx], champion_sha)
    val_data = Dataset([blocks[i][:2] for i in val_idx], champion_sha)
    if not train_data.decisions or not val_data.decisions:
        raise SystemExit("No training or validation decisions")
    champion_weights = load_onnx_weights(args.champion)
    champion = ValueNet(champion_weights).to(device).eval()
    for p in champion.parameters():
        p.requires_grad_(False)
    check = max(champion_check(train_data, champion, device, rng), champion_check(val_data, champion, device, rng))
    if check > 1e-3:
        raise SystemExit(f"Stored champion Q differs from {args.champion} by {check}")
    residual = ValueNet(zero_output_residual(champion_weights)).to(device)
    loaded = time.time()
    loss_args = {
        "keep_weight": args.keep_weight, "margin": args.margin, "champion_margin": args.champion_margin,
        "deviation_weight": args.deviation_weight, "champion_weight": args.champion_weight,
    }

    run_files = {}
    for directory in args.data:
        run = Path(directory) / "run.json"
        if run.exists():
            frozen = json.loads(run.read_text(encoding="utf-8"))
            run_files[str(Path(directory).resolve())] = {
                "runSHA256": sha256(run),
                **{k: frozen.get(k) for k in ("seeds", "lo", "hi", "worlds", "k", "net", "worldsSource",
                                               "beliefSHA256", "championSHA256")},
            }
    summary = {
        "schema": "danmcai-distill-residual-v1",
        "purpose": "Distil the belief-world midgame net-d search into a champion residual; development, not acceptance.",
        "objective": (
            "q = champion + f; per decision K*mean f^2 + A*relu(m + max_{j!=s} q_j - q_s)^2 when the search "
            "deviated (s != champion), else B*relu(m0 + max_{j!=s} q_j - q_s)^2; s = search choice (net-d rule "
            "over rollout means of signed round points); mean over decisions"
        ),
        "commit": git_commit(),
        "sources": {path.name: sha256(path) for path in SOURCES},
        "champion": {"file": str(Path(args.champion).resolve()), "sha256": champion_sha,
                     "maxAbsDiffToStoredQ": check},
        "config": {
            "steps": args.steps, "seed": args.seed, "batchDecisions": args.batch_decisions,
            "learningRate": [args.lr, args.lr_end], "schedule": "cosine", "optimizer": "Adam", "gradClip": 1.0,
            "keepWeight": args.keep_weight, "margin": args.margin, "championMargin": args.champion_margin,
            "deviationWeight": args.deviation_weight, "championWeight": args.champion_weight,
            "device": str(device), "valModulo": args.val_modulo, "valRemainder": args.val_remainder,
            "maxBlocks": args.max_blocks, "deadline": args.deadline or None,
            "stopFiles": [str(p) for p in stop_files],
        },
        "data": {
            "dirs": run_files,
            "train": train_data.describe(),
            "validation": val_data.describe(),
            "split": "validation iff (seeds[0] // blockSeeds) % valModulo == valRemainder; seed ranges disjoint",
            "checks": "decisions == manifest; >=2 rows, one champion and one chosen row per decision; chosen == net-d rule",
        },
        "validation": {"step0": evaluate(val_data, residual, device, loss_args)},
        "losses": [],
    }
    write_json(out / "summary.json", {**summary, "state": "training"})

    optimizer = torch.optim.Adam(residual.parameters(), lr=args.lr)
    c_all = torch.from_numpy(train_data.c)
    chosen_all = torch.from_numpy(train_data.chosen_row)
    dev_all = torch.from_numpy(train_data.deviation)
    keys = ("loss", "keep", "deviationHinge", "championHinge")
    window = {k: 0.0 for k in keys} | {"devActive": 0, "devs": 0, "champActive": 0, "n": 0}
    stop_reason = "steps"
    step = 0
    train_started = time.time()
    while step < args.steps:
        if any(p.exists() for p in stop_files):
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
        loss, parts = distill_loss(
            residual(x), c_all[rows].to(device), chosen_all[rows].to(device),
            torch.from_numpy(segment).to(device), dev_all[decisions].to(device), len(decisions), **loss_args,
        )
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(residual.parameters(), 1.0)
        optimizer.step()
        step += 1
        window["loss"] += float(loss.detach())
        for k in keys[1:]:
            window[k] += float(parts[k].detach())
        window["devActive"] += int(parts["deviationActive"])
        window["devs"] += int(parts["deviations"])
        window["champActive"] += int(parts["championActive"])
        window["n"] += 1
        if step % args.log_every == 0 or step == args.steps:
            n = window["n"]
            entry = {"step": step, "lr": lr, **{k: window[k] / n for k in keys},
                     "deviationActiveShare": window["devActive"] / max(window["devs"], 1),
                     "championActiveShare": window["champActive"] / max(n * args.batch_decisions - window["devs"], 1),
                     "stepsPerSecond": round(step / max(time.time() - train_started, 1e-9), 2),
                     "elapsedSeconds": round(time.time() - started, 1)}
            summary["losses"].append(entry)
            print(json.dumps(entry), flush=True)
            window = {k: 0.0 for k in keys} | {"devActive": 0, "devs": 0, "champActive": 0, "n": 0}
            if args.val_every and step % args.val_every == 0 and step < args.steps:
                summary["validation"][f"step{step}"] = evaluate(val_data, residual, device, loss_args)
            write_json(out / "summary.json", {**summary, "state": "training", "step": step})
    trained = time.time()

    residual.eval()
    final = residual.weights()
    residual_sha = save_residual(final, out / "residual.npz", champion_sha256=champion_sha)
    fused_sha = fused_onnx(champion_weights, final, out / "fused.onnx")
    fused_diff = fused_check(out / "fused.onnx", val_data, residual, device)
    if fused_diff > 1e-3:
        raise SystemExit(f"Fused export differs from champion + residual by {fused_diff}")
    summary["validation"]["final"] = evaluate(val_data, residual, device, loss_args)
    if args.train_metrics:
        # Fit on the training blocks themselves (separates underfitting from unpredictable labels).
        summary["trainingFit"] = {"final": evaluate(train_data, residual, device, loss_args)}
    summary.update({
        "state": "finished",
        "step": step,
        "stopReason": stop_reason,
        "export": {
            "selection": "final step only (no checkpoint selection)",
            "residual": {"file": "residual.npz", "sha256": residual_sha},
            "fused": {"file": "fused.onnx", "sha256": fused_sha,
                      "contract": "state[1,513], actions[batch,54] -> values[batch,1]",
                      "maxAbsDiffToChampionPlusResidual": fused_diff},
        },
        "timing": {
            "loadSeconds": round(loaded - started, 1),
            "trainSeconds": round(trained - loaded, 1),
            "stepsPerSecond": round(step / max(trained - train_started, 1e-9), 2),
            "totalSeconds": round(time.time() - started, 1),
        },
    })
    write_json(out / "summary.json", summary)
    return summary


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", action="append", required=True, help="distill-generate.mjs output dir (repeatable)")
    parser.add_argument("--champion", required=True)
    parser.add_argument("--out", required=True, help="new or empty directory")
    parser.add_argument("--expect-champion-sha256")
    parser.add_argument("--steps", type=int, default=6000)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--batch-decisions", type=int, default=256)
    parser.add_argument("--lr", type=float, default=5e-5)
    parser.add_argument("--lr-end", type=float, default=5e-6)
    parser.add_argument("--keep-weight", type=float, default=10.0)
    parser.add_argument("--margin", type=float, default=0.125, help="deviation margin m")
    parser.add_argument("--champion-margin", type=float, default=0.01, help="agreement margin m0")
    parser.add_argument("--deviation-weight", type=float, default=1.0)
    parser.add_argument("--champion-weight", type=float, default=1.0)
    parser.add_argument("--val-modulo", type=int, default=10)
    parser.add_argument("--val-remainder", type=int, default=0)
    parser.add_argument("--max-blocks", type=int, default=0, help="0 = all; else the first N blocks by seed")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--log-every", type=int, default=100)
    parser.add_argument("--val-every", type=int, default=0, help="descriptive curve only; 0 = start and end")
    parser.add_argument("--deadline", type=float, default=0, help="Unix time; stop and export the final step")
    parser.add_argument("--stop-file", help="extra STOP path besides <out>/STOP")
    parser.add_argument("--train-metrics", type=int, default=1, help="1 = also report final metrics on the training blocks")
    return parser.parse_args(argv)


if __name__ == "__main__":
    result = train(parse())
    print(json.dumps({"final": result["validation"]["final"], "export": result["export"],
                      "timing": result["timing"]}, indent=2))
