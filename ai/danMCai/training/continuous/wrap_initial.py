"""Wrap a P0-architecture champion ONNX with a zero extras projection (values unchanged).

    python ai/danMCai/training/continuous/wrap_initial.py --champion=<017.onnx> --out=<v000000000.onnx>
        [--width=53|215|1295] [--expect-sha=<champion sha256>]
        [--check-rows=<shard.json>[,<shard.json>...] [--check-n=1000] [--check-seed=20261113]
         [--check-out=<parity.json>] [--tolerance=1e-6]]

Prints a JSON line with the source and output SHA-256. The zero projection makes the wrapped
model's values equal the champion's for any extras input; the learner then trains the projection.
Width 1295 = 215 public-belief extras + 1,080 history inputs (extrasMode public-belief-history).

--check-rows scores --check-n rows of trainer shards (x.i8 + e.f32; drawn with --check-seed) with
the champion and with the wrapped model, in torch (ValueNet vs ValueNetExtras loaded from the
written file) and in onnxruntime (CPU, one row per call: the graph's state input is [1, 513]).
At width 1295 the history columns come from the shard's .h.i8 when it is schema 2, else they are
uniform random int8 in [-1, 2] (stated as historySource). Exit status 1 if max |diff| > tolerance.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from value_net import (  # noqa: E402
    BELIEF_EXTRAS, EXTRA_WIDTHS, FEATURES, HISTORY_FEATURES, STATE, export_onnx_extras,
    load_onnx_weights, sha256,
)


def read_rows(manifests, width):
    """x (int8 [n, 567]) and the float32 extras of `width` columns (history as float32)."""
    xs, es, sources = [], [], set()
    stored = BELIEF_EXTRAS if width == BELIEF_EXTRAS + HISTORY_FEATURES else width
    for manifest in manifests:
        manifest = Path(manifest)
        meta = json.loads(manifest.read_text())
        rows, stem = int(meta["rows"]), str(manifest.with_suffix(""))
        if meta.get("extraFeatures") != stored:
            raise ValueError(f"{manifest}: extraFeatures {meta.get('extraFeatures')} != {stored}")
        x = np.fromfile(f"{stem}.x.i8", np.int8).reshape(rows, FEATURES)
        e = np.fromfile(f"{stem}.e.f32", np.float32).reshape(rows, stored)
        if width != stored:
            if meta.get("schema") == 2 and meta.get("historyFeatures") == HISTORY_FEATURES:
                h = np.fromfile(f"{stem}.h.i8", np.int8).reshape(rows, HISTORY_FEATURES)
                sources.add("shard")
            else:
                h = None
                sources.add("random")
            e = (e, h)
        xs.append(x)
        es.append(e)
    return xs, es, sources


def check(champion, wrapped, width, manifests, n, seed):
    import onnxruntime as ort
    import torch
    from value_net import ValueNet, ValueNetExtras
    import onnx
    from onnx import numpy_helper

    rng = np.random.default_rng(seed)
    xs, es, sources = read_rows(manifests, width)
    x = np.concatenate(xs)
    if width == BELIEF_EXTRAS + HISTORY_FEATURES:
        parts = []
        for x_part, (e, h) in zip(xs, es):
            if h is None:
                h = rng.integers(-1, 3, (len(x_part), HISTORY_FEATURES)).astype(np.int8)
            parts.append(np.concatenate((e, h.astype(np.float32)), axis=1))
        extras = np.concatenate(parts)
    else:
        extras = np.concatenate(es)
    if len(x) < n:
        raise ValueError(f"only {len(x)} rows available for a {n}-row check")
    index = np.sort(rng.choice(len(x), n, replace=False))
    x, extras = x[index].astype(np.float32), extras[index].astype(np.float32)

    torch.set_num_threads(1)
    weights = load_onnx_weights(champion)
    projection = {v.name: numpy_helper.to_array(v) for v in onnx.load(str(wrapped)).graph.initializer}["extra_weight"]
    base, student = ValueNet(weights), ValueNetExtras(load_onnx_weights(wrapped), width)
    with torch.no_grad():
        student.extra_weight.copy_(torch.from_numpy(projection.copy()))
        tx = torch.from_numpy(x)
        torch_base = base(tx).numpy()
        torch_wrapped = student(tx, torch.from_numpy(extras)).numpy()

    options = ort.SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    raw = ort.InferenceSession(str(champion), options, providers=["CPUExecutionProvider"])
    wide = ort.InferenceSession(str(wrapped), options, providers=["CPUExecutionProvider"])
    ort_base, ort_wrapped = np.empty(n, np.float32), np.empty(n, np.float32)
    for i in range(n):
        state, actions = x[i : i + 1, :STATE], x[i : i + 1, STATE:]
        ort_base[i] = raw.run(["values"], {"state": state, "actions": actions})[0][0, 0]
        ort_wrapped[i] = wide.run(["values"], {"state": state, "actions": actions,
                                               "extras": extras[i : i + 1]})[0][0, 0]
    return {
        "rows": n,
        "seed": seed,
        "manifests": [str(m) for m in manifests],
        "historySource": sorted(sources) if sources else None,
        "extrasNonzeroFraction": float(np.count_nonzero(extras) / extras.size),
        "projectionMaxAbs": float(np.abs(projection).max()),
        "torchMaxAbsDiff": float(np.abs(torch_wrapped - torch_base).max()),
        "ortMaxAbsDiff": float(np.abs(ort_wrapped - ort_base).max()),
        "torchVsOrtChampionMaxAbsDiff": float(np.abs(torch_base - ort_base).max()),
        "valueRange": [float(ort_base.min()), float(ort_base.max())],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--champion", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=215, choices=EXTRA_WIDTHS)
    parser.add_argument("--expect-sha", default="")
    parser.add_argument("--check-rows", default="")
    parser.add_argument("--check-n", type=int, default=1000)
    parser.add_argument("--check-seed", type=int, default=20261113)
    parser.add_argument("--check-out", default="")
    parser.add_argument("--tolerance", type=float, default=1e-6)
    args = parser.parse_args()
    champion_sha = sha256(args.champion)
    if args.expect_sha and champion_sha != args.expect_sha:
        raise SystemExit(f"champion SHA-256 {champion_sha} != expected {args.expect_sha}")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    digest = export_onnx_extras(load_onnx_weights(args.champion), out, None, args.width)
    record = {"champion": str(args.champion), "championSHA256": champion_sha,
              "out": str(out), "sha256": digest, "extrasWidth": args.width}
    status = 0
    if args.check_rows:
        parity = check(args.champion, out, args.width, args.check_rows.split(","),
                       args.check_n, args.check_seed)
        parity["tolerance"] = args.tolerance
        parity["pass"] = max(parity["torchMaxAbsDiff"], parity["ortMaxAbsDiff"]) <= args.tolerance
        record["parity"] = parity
        status = 0 if parity["pass"] else 1
        if args.check_out:
            Path(args.check_out).write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps(record))
    sys.exit(status)


if __name__ == "__main__":
    main()
