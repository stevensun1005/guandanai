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

def candidate_seeds(start):
    if not 0 <= start < 2**32:
        raise ValueError('Invalid uint32 seed start')
    return range(start,min(2**32,start+1_000_000))


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


def range_conflicts(known, proposed, reserved):
    """Audit up to 200 derived round deals per new match root, including uint32 wrap.

    Historical seeds have mixed match-root/single-round semantics: test both interpretations.
    Unused historical reservations exclude literal roots; do not invent completed games there.
    """
    modulus = 2**32
    inverse = pow(1009, -1, modulus)
    roots = np.sort(np.asarray(list(known), dtype=np.int64))
    literal_as_roots = np.sort((roots * inverse) % modulus)
    conflicts = []
    def hit(values, lo, hi):
        width = hi-lo
        lo %= modulus
        hi = lo+width
        pieces = [(lo, min(hi, modulus))] + ([(0, hi-modulus)] if hi > modulus else [])
        for a,b in pieces:
            i = int(np.searchsorted(values, a))
            if i < len(values) and values[i] < b:
                return int(values[i])
        return None
    for index,(lo,hi) in enumerate(proposed):
        if not 0 <= lo < hi <= modulus:
            raise ValueError('Invalid root interval')
        if any(max(lo,a) < min(hi,b) for a,b in reserved):
            conflicts.append({'range':index,'kind':'reserved-root'})
        for delta in range(-199,200):
            shift = (delta*inverse) % modulus
            old = hit(roots,lo-shift,hi-shift)
            if old is not None:
                conflicts.append({'range':index,'kind':'historical-match-derived','historicalRoot':old,'roundDifference':delta})
                break
        for round_index in range(200):
            shift = (round_index*inverse) % modulus
            old = hit(literal_as_roots,lo+shift,hi+shift)
            if old is not None:
                conflicts.append({'range':index,'kind':'historical-literal-deal','round':round_index})
                break
        for other,(a,b) in enumerate(proposed):
            for delta in range(-199,200):
                if other == index and delta == 0:
                    continue
                shift = (delta*inverse) % modulus
                if hit(np.array([a,b-1],dtype=np.int64),lo-shift,hi-shift) is not None or hit(np.array([lo,hi-1],dtype=np.int64),a+shift,b+shift) is not None:
                    conflicts.append({'range':index,'kind':'new-range-derived','other':other,'roundDifference':delta})
                    break
    return conflicts


def audit(workspace, start, count, training_ranges=None):
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
    if training_ranges:
        conflicts = range_conflicts(known, training_ranges, ranges)
        if conflicts:
            raise ValueError('Training root reservation conflicts: '+json.dumps(conflicts))
        ranges += training_ranges
    inverse = pow(1009, -1, 2**32)
    chosen = []
    for seed in candidate_seeds(start):
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
            'newTrainingRootRanges': training_ranges or [],
            'trainingAudit': 'For each proposed root interval, exclude up to 200 derived deals against historical seeds interpreted both as literal deals and match roots; new intervals also mutually disjoint. Historical unused reservations exclude literal roots, not imaginary completed rounds.',
            'scope': 'Readable local evidence and old audit paths only; unavailable remote machine history is unverified. Excludes 200 possible round deals per known or reserved root.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(__doc__)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--start', type=int, required=True)
    parser.add_argument('--count', type=int, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--training-ranges', type=Path)
    args = parser.parse_args()
    if not 0 <= args.start < 2**32 or not 1 <= args.count <= 40000:
        raise ValueError('Invalid development seed reservation')
    d = audit(args.workspace, args.start, args.count,
              json.loads(args.training_ranges.read_text()) if args.training_ranges else None)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes((json.dumps(d, indent=2)+'\n').encode('utf-8'))
    print(json.dumps({'files': len(d['files']), 'known': d['knownUniqueRootSeeds'], 'reserved': len(d['seeds'])}))
