import { cmpCards, SUIT_ORDER } from '../core/cards.js';

/** A complete, duplicate-free order; manual groups keep their own order. */
export function normalizeOrder(hand, order = {}, level = 2) {
  const held = new Set(hand.map((card) => card.id));
  const used = new Set();
  const take = (ids) =>
    (ids || []).filter((id) => {
      if (!held.has(id) || used.has(id)) return false;
      used.add(id);
      return true;
    });
  const fixed = (order.fixed || []).map(take).filter((group) => group.length);
  const myOrder = take(order.myOrder);
  const missing = hand.filter((card) => !used.has(card.id)).sort((a, b) => cmpCards(a, b, level));
  myOrder.push(...missing.map((card) => card.id));
  return { fixed, myOrder };
}

export function sortActive(hand, order, level, mode = 'rank') {
  const normalized = normalizeOrder(hand, order, level);
  const byId = new Map(hand.map((card) => [card.id, card]));
  normalized.myOrder.sort((x, y) => {
    const a = byId.get(x),
      b = byId.get(y);
    return (mode === 'suit' ? SUIT_ORDER[a.s] - SUIT_ORDER[b.s] : 0) || cmpCards(a, b, level);
  });
  return normalized;
}

const histories = new WeakMap();
const snapshot = (game) => normalizeOrder(game.hands[0], game, game.L);
const key = (game) =>
  `${game.round}:${game.L}:${game.hands[0].map((c) => c.id).sort((a, b) => a - b)}`;
function history(game) {
  let entry = histories.get(game);
  const current = key(game);
  if (!entry || entry.key !== current) {
    entry = { key: current, steps: [], redo: [] };
    histories.set(game, entry);
  }
  return entry;
}

/** Record one user operation, including a whole drag, as one undo step. */
export function changeOrder(game, mutate) {
  const entry = history(game);
  const steps = entry.steps;
  const before = snapshot(game);
  mutate();
  Object.assign(game, snapshot(game));
  if (JSON.stringify(before) === JSON.stringify(snapshot(game))) return false;
  entry.redo.length = 0;
  steps.push(before);
  if (steps.length > 30) steps.shift();
  return true;
}

export function canUndoOrder(game) {
  return !!game?.hands?.[0] && history(game).steps.length > 0;
}

export function undoOrder(game) {
  const entry = history(game);
  const previous = entry.steps.pop();
  if (!previous) return false;
  entry.redo.push(snapshot(game));
  Object.assign(game, previous);
  return true;
}

export function canRedoOrder(game) {
  return !!game?.hands?.[0] && history(game).redo.length > 0;
}

export function redoOrder(game) {
  const entry = history(game);
  const next = entry.redo.pop();
  if (!next) return false;
  entry.steps.push(snapshot(game));
  Object.assign(game, next);
  return true;
}
