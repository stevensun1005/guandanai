#!/usr/bin/env python3
"""Window 5 protocol.json (PLAN sections 3-8). Written as the v1 draft during the build and re-run
by W5-0 (queue.sh) right after window 4's hard end, which pins the frozen src-e encoders, copies
window 4's final numbers (GZ, S8, C1, A1, S6b, M11, V2a rc 5) and re-verifies the champion.

    python make_protocol.py [--stage=draft|W5-0] [--src=<checkout>]

Champion verification (review R4), from the frozen src (src-e) when it exists, else from origin/main
of the repository: web/src/ai/model-catalog.json defaultId 017 and its source.champion record; the
champion manifest (version v000855042, sha256 462afc99...); the full accept record (gate 330,
decision accept, status complete, challenger sha = the champion sha) with its evidence SHA-256 equal
to the catalog's; and the weight file's SHA-256 computed on the file the stages load. ANY mismatch
-> protocol.json is still written with championVerification.ok = false and the script exits 4:
queue.sh starts nothing (logged).
Existing `launch`, `addendumNotes` and `humanResearch` blocks are kept on re-run.
No calendar date is written as a literal in this file except through the dates of the evidence it
reads (review C1 grep rule: the window's own times come from common.sh tor()).
"""
import datetime
import glob
import hashlib
import json
import os
import subprocess
import sys

R = '/Users/stevensun/guandan-runtime.noindex/window5-20261111'
R4 = '/Users/stevensun/guandan-runtime.noindex/window4-20261110'
REPO = '/Users/stevensun/Desktop/guandanai'
OUT = os.path.join(R, 'protocol.json')
M017 = '/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx'
SHA017 = '462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7'
BELIEF = '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx'
SHAV1 = '16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9'
GZ_SHA = '21300c36c7c273b43274a83fa70dc62ce85be0cc84decc6dda2080548e0096b1'

args = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
STAGE = args.get('stage', 'draft')
SRC = args.get('src') or (os.path.join(R, 'src-e') if os.path.isdir(os.path.join(R, 'src-e')) else None)


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''):
            h.update(c)
    return h.hexdigest()


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def read_json(p, fallback=None):
    try:
        with open(p) as f:
            return json.load(f)
    except Exception:
        return fallback


def repo_file(rel):
    """(bytes, where) of a repository file: the frozen src when given, else origin/main."""
    if SRC:
        p = os.path.join(SRC, rel)
        with open(p, 'rb') as f:
            return f.read(), p
    b = subprocess.run(['git', '-C', REPO, 'show', f'origin/main:{rel}'], capture_output=True, check=True).stdout
    return b, f'origin/main:{rel} ({git_rev("origin/main")[:12]})'


