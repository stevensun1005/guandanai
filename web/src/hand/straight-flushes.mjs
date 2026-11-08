import { SUITS, SUIT_ORDER, isWild } from '../core/cards.js';
import { analyze } from '../core/combinations.js';
// Display hints only. Neural/Clint candidate generation remains independent.
export function uniqueStraightFlushes(hand, L) {
  const w = hand.filter((c) => isWild(c, L)),
    out = [];
  for (const su of SUITS)
    for (let s = 1; s <= 10; s++) {
      const nat = [];
      let wu = 0;
      for (let q = s; q < s + 5; q++) {
        const r = q === 1 ? 14 : q,
          c = hand.find((x) => !isWild(x, L) && x.s === su && x.r === r);
        if (c) nat.push(c);
        else wu++;
      }
      if (wu <= w.length && wu < 5) {
        const cards = nat.concat(w.slice(0, wu));
        if (analyze(cards, L).some((a) => a.type === 'sflush')) out.push({ cards, wu, s, su });
      }
    }
  const same = new Map();
  for (const option of out) {
    const key = option.cards
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join(',');
    if (!same.has(key) || option.s > same.get(key).s) same.set(key, option);
  }
  const all = [...same.values()];
  return all
    .filter(
      (a) =>
        !all.some(
          (b) =>
            b !== a &&
            b.wu < a.wu &&
            a.cards.filter((c) => !isWild(c, L)).every((c) => b.cards.includes(c)),
        ),
    )
    .sort((a, b) => a.wu - b.wu || a.s - b.s || SUIT_ORDER[a.su] - SUIT_ORDER[b.su]);
}
