import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { sampleWorlds } from '../../shared/search/belief.mjs';
import { searchObservation } from '../../shared/search/pimc.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { features, publicView } from '../belief/features.mjs';
import {
  CHAMPION_SHA256,
  DEFAULT_CHAMPION,
  buildProtocol,
  compareRows,
  compareRuns,
  createConfig,
  maskHidden,
  netChoice,
  playPair,
  sampleSearchWorlds,
  searchDecision,
  searchRootsOf,
  sourceClosure,
  summarize,
  worldSeed,
} from '../belief/midgame-search.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SMOKE_BELIEF = join(here, '../workspace/belief-smoke/model/belief.onnx');
const ROLLOUT2_RUN = join(here, '../workspace/rollout2-D-net2/part-0.jsonl');
const haveChampion = existsSync(DEFAULT_CHAMPION);
const haveBelief = existsSync(SMOKE_BELIEF);
const remaining = (game) => game.hands.reduce((n, h) => n + h.length, 0);

/** Random legal play until a real decision with <= `hi` cards on the table (no network needed). */
function randomPosition(seed, hi = 40) {
  const game = createRound(seed);
  const random = seededRandom(seed ^ 0x5bd1e995);
  for (;;) {
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    if (remaining(game) <= hi && plays.length > 1 && game.log.length > 20) return game;
    if (advanceRound(game, plays[Math.floor(random() * plays.length)])) return null;
  }
}

function position(seed) {
  for (let s = seed; ; s++) {
    const game = randomPosition(s);
    if (game) return { game, seed: s };
  }
}

/** Same public state, hidden cards of the three other seats reshuffled with the same counts. */
function permuteHidden(game, seed) {
  const seat = game.turn;
  const pool = game.hands.flatMap((hand, s) => (s === seat ? [] : hand));
  const random = seededRandom(seed);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  let at = 0;
  const hands = game.hands.map((hand, s) =>
    s === seat ? hand.slice() : pool.slice(at, (at += hand.length)),
  );
  return {
    ...game,
    hands,
    levels: game.levels.slice(),
    log: game.log.slice(),
    out: game.out.slice(),
  };
}

const ids = (game) => game.hands.map((h) => h.map((c) => c.id).sort((a, b) => a - b));

test('netChoice: net-d guard, champion tie-break and plain argmax at d = 0', () => {
  const roots = [4, 1, 7];
  const base = [0, 0.5, 0, 0, 0.9, 0, 0, 0.2];
  // champion = 4 (root 0). Candidate 1 beats it in 1 of 3 worlds, else ties: higher mean, net 1.
  let outcome = [
    [1, 2, -1],
    [1, 1, -1],
    [1, 1, -1],
  ];
  let means = [1, 4 / 3, -1];
  assert.equal(netChoice({ roots, championIndex: 4, means, outcome, base, net: 2 }).index, 4);
  assert.equal(netChoice({ roots, championIndex: 4, means, outcome, base, net: 1 }).index, 1);
  assert.equal(netChoice({ roots, championIndex: 4, means, outcome, base, net: 0 }).index, 1);
  // Net 2 by many small wins but a lower mean: not allowed.
  outcome = [
    [1, 2, 0],
    [1, 2, 0],
    [3, -3, 0],
  ];
  means = [5 / 3, 1 / 3, 0];
  const r = netChoice({ roots, championIndex: 4, means, outcome, base, net: 2 });
  assert.equal(r.index, 4);
  assert.equal(r.gain, 0);
  // Two allowed candidates with equal top mean: champion Q decides (base[1] 0.5 > base[7] 0.2).
  outcome = [
    [-1, 2, 2],
    [-1, 2, 2],
    [-1, 2, 2],
  ];
  means = [-1, 2, 2];
  const t = netChoice({ roots, championIndex: 4, means, outcome, base, net: 2 });
  assert.equal(t.index, 1);
  assert.deepEqual(t.tied, [1, 7]);
  assert.equal(t.gain, 3);
  // d = 0, every root ties: champion (highest Q) kept.
  outcome = [[0, 0, 0]];
  assert.equal(
    netChoice({ roots, championIndex: 4, means: [0, 0, 0], outcome, base, net: 0 }).index,
    4,
  );
  assert.throws(() => netChoice({ roots, championIndex: 3, means, outcome, base, net: 2 }));
});

