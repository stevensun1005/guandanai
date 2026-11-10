import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from '../../../web/src/ai/candidates.js';
import { makeDeck } from '../../../web/src/core/cards.js';
import { isBomb } from '../../../web/src/core/combinations.js';
import { RULES_ONLY } from '../../../web/src/rule-bot/runtime.mjs';
import { createWebClint, emptyTally } from '../belief/reason-match-eval.mjs';
import {
  blindFollow,
  bootstrapMean,
  clintReadingRule,
  clintRow,
  clintSeed,
  evaluateClintPosition,
  evaluatePosition,
  findPosition,
  playArm,
  positionFilter,
  positionRow,
  readingRule,
  rebuildPosition,
  seatSeed,
  selectRows,
  summarize,
  summarizeClint,
  tableCards,
  teamOutcome,
} from '../belief/opening-counterfactual.mjs';

const deck = makeDeck();
const pick = (r, n, used) => {
  const out = deck.filter((c) => c.r === r && c.s !== 'H' && !used.has(c.id)).slice(0, n);
  out.forEach((c) => used.add(c.id));
  return out;
};

/** Seat 0 holds four 5s, a 9 and a 3, following seat 1's single 4; others fill to `fill` cards. */
function handBuilt({ fill = 27, trickPlayer = 1, own = null } = {}) {
  const used = new Set();
  const four = pick(5, 4, used);
  const hand0 = own ? own(four, used) : [...four, ...pick(9, 1, used), ...pick(3, 1, used)];
  const lead = pick(4, 1, used);
  const rest = deck.filter((c) => !used.has(c.id) && c.r !== 5);
  const hands = [
    hand0,
    rest.slice(0, fill),
    rest.slice(fill, 2 * fill),
    rest.slice(2 * fill, 3 * fill),
  ];
  return {
    hands,
    L: 2,
    levels: [2, 2],
    log: [
      { p: 1, cards: lead, type: 'single', value: 4, n: 1, lead: true },
      { p: 2, cards: null },
      { p: 3, cards: null },
    ],
    trick: { player: trickPlayer, play: { type: 'single', value: 4, n: 1, cards: lead } },
    passes: 2,
    out: [],
    turn: 0,
  };
}
/** Q values putting `first` (a predicate on plays) on top, then a fixed order. */
const qWith = (plays, first) => plays.map((p, i) => (first(p) ? 10 : -i));

test('position filter accepts the reference position and picks the highest non-bomb as B', () => {
  const game = handBuilt();
  assert.ok(tableCards(game) > 60);
  const plays = candidates(game.hands[0], game.L, game.trick.play);
  const base = qWith(plays, (p) => p && isBomb(p));
  const f = positionFilter(game, plays, base);
  assert.equal(f.ok, true);
  assert.ok(isBomb(plays[f.bombIndex]));
  assert.ok(!plays[f.altIndex] || !isBomb(plays[f.altIndex]));
  const others = plays.map((_, i) => i).filter((i) => !plays[i] || !isBomb(plays[i]));
  assert.equal(base[f.altIndex], Math.max(...others.map((i) => base[i])));
});

test('position filter: one hand-built example of each exclusion', () => {
  const reason = (game, plays, base) => positionFilter(game, plays, base).reason;
  const top = (plays) => qWith(plays, (p) => p && isBomb(p));
  const playsOf = (game) => candidates(game.hands[0], game.L, game.trick?.play);
  // 60 or fewer cards on the table
  let game = handBuilt({ fill: 18 });
  assert.equal(tableCards(game), 60);
  assert.equal(reason(game, playsOf(game), top(playsOf(game))), 'table-cards');
  // leading, no trick
  game = handBuilt();
  game.trick = null;
  assert.equal(reason(game, playsOf(game), top(playsOf(game))), 'lead');
  // following the partner's trick
  game = handBuilt({ trickPlayer: 2 });
  assert.equal(reason(game, playsOf(game), top(playsOf(game))), 'partner-trick');
  // a candidate empties the hand (the hand is only the bomb)
  game = handBuilt({ own: (four) => four });
  assert.equal(reason(game, playsOf(game), top(playsOf(game))), 'can-finish');
  // champion's top move is not a bomb
  game = handBuilt();
  let plays = playsOf(game);
  assert.equal(
    reason(
      game,
      plays,
      qWith(plays, (p) => p && p.type === 'single'),
    ),
    'top-not-bomb',
  );
  // no non-bomb candidate (synthetic list: real following lists always include pass)
  plays = playsOf(game).filter((p) => p && isBomb(p));
  assert.equal(reason(game, plays, top(plays)), 'no-non-bomb');
});

