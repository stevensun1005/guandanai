import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from '../../../web/src/ai/candidates.js';
import { makeDeck } from '../../../web/src/core/cards.js';
import { isBomb } from '../../../web/src/core/combinations.js';
import { emptyTally } from '../belief/reason-match-eval.mjs';
import {
  blindFollow,
  bootstrapMean,
  evaluatePosition,
  findPosition,
  playArm,
  positionFilter,
  readingRule,
  seatSeed,
  summarize,
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
