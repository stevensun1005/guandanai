import { SEQS, SUITS, isWild } from './cards.js';
import { analyze } from './combinations.js';

/* ---------- move generation ---------- */
export function genPlays(hand, L) {
  const wild = [],
    jk = { 16: [], 17: [] },
    by = {};
  for (const c of hand) {
    if (isWild(c, L)) wild.push(c);
    else if (c.r >= 16) jk[c.r].push(c);
    else (by[c.r] || (by[c.r] = [])).push(c);
  }
  const w = wild.length,
    sets = [],
    W = (k) => wild.slice(0, k);
  for (const r in by) {
    const g = by[r];
    for (let k = 1; k <= g.length + w; k++) {
      const nat = Math.min(g.length, k);
      sets.push(g.slice(0, nat).concat(W(k - nat)));
    }
  }
  if (w) {
    sets.push(W(1));
    if (w === 2) sets.push(W(2));
  }
  for (const r of [16, 17]) {
    const g = jk[r];
    if (g.length) sets.push([g[0]]);
    if (g.length === 2) sets.push(g.slice());
  }
  if (jk[16].length === 2 && jk[17].length === 2) sets.push(jk[16].concat(jk[17]));
  // three with a pair
  const T = [],
    P = [];
  for (const r in by) {
    const g = by[r],
      R = +r;
    if (g.length >= 3) T.push({ r: R, nat: g.slice(0, 3), wu: 0 });
    else if (g.length + w >= 3) T.push({ r: R, nat: g.slice(), wu: 3 - g.length });
    if (g.length >= 2) P.push({ r: R, nat: g.slice(0, 2), wu: 0 });
    else if (w) P.push({ r: R, nat: g.slice(), wu: 1 });
  }
  if (w === 2 && !by[L]) P.push({ r: L, nat: [], wu: 2 });
  for (const r of [16, 17]) if (jk[r].length === 2) P.push({ r, nat: jk[r].slice(), wu: 0 });
  for (const t of T)
    for (const p of P) {
      if (t.r === p.r || t.wu + p.wu > w) continue;
      sets.push(t.nat.concat(p.nat, W(t.wu + p.wu)));
    }
  // straights, pairs in a row, triples in a row
  for (const [len, need] of SEQS) {
    for (let s = 1; s + len - 1 <= 14; s++) {
      let nat = [],
        wu = 0;
      for (let p = s; p < s + len; p++) {
        const g = by[p === 1 ? 14 : p] || [];
        const k = Math.min(g.length, need);
        nat = nat.concat(g.slice(0, k));
        wu += need - k;
      }
      if (wu <= w) sets.push(nat.concat(W(wu)));
    }
  }
  // straight flushes
  for (const su of SUITS)
    for (let s = 1; s <= 10; s++) {
      const nat = [];
      let wu = 0;
      for (let p = s; p < s + 5; p++) {
        const c = (by[p === 1 ? 14 : p] || []).find((x) => x.s === su);
        if (c) nat.push(c);
        else wu++;
      }
      if (wu <= w) sets.push(nat.concat(W(wu)));
    }
  const out = [],
    seen = new Set();
  for (const cs of sets) {
    const wu = cs.filter((c) => isWild(c, L)).length;
    for (const a of analyze(cs, L)) {
      const key = a.type + '|' + a.value + '|' + a.n + '|' + wu;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...a, cards: cs, wu });
    }
  }
  return out;
}