test('blind follow: last entry and partner last action both passes', () => {
  const game = handBuilt();
  assert.equal(blindFollow(game, 0), true); // seat 3 passed last, partner seat 2 passed
  game.log[1] = { p: 2, cards: [deck[60]], type: 'single', value: 9, n: 1, lead: false };
  assert.equal(blindFollow(game, 0), false);
});

test('team outcome sign convention for both teams', () => {
  for (const points of [1, 2, 3]) {
    assert.deepEqual(
      [0, 1, 2, 3].map((s) => teamOutcome({ winner: 0, points }, s)),
      [points, -points, points, -points],
    );
    assert.deepEqual(
      [0, 1, 2, 3].map((s) => teamOutcome({ winner: 1, points }, s)),
      [-points, points, -points, points],
    );
  }
});

/** Deterministic fake champion: prefers the action with the most cards (ties to the first). */
const fakeValues = async (state) => Float32Array.from(state.actions, (ids) => ids.length);

test('arms A and B share the history up to the forced move and the continuation seeds', async () => {
  let position = null;
  for (let seed = 4_300_000_000; !position && seed < 4_300_000_200; seed++)
    position = await findPosition(seed, fakeValues);
  assert.ok(position, 'a position exists among the first 200 deals');
  const before = JSON.stringify(position.game.log.map((e) => [e.p, e.cards?.map((c) => c.id)]));
  const calls = [];
  const bot = {
    decide: async (game, p, info, tally) => {
      assert.ok(tally);
      calls.push({ ply: game.log.length, p, seed: info.searchSeed });
      return fakeDecide(game, p);
    },
  };
  // evaluatePosition plays A_P1, A_P2, B_P1, B_P2: the P2 records restart at the forced ply + 1
  const evaluation = await evaluatePosition(position, { values: fakeValues, bot });
  const split = calls.findIndex((x, i) => i > 0 && x.ply <= calls[i - 1].ply);
  const seen = { A: calls.slice(0, split), B: calls.slice(split) };
  assert.ok(seen.A.length && seen.B.length);
  assert.equal(seen.A[0].ply, position.ply + 1);
  assert.equal(seen.B[0].ply, position.ply + 1);
  for (const list of [seen.A, seen.B])
    for (const x of list) assert.equal(x.seed, seatSeed(position.seed, x.p));
  if (seen.A[0].p === seen.B[0].p) assert.equal(seen.A[0].seed, seen.B[0].seed);
  // the position itself is untouched and both arms start from its log
  assert.equal(
    JSON.stringify(position.game.log.map((e) => [e.p, e.cards?.map((c) => c.id)])),
    before,
  );
  for (const index of [position.bombIndex, position.altIndex]) {
    const r = await playArm(position, index, fakeDecide);
    assert.deepEqual(
      r.game.log.slice(0, r.prefixLog).map((e) => [e.p, e.cards?.map((c) => c.id)]),
      position.game.log.map((e) => [e.p, e.cards?.map((c) => c.id)]),
    );
    const forced = r.game.log[r.prefixLog];
    const play = position.plays[index];
    assert.deepEqual(
      forced.cards?.map((c) => c.id) ?? null,
      play ? play.cards.map((c) => c.id) : null,
    );
  }
  assert.ok(isBomb(position.plays[position.bombIndex]));
  assert.equal(Object.keys(evaluation.arms).sort().join(), 'A_P1,A_P2,B_P1,B_P2');
  assert.deepEqual(
    Object.keys(emptyTally()).sort(),
    ['champion', 'decisions', 'automatic', 'endgame', 'midgame'].sort(),
  );
});

async function fakeDecide(game, p) {
  const plays = candidates(game.hands[p], game.L, game.trick?.play);
  return plays[0] ?? plays[plays.length - 1];
}

