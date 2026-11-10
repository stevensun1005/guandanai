import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { argmax } from '../training/continuous/lib.mjs';
import { DEFAULT_CHAMPION, createConfig, playRound } from '../belief/midgame-search.mjs';
import {
  ARMS,
  buildHandoverProtocol,
  oracleDecision,
  playArmRound,
  summarizeRun,
  trueCopy,
  trueRollout,
} from '../belief/handover-oracle.mjs';

const haveChampion = existsSync(DEFAULT_CHAMPION);
const remaining = (game) => game.hands.reduce((n, h) => n + h.length, 0);

/** Random legal play until a real decision with <= `hi` cards (no network needed). */
function position(start, hi) {
  for (let seed = start; ; seed++) {
    const game = createRound(seed);
    const random = seededRandom(seed ^ 0x5bd1e995);
    for (;;) {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      if (remaining(game) <= hi && plays.length > 1 && game.log.length > 6) return { game, seed };
      if (advanceRound(game, plays[Math.floor(random() * plays.length)])) break;
    }
  }
}

test('arm table: A is the deployed bot, B is the oracle above hi only, C the oracle everywhere', () => {
  assert.deepEqual(ARMS.A, { above: 'champion', mid: 'search', end: 'search' });
  assert.deepEqual(ARMS.B, { above: 'oracle', mid: 'search', end: 'search' });
  assert.deepEqual(ARMS.C, { above: 'oracle', mid: 'oracle', end: 'oracle' });
});

test('trueCopy keeps the true hands and public fields and does not alias the game', () => {
  const { game } = position(3_838_131_000, 80);
  const copy = trueCopy(game);
  assert.deepEqual(
    copy.hands.map((h) => h.map((c) => c.id)),
    game.hands.map((h) => h.map((c) => c.id)),
  );
  assert.equal(copy.turn, game.turn);
  assert.deepEqual(copy.log, game.log);
  copy.log.push('x');
  copy.hands[0].pop();
  assert.notEqual(copy.log.length, game.log.length);
  assert.notEqual(copy.hands[0].length, game.hands[0].length);
});

test(
  'buildHandoverProtocol: deployed 9001 settings, arms validated, belief seed check applies',
  { skip: !haveChampion && 'champion missing' },
  () => {
    assert.throws(
      () => buildHandoverProtocol({ start: '1', pairs: '2', belief: '/nonexistent.onnx' }),
      /ENOENT|belief/i,
    );
    const p = buildHandoverProtocol({
      start: '3838129000',
      pairs: '400',
      'worlds-source': 'uniform',
      'endgame-worlds': 'uniform',
      arms: 'A,B',
      'stop-file': '/tmp/x/STOP',
    });
    assert.equal(p.mode, 'search');
    assert.equal(p.lo, 21);
    assert.equal(p.hi, 40);
    assert.equal(p.worlds, 8);
    assert.equal(p.k, 6);
    assert.equal(p.net, 2);
    assert.equal(p.endgame, 'pimc');
    assert.equal(p.endgameHi, 20);
    assert.deepEqual(p.arms, ['A', 'B']);
    assert.deepEqual(p.stopFiles, ['/tmp/x/STOP']);
    assert.throws(
      () =>
        buildHandoverProtocol({
          start: '1',
          pairs: '1',
          'worlds-source': 'uniform',
          'endgame-worlds': 'uniform',
          arms: 'A,D',
        }),
      /unknown arm/,
    );
  },
);

async function smallConfig() {
  const ort = await import('onnxruntime-node');
  // Small budgets keep the test fast; the decision code paths are the deployed ones.
  return createConfig(
    {
      mode: 'search',
      worldsSource: 'uniform',
      champion: DEFAULT_CHAMPION,
      lo: 21,
      hi: 30,
      worlds: 2,
      k: 2,
      net: 2,
      tieBreak: 'champion',
      endgame: 'pimc',
      endgameHi: 14,
      endgameWorlds: 'uniform',
    },
    ort,
  );
}

