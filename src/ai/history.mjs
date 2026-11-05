import { cardsArray, replay } from './encoding.mjs';

/** GuanZero's public 20-action history; no opponent hands are read. */
export function encodeHistory(state) {
  const sequence = replay(state.log).sequence.slice(-20);
  const result = new Float32Array(1080);
  sequence.forEach((cards, i) => result.set(cardsArray(cards), (20 - sequence.length + i) * 54));
  return result;
}
