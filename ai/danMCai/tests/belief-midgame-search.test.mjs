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
import { beliefMarginals, createBeliefModel, sampleBeliefWorlds } from '../belief/sampler.mjs';
import { labelDecision } from '../endgame/pimc-actor.mjs';
import { SEARCH, createSearchSolver, playPaired, searchChoice } from '../endgame/evaluate.mjs';
import { argmax } from '../training/continuous/lib.mjs';
import { decisionContext, policyState } from '../../../web/src/ai/observation.js';
import { encodePolicyExtrasBatch } from '../../../web/src/ai/policy-features.mjs';
import {
  BELIEF_MARGINALS,
  CHAMPION_SHA256,
  DEFAULT_CHAMPION,
  FOCAL_RAW_EXTRAS,
  buildProtocol,
  compareRows,
  compareRuns,
  createConfig,
  endgameDecision,
  focalRawDecision,
  focalRawExtras,
  maskHidden,
  netChoice,
  pimcLabelFromWorlds,
  pimcPick,
  playPair,
  playRound,
  rawPolicyState,
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

function position(seed, hi = 40) {
  for (let s = seed; ; s++) {
    const game = randomPosition(s, hi);
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
    'ai/danMCai/endgame/evaluate.mjs',
    'ai/danMCai/endgame/pimc-actor.mjs',
    'ai/danMCai/endgame/solver.mjs',
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

/** Hidden cards (ids, sorted) of every seat except `seat`. */
const hiddenIds = (hands, seat) =>
  hands
    .flatMap((h, s) => (s === seat ? [] : h))
    .map((c) => (typeof c === 'number' ? c : c.id))
    .sort((a, b) => a - b);

test('buildProtocol: endgame defaults, options, band overlap and belief requirements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'midgame-endgame-protocol-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'not the champion');
    const belief = join(dir, 'belief.onnx');
    writeFileSync(belief, 'belief bytes');
    writeFileSync(
      join(dir, 'train-report.json'),
      JSON.stringify({ dataProtocols: [{ seeds: [100, 199], band: [21, 80] }] }),
    );
    const base = { start: '200', pairs: '10', champion, 'allow-champion': '1' };
    const none = buildProtocol(base);
    assert.deepEqual(
      [none.endgame, none.endgameHi, none.endgameWorlds, none.endgameSearch],
      ['none', null, null, undefined],
    );
    assert.throws(() => buildProtocol({ ...base, 'endgame-hi': '20' }), /only used/);
    assert.throws(() => buildProtocol({ ...base, 'endgame-worlds': 'belief' }), /only used/);
    assert.throws(() => buildProtocol({ ...base, endgame: 'exact' }), /none\|pimc/);
    const pimc = buildProtocol({ ...base, endgame: 'pimc' });
    assert.deepEqual([pimc.endgameHi, pimc.endgameWorlds], [20, 'uniform']);
    assert.equal(pimc.endgameSearch.minWorlds, 4);
    assert.deepEqual(pimc.endgameSearch.solver, SEARCH.solver);
    assert.equal(pimc.belief, null);
    // Bands must not overlap: endgame-hi < lo.
    assert.throws(() => buildProtocol({ ...base, endgame: 'pimc', 'endgame-hi': '21' }), /overlap/);
    assert.throws(
      () => buildProtocol({ ...base, endgame: 'pimc', 'endgame-hi': '25', lo: '25' }),
      /overlap/,
    );
    assert.equal(
      buildProtocol({ ...base, endgame: 'pimc', 'endgame-hi': '24', lo: '25' }).endgameHi,
      24,
    );
    assert.throws(() => buildProtocol({ ...base, endgame: 'pimc', 'endgame-worlds': 'x' }));
    // Belief endgame worlds need --belief (also with uniform midgame worlds); seeds checked.
    const eb = { ...base, endgame: 'pimc', 'endgame-worlds': 'belief' };
    assert.throws(() => buildProtocol(eb), /needs --belief/);
    const p = buildProtocol({ ...eb, belief });
    assert.equal(p.worldsSource, 'uniform');
    assert.match(p.beliefSHA256, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.beliefTrainingBands, [[21, 80]]);
    assert.match(p.endgameBeliefNote, /21-80/);
    assert.throws(() => buildProtocol({ ...eb, belief, start: '150' }), /overlap/);
    assert.throws(() => buildProtocol({ ...base, endgame: 'pimc', belief }), /only used/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pimcLabelFromWorlds on uniform worlds equals labelDecision; pimcPick equals searchChoice', () => {
  for (const start of [3_838_129_310, 3_838_129_320, 3_838_129_330]) {
    const { game, seed } = position(start, 14);
    const ply = game.log.length;
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    const wseed = worldSeed(seed, ply);
    const want = labelDecision(game, plays, {
      solver: createSearchSolver(),
      worlds: SEARCH.worlds,
      minWorlds: SEARCH.minWorlds,
      seed: wseed,
    });
    const masked = maskHidden(game, game.turn);
    const worlds = sampleWorlds(searchObservation(masked, game.turn), {
      count: SEARCH.worlds,
      seed: wseed,
    });
    const got = pimcLabelFromWorlds(masked, plays, worlds, createSearchSolver());
    assert.ok(want.q, `seed ${seed} solved`);
    assert.deepEqual(got, want);
    const random = seededRandom(seed);
    const base = plays.map(() => Math.round(random() * 4) / 4); // ties exercise the tie-break
    const choice = searchChoice(game, plays, base, { solver: createSearchSolver(), seed, ply });
    assert.deepEqual(pimcPick(got, base), choice);
  }
  // Not enough solved worlds: no label, no choice.
  assert.deepEqual(pimcPick({ q: null, used: 3 }, [1, 2]), { index: null, used: 3, tied: 0 });
});

test(
  'endgame=pimc + uniform makes evaluate.mjs pimc-search choices (single decisions and whole rounds)',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const cfg = await championConfig({
      endgame: 'pimc',
      endgameHi: 12,
      endgameWorlds: 'uniform',
      lo: 200,
      hi: 200, // no midgame band, so only the endgame arm differs from the champion
    });
    try {
      for (const start of [3_838_129_340, 3_838_129_350, 3_838_129_360]) {
        const { game, seed } = position(start, 14);
        const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
        const base = await cfg.values(DEFAULT_CHAMPION, policyState(game, game.turn, 0, plays));
        const want = searchChoice(game, plays, base, {
          solver: createSearchSolver(),
          seed,
          ply: game.log.length,
        });
        const permuted = permuteHidden(game, start);
        for (const g of [game, permuted]) {
          const d = await endgameDecision(g, seed, cfg);
          assert.equal(d.index, want.index ?? argmax(base), `seed ${seed}`);
          assert.equal(d.fallback, want.index === null);
          assert.equal(d.used, want.used);
          assert.equal(d.championIndex, argmax(base));
        }
      }
      for (const seed of [3_838_129_370]) {
        for (const focalTeam of [0, 1]) {
          const got = await playRound(seed, focalTeam, cfg);
          const want = await playPaired(seed, focalTeam, {
            values: cfg.values,
            champion: DEFAULT_CHAMPION,
            threshold: 12,
            solverCards: -1,
            policy: 'pimc-search',
            solver: createSearchSolver(),
          });
          assert.equal(got.points, want.points);
          assert.deepEqual(got.order, want.order);
          assert.equal(got.endgameSearched, want.searched);
          assert.equal(got.endgameDecisions, want.endgameDecisions);
          assert.equal(got.endgameFallbacks, want.searchFallbacks);
          assert.equal(got.endgameDiffers, want.differs);
          assert.equal(got.endgameWorldsUsed, want.worldsUsed);
          assert.equal(got.searched, 0);
          assert.ok(got.endgameSearched > 0);
        }
      }
    } finally {
      await cfg.close();
    }
  },
);

test(
  'default endgame=none: identical rows and the same round fields as before the endgame option',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const small = { worlds: 2, k: 2, lo: 21, hi: 30 };
    const legacy = await championConfig(small); // protocol without any endgame field
    const explicit = await championConfig({
      ...small,
      ...buildProtocolDefaults(),
    });
    try {
      assert.equal(explicit.endgame, 'none');
      assert.equal(explicit.solver, null);
      for (const seed of [3_838_129_380, 3_838_129_381]) {
        const x = untimed(await playPair(seed, legacy));
        const raw = await playPair(seed, explicit);
        const keys = ['a', 'b'].map((side) => Object.keys(raw[side]).sort());
        assert.deepEqual(untimed(raw), x);
        // Round fields of the midgame-only version (commit 0d0c58f), unchanged; no endgame keys.
        for (const k of keys)
          assert.deepEqual(k, [
            'bandDecisions',
            'beliefMs',
            'candidatesSearched',
            'differPlies',
            'differs',
            'gainEstimate',
            'inferences',
            'order',
            'plies',
            'points',
            'searchMs',
            'searched',
            'ties',
          ]);
      }
    } finally {
      await legacy.close();
      await explicit.close();
    }
  },
);

