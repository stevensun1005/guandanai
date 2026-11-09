import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { FEATURES, STATE } from '../training/continuous/lib.mjs';
import {
  DEFAULT_CHAMPION,
  createConfig,
  playRound,
  searchDecision,
} from '../belief/midgame-search.mjs';
import {
  BYTES_PER_ROW,
  FLAG_CHAMPION,
  FLAG_CHOSEN,
  LABELS,
  buildDistillProtocol,
  decisionRows,
  decisionStarts,
  generateBlock,
  playDistillRound,
  prepareRun,
  readBlock,
  writeBlock,
} from '../belief/distill-generate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const WINDOW1_BELIEF =
  '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx';
const SMOKE_BELIEF = join(here, '../workspace/belief-smoke/model/belief.onnx');
const BELIEF = [WINDOW1_BELIEF, SMOKE_BELIEF].find((f) => existsSync(f)) ?? null;
const haveChampion = existsSync(DEFAULT_CHAMPION);
const remaining = (game) => game.hands.reduce((n, h) => n + h.length, 0);

/** Random legal play until a real decision with <= `hi` cards on the table (no network needed). */
function position(seed, hi = 40) {
  for (let s = seed; ; s++) {
    const game = createRound(s);
    const random = seededRandom(s ^ 0x5bd1e995);
    for (;;) {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      if (remaining(game) <= hi && plays.length > 1 && game.log.length > 20)
        return { game, seed: s };
      if (advanceRound(game, plays[Math.floor(random() * plays.length)])) break;
    }
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

async function searchConfig(overrides = {}) {
  const ort = await import('onnxruntime-node');
  return createConfig(
    {
      mode: 'search',
      worldsSource: 'uniform',
      champion: DEFAULT_CHAMPION,
      lo: 21,
      hi: 40,
      worlds: 2,
      k: 3,
      net: 1,
      tieBreak: 'champion',
      endgame: 'none',
      ...overrides,
    },
    ort,
  );
}

/** Synthetic block: decision A (3 rows, last is pass), decision B (2 rows, no pass). */
function syntheticBlock() {
  const n = 5;
  const x = new Int8Array(n * FEATURES);
  const row = (i, state, action) => {
    x.fill(state, i * FEATURES, i * FEATURES + STATE);
    if (action !== null) x[i * FEATURES + STATE + action] = 1;
  };
  row(0, 1, 3);
  row(1, 1, 7);
  row(2, 1, null); // pass
  row(3, 1, 3); // same state as A, but A ended with a pass: new decision
  row(4, 1, 9);
  return {
    rows: n,
    x,
    y: Float32Array.from([0.5, -1.25, 2, 0, 3]),
    c: Float32Array.from([0.1, 0.2, -0.3, 0.4, 0.5]),
    w: Int8Array.from([0, -3, 2, 0, 8]),
    f: Uint8Array.from([3, 0, 0, 1, 2]),
    stats: { rounds: 1, decisions: 2, rows: n },
  };
}

test('shard round-trip and the residual-learner grouping rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-shard-'));
  try {
    const block = syntheticBlock();
    assert.deepEqual(decisionStarts(block.x), [0, 3]);
    const meta = writeBlock(dir, [10, 12], block, { extra: 'kept' });
    assert.equal(meta.labels, LABELS);
    const back = readBlock(dir, 10);
    for (const key of ['x', 'y', 'c', 'w', 'f']) assert.deepEqual(back[key], block[key], key);
    assert.deepEqual(back.meta.seeds, [10, 12]);
    assert.equal(back.meta.extra, 'kept');
    assert.equal(back.meta.stats.decisions, 2);
    assert.equal(BYTES_PER_ROW, 577);
    // A state change also starts a decision even without a pass.
    const x = new Int8Array(2 * FEATURES);
    x[STATE] = 1;
    x[FEATURES + STATE] = 1;
    assert.deepEqual(decisionStarts(x), [0]);
    x[FEATURES] = 1;
    assert.deepEqual(decisionStarts(x), [0, 1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Dummy model files + a train report with seeds 100..199 for the protocol tests. */
function protocolFixture(dir) {
  const champion = join(dir, 'champion.onnx');
  writeFileSync(champion, 'not the champion');
  const belief = join(dir, 'belief.onnx');
  writeFileSync(belief, 'belief bytes');
  writeFileSync(
    join(dir, 'train-report.json'),
    JSON.stringify({ dataProtocols: [{ seeds: [100, 199] }] }),
  );
  return { champion, belief, 'allow-champion': '1', seeds: '200..259', block: '10' };
}

test('protocol: belief required, champion SHA, belief training-seed overlap refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-protocol-'));
  try {
    const args = protocolFixture(dir);
    const p = buildDistillProtocol(args);
    assert.deepEqual([p.lo, p.hi, p.worlds, p.k, p.net, p.tieBreak], [21, 40, 8, 6, 2, 'champion']);
    assert.equal(p.worldsSource, 'belief');
    assert.deepEqual(p.seeds, [200, 259]);
    assert.deepEqual(p.beliefTrainingSeeds, [[100, 199]]);
    assert.match(p.beliefSHA256, /^[0-9a-f]{64}$/);
    assert.match(p.sources['ai/danMCai/belief/distill-generate.mjs'], /^[0-9a-f]{64}$/);
    assert.match(p.sources['ai/danMCai/belief/midgame-search.mjs'], /^[0-9a-f]{64}$/);
    assert.throws(() => buildDistillProtocol({ ...args, seeds: '150..300' }), /overlap/);
    assert.throws(() => buildDistillProtocol({ ...args, seeds: '0..100' }), /overlap/);
    assert.throws(() => buildDistillProtocol({ ...args, belief: undefined }), /required/);
    assert.throws(() => buildDistillProtocol({ ...args, 'allow-champion': undefined }), /017/);
    assert.throws(
      () => buildDistillProtocol({ ...args, 'belief-train-report': join(dir, 'missing.json') }),
      /No belief train report/,
    );
    assert.throws(() => buildDistillProtocol({ ...args, worlds: '200' }), /int8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resume: same protocol accepted, any protocol change refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'distill-resume-'));
  try {
    const args = protocolFixture(dir);
    const out = join(dir, 'run');
    prepareRun(out, args);
    prepareRun(out, { ...args, workers: '3', minutes: '5' }); // per-invocation options only
    assert.throws(() => prepareRun(out, { ...args, k: '5' }), /different protocol \(k\)/);
    assert.throws(() => prepareRun(out, { ...args, block: '20' }), /different protocol/);
    assert.throws(() => prepareRun(out, { ...args, seeds: '200..299' }), /different protocol/);
    writeFileSync(args.belief, 'other belief bytes');
    assert.throws(() => prepareRun(out, args), /beliefSHA256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'focal-only variant reproduces midgame-search playRound (re-implemented round loop)',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const cfg = await searchConfig();
    try {
      for (const seed of [3_838_129_910, 3_838_129_911]) {
        for (const team of [0, 1]) {
          const want = await playRound(seed, team, cfg);
          const got = await playDistillRound(seed, cfg, { searchTeams: [team] });
          assert.equal(team === 0 ? got.points : -got.points, want.points, `${seed} ${team}`);
          assert.deepEqual(got.order, want.order);
          assert.equal(got.plies, want.plies);
          assert.equal(got.decisions, want.searched);
          assert.equal(got.differs, want.differs);
        }
      }
    } finally {
      await cfg.close();
    }
  },
);

test(
  'grouping invariant, flags and determinism of a generated block (all four seats search)',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const seeds = [3_838_129_920];
    const cfg = await searchConfig();
    const decisions = [];
    let block;
    try {
      const round = await playDistillRound(seeds[0], cfg, {
        onDecision: (rows, info) => decisions.push({ rows, ...info }),
      });
      assert.ok(round.decisions > 0);
      assert.equal(decisions.length, round.decisions);
      assert.deepEqual(new Set(decisions.map((d) => d.player % 2)), new Set([0, 1]));
      block = await generateBlock(seeds, cfg);
    } finally {
      await cfg.close();
    }
    // Determinism: a fresh process-level config gives byte-identical rows.
    const again = await searchConfig();
    try {
      const block2 = await generateBlock(seeds, again);
      for (const key of ['x', 'y', 'c', 'w', 'f']) assert.deepEqual(block2[key], block[key], key);
    } finally {
      await again.close();
    }
    const starts = decisionStarts(block.x);
    assert.equal(starts.length, decisions.length);
    assert.equal(block.stats.decisions, decisions.length);
    let at = 0;
    decisions.forEach((d, i) => {
      assert.equal(starts[i], at, `decision ${i} start`);
      const n = d.rows.length;
      assert.equal(n, d.decision.roots.length);
      const group = Array.from({ length: n }, (_, r) => at + r);
      const state = (r) => block.x.subarray(r * FEATURES, r * FEATURES + STATE);
      for (const r of group) assert.deepEqual(state(r), state(at));
      assert.equal(group.filter((r) => block.f[r] & FLAG_CHAMPION).length, 1);
      assert.equal(group.filter((r) => block.f[r] & FLAG_CHOSEN).length, 1);
      const actions = d.rows.map((row) => row.action);
      assert.deepEqual(
        actions,
        [...actions].sort((a, b) => a - b),
      );
      group.forEach((r, j) => {
        const action = actions[j];
        const root = d.decision.roots.indexOf(action);
        assert.equal(Boolean(block.f[r] & FLAG_CHOSEN), action === d.decision.index);
        assert.equal(Boolean(block.f[r] & FLAG_CHAMPION), action === d.decision.championIndex);
        assert.equal(block.y[r], Math.fround(d.decision.means[root]));
        assert.equal(block.c[r], d.decision.base[action]);
        if (action === d.decision.championIndex) assert.equal(block.w[r], 0);
        assert.ok(Math.abs(block.w[r]) <= d.decision.worlds.length);
        // Pass (empty action) only as the last row of its decision.
        const pass = block.x
          .subarray(r * FEATURES + STATE, (r + 1) * FEATURES)
          .every((v) => v === 0);
        assert.equal(pass, d.decision.plays[action] === null);
        if (pass) assert.equal(j, n - 1);
      });
      at += n;
    });
    assert.equal(at, block.rows);
  },
);

test(
  'written rows of a decision are invariant to a permutation of the hidden hands',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const sources = BELIEF ? ['uniform', 'belief'] : ['uniform'];
    for (const worldsSource of sources) {
      const cfg = await searchConfig({ worldsSource, belief: BELIEF, worlds: 3 });
      try {
        for (const start of [3_838_129_930, 3_838_129_940]) {
          const { game, seed } = position(start);
          const permuted = permuteHidden(game, start);
          assert.notDeepEqual(
            permuted.hands.map((h) => h.map((c) => c.id)),
            game.hands.map((h) => h.map((c) => c.id)),
          );
          const a = decisionRows(game, await searchDecision(game, seed, cfg));
          const b = decisionRows(permuted, await searchDecision(permuted, seed, cfg));
          assert.deepEqual(b, a, `${worldsSource} ${start}`);
          assert.ok(a.length >= 2);
        }
      } finally {
        await cfg.close();
      }
    }
  },
);
