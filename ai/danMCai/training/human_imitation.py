"""Legal-action behavioral cloning of the explicitly authorized private human snapshot.

Only human action indices enter the loss. Output scores are imitation logits, not upgrade
points or calibrated win probabilities. Validation selects a checkpoint; test is read once
after selection. Existing research runs and the website are never edited.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import zipfile

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).parent / 'continuous'))
from value_net import ValueNet, load_onnx_weights, export_onnx, sha256  # noqa: E402


def write(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def grouped_loss(logits, groups, targets, n):
    """Mean cross entropy for ragged, deduplicated legal-action sets."""
    maxima = torch.full((n,), -torch.inf, device=logits.device, dtype=logits.dtype)
    maxima = maxima.scatter_reduce(0, groups, logits, reduce='amax').detach()
    sums = torch.zeros_like(maxima).scatter_add(0, groups, (logits - maxima[groups]).exp())
    return (maxima + sums.log() - logits[targets]).mean()


def argmax_groups(logits, groups, n):
    maxima = torch.full((n,), -torch.inf, device=logits.device, dtype=logits.dtype)
    maxima = maxima.scatter_reduce(0, groups, logits, reduce='amax')
    indices = torch.arange(len(logits), device=logits.device)
    picked = torch.where(logits == maxima[groups], indices, len(logits))
    return torch.full((n,), len(logits), device=logits.device, dtype=torch.long).scatter_reduce(
        0, groups, picked, reduce='amin')


def batches(ids, decisions, batch_size=32, row_cap=8192):
    batch, size = [], 0
    for i in ids:
        length = decisions[int(i)]['length']
        if batch and (len(batch) >= batch_size or size + length > row_cap):
            yield batch
            batch, size = [], 0
        batch.append(int(i))
        size += length
    if batch:
        yield batch


def pack(ids, decisions, features, device):
    selected = [decisions[i] for i in ids]
    lengths = np.array([d['length'] for d in selected])
    rows = np.concatenate([np.arange(d['start'], d['start'] + d['length']) for d in selected])
    starts = np.r_[0, np.cumsum(lengths)[:-1]]
    targets = starts + np.array([d['target'] for d in selected])
    groups = np.repeat(np.arange(len(ids)), lengths)
    tensor = lambda x: torch.as_tensor(x, device=device, dtype=torch.long)
    return features[tensor(rows)], tensor(groups), tensor(targets), starts


def preflight(plan, root):
    import onnxruntime as ort
    device = torch.device('cuda:0')
    assert torch.cuda.is_available(), 'Actual ROCm/CUDA-interface device required'
    torch.manual_seed(plan['seed'])
    net = ValueNet(load_onnx_weights(plan['initialModel'])).to(device)
    x = torch.randint(-1, 3, (7, 567), device=device).float()
    groups = torch.tensor([0, 0, 0, 1, 1, 1, 1], device=device)
    targets = torch.tensor([1, 5], device=device)
    optimizer = torch.optim.AdamW(net.parameters(), lr=plan['learningRate'], weight_decay=plan['weightDecay'])
    before = net.layers[0].weight.detach().clone()
    loss = grouped_loss(net(x), groups, targets, 2)
    loss.backward()
    gradients = [float(p.grad.abs().max()) for p in net.parameters()]
    optimizer.step()
    assert not torch.equal(before, net.layers[0].weight)
    assert len(optimizer.state) == 12
    saved = {'model': copy.deepcopy(net.state_dict()), 'optimizer': copy.deepcopy(optimizer.state_dict())}
    restored = ValueNet().to(device)
    restored.load_state_dict(saved['model'])
    other = torch.optim.AdamW(restored.parameters(), lr=plan['learningRate'], weight_decay=plan['weightDecay'])
    other.load_state_dict(saved['optimizer'])
    # Non-capturable Adam step counters stay on CPU, as in the verified belief restore path.
    for state in other.state.values():
        state['step'] = state['step'].cpu()
    for model, opt in [(net, optimizer), (restored, other)]:
        opt.zero_grad(set_to_none=True)
        grouped_loss(model(x), groups, targets, 2).backward()
        opt.step()
    assert all(torch.equal(a, b) for a, b in zip(net.parameters(), restored.parameters()))
    with tempfile.TemporaryDirectory(dir=root) as temporary:
        path = Path(temporary) / 'preflight.onnx'
        export_onnx(net.weights(), path)
        engine = ort.InferenceSession(str(path), providers=['CPUExecutionProvider'])
        one = x[:1].detach().cpu().numpy()
        # ONNX broadcasts one state across actions. Test a batch with that identical state.
        values = engine.run(None, {'state': one[:, :513], 'actions': x[:, 513:].cpu().numpy()})[0].reshape(-1)
        packed = torch.cat((x[:1, :513].expand(len(x), -1), x[:, 513:]), 1)
        delta = float(np.max(np.abs(values - net(packed).detach().cpu().numpy())))
        assert delta < 1e-4
    report = {'passed': True, 'device': torch.cuda.get_device_name(0), 'backend': str(device),
              'temporarySyntheticUpdates': 4, 'matchingAdamStates': 12, 'restoreNextUpdateEqual': True,
              'gradientMaxPerTensor': gradients, 'onnxTorchMaxDifference': delta,
              'formalUpdates': 0, 'humanRowsUsed': 0, 'strengthEvidence': False}
    write(root / 'gpu-preflight.json', report)
    write(root / 'preflight-panel.json', {'rows': [['实际GPU', report['device']],
          ['检查', '12组Adam/下一更新恢复一致；ONNX兼容'], ['正式更新', 0]]})


def train(plan, root):
    device = torch.device('cuda:0')
    assert torch.cuda.is_available()
    manifest = json.loads((root / 'data/manifest.json').read_text())
    assert sha256(root / 'data/features.i8') == manifest['featureSHA256']
    assert sha256(root / 'data/decisions.json') == manifest['decisionSHA256']
    decisions = json.loads((root / 'data/decisions.json').read_text())
    partitions = {s: [i for i, d in enumerate(decisions) if d['split'] == s] for s in ['train', 'validation', 'test']}
    assert all(partitions.values())
    sets = {s: {decisions[i]['match'] for i in ids} for s, ids in partitions.items()}
    assert not any(sets[a] & sets[b] for a, b in [('train', 'validation'), ('train', 'test'), ('validation', 'test')])
    torch.manual_seed(plan['seed'])
    random = np.random.default_rng(plan['seed'])
    raw = np.memmap(root / 'data/features.i8', dtype=np.int8, mode='r', shape=(manifest['candidateRows'], 567))
    features = torch.as_tensor(np.array(raw), dtype=torch.float32, device=device)
    net = ValueNet(load_onnx_weights(plan['initialModel'])).to(device)
    optimizer = torch.optim.AdamW(net.parameters(), lr=plan['learningRate'], weight_decay=plan['weightDecay'])
    step, current_epoch = 0, 0
    started = time.time()
    deadline = lambda key: time.time() >= __import__('datetime').datetime.fromisoformat(plan[key].replace('Z', '+00:00')).timestamp()
    def allowed(training=False):
        while (root / 'MEMORY_PAUSE').exists():
            if (root / 'STOP').exists() or deadline('deadlineUTC') or (training and deadline('trainingDeadlineUTC')):
                return False
            time.sleep(.25)
        return not ((root / 'STOP').exists() or deadline('deadlineUTC') or
                    (training and ((root / 'TRAIN_STOP').exists() or deadline('trainingDeadlineUTC'))))
    def progress(phase, **extra):
        status = {'pid': os.getpid(), 'phase': phase, 'step': step, 'epoch': current_epoch,
                  'maxEpochs': plan['maxEpochs'], 'device': torch.cuda.get_device_name(0),
                  'elapsedSeconds': time.time() - started, **extra}
        write(root / 'learner-status.json', status)
        write(root / 'train-panel.json', {'rows': [['训练状态', phase], ['实际GPU', status['device']],
              ['新增优化器更新', step], ['轮数', f"{current_epoch}/{plan['maxEpochs']}"],
              *[[k, v] for k, v in extra.items()], ['目标', '真人合法牌面选择；不是胜率/升级分']]})
    @torch.no_grad()
    def evaluate(ids):
        nll, correct, total, predictions = 0., 0, 0, []
        net.eval()
        for ids_batch in batches(ids, decisions):
            if not allowed():
                raise TimeoutError('Evaluation deadline/STOP')
            x, groups, targets, starts = pack(ids_batch, decisions, features, device)
            logits = net(x)
            picked = argmax_groups(logits, groups, len(ids_batch))
            nll += float(grouped_loss(logits, groups, targets, len(ids_batch))) * len(ids_batch)
            correct += int((picked == targets).sum())
            total += len(ids_batch)
            predictions.extend((picked.cpu().numpy() - starts).tolist())
        return {'decisions': total, 'correct': correct, 'accuracy': correct / total, 'nll': nll / total, 'predictions': predictions}
    def slim(m):
        return {k: v for k, v in m.items() if k != 'predictions'}
    def save(name, metric):
        torch.save({'model': net.state_dict(), 'optimizer': optimizer.state_dict(), 'step': step,
                    'epoch': current_epoch, 'validation': slim(metric), 'outputMeaning': 'human imitation logits'}, root / (name+'.tmp'))
        os.replace(root / (name+'.tmp'), root / name)
    progress('baseline-validation')
    baseline_validation = evaluate(partitions['validation'])
    best = baseline_validation['nll']
    save('best.pt', baseline_validation)
    stale, history = 0, []
    stop_reason = 'max-epochs'
    for current_epoch in range(1, plan['maxEpochs'] + 1):
        net.train()
        total_loss, observed, cut = 0., 0, False
        for ids_batch in batches(random.permutation(partitions['train']), decisions):
            if not allowed(training=True):
                stop_reason, cut = 'deadline-or-stop', True
                break
            x, groups, targets, _ = pack(ids_batch, decisions, features, device)
            optimizer.zero_grad(set_to_none=True)
            loss = grouped_loss(net(x), groups, targets, len(ids_batch))
            if not torch.isfinite(loss):
                raise ValueError('Nonfinite imitation loss')
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.)
            optimizer.step()
            step += 1
            observed += len(ids_batch)
            total_loss += float(loss.detach()) * len(ids_batch)
            if step % 10 == 0:
                progress('training', epochDecisions=observed, epochPlanned=len(partitions['train']),
                         trainingMeanNLL=total_loss / observed, bestValidationNLL=best, patienceUsed=stale)
        validation = evaluate(partitions['validation'])
        improved = validation['nll'] < best - plan['minDelta']
        if improved:
            best, stale = validation['nll'], 0
            save('best.pt', validation)
        else:
            stale += 1
        record = {'epoch': current_epoch, 'step': step, 'trainingNLL': total_loss / observed if observed else None,
                  'validation': slim(validation), 'selectedNewBest': improved, 'patienceUsed': stale}
        history.append(record)
        with (root / 'epochs.jsonl').open('a', encoding='utf8') as stream:
            stream.write(json.dumps(record) + '\n')
        progress('epoch-complete', validationAccuracy=validation['accuracy'], validationNLL=validation['nll'], bestValidationNLL=best, patienceUsed=stale)
        if cut:
            break
        if stale >= plan['patience']:
            stop_reason = 'validation-early-stop'
            break
    save('last.pt', validation)
    last_sha = export_onnx(net.weights(), root / 'last.onnx')
    selected = torch.load(root / 'best.pt', map_location=device, weights_only=True)
    net.load_state_dict(selected['model'])
    final_sha = export_onnx(net.weights(), root / 'human-imitation.onnx')
    progress('retrospective-test', selectedStep=selected['step'])
    candidate_test = evaluate(partitions['test'])
    net.load_weights(load_onnx_weights(plan['initialModel']))
    baseline_test = evaluate(partitions['test'])
    net.load_state_dict(selected['model'])
    states = selected['optimizer']['state']
    assert len(states) == (12 if selected['step'] else 0)
    assert all(int(s['step']) == selected['step'] for s in states.values())
    import onnxruntime as ort
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    engine = ort.InferenceSession(str(root / 'human-imitation.onnx'), sess_options=options,
                                 providers=['CPUExecutionProvider'])
    maximum, same = 0., 0
    with torch.no_grad():
        for i in partitions['train'][:16]:
            d = decisions[i]
            x = features[d['start']:d['start']+d['length']]
            encoded = x.cpu().numpy()
            values = engine.run(None, {'state': encoded[:1,:513], 'actions': encoded[:,513:]})[0].reshape(-1)
            expected = net(x).cpu().numpy()
            maximum = max(maximum, float(np.max(np.abs(values-expected))))
            same += int(np.argmax(values) == np.argmax(expected))
    assert maximum < 1e-4
    parity = {'positions':16,'argmaxSame':same,'maxDifference':maximum,
              'scope':'Native CPU ONNX versus actual GPU; existing training positions, not browser or strength evidence'}
    def style(predictions):
        summary = {k: {'opportunities':0,'human':0,'model':0} for k in ['followPass','partnerPlay','bombPlay']}
        for i, prediction in zip(partitions['test'], predictions):
            d = decisions[i]
            actual, predicted = d['actualType'], d['types'][prediction]
            conditions = [('followPass', not d['lead'] and d['canRespond'], actual=='pass',predicted=='pass'),
                          ('partnerPlay', not d['lead'] and d['canRespond'] and d['partnerTrick'], actual!='pass',predicted!='pass'),
                          ('bombPlay', d['canBomb'], actual in ['bomb','sflush','jokers'], predicted in ['bomb','sflush','jokers'])]
            for key, eligible, human, model in conditions:
                if eligible:
                    summary[key]['opportunities'] += 1
                    summary[key]['human'] += int(human)
                    summary[key]['model'] += int(model)
        return summary
    result = {'complete': True, 'formalUpdates': step, 'selectedStep': selected['step'], 'selectedEpoch': selected['epoch'],
              'stopReason': stop_reason, 'baselineValidation': slim(baseline_validation), 'selectedValidation': selected['validation'],
              'baselineTest': slim(baseline_test), 'candidateTest': slim(candidate_test),
              'retrospectiveImitationImproved': candidate_test['nll'] < baseline_test['nll'] and candidate_test['accuracy'] > baseline_test['accuracy'],
              'onnxSHA256': final_sha, 'lastOnnxSHA256': last_sha, 'checkpointSHA256': sha256(root / 'best.pt'),
              'matchingAdamStates': len(selected['optimizer']['state']), 'device': torch.cuda.get_device_name(0),
              'onnxParity': parity,
              'descriptiveTestStyle': {'baseline':style(baseline_test['predictions']), 'candidate':style(candidate_test['predictions']),
                                       'usedInLossOrSelection':False},
              'outputMeaning': 'human action preference logits, not terminal upgrade value or win probability',
              'selection': 'Minimum validation NLL with preregistered minDelta; test read after selection, not used for fit or selection',
              'strengthAccepted': False, 'webPublished': False, 'limits': plan['limits'], 'history': history}
    write(root / 'test-predictions.private.json', {'candidate': candidate_test['predictions'], 'baseline': baseline_test['predictions']})
    write(root / 'results.json', result)
    write(root / 'results-panel.json', {'rows': [['模仿留出牌面一致率', f"{baseline_test['accuracy']:.2%} → {candidate_test['accuracy']:.2%}"],
          ['留出交叉熵', f"{baseline_test['nll']:.4f} → {candidate_test['nll']:.4f}"], ['新增/入选更新', f"{step} / {selected['step']}"],
          ['限制', '仅1个回顾性留出会话；不是胜率或新冠军；网页未更换']]})
    with zipfile.ZipFile(root / 'human-imitation-research.zip', 'x', zipfile.ZIP_DEFLATED) as archive:
        for file in ['human-imitation.onnx', 'best.pt', 'results.json', 'protocol.json']:
            archive.write(root / file, file)
    progress('complete', selectedStep=selected['step'], selectedEpoch=selected['epoch'])
    print(json.dumps({k: v for k, v in result.items() if k != 'history'}))


def main():
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--protocol', type=Path, required=True)
    parser.add_argument('--preflight', action='store_true')
    args = parser.parse_args()
    plan = json.loads(args.protocol.read_text(encoding='utf8'))
    root = Path(plan['run'])
    if sha256(plan['initialModel']) != plan['initialModelSHA256']:
        raise ValueError('Initial champion changed')
    torch.set_num_threads(1)
    if args.preflight:
        preflight(plan, root)
    else:
        if not json.loads((root / 'gpu-preflight.json').read_text())['passed']:
            raise ValueError('Actual GPU restore preflight required')
        train(plan, root)


if __name__ == '__main__':
    main()
