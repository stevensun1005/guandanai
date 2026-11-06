import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, val } from '../../../web/src/core/cards.js';
import { analyze } from '../../../web/src/core/combinations.js';
import { createRuleOpponent } from '../simulation/rule-baseline.mjs';
import { createRound, advanceRound } from '../simulation/simulation.mjs';

const deck = makeDeck();
function take(ranks) {
  const used = new Set();
  return ranks.map((r) => {
    const c = deck.find((c) => c.r === r && c.s !== 'H' && !used.has(c.id));
    assert(c);
    used.add(c.id);
    return c;
  });
}
function singleGame(ranks, winner = 3, rank = 7) {
  const hand = take(ranks);
  const c = deck.find((c) => c.r === rank && c.s !== 'H' && !hand.includes(c));
  const play = { ...analyze([c], 7)[0], cards: [c] };
  return {
    L: 7,
    turn: 0,
    hands: [hand, new Array(20), new Array(20), new Array(20)],
    trick: { player: winner, play },
    log: [{ p: winner, ...play, lead: true }],
    trib: [],
  };
}
const choose = (g) => createRuleOpponent(9204001)(g);

test('Clint follows a partner single with a lone ace, retaining the other combinations', () => {
  const g = singleGame([14, 5, 5, 3, 3, 3], 2, 10),
    p = choose(g);
  assert.equal(p.type, 'single');
  assert.equal(p.value, 14);
});
test('Clint uses the smallest available lone single against either team', () => {
  for (const winner of [2, 3]) {
    const g = singleGame([8, 14, 5, 5, 3, 3, 3], winner, 6),
      p = choose(g);
    assert.equal(p.type, 'single');
    assert.equal(p.value, 8);
  }
});
test('Clint breaks a natural level pair before spending either joker on an opponent ace', () => {
  const g = singleGame([7, 7, 16, 17, 5, 5, 3, 3, 3], 3, 14),
    p = choose(g);
  assert.equal(p.type, 'single');
  assert.equal(p.value, 15);
  assert.equal(p.cards[0].r, 7);
  assert.notEqual(p.cards[0].s, 'H');
  assert.equal(g.hands[0].filter((c) => c.r === 7).length, 2);
});
test('Clint gives an unplayed partner the first try before its only big-joker single', () => {
  assert.equal(choose(singleGame([17, 5, 5, 3, 3, 3])), null);
  const paid = singleGame([17, 5, 5, 3, 3, 3]);
  paid.trib = [{ g: 2, tc: deck.find((c) => c.r === 8) }];
  assert.equal(choose(paid).value, 17);
  assert.equal(choose(singleGame([17, 5, 5, 3, 3, 3], 3, 16)).value, 17);
  const tried = singleGame([17, 5, 5, 3, 3, 3], 1);
  tried.log.push({ p: 2, cards: null }, { p: 3, cards: null });
  assert.equal(choose(tried).value, 17);
  const later = singleGame([17, 5, 5, 3, 3, 3]);
  later.log.unshift({ p: 1, type: 'single', value: 4, n: 1, cards: take([4]), lead: true });
  assert.equal(choose(later).value, 17);
});

// Controlled public-history fixtures, not complete replay or strength evidence.
function leadGame(types) {
  const g = createRound(9204100);
  g.L = 7;
  g.turn = 0;
  g.trick = null;
  g.hands = [g.hands[0].filter((c) => c.r !== 10), new Array(20), new Array(20), new Array(20)];
  const used = new Set(g.hands[0].map((c) => c.id));
  const grab = (r, n) =>
    Array.from({ length: n }, () => {
      const c = deck.find((c) => c.r === r && !used.has(c.id) && !(c.r === 7 && c.s === 'H'));
      assert(c);
      used.add(c.id);
      return c;
    });
  const play = (type, high) => {
    const r = high ? 5 : 3;
    const cards =
      type === 'pair'
        ? grab(r, 2)
        : type === 'full'
          ? grab(r, 3).concat(grab(r + 1, 2))
          : [r, r + 1, r + 2, r + 3, r + 4].flatMap((v) => grab(v, 1));
    const shape = analyze(cards, 7).find((s) => s.type === type);
    assert(shape);
    return { ...shape, cards };
  };
  g.log = [];
  for (const type of types) {
    g.log.push(
      { p: 2, ...play(type, false), lead: true },
      { p: 3, ...play(type, true), lead: false },
    );
    g.log.push({ p: 2, cards: null });
  }
  return g;
}
test('Clint re-leads the latest lost partner kind using a small legal group', () => {
  for (const [type, value] of [
    ['pair', 11],
    ['full', 9],
    ['straight', 2],
  ]) {
    const p = choose(leadGame([type]));
    assert.equal(p.type, type);
    assert.equal(p.value, value);
    assert(analyze(p.cards, 7).some((s) => s.type === p.type && s.value === p.value));
  }
  assert.equal(choose(leadGame(['pair', 'full'])).type, 'full');
});
test('Clint does not infer an unanswered partner lead after the partner has played again', () => {
  const g = leadGame(['full']);
  const used = new Set(g.hands[0].concat(g.log.flatMap((e) => e.cards || [])).map((c) => c.id));
  const full = (r, pair) => {
    const cards = [r, r, r, pair, pair].map((rank) => {
      const c = deck.find((c) => c.r === rank && !used.has(c.id));
      assert(c);
      used.add(c.id);
      return c;
    });
    return { ...analyze(cards, 7).find((s) => s.type === 'full'), cards };
  };
  g.log.pop();
  g.log.push(
    { p: 0, cards: null },
    { p: 1, cards: null },
    { p: 2, ...full(8, 10), lead: false },
    { p: 3, ...full(11, 12), lead: false },
  );
  assert.equal(choose(g).type, 'pair');
});
test('Clint decisions use public observations, independently of opponents private ranks', () => {
  const a = singleGame([7, 7, 16, 17, 5, 5, 3, 3, 3], 3, 14),
    b = structuredClone(a);
  const unseen = deck.filter((c) => !a.hands[0].includes(c) && !a.trick.play.cards.includes(c));
  for (const g of [a, b]) {
    const pool = g === a ? unseen : unseen.slice().reverse();
    for (let p = 1; p < 4; p++) g.hands[p] = pool.slice((p - 1) * 20, p * 20);
  }
  const p = choose(a),
    q = choose(b);
  assert.deepEqual(
    p.cards.map((c) => c.id),
    q.cards.map((c) => c.id),
  );
  assert.equal(val(p.cards[0], 7), 15);
});
test('Clint completes eight seeded legal rounds after the strategy update', (t) => {
  let decisions = 0;
  for (let seed = 9204200; seed < 9204208; seed++) {
    const g = createRound(seed),
      bot = createRuleOpponent(seed ^ 0x6a09e667);
    let result;
    for (let n = 0; n < 2000 && !result; n++) {
      const p = bot(g);
      if (p) assert(analyze(p.cards, g.L).some((s) => s.type === p.type && s.value === p.value));
      result = advanceRound(g, p);
      decisions++;
    }
    assert(result);
    assert.equal(new Set(result.order).size, 4);
  }
  t.diagnostic(
    JSON.stringify({
      purpose: 'development legality only',
      seedBase: 9204200,
      completedRounds: 8,
      decisions,
    }),
  );
});
