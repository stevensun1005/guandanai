import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runtime } from '../../../web/src/app/runtime.js';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { initialize as initializeValue } from '../../../web/src/ai/hand-value.js';
import { initialize as initializeHints } from '../../../web/src/hand/hints.js';
import { chooseRuleAction } from '../../../web/src/rule-bot/strategy.js';
import {
  BRAIN,
  brainOn,
  chooseClintAction,
  endgameBrain,
} from '../../../web/src/rule-bot/endgame-brain.mjs';
import { decideClintRule, ruleObservation } from '../../../web/src/rule-bot/runtime.mjs';
import { createRuleOpponent } from '../simulation/rule-baseline.mjs';
import { advanceRound, createRound, seededRandom } from '../simulation/simulation.mjs';

initializeValue();
initializeHints();
const deck = makeDeck();
const byId = new Map(deck.map((c) => [c.id, c]));
const ids = (pl) => (pl ? pl.cards.map((c) => c.id).sort((a, b) => a - b) : null);
const UNLIMITED = { ms: 1e9, worldMs: 1e9 };

function withRandom(seed, fn) {
  const previous = Math.random;
  Math.random = seededRandom(seed);
  try {
    return fn();
  } finally {
    Math.random = previous;
  }
}
function view(game, p) {
  return {
    hands: game.hands.map((h, s) => (s === p ? h : new Array(h.length))),
    L: game.L,
    trick: game.trick,
    log: game.log,
    seen: game.log.flatMap((e) => e.cards || []),
    trib: [],
    pw: [],
    phase: 'play',
    turn: game.turn,
    passes: game.passes || 0,
    out: game.out.slice(),
  };
}

test('upstream 2d91ecc: a late bomb takes the whole five-ace group, not four plus a single', () => {
  for (const [left, extra] of [
    [5, [3]],
    [8, [4, 9]],
  ]) {
    const used = new Set();
    const take = (r, n, ok = (s) => s !== 'H') => {
      const got = deck.filter((c) => c.r === r && ok(c.s) && !used.has(c.id)).slice(0, n);
      for (const c of got) used.add(c.id);
      return got;
    };
    const hand = take(14, 5, () => true).concat(extra.flatMap((r) => take(r, 1)));
    const joker = take(17, 1, () => true),
      play = { ...analyze(joker, 2)[0], cards: joker };
    const pl = createRuleOpponent(9409001)({
      L: 2,
      turn: 0,
      hands: [hand, new Array(left), new Array(10), new Array(9)],
      trick: { player: 1, play },
      log: [{ p: 1, ...play, lead: true }],
      trib: [],
    });
    // Upstream 15868750 played a four-ace bomb here (or passed with 8 opponent cards); 2d91ecc plays all five.
    assert.equal(pl.type, 'bomb');
    assert.equal(pl.n, 5);
    assert.ok(pl.cards.every((c) => c.r === 14));
  }
});

test('残局大脑 matches upstream endgame-brain.js on fixed positions where it overrides the rules', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/clint-endgame-brain-20261109.json', import.meta.url), 'utf8'),
  );
  assert.equal(fixture.upstreamSHA, '2d91ecca950e6617f80e500cd205450112bb40d4');
  assert.ok(fixture.positions.length >= 4);
  for (const pos of fixture.positions) {
    const cards = (list) => list.map((id) => byId.get(id));
    const game = {
      L: pos.L,
      turn: pos.turn,
      passes: pos.passes,
      out: pos.out,
      hands: pos.hands.map(cards),
      log: pos.log.map(([p, list, lead, type, value, n]) =>
        list ? { p, cards: cards(list), lead: !!lead, type, value, n } : { p, cards: null },
      ),
      trick: pos.trick && {
        player: pos.trick.player,
        play: {
          type: pos.trick.type,
          value: pos.trick.value,
          n: pos.trick.n,
          cards: cards(pos.trick.ids),
        },
      },
    };
    const p = pos.turn;
    runtime.game = view(game, p);
    assert.ok(brainOn(p));
    assert.deepEqual(
      withRandom(pos.seed, () => ids(chooseRuleAction(p))),
      pos.upstreamRules,
    );
    runtime.game = view(game, p);
    const searched = withRandom(pos.seed, () => chooseClintAction(p, UNLIMITED));
    assert.deepEqual(ids(searched), pos.upstreamBrain);
    assert.ok(beats(searched, game.trick?.play));
  }
});

test('残局大脑 stays off outside the endgame, off turn, and keeps the rules play when out of time', () => {
  const game = createRound(9409002);
  runtime.game = view(game, game.turn);
  assert.equal(brainOn(game.turn), false); // 27 cards a hand
  for (const h of game.hands) h.length = Math.min(h.length, BRAIN.max);
  runtime.game = view(game, game.turn);
  assert.equal(brainOn((game.turn + 1) % 4), false);
  assert.equal(brainOn(game.turn), true);
  const rules = withRandom(5, () => chooseRuleAction(game.turn));
  runtime.game = view(game, game.turn);
  const kept = endgameBrain(game.turn, rules, { ms: 0 });
  assert.equal(kept, rules);
});

test('Clint Worker brain reads only its own hand and public counts in the endgame', () => {
  const game = createRound(9409003);
  game.tok = 1;
  game.round = 1;
  game.phase = 'play';
  // play the rules until every hand is within the brain's reach
  for (let i = 0; i < 1000 && !game.hands.every((h) => h.length <= BRAIN.max); i++) {
    runtime.game = view(game, game.turn);
    if (
      advanceRound(
        game,
        withRandom(i, () => chooseRuleAction(game.turn)),
      )
    )
      break;
  }
  const p = game.turn;
  assert.ok(game.hands.every((h) => h.length <= BRAIN.max) && game.hands[p].length);
  const hidden = {
    ...game,
    hands: game.hands.map((h, seat) =>
      seat === p
        ? h
        : new Proxy(h, {
            get(t, k) {
              if (k === 'length') return t.length;
              throw Error('Hidden hand access');
            },
          }),
    ),
  };
  const obs = ruleObservation(hidden, p);
  assert.equal(obs.phase, 'play');
  assert.equal(obs.turn, p);
  assert.deepEqual(obs.out, game.out);
  const previous = runtime.game;
  const reply = decideClintRule(obs, { ms: 300, worldMs: 150 });
  assert.equal(runtime.game, previous);
  const cards = reply ? reply.cards.map((id) => game.hands[p].find((c) => c.id === id)) : null;
  if (cards) assert.ok(cards.every(Boolean));
  else assert.ok(game.trick);
});
