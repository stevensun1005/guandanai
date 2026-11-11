"""Window-5 L1 smoke helper: with trunkFrozen, every ONNX initializer except the extras projection
must be byte-identical between the initial wrapped model and an export (PLAN section 5, L1 smoke).

    python l1_trunk_check.py <initial.onnx> <export.onnx>
Prints a JSON line; exit 1 when a trunk tensor changed or extra_weight did not move.
"""
import json
import sys

import numpy as np
import onnx
from onnx import numpy_helper

a, b = (({i.name: numpy_helper.to_array(i) for i in onnx.load(p).graph.initializer}) for p in sys.argv[1:3])
changed = sorted(k for k in a if k != "extra_weight" and (k not in b or a[k].tobytes() != b[k].tobytes()))
moved = "extra_weight" in a and "extra_weight" in b and not np.array_equal(a["extra_weight"], b["extra_weight"])
print(json.dumps({"trunkTensors": len([k for k in a if k != "extra_weight"]), "trunkChanged": changed,
                  "extraWeightMoved": bool(moved),
                  "extraWeightShape": list(b["extra_weight"].shape) if "extra_weight" in b else None}))
sys.exit(1 if changed or not moved else 0)
