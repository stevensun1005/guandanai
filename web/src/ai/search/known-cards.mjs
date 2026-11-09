/**
 * Publicly known card ownership after a tribute or an anti-tribute, for world sampling.
 *
 * Everyone at the table sees each tribute card and each return card, and an anti-tribute names
 * how many big jokers each giver holds. What is public is a FACE, not a physical copy (the two
 * copies of a card look the same), so this keeps face-level obligations per seat:
 *   kang {g, n}         seat g holds n big jokers;
 *   tribute g -> r, tc  r holds one more face(tc); g loses an obligation of that face if it had one;
 *   return  r -> g, rc  g holds one more face(rc); r loses an obligation of that face if it had one;
 *   a play by seat s    of a card with face F removes one F obligation of s (never below 0).
 * The mover's own seat is skipped (its hand is known). Each remaining obligation is mapped to the
 * lowest-id unseen physical copy of the face; the copies are interchangeable in play, so this does
 * not change any value. A contradiction throws KnownCardsError and the decision falls back.
 */
import { unseenPhysicalCards } from '../../analysis/concepts.mjs';
import { cardIndex } from '../encoding.mjs';

export const BIG_JOKER_FACE = 53;

export class KnownCardsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KnownCardsError';
  }
}

const isId = (id) => Number.isInteger(id) && id >= 0 && id < 108;
const isSeat = (seat) => Number.isInteger(seat) && seat >= 0 && seat < 4;

/**
 * `view` = {p, hand, counts, log} with physical ids; `exchanges` = {trib: [{g, r, tc, rc}],
 * kang: {has: [{g, n}]}} with physical ids (rc may be missing). Returns [{seat, card}].
 */
export function publicKnownCards(view, exchanges) {
  const trib = exchanges?.trib || [];
  const has = exchanges?.kang?.has || [];
  if (!trib.length && !has.length) return [];
  const need = [0, 1, 2, 3].map(() => new Map());
  const add = (seat, face, n = 1) => need[seat].set(face, (need[seat].get(face) || 0) + n);
  const take = (seat, face) => {
    const left = need[seat].get(face) || 0;
    if (left > 0) need[seat].set(face, left - 1);
  };
  for (const { g, n } of has) {
    if (!isSeat(g) || !Number.isInteger(n) || n < 0 || n > 2)
      throw new KnownCardsError('Invalid anti-tribute record');
    add(g, BIG_JOKER_FACE, n);
  }
  for (const t of trib) {
    if (!isSeat(t.g) || !isSeat(t.r) || !isId(t.tc))
      throw new KnownCardsError('Invalid tribute record');
    take(t.g, cardIndex(t.tc));
    add(t.r, cardIndex(t.tc));
  }
  for (const t of trib) {
    if (t.rc === undefined || t.rc === null) continue;
    if (!isId(t.rc)) throw new KnownCardsError('Invalid return record');
    take(t.r, cardIndex(t.rc));
    add(t.g, cardIndex(t.rc));
  }
  for (const entry of view.log)
    for (const id of entry.cards || []) if (isSeat(entry.p)) take(entry.p, cardIndex(id));
  const free = new Map();
  for (const id of unseenPhysicalCards(view).sort((a, b) => a - b)) {
    const face = cardIndex(id);
    if (!free.has(face)) free.set(face, []);
    free.get(face).push(id);
  }
  const known = [];
  for (let seat = 0; seat < 4; seat++) {
    if (seat === view.p) continue;
    let total = 0;
    for (const [face, n] of [...need[seat]].sort((a, b) => a[0] - b[0])) {
      const pool = free.get(face) || [];
      if (pool.length < n) throw new KnownCardsError('Known card is no longer unseen');
      for (const card of pool.splice(0, n)) known.push({ seat, card });
      total += n;
    }
    if (total > view.counts[seat]) throw new KnownCardsError('More known cards than hand count');
  }
  return known;
}
