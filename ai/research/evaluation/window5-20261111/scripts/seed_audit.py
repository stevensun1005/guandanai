#!/usr/bin/env python3
"""Window-5 seed audit (PLAN section 6): window 4's scripts/seed_audit.py with the window-5 ranges.
Its verdict must be "clean" before any launch (W5-0). Window 5 has no continuous-trainer actors (L1 is
a learner fed by the search actor's deal seeds), so the actor namespace is reported, not chosen.
Original window-3 docstring follows.
Window-3 seed audit (plan S0, section 6). Read-only: greps the repository, the evaluation
folders and runtime metadata for every reserved range, checks structured ranges in runtime JSON
(start+pairs, seeds [a, b], seedRange) for overlap, runs the assertHeldOut rule against every belief
model's training ranges, and reads actor nextSeed values to pick a fresh actorSeedOffset.
Writes seed-audit.json next to this script's parent directory."""
import glob, hashlib, json, os, re, sys, datetime

WT = '/Users/stevensun/Desktop/guandanai/.claude/worktrees/pull-latest-version-59e42e'
# W5-0 runs under launchd, which cannot read ~/Desktop: it passes --repo=<RT/src-e> (the frozen copy of
# main). Unreadable roots are listed in couldNotCheck, never silently skipped.
for _a in sys.argv[1:]:
    if _a.startswith('--repo='):
        WT = _a.split('=', 1)[1]
MAIN = '/Users/stevensun/Desktop/guandanai'
RT = '/Users/stevensun/guandan-runtime.noindex'
OUT = os.path.join(RT, 'window5-20261111', 'seed-audit.json')
SELF = '/window5-20261111/'

# Plan section 6 ranges as written. They all lie above 2^32 - 1 = 4,294,967,295: generate.mjs
# (uint32 shard metadata) and midgame-search.mjs buildProtocol refuse them, and seededRandom
# (`seed |= 0`) would alias each to seed - 2^32. They are replaced one for one by a 429x block
# (same use, same size, last digits kept where possible); both are audited.
# Window 5 (PLAN section 6). All < 2^32 (checked below).
PLAN_RANGES = []
RESERVED = [('C2 slot %d deals (in order, blocks of 100)' % s, 4290400000 + 10000 * s, 4290400000 + 10000 * s + 9999) for s in range(10)] + [
    ('D5 fault check pairs', 4290500000, 4290500399),
    ('ACC5 held-out pairs (conditional)', 4290510000, 4290511999),
]
# Released unused (DEV-1 pair match dropped, review R3): audited as free, never played.
RELEASED = [('DEV-1 pair match (dropped, R3)', 4290520000, 4290520599)]
# Ranges used by earlier work that window 5 reuses on purpose: reported, not a collision.
INTENDED_REUSE = [
    ('G1 log loss = S4c validation seeds (third use: v1b, then v2a; weakens that test, stated R8)', 3990000000, 3990000299),
    ('smoke units only (window-3 S1 parity seeds; no evidence drawn)', 4291000000, 4291000019),
]
# Known used (PLAN section 6) -- every window-5 range must avoid them.
KNOWN_USED = [
    ('GuanZero (4213xxxxxx)', 4213000000, 4213999999),
    ('belief v1 training', 4255121000, 4255160999),
    ('window 4 (S6b, E1-ds, E1-A, D1, B3, GZ, C1, A1)', 4290100000, 4290300999),
    ('window 3 (S1, S4a, damage stops, S4d, S6)', 4291000000, 4294502999),
    ('S4c / G1 log-loss validation', 3990000000, 3990000299),
]
# Literal hits that are reservation notes, not uses: window 3 wrote "new ranges, if ever needed, go in
# 4290100000-4290199999 after an audit (none needed tonight)". No window-3 run.json, summary, log or
# stages.log line holds a 42901xxxxx seed (checked by grep and by the structured scan), so the range is unused.
NOTE_ONLY = {
    'window-3 reservation note (newRangesIfNeeded, never used)': [4290100000, 4290199999],
}
NOTE_FILES = ('/window3-20261109/protocol.json', '/window3-20261109/PLAN_AMENDMENTS.md')
U32 = 2 ** 32
WATCH_BANDS = [(4289000000, U32 - 1), (4300000000, 4329999999)]
WATCH = (4289000000, 4329999999)
TOKEN = re.compile(rb'(?<![0-9])(4[23][0-9]{8})(?![0-9])')
SKIP_DIRS = {'node_modules', '.git', '__pycache__', 'generated', 'checkpoints'}
TEXT_EXT = {'.mjs', '.js', '.json', '.jsonl', '.md', '.py', '.sh', '.txt', '.log', '.html', '.csv', '.yml', '.yaml', '.toml'}
MAX_BYTES = 64 << 20