def git_rev(ref, where=REPO):
    try:
        return subprocess.run(['git', '-C', where, 'rev-parse', ref], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None


def frozen_commit(name):
    """RT/<name>.commit (written by scripts/freeze.sh; git cannot reach ~/Desktop under launchd)."""
    try:
        return open(os.path.join(R, name + '.commit')).read().split()[0]
    except Exception:
        return git_rev('HEAD', os.path.join(R, name)) if os.path.isdir(os.path.join(R, name)) else None


now = datetime.datetime.now(datetime.timezone.utc)
now_iso = now.strftime('%Y-%m-%dT%H:%M:%SZ')
prev = read_json(OUT, {}) or {}
if not SRC:
    subprocess.run(['git', '-C', REPO, 'fetch', '-q', 'origin'], capture_output=True)

# ------------------------------------------------------------------ champion verification (R4)
def verify_champion():
    out = {'checkedAt': now_iso, 'source': SRC or 'origin/main ' + (git_rev('origin/main') or '?'), 'problems': []}
    bad = out['problems']
    try:
        cat_b, cat_where = repo_file('web/src/ai/model-catalog.json')
        cat = json.loads(cat_b)
        out['catalog'] = {'file': cat_where, 'sha256': sha_bytes(cat_b), 'defaultId': cat.get('defaultId'),
                          'defaultChoice': (cat.get('selection') or {}).get('defaultChoice'),
                          'danMCaiChampions': (cat.get('selection') or {}).get('danMCaiChampions')}
        if cat.get('defaultId') != '017':
            bad.append(f"catalog defaultId {cat.get('defaultId')} != 017")
        m = next((x for x in cat.get('models', []) if x.get('id') == '017'), None)
        if not m:
            bad.append('catalog has no model 017')
            return out
        if m.get('sha256') != SHA017:
            bad.append(f"catalog 017 sha {m.get('sha256')} != {SHA017}")
        ch = (m.get('source') or {}).get('champion') or {}
        out['catalog']['model017'] = {'version': (m.get('source') or {}).get('version'), 'sha256': m.get('sha256'), 'champion': ch}
        if (m.get('source') or {}).get('version') != 'v000855042':
            bad.append('catalog 017 version is not v000855042')
        man_b, man_where = repo_file(ch.get('manifest', 'ai/research/evaluation/champion-selection-mac-20261106/champion.json'))
        man = json.loads(man_b)
        out['manifest'] = {'file': man_where, 'sha256': sha_bytes(man_b), 'version': man.get('version'), 'weightSHA256': man.get('sha256'), 'since': man.get('since')}
        if man.get('version') != 'v000855042' or man.get('sha256') != SHA017:
            bad.append(f"champion manifest {man.get('version')} {str(man.get('sha256'))[:8]} != v000855042 462afc99")
        last = (man.get('history') or [{}])[-1]
        if last.get('sha256') != SHA017 or last.get('gate') != ch.get('gate'):
            bad.append('champion manifest history does not end with the catalog gate and sha')
        ev_b, ev_where = repo_file(ch.get('evidence', ''))
        ev = json.loads(ev_b)
        ev_sha = sha_bytes(ev_b)
        chal = ev.get('challenger') or {}
        chal_sha = chal.get('sha256') if isinstance(chal, dict) else None
        out['acceptRecord'] = {'file': ev_where, 'sha256': ev_sha, 'expectedSHA256': ch.get('evidenceSHA256'),
                               'decision': ev.get('decision'), 'status': ev.get('status'),
                               'pairs': len(ev['pairs']) if isinstance(ev.get('pairs'), list) else ev.get('pairs'),
                               'wins': ev.get('wins'), 'losses': ev.get('losses'), 'draws': ev.get('draws'),
                               'challengerSHA256': chal_sha, 'finishedAt': ev.get('finishedAt')}
        if ev_sha != ch.get('evidenceSHA256'):
            bad.append(f'accept record sha {ev_sha[:8]} != catalog evidenceSHA256 {str(ch.get("evidenceSHA256"))[:8]}')
        if ev.get('decision') != 'accept' or ev.get('status') != 'complete':
            bad.append(f"accept record decision={ev.get('decision')} status={ev.get('status')}")
        if chal_sha and chal_sha != SHA017:
            bad.append(f'accept record challenger sha {chal_sha[:8]} != 462afc99')
    except Exception as e:  # noqa: BLE001
        bad.append(f'could not read: {e}')
    try:
        w = sha(M017)
        out['weight'] = {'path': M017, 'sha256': w, 'bytes': os.path.getsize(M017)}
        if w != SHA017:
            bad.append(f'weight file sha {w[:8]} != 462afc99')
    except Exception as e:  # noqa: BLE001
        bad.append(f'weight file unreadable: {e}')
    out['ok'] = not bad
    out['rule'] = 'any mismatch -> nothing starts (review R4); the teacher of every C2 seat above 40 and the base of every 9001 arm is this champion'
    return out


champion = verify_champion()


# ------------------------------------------------------------------ encoders (R9, C13)
def encoders():
    out = {}
    for key, rel in (('history.mjs', 'ai/guanzero/training/history.mjs'),
                     ('history_reference.py', 'ai/guanzero/training/history_reference.py'),
                     ('encoding.mjs', 'web/src/ai/encoding.mjs'),
                     ('search-actor.mjs', 'ai/danMCai/training/continuous/search-actor.mjs'),
                     ('learner.py', 'ai/danMCai/training/continuous/learner.py'),
                     ('value_net.py', 'ai/danMCai/training/continuous/value_net.py'),
                     ('wrap_initial.py', 'ai/danMCai/training/continuous/wrap_initial.py'),
                     ('corpus-feed.py', 'ai/danMCai/training/continuous/corpus-feed.py'),
                     ('midgame-search.mjs', 'ai/danMCai/belief/midgame-search.mjs'),
                     ('belief/train.py', 'ai/danMCai/belief/train.py'),
                     ('panel-scorer.mjs', 'ai/danMCai/belief/panel-scorer.mjs'),
                     ('metrics.mjs', 'ai/danMCai/belief/metrics.mjs')):
        try:
            b, where = repo_file(rel)
            out[key] = {'file': where, 'sha256': sha_bytes(b)}
        except Exception:
            out[key] = {'file': rel, 'sha256': None, 'note': 'not present in ' + (SRC or 'origin/main')}
    return out


# ------------------------------------------------------------------ window 4 final numbers (W5-0)
def stages_log_lines(path, pattern):
    try:
        return [l.rstrip() for l in open(path) if pattern in l]
    except OSError:
        return []


def window4_finals():
    f = {'readAt': now_iso, 'stage': STAGE,
         'note': 'copied from window-4 result files (read-only); descriptive in window 5; GuanZero label = 训练任务名-真实冻结版本 from the catalog entry whose sha256 equals the evaluated file'}
    s6b = read_json(f'{R4}/S6b/compare.json')
    if s6b:
        f['S6b'] = {'file': f'{R4}/S6b/compare.json', 'sha256': sha(f'{R4}/S6b/compare.json'), 'commonPairs': s6b.get('commonPairs'),
                    'meanDifference': s6b.get('meanDifference'), 'ci95': s6b.get('ci95'), 'opponents': '9001 seats (--opponents=search)'}
    f['M11'] = stages_log_lines(f'{R4}/stages.log', ' END M11 ')[-1:]
    f['E1'] = stages_log_lines(f'{R4}/stages.log', ' END E1-ds2 ')[-1:] + stages_log_lines(f'{R4}/stages.log', ' SKIP D1 ')[-1:]
    f['V2a'] = stages_log_lines(f'{R4}/stages.log', 'NOTE V2a: ')[-2:] + stages_log_lines(f'{R4}/stages.log', ' END V2a ')[-1:]
    gz = read_json(f'{R4}/GZ/compare.json')
    if gz:
        sa = read_json(f'{R4}/GZ/A/summary.json', {}) or {}
        sb = read_json(f'{R4}/GZ/B/summary.json', {}) or {}
        f['GZ'] = {'file': f'{R4}/GZ/compare.json', 'sha256': sha(f'{R4}/GZ/compare.json'),
                   'opponentLabel': 'guanzero-adp-io48-385979', 'opponentSHA256': GZ_SHA,
                   'labelSource': 'web/src/ai/model-catalog.json model 026 (run guanzero-adp-io48, version model-000000385979, sha256 21300c36...); replaces "GuanZero-385979" of the window-4 notes',
                   'A': {'label': 'deployed 9001', 'pairs': sa.get('pairs'), 'mean': sa.get('meanSignedPoints'), 'ci95': sa.get('ci95'), 'focalWins': sa.get('focalWins'), 'focalLosses': sa.get('focalLosses')},
                   'B': {'label': '9001 + 017w above 40', 'pairs': sb.get('pairs'), 'mean': sb.get('meanSignedPoints'), 'ci95': sb.get('ci95'), 'focalWins': sb.get('focalWins'), 'focalLosses': sb.get('focalLosses')},
                   'commonPairs': gz.get('commonPairs'), 'BminusA': gz.get('meanDifference'), 'ci95': gz.get('ci95'), 'seeds': gz.get('seeds'),
                   'rules': 'single rounds (createRound), no tribute, paired seat swap; descriptive; not comparable with GuanZero whole-match numbers'}
    s8 = f'{R4}/S8/report.json'
    f['S8'] = {'file': s8, 'sha256': sha(s8), 'note': 'descriptive style diagnostics; summary in window-4 stages.log END S8'} if os.path.exists(s8) else \
        {'status': 'not finished at ' + now_iso, 'lines': stages_log_lines(f'{R4}/stages.log', ' S8')[-2:]}
    c1 = f'{R4}/C1/corpus'
    man = read_json(f'{c1}/manifest.json')
    dones = sorted(glob.glob(f'{c1}/blocks/b*.done.json'))
    recs = [read_json(d, {}) for d in dones]
    f['C1'] = {'dir': c1, 'finishedBlocks': len(dones), 'rounds': sum(r.get('rounds', 0) for r in recs),
               'rows': sum(r.get('rowsWritten', 0) for r in recs), 'peakRSSMB': max([r.get('peakRSSMB', 0) for r in recs] or [0]),
               'manifest': ({'file': f'{c1}/manifest.json', 'sha256': sha(f'{c1}/manifest.json')} if man else 'not written yet at ' + now_iso),
               'blockSHA256': {os.path.basename(d)[:-10]: sha(d) for d in dones} if STAGE == 'W5-0' else 'listed at W5-0',
               'use': 'NOT in L1 (no history columns; public logs not stored; replay inexact); W5-0b reads 20 of its blocks to register 017 above-40 MSE (descriptive). Only the L1-215 fallback would feed it.'}
    a1 = read_json(f'{R4}/A1/throughput.json')
    if a1:
        f['A1'] = {'file': f'{R4}/A1/throughput.json', 'sha256': sha(f'{R4}/A1/throughput.json'),
                   'roundsPerWorkerHour': a1['search'].get('roundsPerWorkerHour'), 'peakRSSMB': a1['search'].get('peakRSSMB'),
                   'note': 'measured beside E1, not an idle-machine figure'}
    return f


def human_research():
    m = read_json(os.path.join(R, 'inputs', 'human-research', 'manifest.json'))
    if not m:
        return 'not written yet: scripts/strip_human.mjs'
    return {'dir': os.path.join(R, 'inputs', 'human-research'), 'manifestSha256': sha(os.path.join(R, 'inputs', 'human-research', 'manifest.json')),
            'rounds': m.get('rounds'), 'droppedTest': m.get('droppedTest'), 'registeredInPanel': m.get('registeredInPanel'),
            'rules': m.get('rules'), 'tool': m.get('tool'), 'trust': m.get('trust'),
            'use': 'H1 only (aggregates; nothing leaves the machine); never committed; not used in any training'}


def scripts_sha():
    return {os.path.basename(p): sha(p) for p in sorted(glob.glob(os.path.join(R, 'scripts', '*'))) if os.path.isfile(p)}


audit = read_json(os.path.join(R, 'seed-audit.json'), {}) or {}
REG = 'not validated vs humans, human teammates, mixed teams or tribute'
BIND = ('every report carries W/L/T counts; rules (single round, createRound, no tribute, single-round metric); seeds; '
        'model fingerprints (017 462afc99..., belief v1 16d76783..., v2a from the addendum); encoder fingerprints (encoders.*); '
        'src-e/src-e2 commits; data use (training / held-out / evaluation); uncertainty; and "' + REG + '"')

stages = {
    'W5-0': {'start': "window-4 HARD_END 23:45 -> 23:50", 'cores': 1, 'cls': 'audit',
             'what': 'compute-process check F1 (pgrep of window-4 compute only; its 8770 dashboard and queue.sh excluded); champion verification R4; window-4 final numbers into this file; seed audit; human-research strip check R7; dashboard 8771',
             'rule': 'seed audit "clean" AND championVerification.ok, else nothing starts'},
    'W5-0b': {'start': 'alongside V2a', 'cores': 1, 'cls': 'descriptive', 'seeds': 'block choice 20261114',
              'what': '017 above-40 MSE vs the whole-round label and its round-cluster SD on 20 C1 blocks; scorer rows/s; registers L1-mse detectable delta and cost (F8c, C8)',
              'outputs': ['L1/baseline-c1.json', 'addendum NOTE W5-0b'], 'rule': None},
    'V2a': {'start': '23:50 (after W5-0), alone with C2 slots 0-1', 'cores': 'MPS + 1', 'cls': 'development',
            'what': 'belief v2a, v1 recipe exactly: hidden 512, batch 1024, lr 3e-4, wd 0.01, dropout 0.3/0.1, suit augmentation, val-mod 10, eval every 1000, max 40,000 steps, seed 20261112, --minutes=55; data window-3 S4a data-v1b (41-108) first, then window-1 H/data and H/data-v2, whole blocks, <= 4,000,000 rows; no structure head',
            'memoryRule': 'rows that fit = (free+inactive - 4 GiB reserve - 2.5 GiB working set) / 1,416 B; >= 4 M -> 4 M; 2-4 M -> trained with the cap stated; < 2 M -> not trained: D5, ACC5, G1-v2a and H1-v2a SKIPPED, C2 gets +1 slot',
            'register': 'V2a.sh (at its registered script SHA, the only writer) appends `REGISTER v2a sha256=<onnx> path=<onnx> rows= steps= stopReason=` to protocol-addendum.jsonl',
            'qualifierC10': 'steps < 40,000 -> "v1 recipe, truncated at n steps" on every G1/D5/ACC5 reading',
            'outputs': ['V2a/model/belief-v2a.onnx', 'V2a/train.json'], 'rule': 'development (val log loss by band vs v1)'},
    'C2': {'cores': '2 -> 3-4 -> 4-6 independent one-worker slots', 'cls': 'data (descriptive)',
           'what': 'search actor, --rows=all --history=1 (schema 2: x/y/e + h.i8 1,080 count-encoded history + m.u8 3 meta); belief-v1 worlds 21-40; exact PIMC <= 20 with 8 belief worlds; raw 017 above 40 with softmax 0.02; blocks of 100 rounds; --max-gb=1.6 per slot; slot s plays 4290400000 + 10,000 s ... + 9,999 in order',
           'start': 'slots 0-1 at "V2a logs training" or "V2a exited" (whichever first), at 00:00 at the latest; more slots at V2a END, H1 END, G1 END and whenever D5/ACC5 release cores, each subject to the memory rule; all stop 08:35',
           'fallback': 'search-actor without --history in src-e -> schema 1 with --rows=all (stated; L1 then runs as L1-215)',
           'partial': 'every slot stop logs `PARTIAL slot=s rounds_lost=n` (n estimated from the unfinished block start time and the slot mean seconds per round)',
           'note': 'above 40 cards the actions are raw 017 (softmax 0.02), not reasoning play: rows above 40 carry labels of rounds whose continuation is reasoning play (R10)',
           'rule': None},
    'L1': {'name': '017h (run name only)', 'start': 'V2a END (MPS free)', 'end': '08:30 (--max-seconds)', 'cores': 'MPS + 1', 'cls': 'development',
           'init': '017 (462afc99) wrapped with 1,295 zero extras (215 public-belief + 1,080 history), wrap_initial.py --width=1295',
           'config': {'extrasMode': 'public-belief-history', 'learner': {'device': 'mps', 'threads': 1, 'trunkFrozen': True, 'learningRate': 0.00001, 'extrasLearningRate': 0.0001,
                      'batch': 2048, 'replayRatio': 8, 'capacity': 1600000, 'minSamples': 100000, 'targetMatchWeight': 0, 'anchorWeight': 0, 'gradClip': 1,
                      'exportSeconds': 3600, 'seed': 20261113}},
           'feed': 'corpus-feed.py: every finished C2 block with index mod 10 != 9 hard-linked as s{slot}-{shard}.* with a rewritten json (C3); mod 10 = 9 -> held-out list; feed.jsonl',
           'stop': 'watcher touches L1/run/STOP on RT/STOP, L1/STOP or at 08:30; learner exports on stop; 0 steps -> L1-mse writes the zero-step note (C4)',
           'fallback': 'item 1, 2 or 3 not in src-e -> L1-215: extrasMode public-belief (215), fed C1 and C2 blocks, same recipe, declared; L1-mse verdict without the history ablation',
           'save': 'final export, learner checkpoint (model + optimizer + RNG) kept for a later authorized window (R1: days 2+ need new owner authorization)',
           'rule': 'none (training)'},
    'L1-mse': {'cls': 'development', 'cores': 1,
               'what': 'per-band MSE (> 40 / 21-40 / <= 20) against the whole-round label on held-out C2 blocks (block index mod 10 = 9 in every slot): raw 017, per-band affine-recalibrated 017 (closed-form least squares on the training blocks), each export; the final export also with history shuffled and with belief shuffled across rows within band (seed 20261115)',
               'ci': '95% round-cluster bootstrap, 2,000 resamples, seed 20261114',
               'hourly': 'descriptive, on the held-out set as it stands',
               'final': 're-scores 017, recalibrated 017, every export and both ablations on ONE held-out set frozen at 08:30; if it would exceed 9 min it subsamples whole rounds (seed 20261114) and states the fraction (C8)',
               'rule': 'READ ONLY AT THE FINAL EXPORT, BAND > 40: delta = MSE(L1) - MSE(recalibrated 017). CI below 0 -> "signal"; CI covers 0 -> "no signal yet"; CI above 0 -> "recipe fault". Delta vs raw 017 and the 21-40 / <= 20 bands are reported, not read. History carries information iff MSE(history-shuffled) - MSE(L1) has its CI above 0; belief likewise. Not a strength measure; hourly exports descriptive.'},
    'H1': {'start': 'V2a END', 'cores': 1, 'cls': 'descriptive',
           'what': 'v1 and v2a log loss per unseen copy on the 1,458 unassisted human positions vs uniform; reads ONLY inputs/human-research (strip_human.mjs copy, R7); aggregates only', 'rule': None},
    'G1': {'start': 'V2a END', 'cores': 2, 'cls': 'descriptive',
           'what': 'S4c true-deal regression on the 160 stored 41-60 positions x 64 worlds, CRN, lanes v1 (control) and v2a-marginal; log loss on 3990000000-3990000299 (third use, R8); sampled opponent bomb ranks vs 1.79 true and longest-sequence class match',
           'rule': 'none: descriptive (R2); the old eligibility thresholds are reported as numbers and not used; G1 never decides whether D5/ACC5 run'},
    'D5': {'cores': 3, 'cls': 'development', 'pairs': 400, 'seeds': [4290500000, 4290500399],
           'start': 'H1 END, if v2a exists (>= 2 M rows) and the D5 code is frozen (src-e2 item 5 by 01:50, else the combined arm from src-e)',
           'arms': 'A = deployed 9001 (21-40, belief v1); B = 9001 reasoning at 21-60 (--hi=60; v1 at 21-40, --belief-upper=v2a at 41-60), or the declared combined arm (v2a in both bands) per F7; both --opponents=champion (raw-017 seats, S6 layout)',
           'measures': 'cA, cB = core-seconds per pair per arm (wall x workers / pairs)',
           'rule': 'ACC5 may run only if >= 200 pairs are done and B-A mean >= -0.20; mean < -0.20 -> ACC5 SKIPPED (fault); < 200 pairs by the time cap -> ACC5 SKIPPED (pace)'},
    'M5': {'cls': 'decision', 'what': 'N = min(2000, floor(0.85 x ACC5 core-seconds available to 08:25 / (cA + cB))); workers split cA:cB so both arms reach N together; N < 600 -> ACC5 SKIPPED, cores to C2'},
    'ACC5': {'cls': 'ACCEPTANCE (the only one; conditional)', 'cores': 4, 'seeds': [4290510000, 4290511999], 'end': '08:25',
             'arms': 'as D5, held-out deals', 'evaluation': 'common contiguous prefix of both arms, n stated',
             'rule': '95% CI of B-A above 0 -> "reasoning 21-60 with v2a" registered as a research search candidate under a new id (not web, champion, default or menu); covers 0 -> zero; below 0 -> negative; reported with power (F6) and the C10 qualifier if it applies'},
    'DEV-1': {'cls': 'development (fault check only)', 'start': '08:31-08:38, needs src-e2 item 7',
              'what': 'zero-wrapped 1,295 017 vs raw 017 on 200 stored positions (values within 1e-5, decisions identical); then the final L1 export: % decisions != 017 and mean |value drift|; no sign or gain reported',
              'rule': 'parity fails -> "inference path fault"; no strength reading'},
    'T-close': {'cls': 'owner task', 'what': 'STOP at 08:40; L1 final export + optimizer saved; C2 manifests with every block SHA; END lines; addendum; window-5 compute gone by 08:55'},
    'T-writeup': {'cls': 'owner task', 'what': 'after 09:00, no compute: MODEL_STUDY sections 78 (window 4) and 79 (window 5), evaluation JSONs, CHANGELOG; clean worktree; npm test, npm run format:check, related Python tests; push main'},
}

protocol = {
    'schema': 1,
    'window': 'window5-20261111',
    'status': f'v1 {"draft (build)" if STAGE == "draft" else "registered at W5-0"} written {now_iso}; filled later by the addendum (protocol-addendum.jsonl): v2a SHA (REGISTER), W5-0b baseline, M5 N, L1 export SHAs, src-e2 commit',
    'plan': {'path': f'{R}/PLAN.md', 'sha256': sha(f'{R}/PLAN.md'), 'draft': f'{R}/PLAN.draft-2105.md',
             'onMain': 'ai/research/evaluation/window5-20261111/PLAN.md (commit 409df69)'},
    'ownerBinding': [
        'Auto-start authorised by the owner. Window 5 ENDS at 09:00 Toronto; no new compute after 08:40; no extension; the 10:00 autonomous-compute authorization limit is not used. Days 2+ of the L1 run need NEW owner authorization (R1).',
        'No web, champion, default or menu change. A positive ACC5 gets a new research-candidate id only.',
        'GuanZero: only its history ENCODING (ai/guanzero/training/history.mjs, count-encoded last 20 public plays x 54) is borrowed; no GuanZero model, weight, label, data, game or pool enters danMCai training or evaluation in window 5.',
        'Every stage smoke-run under launchd before queueing (PLAN section 5).',
        'Dashboard on port 8771 (--host=0.0.0.0, launchd com.guandanai.dashboard8771), a card per stage and owner task, START/END in stages.log; heavy compute only after window 4 compute is gone and not before 23:50.',
        'Whole-round result (signed round points +-1..+-3 of single rounds, no tribute) is the only objective and the only label; no intermediate reward, gate or hand-written tactic (AGENTS).',
        'Human records: only H1, only the stripped copy inputs/human-research, aggregates only, nothing leaves the machine.',
    ],
    'championVerification': champion,
    'encoders': encoders(),
    'frozenCheckouts': {
        'src-e': {'path': f'{R}/src-e', 'commit': frozen_commit('src-e'), 'freeze': '23:35 Toronto (items 1-4)'},
        'src-e2': {'path': f'{R}/src-e2', 'commit': frozen_commit('src-e2'), 'freeze': '01:45 Toronto (items 5-8); commit appended to the addendum when frozen'},
        'nodeModules': 'src/node_modules is a symlink to the Desktop checkout (as window 4); repository sources must resolve under the src (preflight --resolve=1, C13); the trainer venv stays on ~/Desktop as in window 4 (stated)',
    },
    'models': {
        'champion017': {'path': M017, 'sha256': SHA017, 'id': '017', 'version': 'v000855042',
                        'role': 'C2 seats above 40 (softmax 0.02), 9001 arms base, L1 initial network, L1-mse comparator, W5-0b'},
        'beliefV1': {'path': BELIEF, 'sha256': SHAV1, 'trainingSeeds': [[4255121000, 4255160999]], 'trainingBand': [21, 80],
                     'role': 'C2 search worlds and the 162 marginals of every row, 9001 at 21-40, G1/H1 control'},
        'beliefV2a': 'registered by V2a.sh in protocol-addendum.jsonl (REGISTER v2a sha256=...); preflight accepts it from there (C2)',
        'L1exports': 'every L1 export: SHA-256 in stages.log and the addendum before any use (L1-mse, DEV-1)',
        'guanzero': 'none (encoding only)',
    },
    'statistics': {
        'pairedDifferenceSD': 1.415, 'source': 'S6 layout (registered, F6)',
        'SE': {'400': 0.071, '1200': 0.041, '2000': 0.032}, 'mde80': {'400': 0.20, '1200': 0.115, '2000': 0.089},
        'ACC5minimum': 'N < 600 -> ACC5 does not run (detectable effect > 0.16); its cores go to C2',
        'interval': '95% deal-cluster normal interval on the common contiguous prefix (midgame-search --compare)',
        'L1mse': 'round-cluster bootstrap 2,000, seed 20261114; held-out by block (mod 10 = 9), so by deal, never by row',
    },
    'seeds': {
        'auditFile': f'{R}/seed-audit.json', 'auditSha256': sha(f'{R}/seed-audit.json') if os.path.exists(f'{R}/seed-audit.json') else None,
        'auditScriptSha256': sha(f'{R}/scripts/seed_audit.py'), 'verdict': audit.get('verdict'),
        'ranges': {'C2 slot s (s = 0..9)': [4290400000, 4290499999], 'D5': [4290500000, 4290500399], 'ACC5': [4290510000, 4290511999]},
        'released': {'DEV-1 pair match (dropped, R3)': [4290520000, 4290520599]},
        'reuse': {'G1 log loss (third use: S4c, v1b, now v2a; weakens that test, R8)': [3990000000, 3990000299],
                  'smoke units (window-3 S1 parity seeds, no evidence)': [4291000000, 4291000019]},
        'learnerAndStatistics': {'V2a': 20261112, 'L1': 20261113, 'L1-mse bootstrap and W5-0b block choice': 20261114, 'ablation shuffle': 20261115},
        'worldSeeds': '(dealSeed*1009 + ply*7919) >>> 0 inside the search; wraps; harmless, stated',
    },
    'deadlines': {'heavyEarliest': '23:50 Toronto, and only after window 4 compute is gone (F1)',
                  'ACC5': '08:25', 'L1': '08:30 (--max-seconds)', 'C2': '08:35', 'L1-mse final and DEV-1': '08:40',
                  'noNewCompute': '08:40 Toronto = 13:40Z', 'pgrepClean': '08:55 Toronto = 13:55Z (pgrep -f window5-20261111 empty, dashboard excepted)',
                  'hardEnd': '09:00 Toronto = 14:00Z', 'extension': 'none'},
    'memoryRule': {'rule': 'launch iff max(smoke peakRSS, registered peak) x workers + 4 GiB < free + inactive at launch (live), else SKIP/wait logged (F2)',
                   'registeredPeaksMB': {'C2 slot': 2300, 'midgame-search worker (D5/ACC5)': 2300, 'V2a': '1.416 KB x rows + 2.5 GiB', 'L1': '1.6 M x 2.53 KB + 1.5 GiB = 5,397', 'others': 'smoke'},
                   'note': 'launchd smoke peaks under-read real peaks 5-18x (C1 126 MB vs 2.3 GB), hence the registered peaks'},
    'stop': 'RT/STOP (global), RT/<stage>/STOP, RT/C2/slot-s/STOP, L1 watcher -> L1/run/STOP; C2 keeps finished blocks and logs PARTIAL; L1 exports on STOP or the zero-step note; evaluations keep their prefix with n stated',
    'preflight': {'script': f'{R}/scripts/preflight.sh', 'rule': 'PLAN section 5: smoke under the stage\'s own launchd job com.guandanai.w5-<stage>-smoke; inputs listed by node from RT/inputs only; tools imported, numpy/torch with the trainer venv; resolve check (C13); ONNX SHAs vs protocol or addendum; deadline > 60 min ahead (C1); one full-budget unit under /usr/bin/time -l; smoke.json + `SMOKE <stage> rc= rss= s=`'},
    'resultBinding': BIND,
    'stages': stages,
    'window4Finals': window4_finals(),
    'humanResearch': human_research(),
    'scripts': scripts_sha(),
    'deviations': prev.get('deviations', []),
    'launch': prev.get('launch', 'filled at launch (src-e commit, queue start)'),
    'outOfScope': 'L1 acceptance tonight; short fine-tune acceptance or match vs 017; trunk unfreeze; LSTM history; SIR / structure-head sampler; auxiliary targets from search values; C1 in L1 (unless L1-215); GuanZero in any pool, label or teacher role; human records outside H1; Clint; whole-match evaluation; web/champion/default/menu/evaluation-source change; teacher refresh; compute after 08:40',
    'commitPolicy': 'code and tools to main (no runtime data, private inputs or weights); evidence JSON to ai/research/evaluation/window5-20261111/ at T-writeup',
    'writtenAt': now_iso,
}
DEV = [
    'H1 privacy copy (R7): seats[].id are replaced by fixed UUIDs 00000000-0000-4000-8000-00000000000<seat> instead of null, because the record validator (web/src/collection/validate.mjs) requires a UUID per seat; room and seats[].name are nulled; record id / matchId are kept (the scorer pairs the solver panel by them; they are not written to any output).',
    'C2 slot memory rule (src-e review, 22:10 Toronto): from V2a END until L1 ends, each new C2 slot also reserves the part of L1\'s registered peak (5,397 MB) not yet resident (registered peak minus the learner\'s current RSS), because L1\'s 1.6 M-row replay fills over hours and a per-launch reading alone would over-commit (queue.sh l1_reserve_mb).',
    'W5-0 runs seed_audit.py and make_protocol.py with the trainer python ($PY -I, stdlib only), not /usr/bin/python3 (src-e review).',
    'seed_audit.py (launcher, 22:20 Toronto): the repository-literal exclusions (RT/window5-20261111/ and ai/research/evaluation/window5-20261111/) are tested on the path inside the repository root, because W5-0 scans the repository at RT/window5-20261111/src-e, whose absolute paths all contain the RT exclusion; before the fix the W5-0 audit would have skipped every repository file.',
    'Heavy compute and the src-e launchd smokes start only once window 4 compute is gone and at or after 23:50 (owner/launcher instruction), not 23:00-23:45 beside window 4 as PLAN section 5 allowed.',
    'W5-0 compute check (F1) uses an explicit window-4 compute pattern (common.sh WINDOW4_COMPUTE) plus "no com.guandanai.w4-* launchd job other than w4-queue"; the 8770 dashboard and queue.sh are excluded.',
]
protocol['deviations'] = list(dict.fromkeys((protocol['deviations'] or []) + DEV))
tmp = OUT + '.tmp'
with open(tmp, 'w') as f:
    json.dump(protocol, f, indent=1, ensure_ascii=False)
    f.write('\n')
os.replace(tmp, OUT)
print(json.dumps({'protocol': OUT, 'sha256': sha(OUT), 'stage': STAGE, 'championOk': champion['ok'],
                  'championProblems': champion['problems'], 'seedAudit': audit.get('verdict')}))
sys.exit(0 if champion['ok'] and audit.get('verdict') == 'clean' else 4)
