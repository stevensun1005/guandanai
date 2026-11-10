/**
 * --opponents=champion|search in ai/danMCai/belief/midgame-search.mjs (window 4, plan section 8
 * items 1-2). Parity is checked on decision fields only (points, order, plies, the search and
 * endgame counters, the played log); rows also carry wall-clock timings, which never match.
 *
 *   (a) --opponents=champion reproduces window-3 S1 arm-A rows (deployed 9001 vs raw 017 seats) on
 *       the 20 pairs 4291000000-4291000019 (already used seeds; parity only, no evidence); the
 *       only field allowed to differ is endgameWorldsUsed, the count of worlds solved inside the
 *       3 s per-world wall-clock budget (S1 ran under load), by at most one world per searched
 *       endgame decision and only while every choice, fallback and tie count is identical;
 *       B1_PARITY_OUT=<file> writes the per-seed comparison;
 *   (b) swap identity: --mode=champion --opponents=search round r is the same game as
 *       --mode=search --opponents=champion round 1-r (same seats search, same world seeds), with
 *       negated points: exactly with --endgame=none, points/order only with --endgame=pimc;
 *   (c) the opponents never take the focal raw model (017w).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CHAMPION,
  OPPONENTS,
  buildProtocol,
  compareRows,
  createConfig,
  playPair,
  playRound,
  summarize,
} from '../belief/midgame-search.mjs';

const BELIEF_V1 = '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx';
const S1_A = '/Users/stevensun/guandan-runtime.noindex/window3-20261109/S1/A';
const S1_START = 4_291_000_000;
const haveChampion = existsSync(DEFAULT_CHAMPION);
const haveBelief = existsSync(BELIEF_V1);
const haveS1 = existsSync(join(S1_A, 'run.json'));

/** Decision fields of a midgame-search round row (timings excluded). */
const SEARCH_FIELDS = [
  'bandDecisions',
  'searched',
  'differs',
  'ties',
  'inferences',
  'candidatesSearched',
  'gainEstimate',
  'differPlies',
];
const ENDGAME_FIELDS = [
  'endgameDecisions',
  'endgameSearched',
  'endgameFallbacks',
  'endgameDiffers',
  'endgameTies',
  'endgameWorldsUsed',
  'endgameDifferPlies',
];
const TIMING_FIELDS = new Set([
  'searchMs',
  'beliefMs',
  'endgameMs',
  'endgameMaxMs',
  'endgameBeliefMs',
]);
/** Solved-world count of the endgame search: depends on the solver's wall-clock budget. */
const BUDGET_FIELD = 'endgameWorldsUsed';
const playedLog = (round) => round.log.map((e) => ({ p: e.p, ids: e.cards?.map((c) => c.id) }));

/**
 * The deployed 9001 settings of window-3 S1 arm A (belief v1 worlds, belief PIMC endgame), or the
 * same midgame search without the endgame arm (endgame 'none').
 */
const deployedArgs = (extra = {}, endgame = 'pimc') => ({
  start: String(S1_START),
  pairs: '20',
  'worlds-source': 'belief',
  belief: BELIEF_V1,
  ...(endgame === 'pimc' ? { endgame: 'pimc', 'endgame-worlds': 'belief' } : { endgame: 'none' }),
  ...extra,
});

async function configOf(args, overrides = {}) {
  const ort = await import('onnxruntime-node');
  return createConfig({ ...buildProtocol(args), ...overrides }, ort);
}

