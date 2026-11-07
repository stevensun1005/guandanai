/** Public/own-hand descriptions only. Never scores, ranks or chooses actions. */
import { makeDeck } from '../core/cards.js';
import { candidates } from '../ai/candidates.js';
import { AIP, handCost, initialize } from '../ai/hand-value.js';

if (!AIP) initialize();
const deck = makeDeck();
const bomb = (play) => !!play && ['bomb', 'sflush', 'jokers'].includes(play.type);
const ids = (cards) => (cards || []).map((c) => (typeof c === 'number' ? c : c.id));

export function remainingStructure(hand, level) {
  const ranks = new Map();
  let wilds = 0,
    jokers = 0;
  for (const id of ids(hand)) {
    const c = deck[id];
    if (!c) throw Error('Invalid physical card');
    if (c.s === 'H' && c.r === level) wilds++;
    else ranks.set(c.r, (ranks.get(c.r) || 0) + 1);
    if (c.r >= 16) jokers++;
  }
  const counts = [...ranks.values()];
  return {
    cards: hand.length,
    singles: counts.filter((n) => n === 1).length,
    pairs: counts.filter((n) => n === 2).length,
    triples: counts.filter((n) => n === 3).length,
    rankBombs: counts.filter((n) => n >= 4).length,
    wilds,
    jokers,
  };
}

/** A rule-derived observation, not proof of control or a reason to prefer a move. */
export function describeAction(state, play) {
  const held = ids(state.hand),
    used = new Set(ids(play?.cards));
  if ([...used].some((id) => !held.includes(id))) throw Error('Action contains foreign cards');
  const remaining = held.filter((id) => !used.has(id));
  const trick = state.canPass ? state.trick : null;
  if (state.canPass && !trick) throw Error('Missing public trick');
  const partner = (state.p + 2) % 4;
  return {
    scope: 'descriptive-not-causal-not-a-reward',
    lead: !trick,
    passed: !play,
    trickOwner: trick?.player ?? null,
    partnerLeading: trick?.player === partner,
    overPartner: !!play && trick?.player === partner,
    bombOverPartner: bomb(play) && trick?.player === partner,
    partnerAlreadyOut: state.counts[partner] === 0,
    partnerRemaining: state.counts[partner],
    opponentRemaining: [state.counts[(state.p + 1) % 4], state.counts[(state.p + 3) % 4]],
    handCostDelta:
      handCost(
        remaining.map((id) => deck[id]),
        state.level,
      ) -
      handCost(
        held.map((id) => deck[id]),
        state.level,
      ),
    remainingStructure: remainingStructure(remaining, state.level),
  };
}

/** Unseen physical pool. Opponent/private hand arrays are deliberately not accepted. */
export function unseenPhysicalCards(state) {
  const known = [...state.hand, ...state.log.flatMap((e) => e.cards || [])];
  if (new Set(known).size !== known.length || known.some((id) => !deck[id]))
    throw Error('Duplicate or invalid public cards');
  const seen = new Set(known);
  const unseen = deck.filter((c) => !seen.has(c.id)).map((c) => c.id);
  if (unseen.length !== state.counts.reduce((n, c, p) => n + (p === state.p ? 0 : c), 0))
    throw Error('Public counts do not conserve 108 physical cards');
  return unseen;
}

/** Uniform-world sample frequency, never a calibrated possession probability. */
export function sampledOvertakeFrequency(state, play, worlds) {
  if (!play || !worlds.length) return null;
  const opponents = [(state.p + 1) % 4, (state.p + 3) % 4];
  const counts = opponents.map((p) =>
    worlds.reduce(
      (n, hands) =>
        n +
        Number(
          candidates(
            hands[p].map((id) => deck[id]),
            state.level,
            play,
          ).some(Boolean),
        ),
      0,
    ),
  );
  return {
    scope: 'uniform-world-frequency-not-probability',
    worlds: worlds.length,
    opponents: opponents.map((seat, i) => ({
      seat,
      overtakes: counts[i],
      frequency: counts[i] / worlds.length,
    })),
  };
}
