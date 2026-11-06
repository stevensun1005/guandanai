"""Audit known local seeds and prepare two independent copies; never launches training."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import subprocess
from datetime import datetime, timezone

import numpy as np

ROOT = next(p for p in Path(__file__).resolve().parents if (p / 'package.json').is_file())
sys.path.insert(0, str(ROOT / 'ai/danMCai/training/continuous'))
from transfer import digest, verify
spec = importlib.util.spec_from_file_location('prepare_return', ROOT / 'ai/danMCai/training/continuous/prepare-windows-return.py')
PREPARE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(PREPARE)


def seeds_in(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'seed' and isinstance(item, int):
                yield item
            elif key == 'seeds' and isinstance(item, list):
                yield from (s for s in item if isinstance(s, int))
            else:
                yield from seeds_in(item)
    elif isinstance(value, list):
        for item in value:
            yield from seeds_in(item)


def audit(workspace, snapshot):
    known, training, files = set(), set(), []
    roots = [workspace / 'ai/danMCai/runs', workspace / 'ai/danMCai/checkpoints',
             snapshot / verify(snapshot)['sourceRun']]
    paths = set()
    for root in roots:
        paths.update(p.resolve() for p in root.rglob('results-*.jsonl'))
        paths.update(p.resolve() for folder in ['gate', 'anchor'] for p in root.rglob(folder + '/*.json'))
    public = ROOT / 'ai/research/evaluation'
    paths.update(p.resolve() for p in public.rglob('*.json'))
    paths.update(p.resolve() for p in public.rglob('*.jsonl.gz'))
    for path in sorted(paths):
        before = digest(path)
        extracted = set()
        if path.name.endswith('.jsonl') or path.name.endswith('.jsonl.gz'):
            opener = gzip.open if path.name.endswith('.gz') else open
            with opener(path, 'rt', encoding='utf8') as stream:
                for line in stream:
                    extracted.update(seeds_in(json.loads(line)))
        else:
            extracted.update(seeds_in(json.loads(path.read_text(encoding='utf8'))))
        if path.name.startswith('results-'):
            training.update(extracted)
        known.update(extracted)
        if digest(path) != before:
            raise ValueError('Audit input changed: ' + str(path))
        files.append({'path': str(path), 'sha256': before, 'seeds': len(extracted)})
    reservations = {}
    for arm, offset, index in [('A', 8_000_000, 700), ('B', 12_000_000, 800)]:
        ranges = [(1_000_000_000 + slot*50_000_000 + offset,
                   1_000_000_000 + slot*50_000_000 + offset+100_000) for slot in range(4)]
        ranges += [(base+index*100_000, base+(index+50)*100_000) for base in [3_500_000_000, 3_600_000_000]]
        if any(start <= seed < end for start, end in ranges for seed in known):
            raise ValueError('Reserved seed block already used: ' + arm)
        reservations[arm] = {'actorOffset': offset, 'actorEnd': offset+100_000,
                             'evaluationOffset': index, 'evaluationEnd': index+50,
                             'halfOpenRootRanges': ranges}
    ranges = [r for arm in reservations.values() for r in arm['halfOpenRootRanges']]
    for i, (start, end) in enumerate(ranges):
        if any(max(start, s) < min(end, e) for s, e in ranges[i+1:]):
            raise ValueError('Reservations overlap')
    # Conservatively exclude 200 possible per-round seeds for every inspected root.
    derived = np.sort(np.array([(seed*1009) & 0xffffffff for seed in known], dtype=np.int64))
    derived_max = int(derived[-1]) if len(derived) else -1
    inverse = pow(1009, -1, 2**32)
    heldout = []
    for seed in range(940_000_000, 941_000_000):
        if seed in known:
            continue
        left = np.searchsorted(derived, seed-199)
        if left < len(derived) and derived[left] <= seed:
            continue
        if derived_max >= seed + 2**32 - 199:
            continue
        # Future reserved training/gate roots must not generate these held-out deals.
        roots_for_deal = [((seed-r)*inverse) & 0xffffffff for r in range(200)]
        if any(start <= r < end for start, end in ranges for r in roots_for_deal):
            continue
        heldout.append(seed)
        if len(heldout) == 7000:
            break
    if len(heldout) != 7000:
        raise ValueError('Insufficient fresh held-out seeds')
    return {'trainingUniqueRootSeeds': len(training), 'knownUniqueRootSeeds': len(known),
            'files': files, 'reservations': reservations, 'heldoutSeeds': heldout,
            'knownRootOverlap': 0, 'knownDerivedRoundOverlap': 0, 'reservedFutureRootDerivedOverlap': 0,
            'scope': 'Saved local danMCai actor logs, checkpoints, Mac return snapshot and committed evaluation records; excludes 200 potential rounds per root. Absent pre-baseline history and unavailable other-machine runs cannot be audited.'}


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf8')


def finalize(output):
    """Seal tested sources before any first launch; never bypass a started run's fingerprint."""
    plan = json.loads((output/'protocol.json').read_text(encoding='utf8'))
    sources = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        "import {sourceHashes} from './ai/danMCai/training/continuous/sources.mjs'; console.log(JSON.stringify(sourceHashes()))"], cwd=ROOT, text=True))
    configurations = []
    for arm, meta in plan['arms'].items():
        run = Path(meta['run'])
        if any((run/name).exists() for name in ['schedule.json', 'events.jsonl', 'learner/status.json', 'learner/log.jsonl']):
            raise ValueError('Cannot reseal an active or previously started run')
        if list((run/'actors').glob('results-*')) or digest(run/'learner/checkpoint.pt') != meta['prepared']['checkpointSHA256']:
            raise ValueError('Prepared state changed')
        if digest(run/'config.json') != meta['configSHA256']:
            raise ValueError('Prepared config changed outside the registered preparation')
        configurations.append((meta, run, json.loads((run/'config.json').read_text(encoding='utf8'))))
    for meta, run, config in configurations:
        config['sourceSHA256'] = sources
        write(run/'config.json', config)
        meta['configSHA256'] = digest(run/'config.json')
    plan['sourceFinalization'] = {'atUTC': datetime.now(timezone.utc).isoformat(),
        'reason': 'Preparation-only final sealing after tests/formatting; neither run has started',
        'sourceSHA256': sources, 'preparationToolSHA256': digest(Path(__file__))}
    write(output/'protocol.json', plan)
    return {'sealedArms': list(plan['arms']), 'sourceFiles': len(sources), 'started': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', required=True)
    parser.add_argument('--snapshot', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--finalize', action='store_true')
    args = parser.parse_args()
    workspace, snapshot, output = (Path(v).resolve() for v in [args.workspace, args.snapshot, args.output])
    if args.finalize:
        print(json.dumps(finalize(output)))
        return
    if output.exists():
        raise FileExistsError('Choose new preparation output')
    result = audit(workspace, snapshot)
    output.mkdir(parents=True)
    write(output/'seed-audit.json', result)
    runs = {}
    for arm, seed in result['reservations'].items():
        run = ROOT / ('ai/danMCai/runs/windows-ab-20261106-' + arm)
        prepared = PREPARE.prepare(snapshot, ROOT, run, actor_offset=seed['actorOffset'],
                                   actor_end=seed['actorEnd'], evaluation_offset=seed['evaluationOffset'],
                                   evaluation_end=seed['evaluationEnd'])
        config = json.loads((run/'config.json').read_text(encoding='utf8'))
        if arm == 'B':
            config['actorMix'] = {'self': 0.3, 'league': 0.5, 'rule': 0.2}
        write(run/'config.json', config)
        runs[arm] = {'run': str(run), 'prepared': prepared, 'configSHA256': digest(run/'config.json')}
    plan = {'schema': 1, 'status': 'prepared-not-started', 'durationHours': None,
            'recommendedEqualBudgetHours': [4, 6], 'arms': runs,
            'onlyTreatment': {'A': {'self': 0.5, 'league': 0.3, 'rule': 0.2},
                              'B': {'self': 0.3, 'league': 0.5, 'rule': 0.2}},
            'independentEvaluation': {'unit': 'single completed round', 'primary': 'A vs B signed upgrade points per paired deal, nominal cluster 95% CI',
             'headToHeadSeeds': result['heldoutSeeds'][:2000],
             'strata': {name: result['heldoutSeeds'][2000+i*1000:3000+i*1000] for i, name in enumerate(['Clint', 'P0', 'champion-v000855042', 'initial-v001013906', 'Clint-teammate-vs-two-Clint'])},
             'secondary': 'Five common-deal A-minus-B contrasts: Bonferroni cluster 99% intervals; each opponent/teammate W/L/D, signed upgrade points and finishing ranks reported separately',
             'pairing': 'Same 108 physical cards, level and initial leader; swap team assignments; balance mixed teammate seats by seed parity',
             'models': 'Freeze both final arm exports and SHA before any result; do not choose checkpoints using these seeds',
             'execution': 'Not started; final model SHA and bounded evaluation deadline pending. Reuse evaluate-round-pairs.mjs and summarize-round-pairs.py only after freezing them.'},
            'trainingStarted': False, 'scheduleCreated': False, 'formalOptimizerUpdatesExecuted': 0}
    write(output/'protocol.json', plan)
    print(json.dumps({'preparedArms': list(runs), 'trainingStarted': False, 'auditedRoots': result['knownUniqueRootSeeds'], 'heldoutDeals': 7000}))


if __name__ == '__main__':
    main()