test('seat seeds depend only on deal seed and seat', () => {
  assert.equal(seatSeed(4_300_000_123, 2), seatSeed(4_300_000_123, 2));
  const seeds = new Set([0, 1, 2, 3].map((s) => seatSeed(4_300_000_123, s)));
  assert.equal(seeds.size, 4);
  assert.notEqual(seatSeed(4_300_000_123, 0), seatSeed(4_300_000_124, 0));
});

test('summary arithmetic on a tiny fixture', () => {
  const row = (seed, band, blind, trickClass, A1, B1, A2, B2, pass) => ({
    seed,
    band,
    blindFollow: blind,
    trickClass,
    moveBIsPass: pass,
    outcomes: { A_P1: A1, B_P1: B1, A_P2: A2, B_P2: B2 },
    d: { P1: B1 - A1, P2: B2 - A2 },
    fallbacks: {
      A_P2: {
        midgame: { requests: 2, fallbacks: {} },
        endgame: { requests: 1, fallbacks: { budget: 1 } },
      },
      B_P2: { midgame: { requests: 1, fallbacks: {} }, endgame: { requests: 0, fallbacks: {} } },
    },
    wallMs: 2000,
  });
  const rows = [
    row(1, '>80', true, 'single', -1, 1, -2, 2, true), // d1 2, d2 4
    row(2, '>80', false, 'pair', 1, 1, 1, -1, true), // d1 0, d2 -2
    row(3, '61-80', false, 'other', 2, -1, 3, 3, false), // d1 -3, d2 0
    row(4, '61-80', true, 'single', -3, 3, -1, 1, true), // d1 6, d2 2
  ];
  const s = summarize(rows, 500);
  assert.equal(s.positions, 4);
  assert.equal(s.P1.d.mean, (2 + 0 - 3 + 6) / 4);
  assert.equal(s.P2.d.mean, (4 - 2 + 0 + 2) / 4);
  assert.equal(s.pairedP2minusP1.mean, (2 - 2 + 3 - 4) / 4);
  assert.equal(s.P1.d.sharePositive, 0.5);
  assert.equal(s.P1.d.shareZero, 0.25);
  assert.equal(s.P1.d.shareNegative, 0.25);
  assert.equal(s.P2.meanOutcomeA, (-2 + 1 + 3 - 1) / 4);
  assert.equal(s.P2.meanOutcomeB, (2 - 1 + 3 + 1) / 4);
  assert.equal(s.P1.byBand['>80'].mean, 1);
  assert.equal(s.P1.byBand['61-80'].mean, 1.5);
  assert.equal(s.P2.byBlindFollow.true.mean, 3);
  assert.equal(s.P2.byTrickClass.single.n, 2);
  assert.equal(s.moveBPassShare, 0.75);
  assert.equal(s.p2SearchFallbacks.endgameFallbacks, 4); // one budget fallback per row
  assert.equal(s.p2SearchFallbacks.midgameRequests, 12);
  assert.equal(s.meanWallSecondsPerPosition, 2);
  const lo = s.P2.d.ci95[0],
    hi = s.P2.d.ci95[1];
  assert.ok(lo <= s.P2.d.mean && s.P2.d.mean <= hi && lo >= -2 && hi <= 4);
  assert.deepEqual(bootstrapMean([3, 3, 3], 200), [3, 3]);
  assert.equal(bootstrapMean([1]), null);
});

test('reading rule', () => {
  assert.equal(readingRule({ mean: 0.3, ci95: [0.1, 0.5] }, { ci95: [-1, 1] }).verdict, 'i');
  assert.equal(
    readingRule({ mean: -0.3, ci95: [-0.5, -0.1] }, { ci95: [-0.2, 0.1] }).verdict,
    'ii',
  );
  assert.equal(
    readingRule({ mean: -0.3, ci95: [-0.5, -0.1] }, { ci95: [0.1, 0.4] }).verdict,
    'iii',
  );
  assert.equal(readingRule({ mean: 0.1, ci95: [-0.1, 0.3] }, { ci95: [-1, 1] }).verdict, 'iii');
});

/* ----------------------------- P4: Clint continuations ----------------------------- */

