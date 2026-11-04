"""JSON-lines CPU inference helper for development self-play, never a web service."""

import json
from pathlib import Path
import sys
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from ai.reference.numpy_engine import encode, cards_array

options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
engine = ort.InferenceSession(
    str(ROOT / "ai/policy.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
)
for line in sys.stdin:
    try:
        state = json.loads(line)
        features = encode(state).reshape(1, 513)
        scores = []
        for first in range(0, len(state["actions"]), 128):
            actions = np.array(
                [cards_array(action) for action in state["actions"][first : first + 128]],
                dtype=np.float32,
            )
            scores.extend(
                engine.run(["values"], {"state": features, "actions": actions})[0]
                .reshape(-1)
                .tolist()
            )
        print(json.dumps({"values": scores}, separators=(",", ":")), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}), flush=True)
