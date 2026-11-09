/**
 * ONNX scorers of the search worker, written to match the Node research bot input for input:
 *   championValues     = createModelPool(...).values in ai/danMCai/training/continuous/lib.mjs
 *                        (P0 layout, every candidate in ONE run, no 128-action chunks);
 *   beliefProbabilities = createBeliefModel(...).probabilities in ai/danMCai/belief/sampler.mjs
 *                        (feature version given explicitly; output 54 faces x 3 seats).
 * `ort` is onnxruntime-web in the browser and either runtime in Node tests.
 */
import { encode, cardsArray } from '../encoding.mjs';
import { featureSpec, featuresFor, TARGETS } from '../../../../ai/danMCai/belief/features.mjs';
import { makeDeck } from '../../core/cards.js';

const STATE = 513,
  ACTION = 54;
const deck = makeDeck();

const release = (output) => {
  for (const tensor of Object.values(output || {})) tensor?.dispose?.();
};

export function championValues(ort, session) {
  return async (state) => {
    const n = state.actions.length;
    if (!n) throw Error('No policy actions');
    const actions = new Float32Array(n * ACTION);
    for (let i = 0; i < n; i++) actions.set(cardsArray(state.actions[i]), i * ACTION);
    const output = await session.run({
      state: new ort.Tensor('float32', encode(state), [1, STATE]),
      actions: new ort.Tensor('float32', actions, [n, ACTION]),
    });
    try {
      const values = Float32Array.from(output.values.data);
      if (values.length !== n || !values.every(Number.isFinite))
        throw Error('Invalid model values');
      return values;
    } finally {
      release(output);
    }
  };
}

export function beliefProbabilities(ort, session, featureVersion) {
  const spec = featureSpec(featureVersion);
  const width = session.inputMetadata?.[0]?.shape?.[1];
  if (typeof width === 'number' && width !== spec.features)
    throw Error(`Belief input width ${width} does not match ${spec.version}`);
  return async (view) => {
    const x = new Float32Array(spec.features);
    x.set(featuresFor(view, { version: spec.version, deck }));
    const output = await session.run({
      features: new ort.Tensor('float32', x, [1, spec.features]),
    });
    try {
      const data = output.probs.data;
      if (data.length !== TARGETS || !data.every(Number.isFinite))
        throw Error('Invalid belief output');
      return Float32Array.from(data);
    } finally {
      release(output);
    }
  };
}
