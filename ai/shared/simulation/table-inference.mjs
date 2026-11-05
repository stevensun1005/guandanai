import * as ort from 'onnxruntime-web';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../../../web/src/ai/models.mjs';
import { prepareTableDecision, decideTablePolicy } from '../../../web/src/ai/table-policy.mjs';

/** Use the installed browser WASM runtime, model encoders and decision code inside Node. */
export function createTableInference({
  policy = null,
  config = MODELS.policy,
  runtime = ort,
} = {}) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  const sessions = new Map();
  const stats = { turns: 0, immediate: 0, inferences: 0, candidates: 0, endgameProofs: 0 };
  function session(key = 'policy') {
    if (!sessions.has(key)) {
      const file =
        key === 'policy' && policy
          ? policy
          : fileURLToPath(
              new URL('../../danMCai/models/baseline/' + MODELS[key].file, import.meta.url),
            );
      sessions.set(
        key,
        readFile(file).then((bytes) =>
          runtime.InferenceSession.create(bytes, {
            ...(runtime === ort
              ? { executionProviders: ['wasm'] }
              : { intraOpNumThreads: 1, interOpNumThreads: 1 }),
            graphOptimizationLevel: 'all',
          }),
        ),
      );
    }
    return sessions.get(key);
  }
  return {
    session,
    stats,
    async decide(game, player, profile = 'balanced') {
      stats.turns++;
      const prepared = prepareTableDecision(game, player, 0, config, profile);
      let index = prepared.index;
      if (index == null) {
        const result = await decideTablePolicy(runtime, session, prepared.state, config);
        index = result.index;
        stats.inferences++;
        stats.candidates += prepared.plays.length;
        if (result.endgame) stats.endgameProofs++;
      } else stats.immediate++;
      if (!Number.isInteger(index) || index < 0 || index >= prepared.plays.length)
        throw Error('Invalid table policy action');
      return prepared.plays[index];
    },
    async close() {
      const results = await Promise.allSettled(sessions.values());
      for (const result of results) if (result.status === 'fulfilled') await result.value.release();
      sessions.clear();
    },
  };
}
