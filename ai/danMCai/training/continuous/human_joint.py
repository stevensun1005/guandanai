"""Opt-in human choice regularizer for terminal-round Monte Carlo learning.

No tactical tags, private opponent hands, validation or test labels enter this loss.
The reference is fixed by the registered batch; this module does not select a model or publish a website.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from datetime import datetime
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from human_imitation import grouped_loss, pack
from value_net import ValueNet, load_onnx_weights, export_onnx


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def filtered_choice_terms(scores, prior, groups, targets, n, top_k=None):
    """Detached value-rank proxy, not a guarantee of equivalent terminal outcomes."""
    with torch.no_grad():
        ids = torch.arange(len(scores), device=scores.device)
        target_scores = scores[targets]
        better = (scores > target_scores[groups]) | ((scores == target_scores[groups]) & (ids < targets[groups]))
        ranks = torch.zeros(n, device=scores.device, dtype=torch.long).scatter_add(0, groups, better.long())
        keep = torch.ones(n, device=scores.device, dtype=torch.bool) if top_k is None else ranks < top_k
    maxima = torch.full((n,), -torch.inf, device=scores.device, dtype=scores.dtype)
    maxima = maxima.scatter_reduce(0, groups, scores, reduce='amax').detach()
    sums = torch.zeros_like(maxima).scatter_add(0, groups, (scores-maxima[groups]).exp())
    per_group = maxima+sums.log()-scores[targets]
    # Fixed original-batch denominators: filtering does not amplify the surviving labels.
    ce = (per_group*keep).sum()/n
    anchor = (((scores-prior)**2)*keep[groups]).mean()
    return ce, anchor, keep


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
        self.feature_file = root / 'features.i8'
        self.feature_rows = manifest['candidateRows']
        self.top_k = settings.get('gateTopK')
        self.enable_after = datetime.fromisoformat(settings['enableAfterUTC'].replace('Z', '+00:00')).timestamp() if self.top_k is not None else None
        if self.top_k is not None and (not isinstance(self.top_k, int) or self.top_k < 1):
            raise ValueError('Invalid human value-rank filter')
        self.features = None if self.top_k is not None else torch.as_tensor(np.fromfile(self.feature_file, dtype=np.int8).reshape(self.feature_rows, 567), dtype=torch.int8 if settings.get('compactFeatures') else torch.float32, device=device)
        self.attempted = self.accepted = self.rejected = 0
        self.cap = len(self.ids) * int(settings['maxPasses'])
        if self.cap < self.batch:
            raise ValueError('Invalid human exposure cap')
        self.last = {}

    def state_dict(self):
        return {'attempted': self.attempted, 'accepted': self.accepted, 'rejected': self.rejected}

    def load_state_dict(self, state):
        if state is None:
            return
        a, b, c = (int(state[k]) for k in ['attempted', 'accepted', 'rejected'])
        if not (0 <= b <= a <= self.cap and c == a-b):
            raise ValueError('Invalid restored human exposure accounting')
        self.attempted, self.accepted, self.rejected = a, b, c

    def rows_used(self, completed_steps):
        if self.top_k is not None:
            return self.accepted
        return min(self.cap, ((completed_steps + self.every - 1) // self.every) * self.batch)

    def loss(self, net, reference, step):
        if self.top_k is not None and time.time() < self.enable_after:
            self.last = {'phase': 'terminal-only-warmup', 'enableAfterUTC': self.settings['enableAfterUTC']}
            return None
        before = self.attempted if self.top_k is not None else self.rows_used(step)
        if step % self.every or before >= self.cap:
            return None
        # A step-indexed stream makes the human schedule repeatable after a matching checkpoint;
        # it does not claim that evicted Monte Carlo replay or actor state is recoverable.
        random = np.random.default_rng((int(self.settings['seed']) + step * 1009) % 2**32)
        ids = random.choice(self.ids, size=min(self.batch, self.cap-before), replace=False).tolist()
        if self.features is None:
            if digest(self.feature_file) != self.settings['dataSHA256']['features.i8']:
                raise ValueError('Human features changed during warmup')
            self.features = torch.as_tensor(np.fromfile(self.feature_file, dtype=np.int8).reshape(self.feature_rows, 567), dtype=torch.int8 if self.settings.get('compactFeatures') else torch.float32, device=self.device)
        x, groups, targets, _ = pack(ids, self.decisions, self.features, self.device)
        x = x.float()
        scores = net(x)
        with torch.no_grad():
            prior = reference(x)
        ce, anchor, keep = filtered_choice_terms(scores, prior, groups, targets, len(ids), self.top_k)
        accepted = int(keep.sum())
        if self.top_k is not None:
            self.attempted += len(ids)
            self.accepted += accepted
            self.rejected += len(ids)-accepted
        self.last = {'choiceNLL': float(ce.detach()), 'humanCandidateAnchorMSE': float(anchor.detach()),
                     'lastHumanBatch': len(ids), 'eligibleLabels': accepted, 'phase': 'value-rank-filtered' if self.top_k else 'unfiltered', **self.state_dict()}
        return self.ce_weight * ce + self.anchor_weight * anchor


def preflight(initial, output, settings=None):
    """Real GPU joint loss/12-state Adam restore/parity using synthetic rows only."""
    import onnxruntime as ort
    if not torch.cuda.is_available():
        raise RuntimeError('Real ROCm GPU required')
    torch.set_num_threads(1)
    torch.manual_seed(2026111511)
    device = torch.device('cuda:0')
    reference = ValueNet(load_onnx_weights(initial)).to(device).requires_grad_(False)
    net = ValueNet(load_onnx_weights(initial)).to(device)
    settings = settings or {'learner': {'learningRate': 1e-6, 'anchorWeight': .1}, 'humanImitation': {'choiceWeight': .2, 'candidateAnchorWeight': .1}}
    learning_rate = settings['learner']['learningRate']
    hs = settings['humanImitation']
    optimizer = torch.optim.Adam(net.parameters(), lr=learning_rate)
    base_step = 0
    continuation = settings.get('continuation')
    if continuation:
        assert digest(continuation['file']) == continuation['sha256']
        parent = torch.load(continuation['file'],weights_only=True,map_location='cpu')
        assert all(torch.equal(v.cpu(),parent['model'][k]) for k,v in net.state_dict().items())
        optimizer.load_state_dict(parent['optimizer']);base_step = parent['step']
        assert base_step == settings['parent']['startingStep'] and len(optimizer.state) == 12
        assert all(int(v['step']) == base_step for v in optimizer.state.values())
    x = torch.randint(-1, 3, (64, 567), device=device).float()
    y = torch.tensor([-3., -2., -1., 1., 2., 3., 1., -1.], device=device).repeat(8)
    groups = torch.arange(4, device=device).repeat_interleave(16)
    targets = torch.tensor([1, 17, 33, 49], device=device)
    if hs.get('gateTopK'):
        with torch.no_grad():
            order = torch.argsort(net(x).reshape(4,16), dim=1, descending=True)
            targets = torch.tensor([int(order[i, 0 if i < 3 else -1])+i*16 for i in range(4)], device=device)
    def loss(model):
        q = model(x)
        with torch.no_grad():
            prior = reference(x)
        ce, human_anchor, _ = filtered_choice_terms(q, prior, groups, targets, 4, hs.get('gateTopK'))
        return ((q-y)**2).mean() + settings['learner']['anchorWeight']*((q-prior)**2).mean() + hs['choiceWeight']*ce + hs['candidateAnchorWeight']*human_anchor
    for _ in range(2):
        optimizer.zero_grad(set_to_none=True);loss(net).backward()
        gradients = [float(p.grad.abs().max()) for p in net.parameters()]
        assert all(g > 0 and np.isfinite(g) for g in gradients)
        torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0);optimizer.step()
    saved = copy.deepcopy({'model': net.state_dict(), 'optimizer': optimizer.state_dict()})
    clone = ValueNet(load_onnx_weights(initial)).to(device);clone.load_state_dict(saved['model'])
    restored = torch.optim.Adam(clone.parameters(), lr=learning_rate);restored.load_state_dict(saved['optimizer'])
    for model, opt in [(net, optimizer), (clone, restored)]:
        opt.zero_grad(set_to_none=True);loss(model).backward();torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0);opt.step()
    assert all(torch.equal(a, b) for a, b in zip(net.parameters(), clone.parameters()))
    assert len(restored.state) == 12 and all(int(s['step']) == base_step+3 for s in restored.state.values())
    with tempfile.TemporaryDirectory(dir=Path(output).parent) as temp:
        file = Path(temp)/'joint.onnx';export_onnx(net.weights(), file)
        session = ort.InferenceSession(str(file), providers=['CPUExecutionProvider'])
        packed = torch.cat((x[:1, :513].expand(len(x), -1), x[:, 513:]), 1)
        cpu = session.run(None, {'state': x[:1, :513].cpu().numpy(), 'actions': x[:, 513:].cpu().numpy()})[0].reshape(-1)
        gpu = net(packed).detach().cpu().numpy();delta = float(np.max(np.abs(cpu-gpu)))
        assert delta < 1e-4 and int(np.argmax(cpu)) == int(np.argmax(gpu))
    report = {'passed': True, 'device': torch.cuda.get_device_name(0), 'backend': str(device),
              'temporarySyntheticUpdates': 4, 'inheritedStep': base_step, 'actualParentCheckpointVerified': bool(continuation), 'matchingAdamStates': 12, 'restoreNextUpdateEqual': True,
              'gradientMaxPerTensor': gradients, 'onnxTorchMaxDifference': delta,
              'formalUpdates': 0, 'humanRowsUsed': 0, 'strengthEvidence': False, 'gateTopK': hs.get('gateTopK'), 'learningRate': learning_rate}
    Path(output).write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--preflight', action='store_true', required=True)
    p.add_argument('--initial', required=True);p.add_argument('--output', required=True);p.add_argument('--settings');args=p.parse_args()
    preflight(args.initial,args.output,json.loads(Path(args.settings).read_text(encoding='utf-8')) if args.settings else None)
