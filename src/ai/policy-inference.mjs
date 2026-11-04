import { encode, cardsArray } from './encoding.mjs';
import { encodePolicyExtrasBatch, POLICY_EXTRA_FEATURES } from './policy-features.mjs';

/** Accumulate the entire candidate list before restricting a learned actor's choices. */
export function selectPolicyScores(proposals, logits, counts, config = {}) {
  const k = config.rerankCandidates;
  if (!k || counts.some((count) => count === 0)) return proposals.slice();
  const selected = proposals
    .map((_, index) => index)
    .sort((a, b) => proposals[b] - proposals[a] || a - b)
    .slice(0, k);
  const maximum = Math.max(...selected.map((index) => logits[index]));
  const normalizer =
    maximum + Math.log(selected.reduce((sum, index) => sum + Math.exp(logits[index] - maximum), 0));
  const values = proposals.map(() => -1e9);
  for (const index of selected) values[index] = (logits[index] - normalizer) * config.temperature;
  return values;
}

/** Shared browser scorer for the original policy, residual heads and proposal actors. */
export async function inferPolicy(ort, engine, state, config = {}) {
  if (!state.actions?.length) throw Error('No policy actions');
  const extraFeatures = config.extraFeatures || 0;
  const rerank = config.rerankCandidates || 0;
  if (extraFeatures && extraFeatures !== POLICY_EXTRA_FEATURES)
    throw Error('Unsupported policy feature layout');
  if (
    rerank &&
    (![2, 4].includes(rerank) ||
      extraFeatures !== POLICY_EXTRA_FEATURES ||
      !Number.isFinite(config.temperature) ||
      config.temperature <= 0)
  )
    throw Error('Unsupported policy reranking configuration');
  const extras = extraFeatures ? encodePolicyExtrasBatch(state) : null;
  const proposals = [],
    logits = [];
  const stateTensor = new ort.Tensor('float32', encode(state), [1, 513]);
  try {
    for (let first = 0; first < state.actions.length; first += 128) {
      const chunk = state.actions.slice(first, first + 128);
      const batch = new Float32Array(chunk.length * 54);
      chunk.forEach((cards, index) => batch.set(cardsArray(cards), index * 54));
      let actionTensor, extraTensor, output;
      try {
        actionTensor = new ort.Tensor('float32', batch, [chunk.length, 54]);
        const inputs = { state: stateTensor, actions: actionTensor };
        if (extras) {
          extraTensor = new ort.Tensor(
            'float32',
            extras.slice(first * extraFeatures, (first + chunk.length) * extraFeatures),
            [chunk.length, extraFeatures],
          );
          inputs.extras = extraTensor;
        }
        output = await engine.run(inputs);
        const values = output.values?.data;
        const actor = rerank ? output.policy_logits?.data : null;
        if (
          values?.length !== chunk.length ||
          !values.every(Number.isFinite) ||
          (rerank && (actor?.length !== chunk.length || !actor.every(Number.isFinite)))
        )
          throw Error('Invalid model output');
        proposals.push(...values);
        if (rerank) logits.push(...actor);
      } finally {
        actionTensor?.dispose();
        extraTensor?.dispose();
        if (output) for (const tensor of Object.values(output)) tensor.dispose();
      }
    }
  } finally {
    stateTensor.dispose();
  }
  const values = selectPolicyScores(proposals, logits, state.counts, config);
  let index = 0;
  for (let candidate = 1; candidate < values.length; candidate++)
    if (values[candidate] > values[index]) index = candidate;
  return { index, value: values[index], values };
}
