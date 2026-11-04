import { runtime } from '../app/runtime.js';
import { isWild, val } from '../core/cards.js';
import { analyze, beats, isBomb, power, strength } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
import { cardSum, groupKey, handGroups, hintOrder, hintTier } from './hints.js';

export function sortHints(plays) {
  const hand = runtime.game.hands[0],
    L = runtime.game.L,
    cur = runtime.game.trick ? runtime.game.trick.play : null,
    full = hintOrder(hand, L, cur, plays);
  const have = new Set(hand.map((c) => c.id));
  runtime.game.fixed = (runtime.game.fixed || [])
    .map((gr) => gr.filter((id) => have.has(id)))
    .filter((gr) => gr.length);
  if (!runtime.game.fixed.length) return full;
  const key = (pl) =>
      pl.cards
        .map((c) => c.id)
        .sort((a, b) => a - b)
        .join(),
    fixed = new Set(runtime.game.fixed.flat());
  const nf = (pl) => pl.cards.filter((c) => fixed.has(c.id)).length;
  const whole = (pl) =>
    runtime.game.fixed.every((gr) => {
      const n = pl.cards.filter((c) => gr.includes(c.id)).length;
      return !n || n === gr.length;
    });
  // a fixed bomb (or straight flush, or the four jokers) is never split up, alone or with active cards: it is
  // offered whole, among the fixed plays
  const solid = runtime.game.fixed.filter((gr) =>
    analyze(
      gr.map((id) => hand.find((c) => c.id === id)),
      L,
    ).some(isBomb),
  );
  const splits = (pl) =>
    solid.some((gr) => {
      const n = pl.cards.filter((c) => gr.includes(c.id)).length;
      return n > 0 && n < gr.length;
    });
  const zone = (cards) =>
    cards.length
      ? hintOrder(
          cards,
          L,
          cur,
          genPlays(cards, L).filter((pl) => beats(pl, cur)),
        )
      : [];
  const own = [];
  for (const gr of runtime.game.fixed) {
    const cards = gr.map((id) => hand.find((c) => c.id === id));
    const r = analyze(cards, L)
      .filter((a) => beats(a, cur) && (!isBomb(a) || (cur && isBomb(cur))))
      .sort((a, b) => strength(a) - strength(b))[0];
    if (r) own.push({ ...r, cards, wu: cards.filter((c) => isWild(c, L)).length });
  }
  const act = hand.filter((c) => !fixed.has(c.id)),
    ag = handGroups(act, L);
  const fx = zone(hand.filter((c) => fixed.has(c.id))).filter((pl) => !splits(pl));
  // the active cards' share of a play: no wild card, and every rank it takes is taken whole, makes it pure
  const part = (pl) => pl.cards.filter((c) => !fixed.has(c.id));
  const aPure = (pl) => {
    const a = part(pl),
      u = {};
    if (a.some((c) => isWild(c, L))) return false;
    for (const c of a) {
      const k = groupKey(c, ag.jk);
      u[k] = (u[k] || 0) + 1;
    }
    return Object.keys(u).every((k) => u[k] === ag.n[k]);
  };
  const pure = (pl) => !pl.wu && !isBomb(pl) && hintTier(pl, ag) === 0;
  // how far a play breaks up the active cards (the fixed groups are not counted: they are played as the player set them)
  const tier = (pl) => {
    const a = part(pl);
    return hintTier({ ...pl, cards: a, wu: a.filter((c) => isWild(c, L)).length }, ag);
  };
  // size for ordering pure plays of both zones together: following, by the play's value; leading, by its lowest card
  // (a run before the single plays of that card)
  const lowest = (pl) =>
    Math.min(99, ...pl.cards.filter((c) => !isWild(c, L)).map((c) => val(c, L)));
  const size = (pl) =>
    cur ? [pl.value, cardSum(pl, L)] : [lowest(pl), /straight|pairs3|trip2/.test(pl.type) ? 0 : 1];
  const bySize = (a, b) => {
    const x = size(a),
      y = size(b);
    return x[0] - y[0] || x[1] - y[1];
  };
  const az = zone(act),
    pureA = az.filter(pure);
  // pure plays of the fixed side: a whole group as set, whole groups together, whole groups with whole active groups
  // (the same size: a single group first, then groups together, then groups with active cards)
  const mixed = full.filter(
    (pl) => nf(pl) > 0 && nf(pl) < pl.cards.length && !splits(pl) && whole(pl),
  );
  const pureB = []
    .concat(
      own.filter((pl) => !isBomb(pl)).map((pl) => ({ pl, k: 0 })),
      fx.filter((pl) => whole(pl) && !isBomb(pl)).map((pl) => ({ pl, k: 1 })),
      mixed.filter((pl) => !isBomb(pl) && aPure(pl)).map((pl) => ({ pl, k: 2 })),
    )
    .sort((a, b) => bySize(a.pl, b.pl) || a.k - b.k)
    .map((x) => x.pl);
  const pures = [];
  for (let i = 0, j = 0; i < pureA.length || j < pureB.length;)
    pures.push(
      j >= pureB.length || (i < pureA.length && bySize(pureA[i], pureB[j]) <= 0)
        ? pureA[i++]
        : pureB[j++],
    );
  // then what breaks no fixed group: the active cards' other plays, bombs (the fixed ones and the active ones together,
  // small to large), plays with wild cards, in the order of the table (breaking a pair, a three, ... wild cards)
  const rest = az
    .filter((pl) => !pure(pl))
    .concat(
      own.filter(isBomb),
      fx.filter((pl) => isBomb(pl) && whole(pl)),
      mixed.filter((pl) => isBomb(pl) || !aPure(pl)),
    )
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        isBomb(a) - isBomb(b) ||
        (isBomb(a) ? power(a) - power(b) : a.value - b.value) ||
        cardSum(a, L) - cardSum(b, L),
    );
  // last, plays that take cards out of a fixed group: the hand's own order, as if those cards were loose
  const seen = new Set();
  const out = full
    .filter((pl) => pl.cards.length === hand.length)
    .concat(
      pures,
      rest,
      full.filter((pl) => !whole(pl) && !splits(pl)),
    )
    .filter((pl) => {
      const k = key(pl);
      return !seen.has(k) && seen.add(k);
    });
  // nothing left but fixed bombs (and the plays that would split them): as in the plain order, when there is nothing else
  // to lead or to answer with, every play that does not split a fixed bomb is listed, the ordinary ones first and the
  // bombs after them, small to large
  if (!out.length)
    return plays
      .filter((pl) => !splits(pl))
      .sort(
        (a, b) =>
          isBomb(a) - isBomb(b) ||
          (isBomb(a) ? power(a) - power(b) : a.value - b.value) ||
          cardSum(a, L) - cardSum(b, L),
      );
  return out;
}