test('searchRootsOf: champion top-K by Q (ties by index) plus pass', () => {
  const plays = [null, 'a', 'b', 'c', 'd'];
  assert.deepEqual(searchRootsOf([0.1, 0.9, 0.5, 0.9, 0.2], plays, 2), [1, 3, 0]);
  assert.deepEqual(searchRootsOf([0.95, 0.9, 0.5, 0.9, 0.2], plays, 2), [0, 1]);
  assert.deepEqual(searchRootsOf([0.1, 0.9, 0.5], ['x', 'y', 'z'], 6), [1, 2, 0]);
});

test('uniform worlds are rollout2 worlds; seeded by (deal seed, ply); same for every candidate', async () => {
  const { game, seed } = position(3_838_129_500);
  const cfg = { worldsSource: 'uniform', worlds: 5 };
  const masked = maskHidden(game, game.turn);
  const { worlds, probs } = await sampleSearchWorlds(masked, seed, cfg);
  assert.equal(probs, null);
  assert.equal(worldSeed(seed, game.log.length), (seed * 1009 + game.log.length * 7919) >>> 0);
  assert.deepEqual(
    worlds,
    sampleWorlds(searchObservation(game, game.turn), {
      count: 5,
      seed: worldSeed(seed, game.log.length),
    }),
  );
  assert.deepEqual((await sampleSearchWorlds(masked, seed, cfg)).worlds, worlds);
  assert.notDeepEqual((await sampleSearchWorlds(masked, seed + 1, cfg)).worlds, worlds);
  for (const hands of worlds) {
    assert.deepEqual(
      hands.map((h) => h.length),
      game.hands.map((h) => h.length),
    );
    assert.deepEqual(
      hands[game.turn],
      game.hands[game.turn].map((c) => c.id),
    );
  }
});

test('masking: hidden cards cannot be read; public inputs are invariant to hidden permutations', async () => {
  const { game, seed } = position(3_838_129_600);
  const masked = maskHidden(game, game.turn);
  const other = [1, 2, 3].map((r) => (game.turn + r) % 4).find((s) => game.hands[s].length);
  assert.throws(() => masked.hands[other][0].id, /Hidden card read/);
  assert.equal(masked.hands[other].length, game.hands[other].length);
  const permuted = permuteHidden(game, 99);
  assert.notDeepEqual(ids(permuted), ids(game));
  assert.deepEqual(
    features(publicView(maskHidden(permuted, game.turn), game.turn)),
    features(publicView(game, game.turn)),
  );
  const cfg = { worldsSource: 'uniform', worlds: 6 };
  assert.deepEqual(
    (await sampleSearchWorlds(maskHidden(permuted, game.turn), seed, cfg)).worlds,
    (await sampleSearchWorlds(masked, seed, cfg)).worlds,
  );
});

test('buildProtocol: champion SHA check and belief held-out seed check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'midgame-protocol-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'not the champion');
    const belief = join(dir, 'belief.onnx');
    writeFileSync(belief, 'belief bytes');
    writeFileSync(
      join(dir, 'train-report.json'),
      JSON.stringify({ dataProtocols: [{ seeds: [100, 199] }] }),
    );
    const base = { start: '200', pairs: '10', champion };
    assert.throws(() => buildProtocol(base), /not the frozen 017/);
    const uniform = buildProtocol({ ...base, 'allow-champion': '1' });
    assert.equal(uniform.worldsSource, 'uniform');
    assert.deepEqual(
      [uniform.lo, uniform.hi, uniform.worlds, uniform.k, uniform.net, uniform.tieBreak],
      [21, 40, 8, 6, 2, 'champion'],
    );
    assert.equal(uniform.beliefSHA256, null);
    const ok = { ...base, 'allow-champion': '1', 'worlds-source': 'belief', belief };
    const p = buildProtocol(ok);
    assert.match(p.beliefSHA256, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.beliefTrainingSeeds, [[100, 199]]);
    assert.throws(() => buildProtocol({ ...ok, start: '150' }), /overlap/);
    assert.throws(() => buildProtocol({ ...base, 'allow-champion': '1', belief }), /only used/);
    assert.throws(() => buildProtocol({ ...ok, 'worlds-source': 'oracle' }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sourceClosure records every statically imported module', () => {
  const sources = sourceClosure();
  for (const file of [
    'ai/danMCai/belief/midgame-search.mjs',
    'ai/danMCai/belief/sampler.mjs',
    'ai/danMCai/belief/features.mjs',
    'ai/shared/simulation/simulation.mjs',
    'ai/shared/search/belief.mjs',
    'web/src/ai/candidates.js',
    'web/src/core/combinations.js',
  ])
    assert.match(sources[file], /^[0-9a-f]{64}$/, file);
});

