"""Prepare a zero-extras champion student. Export only: no optimizer, samples or training."""
import argparse
import json
from pathlib import Path
import sys

import numpy as np
import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'ai/danMCai/training/continuous'))
from value_net import ValueNetExtras, export_onnx_extras, load_onnx_weights, sha256


def prepare(teacher, expected, output):
    if sha256(teacher) != expected:
        raise ValueError('Teacher SHA mismatch')
    if output.resolve() == (ROOT/'ai/danMCai/models/baseline/policy.onnx').resolve():
        raise ValueError('Never overwrite baseline')
    if output.exists():
        raise FileExistsError('Student already exists')
    output.parent.mkdir(parents=True,exist_ok=True)
    torch.set_num_threads(1)
    weights = load_onnx_weights(teacher)
    net = ValueNetExtras(weights)
    assert torch.count_nonzero(net.extra_weight).item() == 0
    for a,b in zip(net.weights(),weights): np.testing.assert_array_equal(a,b)
    digest=export_onnx_extras(net.weights(),output,net.extra_weight.detach().numpy())
    return {'teacherSHA256':expected,'studentSHA256':digest,
            'networkGroupsPreserved':12,'extraWeightShape':[53,512],'extraWeightNonzero':0,
            'optimizerUpdates':0,'trainingStarted':False,'config':{'stateFeatures':513,'actionFeatures':54,'extraFeatures':53},
            'notDeployableAsChampion':'Ordinary oracle context remains incomplete; require separate acceptance and owner authorization.'}


if __name__=='__main__':
    p=argparse.ArgumentParser(__doc__);p.add_argument('--teacher',type=Path,required=True)
    p.add_argument('--expected',required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True);a=p.parse_args()
    d=prepare(a.teacher,a.expected,a.output)
    a.report.write_bytes((json.dumps(d,indent=2)+'\n').encode());print(json.dumps(d))