test('opponents option: default champion, recorded in the protocol, validated', () => {
  assert.deepEqual(OPPONENTS, ['champion', 'search']);
  const dir = mkdtempSync(join(tmpdir(), 'midgame-opponents-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'champion bytes');
    const base = { start: '200', pairs: '10', champion, 'allow-champion': '1' };
    const plain = buildProtocol(base);
    assert.equal(plain.opponents, 'champion');
    assert.equal(plain.opponentsRule, undefined);
    assert.doesNotMatch(plain.purpose, /other team searches/);
    assert.equal(buildProtocol({ ...base, opponents: 'champion' }).opponents, 'champion');
    const s = buildProtocol({ ...base, opponents: 'search' });
    assert.equal(s.opponents, 'search');
    assert.match(s.opponentsRule, /champion greedy above hi \(never the focal raw network\)/);
    assert.match(s.purpose, /other team searches as well/);
    assert.equal(
      buildProtocol({ ...base, mode: 'champion', opponents: 'search' }).mode,
      'champion',
    );
    assert.throws(() => buildProtocol({ ...base, opponents: 'raw' }), /champion\|search/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // compareRuns treats runs from before the option as --opponents=champion.
  const row = (seed, mean) => ({ seed, mean, a: { points: 0 }, b: { points: 0 }, ms: 1 });
  assert.equal(compareRows([row(1, 1)], [row(1, 0)]).meanDifference, -1);
});

test('(c) the opponents never take the focal raw model (017w)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'midgame-opponents-raw-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'champion bytes');
    const model = join(dir, 'v000083172.onnx');
    writeFileSync(model, '017w bytes');
    const belief = join(dir, 'belief.onnx');
    writeFileSync(belief, 'belief bytes');
    const base = {
      start: '200',
      pairs: '10',
      champion,
      'allow-champion': '1',
      belief,
      'belief-train-report': 'none',
    };
    assert.throws(
      () =>
        buildProtocol({
          ...base,
          mode: 'champion',
          opponents: 'search',
          'focal-raw-model': model,
        }),
      /opponents never take the focal raw model/,
    );
    assert.throws(
      () => buildProtocol({ ...base, mode: 'raw', opponents: 'search', 'focal-raw-model': model }),
      /opponents never take the focal raw model/,
    );
    // Allowed: S6b arm B (focal team 017w above hi inside 9001, opponents = deployed 9001).
    const b = buildProtocol({ ...base, opponents: 'search', 'focal-raw-model': model });
    assert.equal(b.mode, 'search');
    assert.equal(b.opponents, 'search');
    assert.match(b.focalRawModelSHA256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The round loop refuses the same combinations if a config is built by hand.
  const cfg = { mode: 'raw', opponents: 'search', lo: 21, hi: 40 };
  await assert.rejects(() => playRound(S1_START, 0, cfg), /not used with --mode=raw/);
  await assert.rejects(
    () => playRound(S1_START, 0, { ...cfg, mode: 'champion', focalRaw: {}, belief: {} }),
    /needs mode search\|raw/,
  );
  await assert.rejects(() => playRound(S1_START, 0, { ...cfg, opponents: 'x' }), /Unknown/);
});

test(
  '(a) --opponents=champion reproduces window-3 S1 arm-A rows on 20 pairs (decision fields)',
  { skip: !(haveChampion && haveBelief && haveS1) && 'champion, belief v1 or S1 rows missing' },
  async () => {
    const recorded = new Map();
    for (const part of [0, 1, 2])
      for (const line of readFileSync(join(S1_A, `part-${part}.jsonl`), 'utf8').split('\n'))
        if (line.trim()) {
          const row = JSON.parse(line);
          recorded.set(row.seed, row);
        }
    const run = JSON.parse(readFileSync(join(S1_A, 'run.json'), 'utf8'));
    const cfg = await configOf(deployedArgs({ opponents: 'champion' }));
    try {
      assert.equal(cfg.championSHA256, run.championSHA256);
      assert.equal(cfg.beliefSHA256, run.beliefSHA256);
      for (const key of ['mode', 'worldsSource', 'lo', 'hi', 'worlds', 'k', 'net', 'endgame'])
        assert.equal(cfg[key], run[key], key);
      assert.equal(cfg.endgameHi, run.endgameHi);
      assert.equal(cfg.endgameWorlds, run.endgameWorlds);
      const report = [];
      for (let seed = S1_START; seed < S1_START + 20; seed++) {
        const want = recorded.get(seed);
        assert.ok(want, `S1 row ${seed}`);
        const got = await playPair(seed, cfg);
        const entry = { seed, mean: [got.mean, want.mean], budgetOnly: [] };
        report.push(entry);
        assert.equal(got.mean, want.mean, `seed ${seed} mean`);
        for (const side of ['a', 'b']) {
          const g = got[side],
            w = want[side];
          assert.ok(!('opp' in g), 'default rows carry no opp counters');
          // S1 rows come from handover-oracle.mjs and add its own above-hi/oracle fields.
          for (const key of Object.keys(g)) {
            assert.ok(key in w, `seed ${seed} ${side}: ${key} not in the S1 row`);
            if (TIMING_FIELDS.has(key)) continue;
            if (key === BUDGET_FIELD && g[key] !== w[key]) {
              // A world that hit the 3 s per-world solver budget in one run but not the other: the
              // count of solved worlds is wall-clock dependent (S1 ran under window-3 load). It is
              // accepted only when every decision (choices, fallbacks, ties) is identical, at most
              // one world per searched endgame decision apart.
              assert.ok(
                Math.abs(g[key] - w[key]) <= g.endgameSearched,
                `seed ${seed} ${side} ${key}`,
              );
              entry.budgetOnly.push({ side, key, got: g[key], recorded: w[key] });
              continue;
            }
            assert.deepEqual(g[key], w[key], `seed ${seed} ${side} ${key}`);
          }
          for (const key of ['points', 'order', 'plies', ...SEARCH_FIELDS, ...ENDGAME_FIELDS])
            assert.ok(key in g, `${key} recorded`);
        }
      }
      if (process.env.B1_PARITY_OUT)
        writeFileSync(
          process.env.B1_PARITY_OUT,
          JSON.stringify(
            {
              test: '(a) --opponents=champion vs window-3 S1 arm A, decision fields',
              s1Run: join(S1_A, 'run.json'),
              pairs: report.length,
              pairsWithBudgetOnlyDifferences: report.filter((e) => e.budgetOnly.length).length,
              budgetField: BUDGET_FIELD,
              rows: report,
            },
            null,
            2,
          ),
        );
    } finally {
      await cfg.close();
    }
  },
);

/**
 * Swap identity on `seeds`: X = --mode=champion --opponents=search, Y = --mode=search
 * --opponents=champion. X round with focal team r and Y round with focal team 1-r have the same
 * searching seats (team 1-r) and the same world seeds.
 */
async function swapIdentity(seeds, endgame) {
  const args = deployedArgs({}, endgame);
  const X = await configOf({ ...args, mode: 'champion', opponents: 'search' }, { keepLog: true });
  const Y = await configOf({ ...args, mode: 'search', opponents: 'champion' }, { keepLog: true });
  try {
    for (const seed of seeds)
      for (const r of [0, 1]) {
        const x = await playRound(seed, r, X);
        const y = await playRound(seed, 1 - r, Y);
        const at = `seed ${seed} r ${r} endgame ${endgame}`;
        assert.equal(x.points, -y.points, `${at} points`);
        assert.deepEqual(x.order, y.order, `${at} order`);
        assert.ok(x.opp && !('opp' in y), `${at} opp counters only with --opponents=search`);
        // The focal team of X never searches; its band counters still count its decisions.
        assert.equal(x.searched, 0);
        assert.equal(x.differs, 0);
        if (endgame !== 'pimc') {
          assert.equal(x.plies, y.plies, `${at} plies`);
          assert.deepEqual(playedLog(x), playedLog(y), `${at} played log`);
          for (const key of SEARCH_FIELDS)
            assert.deepEqual(x.opp[key], y[key], `${at} opp.${key} vs focal ${key}`);
          assert.ok(!('endgameSearched' in x.opp));
        } else {
          assert.ok('endgameSearched' in x.opp && 'endgameSearched' in y);
          assert.equal(x.endgameSearched, 0);
        }
      }
  } finally {
    await X.close();
    await Y.close();
  }
}

test(
  '(b) swap identity with --endgame=none: same played log, negated points, opp counters = focal counters',
  { skip: !(haveChampion && haveBelief) && 'champion or belief v1 missing' },
  () => swapIdentity([S1_START + 1, S1_START + 2], 'none'),
);

test(
  '(b) swap identity with --endgame=pimc: negated points and the same finishing order',
  { skip: !(haveChampion && haveBelief) && 'champion or belief v1 missing' },
  () => swapIdentity([S1_START + 1, S1_START + 2], 'pimc'),
);

test(
  'four searching seats, same policy on both teams: both rounds are one game, the pair scores 0',
  { skip: !(haveChampion && haveBelief) && 'champion or belief v1 missing' },
  async () => {
    const cfg = await configOf(deployedArgs({ opponents: 'search' }, 'none'), { keepLog: true });
    try {
      const seed = S1_START + 3;
      const a = await playRound(seed, 0, cfg);
      const b = await playRound(seed, 1, cfg);
      assert.equal(a.points, -b.points);
      assert.deepEqual(playedLog(a), playedLog(b));
      for (const key of SEARCH_FIELDS) {
        assert.deepEqual(a.opp[key], b[key], `a.opp.${key} = b.${key}`);
        assert.deepEqual(b.opp[key], a[key], `b.opp.${key} = a.${key}`);
      }
      assert.ok(a.searched + a.opp.searched > 0);
      const row = { seed, a, b, mean: (a.points + b.points) / 2, ms: 1 };
      assert.equal(row.mean, 0);
      assert.ok(!('log' in JSON.parse(JSON.stringify(a))), 'the played log never enters a row');
      const s = summarize([row]);
      assert.equal(s.opponents.searchedDecisions, a.opp.searched + b.opp.searched);
      assert.equal(s.opponents.endgameSearchedDecisions, undefined);
    } finally {
      await cfg.close();
    }
  },
);
