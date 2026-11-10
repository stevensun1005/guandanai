// Window 3, S7 (M5): tests of the descriptive human-panel scorer. The parity tests need the
// private human records, the frozen audit/lead rows, champion 017, belief v1 and the wrapped
// initial model; they skip cleanly when any of these is absent (CI has none of them).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeDeck } from '../../../web/src/core/cards.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import {
  DEFAULTS,
  PUBLISHED_017,
  ROOT,
  choiceIndex,
  classifyLead,
  clusterBootstrap,
  firstMax,
  minPlays,
  parseOptions,
  run,
  structureCost,
} from '../belief/panel-scorer.mjs';
import { DEFAULT_CHAMPION } from '../belief/midgame-search.mjs';

const deck = makeDeck();
const card = (r, s = 'S', copy = 0) =>
  deck.find((c) => c.r === r && c.s === s && c.id >= copy * 54);

test('repository root resolves to this checkout', () => {
  assert.ok(existsSync(join(ROOT, 'ai/danMCai/belief/panel-scorer.mjs')));
});

test('plays-to-empty and structure cost (audit definitions)', () => {
  const straight = [3, 4, 5, 6, 7].map((r, i) => card(r, 'SHCD'[i % 4]));
  assert.deepEqual(minPlays(straight, 2), { plays: 1, singles: 0, lowSingles: 0 });
  const two = [card(3), card(9)];
  assert.deepEqual(minPlays(two, 2), { plays: 2, singles: 2, lowSingles: 2 });
  // a single 3 out of the straight leaves four singles: 4 plays after instead of 0
  const plays = candidates(straight, 2, null);
  const single3 = plays.find((p) => p && p.type === 'single' && p.value === 3);
  assert.equal(structureCost(straight, single3, 2), 4);
  const whole = plays.find((p) => p && p.cards.length === 5 && p.type === 'straight');
  assert.equal(structureCost(straight, whole, 2), 0);
  assert.equal(structureCost(straight, null, 2), 0);
});

test('choice convention: finishing move, single candidate, then the first maximum', () => {
  const plays = [null, { cards: [1] }, { cards: [1, 2] }];
  assert.equal(choiceIndex(plays, 2, [9, 9, 0]), 2);
  assert.equal(choiceIndex([{ cards: [1] }], 3, [0]), 0);
  assert.equal(choiceIndex(plays, 5, [1, 3, 3]), 1);
  assert.equal(firstMax([0.5, 0.7, 0.7]), 1);
});

test('lead classification: uncovered full house vs a kept bomb', () => {
  // full house 3-3-3 + 4-4, nothing else: no same-type cover, no bomb -> uncovered
  const hand = [card(3, 'S'), card(3, 'H'), card(3, 'C'), card(4, 'S'), card(4, 'H'), card(9, 'D')];
  const unseen = [card(5, 'S'), card(5, 'H'), card(5, 'C'), card(6, 'S'), card(6, 'H')];
  const full = candidates(hand, 2, null).find((p) => p && p.type === 'full');
  const c = classifyLead(hand, full, unseen, 2);
  assert.equal(c.type, 'full');
  assert.equal(c.uncovered, true);
  assert.equal(c.boss, false);
  assert.equal(c.u, 5);
  const withBomb = [...hand, card(8, 'S'), card(8, 'H'), card(8, 'C'), card(8, 'D')];
  const c2 = classifyLead(withBomb, full, unseen, 2);
  assert.equal(c2.bomb, true);
  assert.equal(c2.uncovered, false);
});

test('round-cluster bootstrap is deterministic and zero for identical arms', () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    cluster: i % 8,
    num: i % 3 === 0 ? 1 : 0,
    den: 1,
  }));
  const a = clusterBootstrap(items, ['num', 'den'], (t) => t.num / t.den);
  const b = clusterBootstrap(items, ['num', 'den'], (t) => t.num / t.den);
  assert.deepEqual(a, b);
  assert.ok(a[0] <= 14 / 40 && a[1] >= 14 / 40);
  const d = clusterBootstrap(
    items.map((x) => ({ ...x, n2: x.num })),
    ['num', 'n2', 'den'],
    (t) => t.n2 / t.den - t.num / t.den,
  );
  assert.deepEqual(d, [0, 0]);
});

/* ------------------------------ parity on the private panel ------------------------------ */
const WRAPPED =
  process.env.W3_WRAPPED_MODEL ||
  '/Users/stevensun/guandan-runtime.noindex/window3-20261109/train-init/v000000000.onnx';
const haveRecords = DEFAULTS.raw.every(
  (d) => existsSync(d) && readdirSync(d).some((f) => /^round-\d+\.json$/.test(f)),
);
const missing = [
  ...(!haveRecords ? ['private human records'] : []),
  ...[DEFAULT_CHAMPION, DEFAULTS.belief, DEFAULTS.auditRows, DEFAULTS.leadRows, DEFAULTS.solverRows]
    .filter((f) => !existsSync(f))
    .map((f) => f.split('/').at(-1)),
];
const skipParity = missing.length ? `absent: ${missing.join(', ')}` : false;

