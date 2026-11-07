"""Verify a champion initialization on the actual backend using a disposable optimizer.

The source ONNX and run directories are never written. The one gradient update and
in-memory Adam roundtrip belong only to this numerical preflight, not to training.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sys

import numpy as np
import torch

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
sys.path.insert(0, str(ROOT / 'ai/danMCai/training/continuous'))
from value_net import ValueNet, load_onnx_weights


def verify(model, expected_sha, device):
    model = Path(model)
    digest = lambda: hashlib.sha256(model.read_bytes()).hexdigest()
    assert digest() == expected_sha, 'Initial network SHA mismatch'
    backend = torch.device(device)
    assert backend.type in ['cpu', 'cuda']
    assert backend.type != 'cuda' or torch.cuda.is_available(), 'No usable CUDA/ROCm'
    torch.set_num_threads(1)
    torch.manual_seed(20261107)
    features = torch.from_numpy(np.random.default_rng(20261107).integers(0, 3, (129, 567)).astype(np.float32))
    net = ValueNet(load_onnx_weights(model))
    with torch.no_grad():
        reference = net(features).clone()
        actual = net.to(backend)(features.to(backend)).cpu()
    torch.testing.assert_close(actual, reference, atol=1e-4, rtol=1e-4)
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-5)
    assert not optimizer.state, 'Fresh optimizer must have no inherited Adam moments'
    loss = (net(features.to(backend)) - torch.ones(129, device=backend)).square().mean()
    assert torch.isfinite(loss)
    optimizer.zero_grad(); loss.backward()
    parameters = list(net.parameters())
    assert len(parameters) == 12
    assert all(p.grad is not None and torch.isfinite(p.grad).all() for p in parameters)
    optimizer.step()
    assert len(optimizer.state) == 12
    saved = io.BytesIO()
    torch.save({'model': net.state_dict(), 'optimizer': optimizer.state_dict()}, saved)
    saved.seek(0)
    checkpoint = torch.load(saved, weights_only=True, map_location='cpu')
    restored = ValueNet(load_onnx_weights(model)).to(backend)
    restored.load_state_dict(checkpoint['model'])
    restored_optimizer = torch.optim.Adam(restored.parameters(), lr=1e-5)
    restored_optimizer.load_state_dict(checkpoint['optimizer'])
    for parameter, other in zip(parameters, restored.parameters()):
        assert torch.equal(parameter, other)
        state = restored_optimizer.state[other]
        assert int(state['step']) == 1
        for key in ['exp_avg', 'exp_avg_sq']:
            assert state[key].device == other.device and torch.isfinite(state[key]).all()
            assert torch.equal(state[key], optimizer.state[parameter][key])
    assert digest() == expected_sha, 'Preflight changed the source model'
    return {'passed': True, 'verifiedAtUTC': datetime.now(timezone.utc).isoformat(),
            'platform': sys.platform, 'python': sys.version, 'torch': torch.__version__,
            'hip': torch.version.hip, 'backendActuallyTested': str(backend),
            'deviceName': torch.cuda.get_device_name(backend) if backend.type == 'cuda' else 'CPU',
            'gpuPeakAllocatedBytes': torch.cuda.max_memory_allocated(backend) if backend.type == 'cuda' else None,
            'networkSHA256': expected_sha, 'inputRows': 129,
            'forwardMaxAbsError': float((actual-reference).abs().max()),
            'gradientParameterGroups': len(parameters), 'adamStates': len(optimizer.state),
            'disposableOptimizerUpdates': 1, 'actualRunOptimizerUpdates': 0,
            'freshAdamInMemoryRoundtrip': True, 'sourceNetworkUnchanged': True,
            'limit': 'Synthetic numerical input; no playing-strength claim. Fresh Adam, not restored champion Adam.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', required=True)
    parser.add_argument('--sha256', required=True)
    parser.add_argument('--device', default='cuda:0')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    result = verify(args.model, args.sha256, args.device)
    output = Path(args.output)
    assert output.resolve() != Path(args.model).resolve()
    output.write_bytes((json.dumps(result, indent=2) + '\n').encode())
    print(json.dumps(result))
