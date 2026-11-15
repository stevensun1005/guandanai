"""Opt-in human choice regularizer for terminal-round Monte Carlo learning.

No tactical tags, private opponent hands, validation or test labels enter this loss.
The reference is fixed029; this module does not select a model or publish a website.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from human_imitation import grouped_loss, pack
from value_net import ValueNet, load_onnx_weights, export_onnx


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class HumanRegularizer:
    def __init__(self, settings, device):
        self.settings = settings
        self.device = device
        self.every = int(settings['everyUpdates'])
        self.batch = int(settings['batchDecisions'])
        self.ce_weight = float(settings['choiceWeight'])
        self.anchor_weight = float(settings['candidateAnchorWeight'])
        if not (self.every >= 1 and self.batch >= 1 and self.ce_weight > 0 and self.anchor_weight > 0):
            raise ValueError('Invalid joint regularization weights/schedule')
        root = Path(settings['data'])
        for name, expected in settings['dataSHA256'].items():
            if digest(root / name) != expected:
                raise ValueError('Human data fingerprint changed: ' + name)
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        if digest(root / 'features.i8') != manifest['featureSHA256'] or digest(root / 'decisions.json') != manifest['decisionSHA256']:
            raise ValueError('Compiled human data changed')
        self.decisions = json.loads((root / 'decisions.json').read_text(encoding='utf-8'))
        split = {s: {d['match'] for d in self.decisions if d['split'] == s}
                 for s in ['train', 'validation', 'test']}
        if any(split[a] & split[b] for a, b in [('train', 'validation'), ('train', 'test'), ('validation', 'test')]):
            raise ValueError('Human match split overlap')
        self.ids = [i for i, d in enumerate(self.decisions) if d['split'] == 'train']
        if len(self.ids) < self.batch or manifest['features'] != 567:
            raise ValueError('Invalid human training corpus')
        raw = np.memmap(root / 'features.i8', dtype=np.int8, mode='r', shape=(manifest['candidateRows'], 567))
        self.features = torch.as_tensor(np.array(raw), dtype=torch.float32, device=device)
        self.cap = len(self.ids) * int(settings['maxPasses'])
        if self.cap < self.batch:
            raise ValueError('Invalid human exposure cap')
        self.last = {}

    def rows_used(self, completed_steps):
        return min(self.cap, ((completed_steps + self.every - 1) // self.every) * self.batch)

    def loss(self, net, reference, step):
        before = self.rows_used(step)
        if step % self.every or before >= self.cap:
            return None
        # A step-indexed stream makes the human schedule repeatable after a matching checkpoint;
        # it does not claim that evicted Monte Carlo replay or actor state is recoverable.
        random = np.random.default_rng((int(self.settings['seed']) + step * 1009) % 2**32)
        ids = random.choice(self.ids, size=min(self.batch, self.cap-before), replace=False).tolist()
        x, groups, targets, _ = pack(ids, self.decisions, self.features, self.device)
        scores = net(x)
        with torch.no_grad():
            prior = reference(x)
        ce = grouped_loss(scores, groups, targets, len(ids))
        anchor = torch.mean((scores-prior)**2)
        self.last = {'choiceNLL': float(ce.detach()), 'humanCandidateAnchorMSE': float(anchor.detach()),
                     'lastHumanBatch': len(ids)}
        return self.ce_weight * ce + self.anchor_weight * anchor


def preflight(initial, output):
    """Real GPU joint loss/12-state Adam restore/parity using synthetic rows only."""
    import onnxruntime as ort
    if not torch.cuda.is_available():
        raise RuntimeError('Real ROCm GPU required')
    torch.set_num_threads(1)
    torch.manual_seed(2026111511)
    device = torch.device('cuda:0')
    reference = ValueNet(load_onnx_weights(initial)).to(device).requires_grad_(False)
    net = ValueNet(load_onnx_weights(initial)).to(device)
    optimizer = torch.optim.Adam(net.parameters(), lr=1e-6)
    x = torch.randint(-1, 3, (64, 567), device=device).float()
    y = torch.tensor([-3., -2., -1., 1., 2., 3., 1., -1.], device=device).repeat(8)
    groups = torch.arange(4, device=device).repeat_interleave(16)
    targets = torch.tensor([1, 17, 33, 49], device=device)
    def loss(model):
        q = model(x)
        with torch.no_grad():
            prior = reference(x)
        return ((q-y)**2).mean() + .1*((q-prior)**2).mean() + .2*grouped_loss(q, groups, targets, 4) + .1*((q-prior)**2).mean()
    for _ in range(2):
        optimizer.zero_grad(set_to_none=True);loss(net).backward()
        gradients = [float(p.grad.abs().max()) for p in net.parameters()]
        assert all(g > 0 and np.isfinite(g) for g in gradients)
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0);optimizer.step()
    saved = copy.deepcopy({'model': net.state_dict(), 'optimizer': optimizer.state_dict()})
    clone = ValueNet(load_onnx_weights(initial)).to(device);clone.load_state_dict(saved['model'])
    restored = torch.optim.Adam(clone.parameters(), lr=1e-6);restored.load_state_dict(saved['optimizer'])
    for model, opt in [(net, optimizer), (clone, restored)]:
        opt.zero_grad(set_to_none=True);loss(model).backward();torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0);opt.step()
    assert all(torch.equal(a, b) for a, b in zip(net.parameters(), clone.parameters()))
    assert len(restored.state) == 12 and all(int(s['step']) == 3 for s in restored.state.values())
    with tempfile.TemporaryDirectory(dir=Path(output).parent) as temp:
        file = Path(temp)/'joint.onnx';export_onnx(net.weights(), file)
        session = ort.InferenceSession(str(file), providers=['CPUExecutionProvider'])
        packed = torch.cat((x[:1, :513].expand(len(x), -1), x[:, 513:]), 1)
        cpu = session.run(None, {'state': x[:1, :513].cpu().numpy(), 'actions': x[:, 513:].cpu().numpy()})[0].reshape(-1)
        gpu = net(packed).detach().cpu().numpy();delta = float(np.max(np.abs(cpu-gpu)))
        assert delta < 1e-4 and int(np.argmax(cpu)) == int(np.argmax(gpu))
    report = {'passed': True, 'device': torch.cuda.get_device_name(0), 'backend': str(device),
              'temporarySyntheticUpdates': 4, 'matchingAdamStates': 12, 'restoreNextUpdateEqual': True,
              'gradientMaxPerTensor': gradients, 'onnxTorchMaxDifference': delta,
              'formalUpdates': 0, 'humanRowsUsed': 0, 'strengthEvidence': False}
    Path(output).write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--preflight', action='store_true', required=True)
    p.add_argument('--initial', required=True);p.add_argument('--output', required=True);args=p.parse_args()
    preflight(args.initial,args.output)
