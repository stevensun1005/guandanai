import { isWild } from './cards.js';
import { analyze, beats, strength } from './combinations.js';
import { returnOptions } from './tribute.js';

/** Resolve a proposed card selection to a legal, canonical play. */
export function readPlay(hand, proposal, current, level) {
  const ids = proposal?.ids;
  if (!Array.isArray(hand) || !Array.isArray(ids) || ids.length < 1 || ids.length > 10) return null;
  if (ids.some((id) => !Number.isInteger(id)) || new Set(ids).size !== ids.length) return null;
  const holding = new Map(hand.map((card) => [card.id, card]));
  const cards = ids.map((id) => holding.get(id));
  if (cards.some((card) => !card)) return null;
  const readings = analyze(cards, level).filter((play) => beats(play, current));
  if (!readings.length) return null;
  readings.sort((a, b) => strength(b) - strength(a));
  const shape =
    readings.find((play) => play.type === proposal.type && play.value === proposal.value) ||
    readings[0];
  return { ...shape, cards, wu: cards.filter((card) => isWild(card, level)).length };
}

export function canPass(current) {
  return current != null;
}

export function isReturnCard(card, level, hand = null) {
  if (!card || isWild(card, level)) return false;
  return hand ? returnOptions(hand, level).some((option) => option.id === card.id) : card.r <= 10;
}