/** Identifier strings of the private records (ids, rooms, human seat names) for the privacy grep. */
function privateStrings() {
  const out = new Set();
  for (const dir of DEFAULTS.raw)
    for (const f of readdirSync(dir).filter((x) => /^round-\d+\.json$/.test(x))) {
      out.add(f);
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const s of [r.id, r.matchId, r.matchId?.slice(0, 8), r.room]) if (s) out.add(String(s));
      for (const seat of r.seats || []) {
        if (seat.id) out.add(String(seat.id));
        if (seat.human && seat.name) out.add(String(seat.name));
      }
    }
  return [...out].filter((s) => s.length >= 3);
}
function assertPrivate(text) {
  for (const s of privateStrings()) {
    assert.ok(!text.includes(`"${s}"`), 'a private identifier appears as a value in the output');
    if (/[A-Za-z]/.test(s) && s.length >= 6)
      assert.ok(!text.includes(s), 'a private identifier appears in the output');
  }
}

const baseOptions = (model) => ({
  ...parseOptions([`--model=${model}`, '--s7a-rows=none', '--parity=1']),
});

test(
  'parity: the wrapped initial (017 + zero 215 projection) reproduces 017 on every panel position',
  { skip: skipParity || (!existsSync(WRAPPED) && 'absent: wrapped initial model') },
  async () => {
    const result = await run(baseOptions(`wrapped=${WRAPPED}`));
    assert.equal(result.records.rounds, 31);
    assert.equal(result.records.registeredInPanel, 31);
    assert.equal(result.positions, PUBLISHED_017.decisions);
    assert.equal(result.identical, result.positions);
    assert.equal(result.leadsIdentical, PUBLISHED_017.leads);
    assert.equal(result.solverPositionsIdentical, result.solverPositions);
    assert.equal(result.solverPositions, PUBLISHED_017.solverCritical[1]);
    for (const [k, v] of Object.entries(result.publishedMatch)) assert.ok(v.match, k);
    const a = result.reproduction.auditRows;
    assert.equal(a.matched, 1458);
    assert.equal(a.championIndexEqual, 1458);
    assert.equal(a.humanIndexEqual, 1458);
    assert.equal(a.championCostEqual, 1458);
    const l = result.reproduction.leadRows;
    assert.equal(l.matched, 269);
    assert.equal(l.championEqual, 269);
    assert.equal(l.ctlEqual, 269);
    assert.equal(result.solverChecks.storedChampionConsistency.inconsistent, 0);
    assert.equal(result.solverChecks.keepsValueChecks, 0);
    for (const [k, d] of Object.entries(result.paired['wrapped minus 017']))
      if (d.positions) assert.equal(d.point, 0, k);
    assert.ok(result.pass);
    assertPrivate(JSON.stringify(result));
  },
);

test(
  'parity: champion 017 scored as a candidate reproduces itself and the published numbers',
  { skip: skipParity },
  async () => {
    const result = await run(baseOptions(`champion=${DEFAULT_CHAMPION}`));
    assert.equal(result.identical, 1458);
    assert.ok(result.pass);
    const m = result.metrics['017'];
    assert.equal(m.bomb.value.toFixed(3), '0.360');
    assert.equal(m.joker.value.toFixed(3), '0.250');
    assert.equal(m.cost.value.toFixed(3), '0.493');
    assert.equal(m.unc.value.toFixed(3), '0.149');
    assert.equal(m.solver.value.toFixed(3), '0.730');
    assert.ok(result.belief.all.copies > 0);
    assertPrivate(JSON.stringify(result));
  },
);

/* -------------------- arm replay: same rounds as midgame-search playRound -------------------- */
test(
  'arm-replay replayRound plays exactly midgame-search playRound (uniform worlds, endgame solver)',
  { skip: !existsSync(DEFAULT_CHAMPION) && 'champion missing' },
  async () => {
    const ort = await import('onnxruntime-node');
    const { createConfig, playRound } = await import('../belief/midgame-search.mjs');
    const { replayRound, summarizeRounds } = await import('../belief/arm-replay.mjs');
    const cfg = await createConfig(
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
    try {
      const rounds = [];
      for (const [seed, team] of [
        [3_838_131_100, 0],
        [3_838_131_101, 1],
      ]) {
        const a = await playRound(seed, team, cfg);
        const b = await replayRound(seed, team, cfg, null);
        assert.equal(b.points, a.points);
        assert.equal(b.plies, a.plies);
        assert.deepEqual(b.order, a.order);
        assert.ok(b.handover && Number.isFinite(b.handover.q017));
        rounds.push({ ...b, matched: true });
      }
      const s = summarizeRounds(rounds);
      assert.equal(s.rounds, 2);
      assert.equal(s.matchedStoredRows, 2);
      assert.equal(s.handover.rounds, 2);
    } finally {
      await cfg.close();
    }
  },
);
