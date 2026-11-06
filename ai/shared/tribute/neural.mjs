/** Frozen public-information continuation policies used to generate whole-round returns. */
import * as ort from 'onnxruntime-node';
import { modelBytes } from '../../publishing/artifacts.mjs';
import { encode, cardsArray } from '../../../web/src/ai/encoding.mjs';
import { encodeHistory } from '../../../web/src/ai/history.mjs';
import { policyState } from '../../../web/src/ai/observation.js';
import { createCandidateCache } from '../../danMCai/training/continuous/fast-candidates.mjs';
import { advanceRound } from '../simulation/simulation.mjs';

export async function continuation(root, model, { provider = 'dml', delayMs = 1 } = {}) {
  const bytes = await modelBytes(root, model);
  let engine,
    requested = provider,
    mode;
  const settings = {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    enableMemPattern: false,
    enableCpuMemArena: false,
  };
  try {
    engine = await ort.InferenceSession.create(bytes, {
      ...settings,
      executionProviders: [provider],
    });
    mode = provider === 'dml' ? 'dml-requested-cpu-node-fallback-possible' : 'cpu';
  } catch (error) {
    engine = await ort.InferenceSession.create(bytes, { ...settings, executionProviders: ['cpu'] });
    mode = `cpu-after-${provider}-session-error: ${error.message}`;
  }
  if (model.config.extraFeatures || model.config.rerankCandidates)
    throw Error('Unsupported continuation configuration');
  const expected = ['actions', 'state', ...(model.config.history ? ['history'] : [])].sort();
  if (
    JSON.stringify(engine.inputNames.slice().sort()) !== JSON.stringify(expected) ||
    !engine.outputNames.includes('values')
  )
    throw Error('Unexpected continuation ONNX interface');
  const cache = createCandidateCache({ limit: 1024 }),
    stats = {
      requestedProvider: requested,
      mode,
      calls: 0,
      candidates: 0,
      inferenceMs: 0,
      rounds: 0,
    };
  async function choose(game) {
    const plays = cache.candidates(game.hands[game.turn], game.L, game.trick?.play);
    if (plays.length === 1) return plays[0];
    const state = policyState(game, game.turn, 0, plays),
      n = plays.length,
      values = new Float32Array(n);
    const stateTensor = new ort.Tensor('float32', encode(state), [1, 513]);
    const history =
      model.config.history === 'guanzero-v1'
        ? new ort.Tensor('float32', encodeHistory(state), [1, 5, 216])
        : null;
    const started = performance.now();
    try {
      for (let first = 0; first < n; first += 1024) {
        const chunk = state.actions.slice(first, first + 1024),
          a = new Float32Array(chunk.length * 54);
        chunk.forEach((cards, i) => a.set(cardsArray(cards), i * 54));
        const actions = new ort.Tensor('float32', a, [chunk.length, 54]);
        let output;
        try {
          output = await engine.run({
            state: stateTensor,
            actions,
            ...(history ? { history } : {}),
          });
          if (output.values.data.length !== chunk.length)
            throw Error('Invalid continuation output');
          values.set(output.values.data, first);
        } finally {
          actions.dispose();
          if (output) Object.values(output).forEach((t) => t.dispose());
        }
      }
    } finally {
      stateTensor.dispose();
      history?.dispose();
    }
    stats.calls++;
    stats.candidates += n;
    stats.inferenceMs += performance.now() - started;
    if (!values.every(Number.isFinite)) throw Error('Non-finite continuation output');
    let best = 0;
    for (let i = 1; i < n; i++) if (values[i] > values[best]) best = i;
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return plays[best];
  }
  return {
    stats,
    choose,
    async playRound(game, { check = async () => {} } = {}) {
      for (let decisions = 0; decisions < 1000; decisions++) {
        await check();
        const result = advanceRound(game, await choose(game));
        if (result) {
          stats.rounds++;
          return { ...result, decisions: decisions + 1 };
        }
      }
      throw Error('Continuation round did not terminate; not a draw');
    },
    close: () => engine.release(),
  };
}
