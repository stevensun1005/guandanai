/** One public decision/action row. No other seat's private hand is accepted. */
import { makeDeck } from '../../../web/src/core/cards.js';
import { tributeOptions, returnOptions } from '../../../web/src/core/tribute.js';

export const TRIBUTE_FEATURES = 389;
export const TRIBUTE_ENCODING = 'public-tribute-389-v1';
export const TRIBUTE_HEADS = ['danMCai', 'GuanZero'];
const deck = makeDeck();

export function tributeActions(state) {
  if (
    !['tribute', 'return'].includes(state.stage) ||
    !Array.isArray(state.hand) ||
    new Set(state.hand).size !== state.hand.length ||
    state.hand.some((id) => !Number.isInteger(id) || !deck[id])
  )
    throw Error('Invalid tribute observation');
  const legal = (state.stage === 'tribute' ? tributeOptions : returnOptions)(
    state.hand.map((id) => deck[id]),
    state.level,
  );
  const seen = new Set();
  return legal
    .map((c) => c.id)
    .filter((id) => {
      const key = id % 54;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function encodeTribute(state, action) {
  if (!tributeActions(state).some((id) => id % 54 === action % 54) || !state.hand.includes(action))
    throw Error('Illegal tribute action');
  if (
    !Number.isInteger(state.player) ||
    state.player < 0 ||
    state.player > 3 ||
    !Number.isInteger(state.level) ||
    state.level < 2 ||
    state.level > 14 ||
    state.levels?.length !== 2 ||
    state.levels.some((l) => !Number.isInteger(l) || l < 2 || l > 14) ||
    state.previousOrder?.length !== 4 ||
    new Set(state.previousOrder).size !== 4 ||
    state.previousOrder.some((p) => !Number.isInteger(p) || p < 0 || p > 3) ||
    [state.recipient, state.leader].some(
      (p) => p != null && (!Number.isInteger(p) || p < 0 || p > 3),
    )
  )
    throw Error('Invalid tribute context');
  const row = new Int8Array(TRIBUTE_FEATURES),
    rel = (p) => (p - state.player + 4) % 4;
  state.hand.forEach((id) => row[id % 54]++);
  row[54 + (action % 54)] = 1;
  if (state.stage === 'tribute' && state.publicOffers?.length)
    throw Error('Unrevealed simultaneous offers cannot enter input');
  for (const offer of state.publicOffers || []) {
    if (!Number.isInteger(offer.from) || offer.from < 0 || offer.from > 3 || !deck[offer.id])
      throw Error('Invalid public offer');
    row[108 + rel(offer.from) * 54 + (offer.id % 54)]++;
  }
  row[324 + (state.stage === 'return' ? 1 : 0)] = 1;
  row[326 + state.level - 2] = 1;
  for (let i = 0; i < 2; i++) row[339 + i * 13 + state.levels[(state.player + i) % 2] - 2] = 1;
  state.previousOrder.forEach((p, i) => (row[365 + i * 4 + rel(p)] = 1));
  if (state.recipient != null) row[381 + rel(state.recipient)] = 1;
  if (state.leader != null) row[385 + rel(state.leader)] = 1;
  return row;
}

export function encodeTributeBatch(state) {
  const actions = tributeActions(state),
    rows = new Float32Array(actions.length * TRIBUTE_FEATURES);
  actions.forEach((id, i) => rows.set(encodeTribute(state, id), i * TRIBUTE_FEATURES));
  return { actions, rows };
}