def overlaps(a, b):
    return [name for name, lo, hi in RESERVED + PLAN_RANGES if a <= hi and lo <= b] + [
        name + ' (32-bit alias of the plan range)' for name, lo, hi in PLAN_RANGES if a <= hi - U32 and lo - U32 <= b]


def watched(v):
    return any(lo <= v <= hi for lo, hi in WATCH_BANDS)


def scan_tree(root, hits, counts, follow_runs=True):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith('dashboard-runtime-')]
        for f in filenames:
            p = os.path.join(dirpath, f)
            if os.path.splitext(f)[1] not in TEXT_EXT:
                continue
            try:
                if os.path.getsize(p) > MAX_BYTES:
                    counts['skippedLarge'].append(p)
                    continue
                data = open(p, 'rb').read()
            except OSError:
                continue
            counts['files'] += 1
            for m in TOKEN.finditer(data):
                v = int(m.group(1))
                # Exclusions are tested on the path INSIDE the repository root: under W5-0 the repository
                # is RT/window5-20261111/src-e, whose absolute paths all contain SELF (launcher fix, 22:20).
                rel = p[len(WT):] if p.startswith(WT) else p
                if watched(v) and SELF not in rel and '/evaluation/window5-20261111/' not in rel:
                    key = p
                    hits.setdefault(key, set()).add(v)


