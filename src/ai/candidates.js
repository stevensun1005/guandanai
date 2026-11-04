import { SEQS, isWild } from '../core/cards.js';
import { analyze, beats } from '../core/combinations.js';

const cardKey = (c) => c.r + c.s;

// Both copies of a card are interchangeable; suits are not.
function choose(cards, n) {
  const out = [];
  function visit(start, picked) {
    if (picked.length === n) {
      out.push(picked);
      return;
    }
    for (let i = start; i <= cards.length - (n - picked.length); i++) {
      if (i > start && cardKey(cards[i]) === cardKey(cards[i - 1])) continue;
      visit(i + 1, picked.concat(cards[i]));
    }
  }
  visit(0, []);
  return out;
}

export function candidates(hand, L, cur) {
  const wild = hand.filter((c) => isWild(c, L));
  const by = {};
  for (const c of hand.filter((c) => !isWild(c, L))) (by[c.r] ||= []).push(c);
  for (const group of Object.values(by))
    group.sort((a, b) => a.s.localeCompare(b.s) || a.id - b.id);
  const out = [],
    seen = new Set();
  function add(cards) {
    const faces = cards.map(cardKey).sort().join(',');
    for (const a of analyze(cards, L)) {
      if (!beats(a, cur)) continue;
      const key = a.type + ':' + a.value + ':' + faces;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...a, cards, wu: cards.filter((c) => isWild(c, L)).length });
    }
  }
  function groups(rank, n) {
    const result = [];
    for (let w = 0; w <= Math.min(wild.length, n); w++) {
      if (rank >= 16 && w) continue;
      for (const cards of choose(by[rank] || [], n - w)) result.push({ cards, w });
    }
    return result;
  }
  for (let rank = 2; rank <= 17; rank++) {
    if (rank === 15) continue;
    const max = rank >= 16 ? 2 : Math.min(10, (by[rank] || []).length + wild.length);
    for (let n = 1; n <= max; n++)
      for (const g of groups(rank, n)) add(g.cards.concat(wild.slice(0, g.w)));
  }
  const jokers = (by[16] || []).concat(by[17] || []);
  if (jokers.length === 4) add(jokers);
  for (let t = 2; t <= 14; t++)
    for (const triple of groups(t, 3)) {
      for (let p = 2; p <= 17; p++) {
        if (p === t || p === 15) continue;
        for (const pair of groups(p, 2))
          if (triple.w + pair.w <= wild.length) {
            add(triple.cards.concat(pair.cards, wild.slice(0, triple.w + pair.w)));
          }
      }
    }
  for (const [len, need] of SEQS)
    for (let start = 1; start + len - 1 <= 14; start++) {
      function run(offset, cards, w) {
        if (offset === len) {
          add(cards.concat(wild.slice(0, w)));
          return;
        }
        const rank = start + offset === 1 ? 14 : start + offset;
        for (const group of groups(rank, need))
          if (w + group.w <= wild.length) {
            run(offset + 1, cards.concat(group.cards), w + group.w);
          }
      }
      run(0, [], 0);
    }
  if (cur) out.push(null);
  return out;
}
