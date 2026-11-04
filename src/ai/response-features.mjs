import { cardsArray } from './encoding.mjs';
import { observeResponses } from './observation.js';

export const RESPONSE_FEATURES = 253;
export const RESPONSE_TYPES = [
  'single',
  'pair',
  'triple',
  'full',
  'straight',
  'pairs3',
  'trip2',
  'bomb',
  'sflush',
  'jokers',
];
export function encodeResponse(context, play, recipient) {
  const own = cardsArray(context.hand.map((card) => card.id));
  const unseen = new Float32Array(54).fill(2);
  const played = new Float32Array(54);
  for (let index = 0; index < 54; index++) unseen[index] -= own[index];
  for (const entry of context.log) {
    if (!entry.cards?.length) continue;
    const vector = cardsArray(entry.cards.map((card) => card.id));
    for (let index = 0; index < 54; index++) {
      unseen[index] -= vector[index];
      if (entry.p === recipient) played[index] += vector[index];
    }
  }
  const output = new Float32Array(RESPONSE_FEATURES);
  let offset = 0;
  for (const vector of [own, unseen, played, cardsArray(play.cards.map((card) => card.id))]) {
    for (const value of vector) output[offset++] = value / 2;
  }
  for (let step = 0; step < 4; step++)
    output[offset++] = context.counts[(context.p + step) % 4] / 27;
  output[offset + context.level - 2] = 1;
  offset += 13;
  const relative = (recipient - context.p + 4) % 4;
  if (relative > 0) output[offset + relative - 1] = 1;
  offset += 3;
  const type = RESPONSE_TYPES.indexOf(play.type);
  if (type >= 0) output[offset + type] = 1;
  offset += 10;
  output[offset++] = play.cards.length / 10;
  output[offset++] = Math.min(17, play.value) / 17;
  const stats = observeResponses(context.log)[recipient];
  const bucket = stats.bySize[play.cards.length] || { passes: 0, responds: 0 };
  output[offset++] = (stats.passes + 1) / (stats.responses + 2);
  output[offset++] = Math.min(30, stats.responses) / 30;
  output[offset++] = (bucket.passes + 1) / (bucket.passes + bucket.responds + 2);
  output[offset++] = stats.bombs / (stats.plays + 1);
  output[offset++] = context.trick ? 0 : 1;
  if (offset !== RESPONSE_FEATURES) throw Error('Response feature dimension changed');
  return output;
}