test('compare mode: paired difference with a deal-cluster interval on common prefix seeds', () => {
  const row = (seed, mean) => ({ seed, mean, a: { points: 0 }, b: { points: 0 }, ms: 1 });
  const A = [row(10, 1), row(11, -1), row(12, 0), row(13, 2)];
  const B = [row(10, 1), row(11, 0.5), row(12, -1), row(14, 3)];
  const c = compareRows(A, B);
  // common seeds 10..12; diffs 0, 1.5, -1
  assert.equal(c.commonPairs, 3);
  assert.deepEqual(c.seeds, [10, 12]);
  const diffs = [0, 1.5, -1];
  const mean = 0.5 / 3;
  const sd = Math.sqrt(diffs.reduce((s, x) => s + (x - mean) ** 2, 0) / 2);
  assert.ok(Math.abs(c.meanDifference - mean) < 1e-12);
  assert.ok(Math.abs(c.sdDifference - sd) < 1e-12);
  assert.ok(Math.abs(c.ci95[0] - (mean - (1.96 * sd) / Math.sqrt(3))) < 1e-12);
  assert.ok(Math.abs(c.ci95[1] - (mean + (1.96 * sd) / Math.sqrt(3))) < 1e-12);
  assert.deepEqual([c.pairsIdentical, c.pairsBBetter, c.pairsABetter], [1, 1, 1]);
  assert.equal(c.meanA, 0);
  assert.ok(Math.abs(c.meanB - 0.5 / 3) < 1e-12);

  const dir = mkdtempSync(join(tmpdir(), 'midgame-compare-'));
  try {
    const write = (name, run, parts) => {
      const d = join(dir, name);
      mkdirSync(d);
      writeFileSync(join(d, 'run.json'), JSON.stringify(run));
      parts.forEach((rows, i) =>
        writeFileSync(join(d, `part-${i}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n')),
      );
      return d;
    };
    const run = { start: 10, workers: 2, championSHA256: 'c', worldsSource: 'uniform', net: 2 };
    // A: 10..13 complete; B: 10, 11, 12, 14 (13 missing -> prefix 10..12).
    const dA = write('a', run, [
      [A[0], A[2]],
      [A[1], A[3]],
    ]);
    const dB = write('b', { ...run, worldsSource: 'belief', beliefSHA256: 'x' }, [
      [B[0], B[2], B[3]],
      [B[1]],
    ]);
    const r = compareRuns(dA, dB);
    assert.deepEqual(r.prefixPairs, [4, 3]);
    assert.equal(r.commonPairs, 3);
    assert.ok(Math.abs(r.meanDifference - mean) < 1e-12);
    assert.deepEqual(r.settingDifferences, {
      worldsSource: ['uniform', 'belief'],
      beliefSHA256: [null, 'x'],
    });
    const dC = write('c', { ...run, championSHA256: 'other' }, [[A[0]], [A[1]]]);
    assert.throws(() => compareRuns(dA, dC), /different champions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const s = summarize([row(1, 1), row(2, -1)]);
  assert.equal(s.meanSignedPoints, 0);
  assert.equal(s.pairs, 2);
});

/** Champion-backed tests (skipped when the frozen champion copy is not on this machine). */
async function championConfig(overrides) {
  const ort = await import('onnxruntime-node');
  return createConfig(
    {
      mode: 'search',
      worldsSource: 'uniform',
      champion: DEFAULT_CHAMPION,
      lo: 21,
      hi: 40,
      worlds: 8,
      k: 6,
      net: 2,
      tieBreak: 'champion',
      ...overrides,
    },
    ort,
  );
}

test(
  'uniform search reproduces the recorded rollout2 --net=2 rounds',
  { skip: !(haveChampion && existsSync(ROLLOUT2_RUN)) && 'champion or rollout2 record missing' },
  async () => {
    const { createHash } = await import('node:crypto');
    assert.equal(
      createHash('sha256').update(readFileSync(DEFAULT_CHAMPION)).digest('hex'),
      CHAMPION_SHA256,
    );
    const recorded = new Map(
      readFileSync(ROLLOUT2_RUN, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .map((r) => [r.seed, r]),
    );
    const cfg = await championConfig({});
    try {
      for (const seed of [3_838_090_000, 3_838_090_002]) {
        const want = recorded.get(seed);
        const got = await playPair(seed, cfg);
        assert.equal(got.mean, want.mean, `seed ${seed}`);
        for (const side of ['a', 'b'])
          for (const key of [
            'points',
            'order',
            'plies',
            'bandDecisions',
            'searched',
            'differs',
            'ties',
            'inferences',
            'candidatesSearched',
            'gainEstimate',
          ])
            assert.deepEqual(got[side][key], want[side][key], `seed ${seed} ${side} ${key}`);
      }
    } finally {
      await cfg.close();
    }
  },
);

test(
  'champion mode pairs score 0; an unreachable net-d threshold plays exactly the champion',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const champion = await championConfig({ mode: 'champion' });
    const guarded = await championConfig({ worlds: 2, k: 2, net: 3, lo: 21, hi: 30 });
    try {
      for (const seed of [3_838_129_900, 3_838_129_901]) {
        const c = await playPair(seed, champion);
        assert.equal(c.mean, 0);
        assert.equal(c.a.searched, 0);
        const g = await playPair(seed, guarded);
        assert.equal(g.a.differs + g.b.differs, 0);
        assert.deepEqual([g.a.order, g.b.order], [c.a.order, c.b.order]);
        assert.equal(g.mean, 0);
      }
    } finally {
      await champion.close();
      await guarded.close();
    }
  },
);

test(
  'search decision (both sources) is invariant to a permutation of the hidden hands',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const sources = haveBelief ? ['uniform', 'belief'] : ['uniform'];
    for (const worldsSource of sources) {
      const cfg = await championConfig({
        worldsSource,
        belief: haveBelief ? SMOKE_BELIEF : null,
        worlds: 3,
        k: 3,
        net: 1,
      });
      try {
        for (const start of [3_838_129_700, 3_838_129_800]) {
          const { game, seed } = position(start);
          const permuted = permuteHidden(game, start);
          const x = await searchDecision(game, seed, cfg);
          const y = await searchDecision(permuted, seed, cfg);
          assert.deepEqual(y.worlds, x.worlds);
          assert.deepEqual(y.probs, x.probs);
          assert.deepEqual(y.roots, x.roots);
          assert.deepEqual(y.outcome, x.outcome);
          assert.equal(y.index, x.index);
          assert.equal(x.worlds.length, 3);
          if (worldsSource === 'belief') assert.equal(x.probs.length, 162);
          else assert.equal(x.probs, null);
        }
      } finally {
        await cfg.close();
      }
    }
  },
);

test(
  'belief worlds source plays a full pair with the smoke belief network',
  { skip: !(haveChampion && haveBelief) && 'champion or smoke belief ONNX missing' },
  async () => {
    const cfg = await championConfig({
      worldsSource: 'belief',
      belief: SMOKE_BELIEF,
      worlds: 2,
      k: 2,
      lo: 21,
      hi: 30,
    });
    try {
      const r = await playPair(3_838_129_950, cfg);
      assert.ok(Number.isInteger(r.a.points) && Number.isInteger(r.b.points));
      assert.ok(r.a.searched + r.b.searched > 0);
      assert.ok(r.a.beliefMs + r.b.beliefMs > 0);
      assert.equal(r.a.searched, r.a.bandDecisions);
    } finally {
      await cfg.close();
    }
  },
);
