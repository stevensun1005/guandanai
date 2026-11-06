import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decisionCases, intervene } from './scenarios.mjs';
import { tributeActions, encodeTribute, TRIBUTE_FEATURES, TRIBUTE_ENCODING } from './encoding.mjs';
import { writeJSON } from '../../danMCai/training/continuous/lib.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** All counterfactual actions finish the current round; no short-horizon hand heuristic is a label. */
export async function sampleDecision({ seed, head, stage, teacher, check, onProgress = () => {} }) {
  const available = decisionCases(seed),
    preferred = available.filter((s) => s.stage === stage);
  const list = preferred.length ? preferred : available;
  if (!list.length) return null;
  const state = list[(seed >>> 1) % list.length],
    actions = tributeActions(state),
    outcomes = [];
  for (let i = 0; i < actions.length; i++) {
    await check();
    const result = await teacher.playRound(intervene(seed, state, actions[i]), { check });
    outcomes.push({
      ...result,
      value: (result.winner === state.player % 2 ? 1 : -1) * result.points,
    });
    onProgress({ seed, head, stage: state.stage, completed: i + 1, total: actions.length });
  }
  const features = new Int8Array(actions.length * TRIBUTE_FEATURES),
    labels = new Float32Array(actions.length);
  actions.forEach((id, i) => {
    features.set(encodeTribute(state, id), i * TRIBUTE_FEATURES);
    labels[i] = outcomes[i].value;
  });
  const baseline = actions.findIndex((id) => id % 54 === state.baseline % 54);
  if (baseline < 0) throw Error('Baseline not in legal action set');
  return {
    features,
    labels,
    meta: {
      schema: 1,
      encoding: TRIBUTE_ENCODING,
      seed,
      head,
      stage: state.stage,
      rows: actions.length,
      baseline,
      actions,
      state,
      outcomes,
    },
  };
}

export function saveDecision(run, split, sample, protocolSHA) {
  const folder = join(run, 'data', split);
  mkdirSync(folder, { recursive: true });
  const name = `case-${sample.meta.seed}`,
    x = Buffer.from(sample.features.buffer),
    y = Buffer.from(sample.labels.buffer);
  writeFileSync(join(folder, name + '.x.i8'), x, { flag: 'wx' });
  writeFileSync(join(folder, name + '.y.f32'), y, { flag: 'wx' });
  writeJSON(join(folder, name + '.json'), {
    ...sample.meta,
    protocolSHA,
    xSHA256: sha(x),
    ySHA256: sha(y),
  });
  return sample.meta.rows;
}