test(
  'oracle decision = argmax of one true-deal champion rollout per top-k candidate (+ pass), Q tie-break',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const cfg = await smallConfig();
    try {
      for (const start of [3_838_131_010, 3_838_131_020]) {
        const { game } = position(start, 60);
        const before = JSON.stringify(game.hands.map((h) => h.map((c) => c.id)));
        const d = await oracleDecision(game, cfg);
        assert.equal(JSON.stringify(game.hands.map((h) => h.map((c) => c.id))), before);
        const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
        const base = await cfg.values(cfg.champion, policyState(game, game.turn, 0, plays));
        const order = Array.from(base, (_, i) => i).sort((a, b) => base[b] - base[a] || a - b);
        const roots = order.slice(0, cfg.k);
        const pass = plays.findIndex((p) => p === null);
        if (pass >= 0 && !roots.includes(pass)) roots.push(pass);
        assert.deepEqual(d.roots, roots);
        const values = [];
        for (const r of roots) values.push(await trueRollout(game, plays[r], game.turn % 2, cfg));
        assert.deepEqual(d.means, values);
        const top = Math.max(...values);
        const tied = roots.filter((_, i) => values[i] >= top - 1e-9);
        const expected = tied.reduce((best, i) => (base[i] > base[best] ? i : best), tied[0]);
        assert.equal(d.index, expected);
        assert.equal(d.championIndex, argmax(base));
      }
    } finally {
      await cfg.close();
    }
  },
);

test(
  'arm A reproduces midgame-search playRound (the deployed bot) round for round',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const cfg = await smallConfig();
    try {
      for (const [seed, team] of [
        [3_838_131_100, 0],
        [3_838_131_101, 1],
      ]) {
        const ref = await playRound(seed, team, cfg);
        const mine = await playArmRound(seed, team, cfg, 'A');
        assert.equal(mine.points, ref.points);
        assert.deepEqual(mine.order, ref.order);
        assert.equal(mine.plies, ref.plies);
        for (const key of [
          'bandDecisions',
          'searched',
          'differs',
          'endgameDecisions',
          'endgameDiffers',
        ])
          assert.equal(mine[key], ref[key], key);
        assert.deepEqual(mine.differPlies, ref.differPlies);
        assert.equal(mine.oracleDecisions, 0);
        assert.ok(Number.isFinite(mine.handoverQ));
        assert.ok(mine.handoverCards <= cfg.hi);
      }
    } finally {
      await cfg.close();
    }
  },
);

test(
  'arms B and C use the oracle only where specified',
  { skip: !haveChampion && 'champion missing' },
  async () => {
    const cfg = await smallConfig();
    try {
      const seed = 3_838_131_200;
      const b = await playArmRound(seed, 0, cfg, 'B');
      assert.equal(b.oracleDecisions, b.aboveDecisions);
      assert.ok(b.aboveDecisions > 0);
      assert.equal(b.searched, b.bandDecisions);
      assert.equal(b.endgameSearched, b.endgameDecisions);
      const c = await playArmRound(seed, 0, cfg, 'C');
      assert.equal(c.searched, 0);
      assert.equal(c.endgameSearched, 0);
      assert.equal(c.oracleDecisions, c.aboveDecisions + c.bandDecisions + c.endgameDecisions);
    } finally {
      await cfg.close();
    }
  },
);

test('summarizeRun: per-arm prefix summaries and paired compare files', () => {
  const out = mkdtempSync(join(tmpdir(), 'handover-'));
  try {
    const run = {
      start: 100,
      pairs: 4,
      workers: 2,
      arms: ['A', 'B'],
      armSpec: { A: ARMS.A, B: ARMS.B },
    };
    writeFileSync(join(out, 'run.json'), JSON.stringify(run));
    const round = (points, q) => ({ points, oracleDecisions: 1, oracleMs: 10, handoverQ: q });
    const row = (seed, pa, pb, q = 0) => ({
      seed,
      a: round(pa, q),
      b: round(pb, -q),
      mean: (pa + pb) / 2,
      ms: 1,
    });
    for (const arm of ['A', 'B']) mkdirSync(join(out, arm));
    writeFileSync(
      join(out, 'A', 'part-0.jsonl'),
      [row(100, 1, -1, 0.1), row(102, 2, 1, 0.5)].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    writeFileSync(join(out, 'A', 'part-1.jsonl'), JSON.stringify(row(101, -1, -1, -0.2)) + '\n');
    writeFileSync(
      join(out, 'B', 'part-0.jsonl'),
      [row(100, 1, 1), row(102, 3, 1)].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );
    writeFileSync(join(out, 'B', 'part-1.jsonl'), JSON.stringify(row(101, 1, -1)) + '\n');
    const r = summarizeRun(out);
    assert.equal(r.arms.A.pairs, 3);
    assert.equal(r.arms.B.pairs, 3);
    const c = JSON.parse(readFileSync(join(out, 'compare-A-B.json'), 'utf8'));
    assert.equal(c.commonPairs, 3);
    // B - A per pair: 1 - 0, 0 - (-1), 2 - 1.5
    assert.ok(Math.abs(c.meanDifference - (1 + 1 + 0.5) / 3) < 1e-12);
    assert.ok(existsSync(join(out, 'A', 'summary.json')));
    assert.equal(r.arms.A.oracle.oracleDecisions, 6);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
