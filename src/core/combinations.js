import { isWild } from './cards.js';

export const isBomb = (p) => p.type === 'bomb' || p.type === 'sflush' || p.type === 'jokers';

export const power = (p) =>
  p.type === 'jokers' ? 10000 : p.type === 'sflush' ? 550 + p.value : p.n * 100 + p.value;

export const strength = (p) => (isBomb(p) ? 100000 + power(p) : p.value);

/* ---------- combination rules ---------- */
// starts s (A may sit at 1 or 14) where nat cards fit len consecutive ranks with `need` each; wilds fill the gaps
function seqStarts(nat, w, len, need) {
  const out = [];
  if (nat.length + w !== len * need) return out;
  for (let s = 1; s + len - 1 <= 14; s++) {
    const cnt = {};
    let ok = true;
    for (const c of nat) {
      let p = c.r;
      if (p === 14 && s === 1) p = 1;
      if (p < s || p > s + len - 1) {
        ok = false;
        break;
      }
      cnt[p] = (cnt[p] || 0) + 1;
      if (cnt[p] > need) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(s);
  }
  return out;
}

// every legal reading of a set of cards
export function analyze(cards, L) {
  const n = cards.length,
    res = [];
  if (!n) return res;
  const wild = cards.filter((c) => isWild(c, L)),
    rest = cards.filter((c) => !isWild(c, L));
  const w = wild.length;
  const jok = rest.filter((c) => c.r >= 16),
    nat = rest.filter((c) => c.r < 16);
  const cnt = {};
  for (const c of nat) cnt[c.r] = (cnt[c.r] || 0) + 1;
  const ranks = Object.keys(cnt).map(Number);
  const v = (r) => (r >= 16 ? r : r === L ? 15 : r);
  const add = (type, value) => res.push({ type, value, n });

  if (jok.length) {
    if (n === 1) add('single', jok[0].r);
    else if (n === 2 && jok.length === 2 && jok[0].r === jok[1].r) add('pair', jok[0].r);
    else if (n === 4 && jok.length === 4) add('jokers', 99);
    else if (
      n === 5 &&
      jok.length === 2 &&
      jok[0].r === jok[1].r &&
      ranks.length === 1 &&
      nat.length + w === 3
    )
      add('full', v(ranks[0]));
    return res;
  }
  if (ranks.length <= 1) {
    const sv = ranks.length ? v(ranks[0]) : 15;
    if (n === 1) add('single', sv);
    else if (n === 2) add('pair', sv);
    else if (n === 3) add('triple', sv);
    else add('bomb', sv);
  }
  if (n === 5) {
    if (ranks.length === 2) {
      for (const [t, p] of [
        [ranks[0], ranks[1]],
        [ranks[1], ranks[0]],
      ]) {
        if (cnt[t] <= 3 && cnt[p] <= 2) add('full', v(t));
      }
    }
    if (ranks.length === 1 && nat.length === 3 && w === 2 && ranks[0] !== L)
      add('full', v(ranks[0]));
    const ss = seqStarts(nat, w, 5, 1);
    if (ss.length) {
      const top = Math.max(...ss);
      // a run all in one suit (a wild card filling any gap) is a straight flush, a bomb; it cannot be played as a plain straight
      if (new Set(nat.map((c) => c.s)).size <= 1) add('sflush', top);
      else add('straight', top);
    }
  }
  if (n === 6) {
    const a = seqStarts(nat, w, 3, 2);
    if (a.length) add('pairs3', Math.max(...a));
    const b = seqStarts(nat, w, 2, 3);
    if (b.length) add('trip2', Math.max(...b));
  }
  return res;
}

export function beats(p, cur) {
  if (!cur) return true;
  const pb = isBomb(p),
    cb = isBomb(cur);
  if (pb && !cb) return true;
  if (!pb && cb) return false;
  if (pb) return power(p) > power(cur);
  return p.type === cur.type && p.n === cur.n && p.value > cur.value;
}