const storedOf = (position) =>
  JSON.parse(
    JSON.stringify(
      positionRow(position, {
        arms: {
          A_P1: { outcome: -1, order: [] },
          B_P1: { outcome: 1, order: [] },
          A_P2: { outcome: -2, order: [] },
          B_P2: { outcome: 1, order: [] },
        },
        fallbacks: {},
        times: {},
        ms: 0,
      }),
    ),
  );

async function firstFakePosition() {
  for (let seed = 4_300_000_000; seed < 4_300_000_200; seed++) {
    const position = await findPosition(seed, fakeValues);
    if (position) return position;
  }
  throw Error('no position among the first 200 deals');
}

test('blind-first selection: every blind follow, then visible tricks, stored order, capped', () => {
  const rows = [
    { seed: 10, blindFollow: false },
    { seed: 11, blindFollow: true },
    { seed: 12, blindFollow: false },
    { seed: 13, blindFollow: true },
    { seed: 14, blindFollow: false },
  ];
  const s = selectRows(rows, 'blind-first:4');
  assert.deepEqual(
    s.map((x) => [x.rank, x.storedIndex, x.row.seed]),
    [
      [0, 1, 11],
      [1, 3, 13],
      [2, 0, 10],
      [3, 2, 12],
    ],
  );
  assert.equal(selectRows(rows, 'blind-first:1').length, 1);
  assert.equal(selectRows(rows, 'blind-first:400').length, 5);
  assert.throws(() => selectRows(rows, 'first:4'));
  assert.throws(() => selectRows([...rows, { seed: 11, blindFollow: true }], 'blind-first:9'));
});

test('stored positions are rebuilt from the deal seed and checked against the row', async () => {
  const position = await firstFakePosition();
  const stored = storedOf(position);
  const rebuilt = await rebuildPosition(stored, fakeValues);
  assert.equal(rebuilt.game.log.length, stored.ply);
  assert.equal(rebuilt.game.turn, stored.seat);
  assert.equal(rebuilt.bombIndex, position.bombIndex);
  assert.equal(rebuilt.altIndex, position.altIndex);
  const bad = (edit) => {
    const row = structuredClone(stored);
    edit(row);
    return rebuildPosition(row, fakeValues);
  };
  await assert.rejects(
    bad((r) => (r.ply += 1)),
    /ply/,
  );
  await assert.rejects(
    bad((r) => (r.bomb.ids = r.bomb.ids.slice(1))),
    /bomb ids/,
  );
  await assert.rejects(
    bad((r) => (r.moveB = r.moveB === 'pass' ? { ids: [0] } : 'pass')),
    /move B/,
  );
  await assert.rejects(
    bad((r) => (r.blindFollow = !r.blindFollow)),
    /blind follow/,
  );
});

test('P4: acting team = bot with P2 seeds, other team = Clint, fresh stream and token per arm', async () => {
  const position = await firstFakePosition();
  const team = position.game.turn % 2;
  const botCalls = [],
    clintCalls = [],
    factories = [];
  const bot = {
    decide: async (game, p, info, tally) => {
      assert.ok(tally);
      assert.equal(p % 2, team);
      assert.equal(info.searchSeed, seatSeed(position.seed, p));
      botCalls.push(game.tok);
      return fakeDecide(game, p);
    },
  };
  const clintFactory = (seed) => {
    factories.push(seed);
    return (game, p) => {
      assert.notEqual(p % 2, team);
      clintCalls.push(game.tok);
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      return plays[0] ?? plays[plays.length - 1];
    };
  };
  const evaluation = await evaluateClintPosition(position, { bot, clintFactory });
  assert.deepEqual(factories, [clintSeed(position.seed), clintSeed(position.seed)]);
  assert.equal(new Set([...botCalls, ...clintCalls]).size, 2); // one token per arm
  assert.ok(clintCalls.length > 0 && botCalls.length > 0);
  assert.equal(position.game.tok, undefined); // the stored position is not tagged
  assert.deepEqual(Object.keys(evaluation.arms).sort(), ['A_P4', 'B_P4']);
  assert.deepEqual(Object.keys(evaluation.clintBrain.A_P4).sort(), [
    'calls',
    'changed',
    'fallback',
    'ms',
    'used',
  ]);
  const stored = storedOf(position);
  const row = clintRow({ rank: 0, storedIndex: 7, row: stored }, position, evaluation, 12);
  assert.equal(row.d.P4, row.outcomes.B_P4 - row.outcomes.A_P4);
  assert.equal(row.d.P2, 3);
  assert.equal(row.d.P1, 2);
  assert.equal(row.storedIndex, 7);
  assert.equal(row.blindFollow, stored.blindFollow);
});