/** A pair row without its wall-clock fields (the only fields that differ between reruns). */
const untimed = ({ ms: _, ...row }) => {
  for (const side of ['a', 'b']) {
    const { searchMs: _s, beliefMs: _b, ...rest } = row[side];
    row[side] = rest;
  }
  return row;
};

/** The endgame fields buildProtocol records for a default (endgame=none) run. */
function buildProtocolDefaults() {
  return { endgame: 'none', endgameHi: null, endgameWorlds: null };
}

test(
  'belief endgame worlds: 8 count-consistent masked worlds from the belief network, permutation invariant',
  { skip: !(haveChampion && haveBelief) && 'champion or smoke belief ONNX missing' },
  async () => {
    const cfg = await championConfig({
      endgame: 'pimc',
      endgameHi: 20,
      endgameWorlds: 'belief',
      belief: SMOKE_BELIEF,
    });
    try {
      for (const start of [3_838_129_390, 3_838_129_395]) {
        const { game, seed } = position(start, 20);
        assert.ok(remaining(game) <= 20);
        const d = await endgameDecision(game, seed, cfg);
        assert.equal(d.worlds.length, SEARCH.worlds);
        assert.equal(d.probs.length, 162);
        assert.deepEqual(
          d.worlds,
          sampleBeliefWorlds(searchObservation(game, game.turn), d.probs, {
            count: SEARCH.worlds,
            seed: worldSeed(seed, game.log.length),
          }),
        );
        for (const hands of d.worlds) {
          assert.deepEqual(
            hands.map((h) => h.length),
            game.hands.map((h) => h.length),
          );
          assert.deepEqual(
            hands[game.turn],
            game.hands[game.turn].map((c) => c.id),
          );
          assert.deepEqual(hiddenIds(hands, game.turn), hiddenIds(game.hands, game.turn));
        }
        assert.ok(d.used <= SEARCH.worlds);
        assert.ok(d.beliefMs > 0);
        const e = await endgameDecision(permuteHidden(game, start), seed, cfg);
        assert.deepEqual(e.worlds, d.worlds);
        assert.deepEqual(e.probs, d.probs);
        assert.equal(e.index, d.index);
      }
    } finally {
      await cfg.close();
    }
  },
);

