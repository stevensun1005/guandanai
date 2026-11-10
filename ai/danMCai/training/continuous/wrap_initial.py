"""Wrap a P0-architecture champion ONNX with a zero extras projection (values unchanged).

    python ai/danMCai/training/continuous/wrap_initial.py --champion=<017.onnx> --out=<v000000000.onnx> [--width=215]

Prints a JSON line with the source and output SHA-256. The zero projection makes the wrapped
model's values equal the champion's for any extras input; the learner then trains the projection.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from value_net import export_onnx_extras, load_onnx_weights, sha256  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--champion", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=215)
    args = parser.parse_args()
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    digest = export_onnx_extras(load_onnx_weights(args.champion), out, None, args.width)
    print(json.dumps({"champion": str(args.champion), "championSHA256": sha256(args.champion),
                      "out": str(out), "sha256": digest, "extrasWidth": args.width}))


if __name__ == "__main__":
    main()
