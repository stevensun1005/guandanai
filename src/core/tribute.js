import { isWild, val } from './cards.js';

export function tributeOptions(hand, level) {
  const cards = hand.filter((card) => !isWild(card, level));
  const largest = Math.max(...cards.map((card) => val(card, level)));
  return cards.filter((card) => val(card, level) === largest);
}

export function returnOptions(hand, level) {
  const cards = hand.filter((card) => !isWild(card, level));
  const low = cards.filter((card) => card.r <= 10);
  if (low.length) return low;
  const smallest = Math.min(...cards.map((card) => val(card, level)));
  return cards.filter((card) => val(card, level) === smallest);
}

export function returnInstruction(hand, level) {
  return returnOptions(hand, level).some((card) => card.r <= 10)
    ? '请还一张 10 或以下的非百搭牌'
    : '本手没有低牌，请还最小的非百搭牌';
}
