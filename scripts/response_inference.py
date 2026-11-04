"""Development-only JSON-lines inference for the independent response network."""
import json,sys
from pathlib import Path
import numpy as np
import onnxruntime as ort
options=ort.SessionOptions();options.intra_op_num_threads=1;options.inter_op_num_threads=1
model=Path(__file__).resolve().parents[1]/'ai/response.onnx'
engine=ort.InferenceSession(str(model),sess_options=options,providers=['CPUExecutionProvider'])
for line in sys.stdin:
    try:
        request=json.loads(line);features=np.asarray(request['features'],dtype=np.float32)
        values=engine.run(['probability'],{'features':features})[0].reshape(-1).tolist()
        print(json.dumps({'values':values},separators=(',',':')),flush=True)
    except Exception as error:print(json.dumps({'error':str(error)}),flush=True)