test('P4 with the real web Clint seat (rules only) plays both arms legally', async () => {
  const position = await firstFakePosition();
  const bot = { decide: async (game, p) => fakeDecide(game, p) };
  const evaluation = await evaluateClintPosition(position, {
    bot,
    clintFactory: (seed) => createWebClint(seed, RULES_ONLY),
  });
  for (const arm of Object.values(evaluation.arms)) {
    assert.ok([1, 2, 3, -1, -2, -3].includes(arm.outcome));
    assert.equal(arm.game.hands.filter((h) => h.length === 0).length >= 2, true);
  }
  assert.ok(evaluation.clintTime.A_P4.decisions > 0);
  assert.equal(evaluation.clintBrain.A_P4.calls, 0); // brain off with RULES_ONLY
});

test('P4 summary: contiguous prefix, primary blind follows, pairing, timeout share and reading', () => {
  const row = (rank, blind, A4, B4, dP2, calls, fallback) => ({
    rank,
    seed: 100 + rank,
    blindFollow: blind,
    band: '>80',
    trickClass: 'single',
    moveBIsPass: false,
    outcomes: { A_P4: A4, B_P4: B4 },
    d: { P4: B4 - A4, P2: dP2, P1: 0 },
    clintBrain: {
      A_P4: { calls, used: calls - fallback, fallback, changed: 0, ms: 10 },
      B_P4: { calls: 0, used: 0, fallback: 0, changed: 0, ms: 0 },
    },
    clintTime: { A_P4: { ms: 100, decisions: 10 }, B_P4: { ms: 100, decisions: 10 } },
    fallbacks: {},
    wallMs: 4000,
  });
  const rows = [
    row(0, true, -1, 1, 0, 4, 1), // d4 2
    row(1, true, 1, 2, 2, 4, 0), // d4 1
    row(2, false, 1, -1, -1, 2, 1), // d4 -2
    row(4, false, 3, 3, 0, 10, 10), // outside the contiguous prefix (rank 3 missing)
  ];
  const s = summarizeClint(rows, { selected: 5, selectedBlind: 3 }, 500);
  assert.equal(s.prefixPositions, 3);
  assert.equal(s.completedRows, 4);
  assert.equal(s.primaryBlindFollowD_P4.n, 2);
  assert.equal(s.primaryBlindFollowD_P4.mean, 1.5);
  assert.equal(s.secondaryAllD_P4.mean, (2 + 1 - 2) / 3);
  assert.equal(s.secondaryPairedD_P4minusD_P2.mean, (2 - 1 - 1) / 3);
  assert.equal(s.pairedBlindD_P4minusD_P2.mean, (2 - 1) / 2);
  assert.equal(s.clintBrain.calls, 10);
  assert.equal(s.clintBrain.fallback, 2);
  assert.equal(s.clintBrain.timeoutShare, 0.2);
  assert.equal(s.clintBrain.roundsWithBrainCalls, 3);
  assert.equal(s.clintBrain.perRoundTimeoutShare.roundsAbove30pct, 1);
  assert.equal(s.clintMsPerDecision, 10);
  assert.match(s.incomplete, /2 of 3/);
  assert.equal(clintReadingRule({ mean: 0.2, ci95: [0.05, 0.4] }, 0.2).verdict, 'a');
  assert.equal(clintReadingRule({ mean: -0.2, ci95: [-0.4, -0.05] }, 0.2).verdict, 'b');
  assert.equal(clintReadingRule({ mean: 0.1, ci95: [-0.1, 0.3] }, 0.2).verdict, 'c');
  assert.equal(clintReadingRule({ mean: 0.2, ci95: [0.05, 0.4] }, 0.31).verdict, 'unreliable');
  assert.equal(clintReadingRule({ mean: 0.2, ci95: null }, null).verdict, 'c');
});
