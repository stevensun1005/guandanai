import { encodeResponse, RESPONSE_FEATURES } from './response-features.mjs';

/** Response estimates rank plays only; the value policy keeps the pass decision. */
export function responseCandidates(plays, values, context, original) {
  if (!plays[original]) return null;
  let recipient = -1;
  for (let step = 1; step < 4; step++) {
    const seat = (context.p + step) % 4;
    if (context.counts[seat]) {
      recipient = seat;
      break;
    }
  }
  if (recipient < 0 || recipient % 2 === context.p % 2) return null;
  const floor = Math.max(...values) - 0.055;
  const indices = plays
    .map((play, index) => (play && values[index] >= floor ? index : -1))
    .filter((index) => index >= 0);
  return indices.length >= 2 ? { indices, recipient } : null;
}

export async function predictResponses(ort, engine, context, plays, { indices, recipient }) {
  const risks = plays.map(() => null);
  for (let first = 0; first < indices.length; first += 128) {
    const chunk = indices.slice(first, first + 128);
    const batch = new Float32Array(chunk.length * RESPONSE_FEATURES);
    chunk.forEach((index, offset) =>
      batch.set(encodeResponse(context, plays[index], recipient), offset * RESPONSE_FEATURES),
    );
    const tensor = new ort.Tensor('float32', batch, [chunk.length, RESPONSE_FEATURES]);
    let output;
    try {
      output = await engine.run({ features: tensor });
      const probabilities = output.probability.data;
      chunk.forEach((index, offset) => {
        const value = probabilities[offset];
        if (!Number.isFinite(value) || value < 0 || value > 1)
          throw Error('Invalid response probability');
        risks[index] = value;
      });
    } finally {
      tensor.dispose();
      if (output) for (const value of Object.values(output)) value.dispose();
    }
  }
  return risks;
}
