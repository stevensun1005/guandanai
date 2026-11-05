import { isWild, val } from '../core/cards.js';
import { analyze, beats, isBomb, power } from '../core/combinations.js';

export let groupKey;
export let cardSum;

export function handGroups(hand, L) {
  const n = {},
    jk = hand.filter((c) => c.r >= 16).length;
  for (const c of hand)
    if (!isWild(c, L)) {
      const k = groupKey(c, jk);
      n[k] = (n[k] || 0) + 1;
    }
  return { n, jk };
}

// 0 whole groups, 1 breaks a pair, 2 breaks a three, 3 a bomb, 4 breaks a bomb, 5 uses wild cards
export function hintTier(pl, g) {
  if (pl.wu) return 5;
  const used = {};
  for (const c of pl.cards) {
    const k = groupKey(c, g.jk);
    used[k] = (used[k] || 0) + 1;
  }
  let t = isBomb(pl) ? 3 : 0;
  for (const k in used) {
    const s = g.n[k];
    if (used[k] < s) t = Math.max(t, s >= 4 ? 4 : s === 3 ? 2 : 1);
  }
  return t;
}

// every three-with-a-pair without wild cards (move generation keeps only one pair per three)
function fullHouses(hand, L) {
  const by = {},
    out = [];
  for (const c of hand) if (!isWild(c, L)) (by[c.r] || (by[c.r] = [])).push(c);
  for (const t in by)
    if (t < 16 && by[t].length >= 3)
      for (const p in by)
        if (p !== t && by[p].length >= 2) {
          const cards = by[t].slice(0, 3).concat(by[p].slice(0, 2));
          for (const a of analyze(cards, L))
            if (a.type === 'full') out.push({ ...a, cards, wu: 0 });
        }
  return out;
}

// following: whole groups first, then breaking a pair, a three, then bombs, broken bombs and wild cards;
// smallest first at each step, bombs after the other plays of their step
function followHints(hand, L, cur, plays) {
  const g = handGroups(hand, L);
  const all = plays
    .filter((pl) => pl.type !== 'full' || pl.wu)
    .concat(fullHouses(hand, L).filter((pl) => beats(pl, cur)));
  return all
    .map((pl) => ({ pl, t: hintTier(pl, g), b: isBomb(pl) }))
    .sort(
      (a, b) =>
        a.t - b.t ||
        a.b - b.b ||
        (a.b ? power(a.pl) - power(b.pl) : a.pl.value - b.pl.value) ||
        cardSum(a.pl, L) - cardSum(b.pl, L),
    )
    .map((x) => x.pl);
}

// leading: the smallest card's whole group first (a three takes the smallest whole pair along), then upwards;
// a run made only of whole groups comes before its lowest card's group; no wild cards, broken bombs or bombs
function leadHints(hand, L, plays) {
  const g = handGroups(hand, L),
    by = {},
    out = [];
  for (const c of hand) if (!isWild(c, L)) (by[c.r] || (by[c.r] = [])).push(c);
  const v = (r) => (r >= 16 ? +r : r == L ? 15 : +r);
  for (const pl of plays)
    if (/straight|pairs3|trip2/.test(pl.type) && hintTier(pl, g) === 0)
      out.push({ pl, k: pl.value, s: 0 });
  // a run that needs a wild card to fill a gap (33 4 55 and a wild as two 4s) but breaks no group comes right after
  // the plays of its lowest rank
  for (const pl of plays)
    if (
      pl.wu &&
      /straight|pairs3|trip2/.test(pl.type) &&
      hintTier({ ...pl, cards: pl.cards.filter((c) => !isWild(c, L)), wu: 0 }, g) === 0
    )
      out.push({ pl, k: pl.value, s: 2 });
  const pairs = Object.keys(by)
    .filter((r) => by[r].length === 2 && g.n[groupKey(by[r][0], g.jk)] === 2)
    .sort((a, b) => v(a) - v(b));
  for (const r in by) {
    const cs = by[r];
    if (g.n[groupKey(cs[0], g.jk)] >= 4) continue;
    const p = cs.length === 3 && pairs.find((q) => q !== r);
    const cards = p ? cs.concat(by[p]) : cs.slice();
    const a = analyze(cards, L).find(
      (a) => a.type === (p ? 'full' : ['single', 'pair', 'triple'][cs.length - 1]),
    );
    if (a) out.push({ pl: { ...a, cards, wu: 0 }, k: v(r), s: 1 });
  }
  return out.sort((a, b) => a.k - b.k || a.s - b.s).map((x) => x.pl);
}

export function hintOrder(hand, L, cur, plays) {
  const fin = plays.filter((pl) => pl.cards.length === hand.length);
  let list = cur ? followHints(hand, L, cur, plays) : leadHints(hand, L, plays);
  if (!list.length)
    list = plays
      .slice()
      .sort(
        (a, b) => isBomb(a) - isBomb(b) || (isBomb(a) ? power(a) - power(b) : a.value - b.value),
      );
  const seen = new Set();
  return fin.concat(list).filter((pl) => {
    const k = pl.cards
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join();
    return !seen.has(k) && seen.add(k);
  });
}

export function initialize() {
  /* ---------- hints: follow the shape of the hand, not strategy ---------- */
  // each rank's cards are one group (single, pair, three, bomb); four jokers are one group; wild cards belong to none
  groupKey = (c, jk) => (c.r >= 16 && jk === 4 ? 'J' : c.r);
  cardSum = (pl, L) => pl.cards.reduce((s, c) => s + val(c, L), 0);
}
