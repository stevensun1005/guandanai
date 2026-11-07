"""Reserve fresh development/heldout deals against locally readable seed evidence."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re

import numpy as np

ROOT = Path(__file__).resolve().parents[3]


def seeds_in(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == 'seed' and isinstance(item, int):
                yield item
            elif key in ['seeds', 'heldoutSeeds'] and isinstance(item, list):
                yield from (n for n in item if isinstance(n, int))
            else:
                yield from seeds_in(item)
    elif isinstance(value, list):
        for item in value:
            yield from seeds_in(item)


def audit(workspace, start, count):
    public = ROOT / 'ai/research/evaluation'
    files = set(public.rglob('*.json')) | set(public.rglob('*.jsonl.gz'))
    ranges = []
    # Existing audits identify the read-only Mac snapshot and old Windows log locations.
    for p in public.rglob('seed-audit.json'):
        d = json.loads(p.read_text(encoding='utf-8'))
        for item in d.get('files', []):
            path = Path(item['path'])
            if path.is_file():
                files.add(path)
        reservation = d.get('reservations', {})
        if isinstance(reservation, dict) and 'halfOpenRootRanges' in reservation:
            ranges.extend(reservation['halfOpenRootRanges'])
        for r in (reservation.values() if isinstance(reservation, dict) else reservation):
            if isinstance(r, dict):
                ranges.extend(r.get('halfOpenRootRanges', []))
                if 'startInclusive' in r and 'endExclusive' in r:
                    ranges.append((r['startInclusive'], r['endExclusive']))
    runs = workspace / 'ai/danMCai/runs'
    files.update(runs.rglob('results-*.jsonl'))
    files.update(runs.rglob('protocol.json'))
    files.update(runs.rglob('gate-*.json'))
    files.update(runs.rglob('anchor-*.json'))
    # Current champion-restart future roots, not just its observed prefix.
    ranges += [(1_000_000_000 + s * 50_000_000 + 22_000_000,
                1_000_000_000 + s * 50_000_000 + 22_100_000) for s in range(4)]
    ranges += [(base + 900 * 100_000, base + 950 * 100_000)
               for base in [3_500_000_000, 3_600_000_000]]
    known, inspected = set(), []
    for path in sorted({p.resolve() for p in files}):
        # Active append-only logs are audited at a fixed complete-line prefix; future blocks above
        # cover subsequent roots. Never require an active producer to stop for this audit.
        size = path.stat().st_size
        if path.name.endswith('.jsonl'):
            raw = path.read_bytes()[:size]
            raw = raw[:raw.rfind(b'\n') + 1]
            found = set(map(int, re.findall(rb'"seed"\s*:\s*(\d+)', raw)))
        elif path.name.endswith('.gz'):
            raw = path.read_bytes()
            found = set(map(int, re.findall(rb'"seed"\s*:\s*(\d+)', gzip.decompress(raw))))
        else:
            raw = path.read_bytes()
            found = set(seeds_in(json.loads(raw)))
        known.update(found)
        inspected.append({'path': str(path), 'prefixBytes': len(raw),
                          'sha256': hashlib.sha256(raw).hexdigest(), 'seeds': len(found)})
    derived = np.sort(np.asarray([(n * 1009) & 0xffffffff for n in known], dtype=np.int64))
    inverse = pow(1009, -1, 2**32)
    chosen = []
    for seed in range(start, min(1_000_000_000, start + 1_000_000)):
        if seed in known:
            continue
        i = np.searchsorted(derived, seed - 199)
        if i < len(derived) and derived[i] <= seed:
            continue
        if len(derived) and derived[-1] >= seed + 2**32 - 199:
            continue
        roots = [((seed-r) * inverse) & 0xffffffff for r in range(200)]
        if any(lo <= root < hi for root in roots for lo,hi in ranges):
            continue
        chosen.append(seed)
        if len(chosen) == count:
            break
    if len(chosen) != count:
        raise ValueError('Insufficient fresh seeds')
    return {'schema': 1, 'observedAtUTC': datetime.now(timezone.utc).isoformat(),
            'purpose': 'Development validation; exclude from future independent acceptance',
            'files': inspected, 'knownUniqueRootSeeds': len(known), 'seeds': chosen,
            'futureRootRanges': ranges, 'rootOverlap': 0, 'derivedRoundOverlap': 0,
            'scope': 'Readable local evidence and old audit paths only; unavailable remote machine history is unverified. Excludes 200 possible round deals per known or reserved root.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--start', type=int, required=True)
    parser.add_argument('--count', type=int, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if not 0 <= args.start < 1_000_000_000 or not 1 <= args.count <= 40000:
        raise ValueError('Invalid development seed reservation')
    d = audit(args.workspace, args.start, args.count)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes((json.dumps(d, indent=2)+'\n').encode('utf-8'))
    print(json.dumps({'files': len(d['files']), 'known': d['knownUniqueRootSeeds'], 'reserved': len(d['seeds'])}))
