"""Read-only, deal-held-out ridge diagnostics of final-round G minus frozen Q.

No optimizer, tactical target, policy update, model export or simulated game.
"""
import os
for _name in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'):
    os.environ[_name] = '1'
import argparse
import ctypes
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[3]
read = lambda p: json.loads(Path(p).read_bytes())
now = lambda: datetime.now(timezone.utc).isoformat()


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def write(path, value):
    temp = Path(str(path) + '.tmp')
    temp.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    os.replace(temp, path)


def split_deal(seed, salt):
    bucket = int.from_bytes(hashlib.sha256(f'{salt}:{seed}'.encode()).digest()[:8], 'big') % 10
    return 0 if bucket < 6 else 1 if bucket < 8 else 2


def ridge(moment, indices, penalty):
    weight, sx, sy, xx, xy = moment
    mx, my = sx[indices] / weight, sy / weight
    covariance = xx[np.ix_(indices, indices)] / weight - np.outer(mx, mx)
    scale = np.sqrt(np.maximum(np.diag(covariance), 0))
    scale[scale < 1e-8] = 1
    cross = xy[indices] / weight - mx * my
    beta = np.linalg.solve(covariance / np.outer(scale, scale) + penalty * np.eye(len(indices)), cross / scale) / scale
    return beta, float(my - mx @ beta)


def paired_intervals(errors, seed, replicates, check=lambda: None):
    """Columns: baseline, extras, raw, raw+extras, hidden, hidden+extras."""
    def metrics(means):
        return np.concatenate((1 - means[..., 1:] / means[..., :1],
                               (1 - means[..., 3] / means[..., 2])[..., None],
                               (1 - means[..., 5] / means[..., 4])[..., None]), axis=-1)
    rng, draws = np.random.default_rng(seed), []
    for start in range(0, replicates, 50):
        check()
        indices = rng.integers(len(errors), size=(min(50, replicates-start), len(errors)))
        draws.append(metrics(errors[indices].mean(axis=1)))
    samples = np.concatenate(draws)
    return {'names': ['extrasR2', 'rawR2', 'rawExtrasR2', 'hiddenR2', 'hiddenExtrasR2', 'rawPartialR2', 'hiddenPartialR2'],
            'point': metrics(errors.mean(axis=0)).tolist(),
            'ci95': np.quantile(samples, [.025, .975], axis=0).T.tolist(),
            'ci99': np.quantile(samples, [.005, .995], axis=0).T.tolist()}


def available_gib():
    class Memory(ctypes.Structure):
        _fields_ = [('length', ctypes.c_ulong), ('load', ctypes.c_ulong)] + [(n, ctypes.c_ulonglong) for n in ('total', 'available', 'totalPage', 'availablePage', 'totalVirtual', 'availableVirtual', 'extended')]
    value = Memory()
    value.length = ctypes.sizeof(value)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(value)):
        raise RuntimeError('Cannot measure available memory')
    return value.available / 2**30


