import * as ort from './vendor/ort.wasm.min.mjs';
import { decideTablePolicy } from './table-policy.mjs';
import { MODELS } from './models.mjs';

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
const sessions = new Map();
function session(key = 'policy') {
  if (!sessions.has(key)) {
    const url = new URL('../models/' + MODELS[key].file, import.meta.url);
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
      const result =
        type === 'init'
          ? (await session(), { ready: true })
          : await decideTablePolicy(ort, session, state, MODELS.policy);
      self.postMessage({ id, result });
    } catch (error) {
      sessions.clear();
      self.postMessage({ id, error: String(error.message || error) });
    }
  });
};