def structured(root_glob_list):
    rows = []
    for pattern in root_glob_list:
        for p in glob.glob(pattern, recursive=True):
            if '/node_modules/' in p or '/dashboard-runtime-' in p:
                continue
            try:
                d = json.load(open(p))
            except Exception:
                continue
            found = []

            def walk(x, path=''):
                if isinstance(x, dict):
                    s = x.get('start')
                    n = x.get('pairs') or x.get('rounds') or x.get('count')
                    if isinstance(s, int) and isinstance(n, int) and s > 10**8:
                        found.append((path + '.start+pairs', s, s + n - 1))
                    for k in ('seeds', 'seedRange', 'range'):
                        r = x.get(k)
                        if isinstance(r, list) and len(r) == 2 and all(isinstance(v, int) for v in r) and r[0] > 10**8:
                            found.append((path + '.' + k, r[0], r[1]))
                    for k, v in x.items():
                        if isinstance(v, (dict, list)):
                            walk(v, path + '.' + k)
                elif isinstance(x, list):
                    for i, v in enumerate(x[:200]):
                        if isinstance(v, (dict, list)):
                            walk(v, f'{path}[{i}]')

            walk(d)
            for where, a, b in found:
                rows.append({'file': p, 'key': where, 'range': [a, b], 'overlapsReserved': overlaps(a, b)})
    return rows


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    hits, counts = {}, {'files': 0, 'skippedLarge': []}
    roots = [os.path.join(WT, 'ai'), os.path.join(WT, 'web', 'src'), os.path.join(WT, 'ai', 'research', 'evaluation'), os.path.join(WT, 'AGENTS.md')]
    for r in [os.path.join(WT, 'ai'), os.path.join(WT, 'web', 'src')]:
        scan_tree(r, hits, counts)
    # runtime: every metadata JSON at any depth (excluding repo checkouts' node_modules and dashboard copies)
    rt_files = []
    for name in ('meta.json', 'protocol.json', 'seeds.json', 'run.json', 'config.json', 'summary.json', 'schedule.json'):
        rt_files += glob.glob(os.path.join(RT, '**', name), recursive=True)
    rt_files = [p for p in rt_files if '/node_modules/' not in p and '/dashboard-runtime-' not in p and SELF not in p]
    for p in rt_files:
        try:
            data = open(p, 'rb').read()
        except OSError:
            continue
        counts['files'] += 1
        for m in TOKEN.finditer(data):
            v = int(m.group(1))
            if watched(v):
                hits.setdefault(p, set()).add(v)
    literal = []
    for p, vals in sorted(hits.items()):
        vals = sorted(vals)
        inside = [v for v in vals if overlaps(v, v)]
        literal.append({'file': p, 'values43xx': vals[:20], 'count': len(vals), 'insideReserved': inside})
    struct = structured([os.path.join(RT, '**', n) for n in ('meta.json', 'protocol.json', 'seeds.json', 'run.json', 'config.json', 'summary.json')])
    struct = [r for r in struct if SELF not in r['file']]
    struct_overlap = [r for r in struct if r['overlapsReserved']]
    # belief training ranges (assertHeldOut rule: [a,b] must not overlap any training range)
    belief = []
    for rep in glob.glob(os.path.join(RT, '**', 'train-report.json'), recursive=True):
        if '/node_modules/' in rep:
            continue
        try:
            d = json.load(open(rep))
            protos = d.get('dataProtocols') or ([d['dataProtocol']] if d.get('dataProtocol') else [])
            ranges = [p['seeds'] for p in protos if isinstance(p.get('seeds'), list)]
        except Exception:
            continue
        if not ranges:
            continue
        bad = [{'reserved': name, 'training': r} for name, lo, hi in RESERVED + PLAN_RANGES for r in ranges if lo <= r[1] and r[0] <= hi]
        belief.append({'trainReport': rep, 'trainingRanges': ranges, 'assertHeldOut': 'pass' if not bad else 'FAIL', 'overlaps': bad})
    # actor namespace
    actors = []
    for d in glob.glob(os.path.join(RT, '*', 'actors')) + glob.glob(os.path.join(MAIN, 'ai', 'danMCai', 'runs', '*', 'actors')):
        for f in glob.glob(os.path.join(d, '*.json')):
            try:
                j = json.load(open(f))
            except Exception:
                continue
            if isinstance(j.get('nextSeed'), int):
                actors.append({'file': f, 'nextSeed': j['nextSeed']})
    cfg_offsets = []
    for p in glob.glob(os.path.join(WT, 'ai', 'research', 'evaluation', '**', '*.json'), recursive=True) + glob.glob(os.path.join(MAIN, 'ai', 'danMCai', 'runs', '*', 'config.json')) + glob.glob(os.path.join(RT, '*', 'config.json')):
        try:
            text = open(p, 'rb').read().decode('utf8', 'replace')
        except OSError:
            continue
        for k in ('actorSeedOffset', 'actorSeedEnd'):
            for m in re.finditer(r'"%s"\s*:\s*(\d+)' % k, text):
                cfg_offsets.append({'file': p, 'key': k, 'value': int(m.group(1))})
    mac_window = [a for a in actors if '/runs/mac-20261105/' in a['file']]
    # window-3 runtime actors (RT/window3-20261109/train/actors) are matched by the RT/*/actors glob? no: they sit one level deeper
    for f in glob.glob(os.path.join(RT, '*', '*', 'actors', '*.json')):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        if isinstance(j.get('nextSeed'), int):
            actors.append({'file': f, 'nextSeed': j['nextSeed']})
    for p in glob.glob(os.path.join(RT, '*', '*-config.json')) + glob.glob(os.path.join(RT, '*', '*', 'config.json')):
        if SELF in p:
            continue
        try:
            text = open(p, 'rb').read().decode('utf8', 'replace')
        except OSError:
            continue
        for k in ('actorSeedOffset', 'actorSeedEnd'):
            for m in re.finditer(r'"%s"\s*:\s*(\d+)' % k, text):
                cfg_offsets.append({'file': p, 'key': k, 'value': int(m.group(1))})
    namespace_used = [a['nextSeed'] for a in actors if a['nextSeed'] < 50_000_000] + [c['value'] for c in cfg_offsets if c['value'] <= 50_000_000]
    max_used = max(namespace_used) if namespace_used else None
    # PLAN section 7 asked for actorSeedOffset 50,000,000 / actorSeedEnd 55,000,000. The trainer cannot take it:
    # actor.mjs / fast-actor.mjs throw unless 0 <= nextSeed < TRAIN_SEED_SPAN = 50,000,000 and supervisor.mjs
    # rejects actorSeedEnd > 50,000,000 (seed = 1e9 + slot*5e7 + nextSeed, so nextSeed >= 5e7 would alias the
    # next slot). The only free block below the span above every used value is 49,000,000-50,000,000.
    chosen = None  # window 5 runs no continuous-trainer actors
    for x in literal:
        if x['insideReserved'] and x['file'].endswith(NOTE_FILES):
            x['classifiedAs'] = 'reservation note only (window 3 newRangesIfNeeded 4290100000-4290199999, never used)'
            x['insideReserved'] = [v for v in x['insideReserved'] if v not in (4290100000, 4290199999)]
    # Unit-test protocol literal: search-actor-history.test.mjs passes start 4290400000 to
    # buildActorProtocol() only (no round is played; its played deals are 4291000000+, window-3 S1
    # parity seeds). Classified, not a use.
    for x in literal:
        if x['file'].endswith('/ai/danMCai/tests/search-actor-history.test.mjs') and x['insideReserved'] == [4290400000]:
            x['classifiedAs'] = 'unit-test protocol literal (buildActorProtocol only; no round played)'
            x['insideReserved'] = []
    literal_bad = [x for x in literal if x['insideReserved']]
    result = {
        'schema': 1,
        'observedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'observedAtToronto': datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-5))).strftime('%Y-%m-%d %H:%M EST'),
        'purpose': 'Window-5 seed audit for PLAN section 6 (window 4 seed_audit.py with the window-5 ranges); read-only; development record',
        'released': [{'use': n, 'range': [a, b], 'literalHits': [x['file'] for x in literal if any(a <= v <= b for v in x['values43xx'])]} for n, a, b in RELEASED],
        'allBelow2pow32': all(b < U32 for _, a, b in RESERVED + INTENDED_REUSE),
        'pairwiseDisjoint': all(not (a1 <= b2 and a2 <= b1) for i, (_, a1, b1) in enumerate(RESERVED) for (_, a2, b2) in RESERVED[i + 1:]),
        'knownUsedOverlaps': [{'reserved': n, 'knownUsed': u} for n, a, b in RESERVED for u, c, d in KNOWN_USED if a <= d and c <= b],
        'intendedReuse': [{'use': n, 'range': [a, b]} for n, a, b in INTENDED_REUSE],
        'reserved': [{'use': n, 'range': [a, b]} for n, a, b in RESERVED],
        'planRangesAsWritten': [{'use': n, 'range': [a, b], 'aliasesTo32bitSeeds': [a - U32, b - U32]} for n, a, b in PLAN_RANGES],
        'scanned': {
            'repositoryRoots': [os.path.join(WT, 'ai'), os.path.join(WT, 'web', 'src')],
            'evaluationFolders': os.path.join(WT, 'ai', 'research', 'evaluation') + ' (inside ai/)',
            'runtimeMetadataFiles': len(rt_files),
            'textFilesScanned': counts['files'],
            'skippedLargeFiles': counts['skippedLarge'],
            'excluded': 'the window-5 reservation files themselves (ai/research/evaluation/window5-20261111/PLAN.md and RT/window5-20261111), node_modules, .git, __pycache__, generated, checkpoints, dashboard-runtime-* checkouts (copies of this repository). Window 3 and window 4 runtime ARE scanned (used seeds).',
        },
        'literal43xxReferences': literal,
        'literalInsideReserved': literal_bad,
        'structuredRanges43xx': [r for r in struct if 4300000000 <= r['range'][1] and r['range'][0] <= 4329999999],
        'structuredRanges429x': [r for r in struct if 4289000000 <= r['range'][1] and r['range'][0] <= U32 - 1],
        'structuredRangesTotal': len(struct),
        'structuredOverlapsReserved': struct_overlap,
        'beliefAssertHeldOut': belief,
        'actorNamespace': {
            'note': 'continuous-trainer actor seeds (TRAIN_SEED_BASE + slot*50,000,000 + nextSeed) are not used in window 5: L1 is a learner fed only by C2 search-actor blocks (deal seeds above); reported for completeness',
            'configuredOffsetsAndEnds': sorted({(c['key'], c['value']) for c in cfg_offsets}),
            'maxUsedWithinSpan': max_used,
        },
        'verdict': 'clean' if not literal_bad and not struct_overlap and all(b['assertHeldOut'] == 'pass' for b in belief) and all(b < U32 for _, a, b in RESERVED) and all(not (a1 <= b2 and a2 <= b1) for i, (_, a1, b1) in enumerate(RESERVED) for (_, a2, b2) in RESERVED[i + 1:]) and not [1 for n, a, b in RESERVED for u, c, d in KNOWN_USED if a <= d and c <= b] else 'COLLISION',
        'couldNotCheck': [r + ' (not readable by this process)' for r in (os.path.join(WT, 'ai'), os.path.join(MAIN, 'ai', 'danMCai', 'runs')) if not os.access(r, os.R_OK | os.X_OK)] + ['seed histories on the Windows machine and other Macs', 'git history of the repository (only the current tree and this Mac\'s runtime folders were scanned)'],
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump(result, f, indent=2, default=list)
    print(json.dumps({'verdict': result['verdict'], 'literalFiles': len(literal), 'literalInsideReserved': len(literal_bad),
                      'structuredOverlaps': len(struct_overlap), 'belief': [(b['trainReport'], b['assertHeldOut']) for b in belief],
                      'maxUsedWithinSpan': max_used,
                      'filesScanned': counts['files']}, indent=1))


if __name__ == '__main__':
    main()