test(
  'combined pair (midgame rollout + endgame PIMC) records endgame stats; summary and compare',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const cfg = await championConfig({
      worlds: 2,
      k: 2,
      lo: 21,
      hi: 30,
      endgame: 'pimc',
      endgameHi: 14,
      endgameWorlds: 'uniform',
    });
    try {
      const r = await playPair(3_838_129_385, cfg);
      for (const side of [r.a, r.b]) {
        assert.equal(side.endgameSearched, side.endgameDecisions);
        assert.equal(side.endgameDifferPlies.length, side.endgameDiffers);
        assert.ok(side.endgameFallbacks <= side.endgameSearched);
        assert.equal(side.searched, side.bandDecisions);
      }
      assert.ok(r.a.endgameSearched + r.b.endgameSearched > 0);
      const s = summarize([r]);
      assert.equal(s.endgame.searchedDecisions, r.a.endgameSearched + r.b.endgameSearched);
      assert.ok(s.endgame.secondsPerSearchedDecision > 0);
      assert.equal(summarize([{ ...r, a: { points: 0 }, b: { points: 0 } }]).endgame, undefined);
    } finally {
      await cfg.close();
    }
    const dir = mkdtempSync(join(tmpdir(), 'midgame-compare-endgame-'));
    try {
      const write = (name, run) => {
        const d = join(dir, name);
        mkdirSync(d);
        writeFileSync(join(d, 'run.json'), JSON.stringify(run));
        writeFileSync(
          join(d, 'part-0.jsonl'),
          JSON.stringify({ seed: 5, mean: 1, a: { points: 1 }, b: { points: 1 }, ms: 1 }),
        );
        return d;
      };
      const run = { start: 5, workers: 1, championSHA256: 'c', worldsSource: 'belief', net: 2 };
      const legacy = write('legacy', run);
      const none = write('none', { ...run, ...buildProtocolDefaults() });
      const pimc = write('pimc', {
        ...run,
        endgame: 'pimc',
        endgameHi: 20,
        endgameWorlds: 'belief',
      });
      assert.deepEqual(compareRuns(legacy, none).settingDifferences, {});
      const c = compareRuns(none, pimc);
      assert.deepEqual(c.settingDifferences, {
        endgame: ['none', 'pimc'],
        endgameHi: [null, 20],
        endgameWorlds: [null, 'belief'],
      });
      assert.equal(c.commonPairs, 1);
      assert.equal(c.meanDifference, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

/* ---- Focal raw network (--focal-raw-model, --mode=raw; window 3 plan section 8 item 7) ---- */

const W3_INIT =
  '/Users/stevensun/guandan-runtime.noindex/window3-20261109/train-init/v000000000.onnx';
const BELIEF_V1 = '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx';
const marginalBelief = existsSync(BELIEF_V1) ? BELIEF_V1 : SMOKE_BELIEF;
const haveInit = existsSync(W3_INIT) && existsSync(marginalBelief);

test('buildProtocol: focal raw model and raw mode requirements, SHA and held-out wording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'midgame-focal-raw-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'champion bytes');
    const model = join(dir, 'v000000000.onnx');
    writeFileSync(model, 'wrapped bytes');
    const belief = join(dir, 'belief.onnx');
    writeFileSync(belief, 'belief bytes');
    writeFileSync(
      join(dir, 'train-report.json'),
      JSON.stringify({ dataProtocols: [{ seeds: [100, 199], band: [21, 80] }] }),
    );
    const base = { start: '200', pairs: '10', champion, 'allow-champion': '1' };
    const plain = buildProtocol(base);
    assert.deepEqual(
      [plain.focalRawModel, plain.focalRawModelSHA256, plain.heldOut],
      [null, null, false],
    );
    assert.throws(() => buildProtocol({ ...base, mode: 'raw' }), /needs --focal-raw-model/);
    const raw = { ...base, mode: 'raw', 'focal-raw-model': model };
    assert.throws(() => buildProtocol(raw), /needs --belief/);
    const p = buildProtocol({ ...raw, belief });
    assert.equal(p.focalRawModel, model);
    assert.match(p.focalRawModelSHA256, /^[0-9a-f]{64}$/);
    assert.equal(p.focalRawExtras.width, 215);
    assert.match(p.purpose, /no search/);
    assert.deepEqual(p.beliefTrainingSeeds, [[100, 199]]);
    assert.throws(() => buildProtocol({ ...raw, belief, start: '150' }), /overlap/);
    assert.throws(
      () => buildProtocol({ ...raw, belief, endgame: 'pimc', 'endgame-worlds': 'belief' }),
      /no endgame/,
    );
    assert.throws(
      () => buildProtocol({ ...raw, belief, 'worlds-source': 'belief' }),
      /no search worlds/,
    );
    assert.throws(
      () => buildProtocol({ ...base, mode: 'champion', 'focal-raw-model': model, belief }),
      /only used with --mode=search\|raw/,
    );
    assert.throws(
      () => buildProtocol({ ...base, 'focal-raw-model': champion, belief }),
      /champion file itself/,
    );
    const s = buildProtocol({
      ...base,
      'focal-raw-model': model,
      belief,
      'worlds-source': 'belief',
      endgame: 'pimc',
      'endgame-worlds': 'belief',
      'held-out': '1',
    });
    assert.equal(s.mode, 'search');
    assert.equal(s.heldOut, true);
    assert.match(s.purpose, /^held-out run/);
    assert.match(s.focalRawExtras.appliesTo, /more than hi cards/);
    assert.throws(() => buildProtocol({ ...base, mode: 'greedy' }), /search\|champion\|raw/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const row = (seed, mean) => ({ seed, mean, a: { points: 0 }, b: { points: 0 }, ms: 1 });
  assert.match(summarize([row(1, 1)]).interval, /development seeds, not held-out/);
  assert.match(summarize([row(1, 1)], { heldOut: true }).interval, /held-out seeds/);
  assert.match(compareRows([row(1, 1)], [row(1, 0)], { heldOut: true }).interval, /^paired/);
});

test('focal raw extras: per row the 53 public extras of the trainer state, then the 162 marginals', () => {
  const { game } = position(3_838_129_420, 60);
  const player = game.turn;
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const state = rawPolicyState(game, player, plays);
  // The fast rollout's state: policyState + decisionContext trick + action shapes.
  const context = decisionContext(game, player);
  assert.deepEqual(state.trick, context.trick);
  assert.deepEqual(state, {
    ...policyState(game, player, 0, plays),
    trick: context.trick,
    actionShapes: plays.map((x) => x && { type: x.type, value: x.value, n: x.n }),
  });
  const marginals = Float32Array.from({ length: BELIEF_MARGINALS }, (_, i) => i / 100);
  const extras = focalRawExtras(state, marginals);
  assert.equal(FOCAL_RAW_EXTRAS, 215);
  assert.equal(extras.length, plays.length * 215);
  const pub = encodePolicyExtrasBatch(state);
  for (let i = 0; i < plays.length; i++) {
    assert.deepEqual(extras.slice(i * 215, i * 215 + 53), pub.slice(i * 53, (i + 1) * 53));
    assert.deepEqual(extras.slice(i * 215 + 53, (i + 1) * 215), marginals);
  }
  assert.throws(() => focalRawExtras(state, marginals.slice(1)), /162/);
  assert.throws(() => focalRawExtras(state, Array(162).fill(NaN)), /finite/);
});

test(
  'focal raw belief marginals: public view only, same as from the trainer state, hidden-permutation invariant',
  { skip: !(haveInit && haveChampion) && 'window-3 initial model, belief or champion missing' },
  async () => {
    const ort = await import('onnxruntime-node');
    const model = await createBeliefModel(ort, marginalBelief);
    const cfg = await championConfig({
      mode: 'raw',
      focalRawModel: W3_INIT,
      focalRawModelSHA256: 'test',
      belief: marginalBelief,
    });
    try {
      for (const [start, hi] of [
        [3_838_129_430, 100],
        [3_838_129_440, 70],
        [3_838_129_450, 40],
      ]) {
        const { game } = position(start, hi);
        const player = game.turn;
        const masked = maskHidden(game, player);
        const plays = candidates(game.hands[player], game.L, game.trick?.play);
        const fromView = await beliefMarginals(model, publicView(masked, player));
        const fromState = await beliefMarginals(model, rawPolicyState(masked, player, plays));
        assert.equal(fromView.length, BELIEF_MARGINALS);
        assert.deepEqual(fromState, fromView);
        const d = await focalRawDecision(game, cfg);
        const e = await focalRawDecision(permuteHidden(game, start), cfg);
        assert.deepEqual(d.marginals, fromView);
        assert.deepEqual(e.marginals, d.marginals);
        assert.deepEqual(e.values, d.values);
        assert.equal(e.index, d.index);
        // Wrapped 017 (zero extras projection): values equal the champion's to 1e-5.
        const champion = await cfg.values(cfg.champion, policyState(game, player, 0, plays));
        for (let i = 0; i < plays.length; i++)
          assert.ok(Math.abs(d.values[i] - champion[i]) < 1e-5, `candidate ${i}`);
        assert.equal(d.index, d.championIndex);
      }
    } finally {
      await model.close();
      await cfg.close();
    }
  },
);

/** Development seeds already used by the tests above (outside every window-3 reserved range). */
const FOCAL_RAW_SEEDS = [
  3_838_129_380, 3_838_129_381, 3_838_129_385, 3_838_129_390, 3_838_129_395, 3_838_129_900,
  3_838_129_901, 3_838_129_950,
];

test(
  'test 9e: --mode=raw with --focal-raw-model = wrapped 017 reproduces the champion arm pair for pair',
  { skip: !(haveInit && haveChampion) && 'window-3 initial model, belief or champion missing' },
  async () => {
    const champion = await championConfig({ mode: 'champion' });
    const raw = await championConfig({
      mode: 'raw',
      focalRawModel: W3_INIT,
      focalRawModelSHA256: 'sha-of-init',
      belief: marginalBelief,
    });
    try {
      for (const seed of FOCAL_RAW_SEEDS) {
        const c = await playPair(seed, champion);
        const r = await playPair(seed, raw);
        assert.equal(r.focalRawModelSHA256, 'sha-of-init');
        assert.equal(c.focalRawModelSHA256, undefined);
        assert.equal(r.mean, c.mean, `seed ${seed}`);
        for (const side of ['a', 'b']) {
          for (const key of ['points', 'order', 'plies', 'bandDecisions', 'differs', 'searched'])
            assert.deepEqual(r[side][key], c[side][key], `seed ${seed} ${side} ${key}`);
          assert.ok(r[side].rawDecisions > 0);
          assert.equal(r[side].rawDiffers, 0, `seed ${seed} ${side}`);
          assert.deepEqual(r[side].rawDifferPlies, []);
        }
      }
      const s = summarize([await playPair(FOCAL_RAW_SEEDS[0], raw)]);
      assert.deepEqual(s.focalRaw.modelSHA256, ['sha-of-init']);
      assert.equal(s.focalRaw.decisionsDifferentFromChampion, 0);
      assert.ok(s.focalRaw.secondsPerRawDecision > 0);
    } finally {
      await champion.close();
      await raw.close();
    }
  },
);

test(
  'search mode with --focal-raw-model = wrapped 017 above hi plays the same rounds as without it',
  { skip: !(haveInit && haveChampion) && 'window-3 initial model, belief or champion missing' },
  async () => {
    const small = { worlds: 2, k: 2, lo: 21, hi: 30 };
    const plain = await championConfig(small);
    const focal = await championConfig({
      ...small,
      focalRawModel: W3_INIT,
      focalRawModelSHA256: 'sha-of-init',
      belief: marginalBelief,
    });
    try {
      for (const seed of FOCAL_RAW_SEEDS.slice(0, 2)) {
        const x = untimed(await playPair(seed, plain));
        const { focalRawModelSHA256, ...y } = untimed(await playPair(seed, focal));
        assert.equal(focalRawModelSHA256, 'sha-of-init');
        for (const side of ['a', 'b']) {
          const { rawDecisions, rawDiffers, rawMs, rawBeliefMs, rawDifferPlies, ...rest } = y[side];
          assert.ok(rawDecisions > 0 && rawMs > 0 && rawBeliefMs > 0);
          assert.equal(rawDiffers, 0);
          assert.deepEqual(rawDifferPlies, []);
          y[side] = rest;
        }
        assert.deepEqual(y, x);
      }
    } finally {
      await plain.close();
      await focal.close();
    }
  },
);
