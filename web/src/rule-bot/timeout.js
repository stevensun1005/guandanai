/** Clint-only human timeout policy. Not used for neural inference or ordinary rule turns. */
import { isWild, val } from '../core/cards.js';
import { analyze, isBomb, power } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
const types = ['single', 'pair', 'triple', 'full', 'straight', 'pairs3', 'trip2'];
function plays(hand, L) {
  const all = genPlays(hand, L),
    by = {};
  for (const c of hand) if (!isWild(c, L)) (by[c.r] ||= []).push(c);
  for (const t in by)
    if (Number(t) < 16 && by[t].length >= 3)
      for (const p in by)
        if (t !== p && by[p].length >= 2) {
          const cards = by[t].slice(0, 3).concat(by[p].slice(0, 2));
          for (const shape of analyze(cards, L))
            if (shape.type === 'full') all.push({ ...shape, cards });
        }
  return all;
}
export function clintTimeout(hand, L, trick, fixed = [], random = Math.random) {
  if (!hand.length || trick) return null;
  const small = (a, b) =>
    a.value - b.value ||
    a.cards.reduce((s, c) => s + val(c, L), 0) - b.cards.reduce((s, c) => s + val(c, L), 0);
  const grouped = new Set(fixed.flat()),
    active = hand.filter((c) => !grouped.has(c.id));
  const jk = active.filter((c) => c.r >= 16).length,
    key = (c) => (c.r >= 16 && jk === 4 ? 'J' : c.r),
    counts = {};
  for (const c of active) if (!isWild(c, L)) counts[key(c)] = (counts[key(c)] || 0) + 1;
  const whole = plays(active, L).filter((pl) => {
    if (pl.cards.some((c) => isWild(c, L))) return false;
    const used = {};
    for (const c of pl.cards) used[key(c)] = (used[key(c)] || 0) + 1;
    return Object.keys(used).every((k) => used[k] === counts[k]);
  });
  for (const type of types) {
    const chosen = whole.filter((pl) => pl.type === type).sort(small)[0];
    if (chosen) return chosen;
  }
  const set = [];
  for (const ids of fixed) {
    const cards = ids.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length)
      for (const shape of analyze(cards, L)) if (!isBomb(shape)) set.push({ ...shape, cards });
  }
  if (set.length) return set.sort(small)[0];
  const all = plays(hand, L),
    bombs = all.filter(isBomb).sort((a, b) => power(a) - power(b));
  return (
    bombs[0] ||
    (all.length ? all[Math.min(all.length - 1, Math.floor(random() * all.length))] : null)
  );
}