def run(directory):
    run_path = Path(directory).resolve()
    task, protocol = read(run_path/'campaign-task.json'), read(run_path/'protocol.json')
    deadline = min(datetime.fromisoformat(task['window']['deadlineUTC'].replace('Z', '+00:00')),
                   datetime.fromisoformat(protocol['deadlineUTC'].replace('Z', '+00:00')),
                   datetime.fromisoformat('2026-11-11T16:45:00+00:00'))
    def stop():
        if (run_path/'STOP').exists() or (run_path.parent.parent/'STOP').exists() or datetime.now(timezone.utc) >= deadline:
            raise RuntimeError('STOP or fixed deadline')
    stop()  # Before model, data, lock or output access; exercised by a real CLI test.
    if sha(run_path/'protocol.json') != task['protocolSHA256']:
        raise RuntimeError('Registered protocol changed')
    if (run_path/'status.json').exists():
        raise RuntimeError('Existing attempt: refusing to reset counters or repeat a fit')
    lock = run_path/'probe.lock'
    with lock.open('x', encoding='utf-8') as stream:
        json.dump({'pid': os.getpid()}, stream)
    state = {'phase': 'analysis', 'pid': os.getpid(), 'startedAtUTC': now(), 'completedPositions': 0,
             'plannedPositions': protocol['choiceRows'], 'positionUnit': '条既有选择决策（冻结前向）',
             'optimizerUpdates': 0, 'strengthGames': 0, 'completedDeals': 0,
             'minimumAvailableGiB': available_gib(), 'protocolSHA256': task['protocolSHA256']}
    last = [0.0]
    def check(stage=None, force=False):
        stop()
        memory = available_gib()
        state['minimumAvailableGiB'] = min(state['minimumAvailableGiB'], memory)
        while memory < (5 if state.get('memoryPaused') else 4):
            state.update(memoryPaused=True, availableGiB=memory, updatedAtUTC=now())
            write(run_path/'status.json', state)
            time.sleep(1)
            stop()
            memory = available_gib()
        state.update(memoryPaused=False, availableGiB=memory)
        if stage:
            state['analysisStage'] = stage
        if force or time.monotonic()-last[0] >= 3:
            state['updatedAtUTC'] = now()
            write(run_path/'status.json', state)
            last[0] = time.monotonic()
    try:
        if available_gib() < 5:
            state['memoryPaused'] = True
        check('verify-inputs', True)
        import subprocess
        actual = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
        if actual != protocol['sourceSHA']:
            raise RuntimeError('Frozen source HEAD mismatch')
        for name, expected in protocol['sourceFiles'].items():
            check()
            if sha(ROOT/name) != expected:
                raise RuntimeError('Frozen source file changed: '+name)
        data = Path(protocol['dataDirectory'])
        for name, expected in protocol['dataFiles'].items():
            check()
            if sha(data/name) != expected['sha256'] or (data/name).stat().st_size != expected['bytes']:
                raise RuntimeError('Corpus changed: '+name)
        teacher = protocol['teacher']
        if sha(teacher['file']) != teacher['sha256']:
            raise RuntimeError('Teacher changed')
        deals = read(data/'deals.json')
        n = protocol['rows']
        features = np.memmap(data/'features.i8', mode='r', dtype='i1', shape=(n,567))
        extras = np.memmap(data/'extras.f32', mode='r', dtype='<f4', shape=(n,53))
        metadata = np.memmap(data/'metadata.u32', mode='r', dtype='<u4', shape=(n,5))
        labels = np.memmap(data/'labels.f32', mode='r', dtype='<f4', shape=(n,11))
        groups = np.repeat(np.arange(len(deals)), [d['rows'] for d in deals])
        split = np.array([split_deal(d['seed'], protocol['splitSalt']) for d in deals])
        choice = metadata[:,3] > 1
        counts = np.bincount(groups[choice], minlength=len(deals))
        if int(choice.sum()) != protocol['choiceRows'] or len(groups) != n or np.any(counts == 0):
            raise RuntimeError('Unexpected corpus shape or empty choice cluster')
        split_record = {str(k): [d['seed'] for i,d in enumerate(deals) if split[i] == k] for k in range(3)}
        write(run_path/'split.json', split_record)
        sys.path.insert(0, str(ROOT/'ai/danMCai/training/continuous'))
        import torch
        from value_net import ValueNet, load_onnx_weights
        torch.set_num_threads(1)
        if not torch.cuda.is_available() or not torch.version.hip:
            raise RuntimeError('Registered ROCm GPU unavailable; no backend substitution')
        net = ValueNet(load_onnx_weights(teacher['file'])).to('cuda:0').eval()
        net.requires_grad_(False)
        def fingerprint():
            return hashlib.sha256(b''.join(p.detach().cpu().numpy().tobytes() for p in net.parameters())).hexdigest()
        before = fingerprint()
        if len(list(net.parameters())) != 12:
            raise RuntimeError('Expected twelve frozen parameter groups')
        state.update(provider='ROCm cuda:0 frozen forward / CPU float64 ridge', device=torch.cuda.get_device_name(0), parameterGroups=12)
        def hidden(indices):
            with torch.inference_mode():
                h = torch.as_tensor(np.array(features[indices], dtype='float32'), device='cuda:0')
                for layer in net.layers[:-1]:
                    h = torch.tanh(layer(h))
                q = net.layers[-1](h).squeeze(-1).cpu().numpy()
                error = float(np.max(np.abs(q-labels[indices,0])))
                state['maxQDifference'] = max(state.get('maxQDifference',0), error)
                if error > protocol['qTolerance']:
                    raise RuntimeError('Frozen GPU Q mismatch')
                return h.cpu().numpy().astype('float64')
        train_indices = np.flatnonzero(choice & (split[groups] == 0))
        hidden(train_indices[:256])
        state['gpuForwardPreflightPassed'] = True
        check('train-moments', True)
        moments = [[0.,np.zeros(p),0.,np.zeros((p,p)),np.zeros(p)] for p in (620,565)]
        models = [('extras',0,np.arange(567,620)), ('raw',0,np.arange(567)), ('rawExtras',0,np.arange(620)),
                  ('hidden',1,np.arange(512)), ('hiddenExtras',1,np.arange(565))]
        fits, validation = [], np.zeros((5,len(protocol['penalties'])))
        test_sse = np.zeros((len(deals),6))
        for phase in range(3):
            indices = np.flatnonzero(choice & (split[groups] == phase))
            for start in range(0,len(indices),2048):
                check(['train-moments','validation','test'][phase])
                idx = indices[start:start+2048]
                h = hidden(idx)
                e = np.array(extras[idx], dtype='float64')
                x = [np.concatenate((features[idx],e), axis=1), np.concatenate((h,e), axis=1)]
                y = labels[idx,1].astype('float64') - labels[idx,0]
                w = 1/counts[groups[idx]]
                if phase == 0:
                    for m,a in zip(moments,x):
                        m[0] += w.sum(); m[1] += w@a; m[2] += w@y
                        m[3] += a.T@(a*w[:,None]); m[4] += a.T@(w*y)
                elif phase == 1:
                    for j,(_,block,columns) in enumerate(models):
                        for k,(beta,intercept) in enumerate(fits[j]):
                            validation[j,k] += np.sum(w*(y-x[block][:,columns]@beta-intercept)**2)
                else:
                    errors = [(y-baseline)**2]
                    for j,(_,block,columns) in enumerate(models):
                        beta,intercept = fits[j][selected[j]]
                        errors.append((y-x[block][:,columns]@beta-intercept)**2)
                    for j,err in enumerate(errors):
                        test_sse[:,j] += np.bincount(groups[idx], weights=err, minlength=len(deals))
                state['completedPositions'] += len(idx)
            if phase == 0:
                check('fit-ridge',True)
                for _,block,columns in models:
                    fits.append([ridge(moments[block],columns,p) for p in protocol['penalties']])
                    check()
                baseline = float(moments[0][2]/moments[0][0])
            if phase == 1:
                selected = validation.argmin(axis=1)
                state['selectedPenalties'] = {m[0]: protocol['penalties'][int(k)] for m,k in zip(models,selected)}
                check('test',True)
        test_errors = test_sse[split==2]/counts[split==2,None]
        interval = paired_intervals(test_errors,protocol['bootstrapSeed'],protocol['bootstrapReplicates'],lambda: check('bootstrap'))
        if fingerprint() != before or any(p.grad is not None for p in net.parameters()):
            raise RuntimeError('Frozen network mutated or gradient exists')
        upper = interval['ci95']
        result = dict(state, phase='complete', completedAtUTC=now(), sourceSHA=actual,
                      splitSHA256=sha(run_path/'split.json'), splitDeals=[int((split==k).sum()) for k in range(3)],
                      splitChoiceRows=[int(np.sum(choice & (split[groups]==k))) for k in range(3)],
                      dataDeals=len(deals), modelNames=['baseline']+[m[0] for m in models],
                      testMeanSquaredError=test_errors.mean(axis=0).tolist(), validationWeightedSSE=validation.tolist(),
                      intervals=interval, parameterSHA256Before=before, parameterSHA256After=fingerprint(),
                      ridgeFits=15, conservativeInputClosureCondition=bool(upper[0][1]<.01 and upper[6][1]<.01),
                      scope='Existing champion trajectories, independent complete single-round deal split; conditional statistical inference, no match or policy-strength acceptance. Tactical and privileged labels unused.')
        write(run_path/'results.json',result)
        state.update(phase='complete',completedAtUTC=result['completedAtUTC'])
        check(force=True)
    except Exception as error:
        state.update(phase='stopped' if 'STOP or fixed deadline' in str(error) else 'failed', error=str(error), stoppedAtUTC=now(), updatedAtUTC=now())
        write(run_path/'status.json',state)
        raise
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--run',required=True)
    run(parser.parse_args().run)
