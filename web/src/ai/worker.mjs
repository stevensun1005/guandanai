import * as ort from './vendor/ort.wasm.min.mjs';
import { decideTablePolicy } from './table-policy.mjs';
import { MODELS } from './models.mjs';
import { botModel } from './model-catalog.mjs';
import { decideClintRule } from '../rule-bot/runtime.mjs';
import { COACH_MODEL_ID, prepareCoachPolicy } from '../coach/evaluation.mjs';
import { inferPolicy } from './policy-inference.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
const sessions = new Map();
function session(key = 'policy') {
  if (!sessions.has(key)) {
    const model = key.startsWith('bot:') ? botModel(key.slice(4)) : MODELS[key];
    const url = new URL('../models/' + model.file, import.meta.url);
    url.searchParams.set('v', __MODEL_VERSIONS__[key]);
    const promise = ort.InferenceSession.create(url.href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    sessions.set(key, promise);
  }
  return sessions.get(key);
}

let queue = Promise.resolve();
self.onmessage = (event) => {
  const { id, type, state } = event.data;
  queue = queue.then(async () => {
    try {
      if (type === 'coach') {
        const model = botModel(COACH_MODEL_ID),
          input = prepareCoachPolicy(state);
        const scored = await inferPolicy(
          ort,
          await session('bot:' + model.id),
          input,
          model.config,
        );
        self.postMessage({
          id,
          result: { actions: input.actions, values: scored.values, modelId: model.id },
        });
        return;
      }
      if (type === 'init' || type === 'rule') {
        self.postMessage({
          id,
          result: type === 'init' ? { ready: true } : decideClintRule(state),
        });
        return;
      }
      const model = botModel(state?.modelId);
      const selectedSession = (key) => session(key === 'response' ? key : 'bot:' + model.id);
      const result = await decideTablePolicy(ort, selectedSession, state, model.config);
      self.postMessage({ id, result });
    } catch (error) {
      sessions.clear();
      self.postMessage({ id, error: String(error.message || error) });
    }
  });
};
