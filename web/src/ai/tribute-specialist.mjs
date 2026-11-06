import { runtime } from '../app/runtime.js';
import manifest from './tribute-model.json' with { type: 'json' };
import { botModel, botModelId, CLINT_RULE_ID } from './model-catalog.mjs';
import { tributeObservation, specialistHead } from './tribute-observation.mjs';
import { tributeActions } from '../../../ai/shared/tribute/encoding.mjs';
import { aiReturnCard, tributeCard } from './rule-policy.js';
import { VERSION } from '../network/protocol.js';

let worker,
  sequence = 0;
const pending = new Map(),
  requests = new WeakMap();
function stop() {
  worker?.terminate();
  worker = null;
  for (const item of pending.values()) {
    clearTimeout(item.timer);
    item.reject(Error('Tribute worker stopped'));
  }
  pending.clear();
}
function request(state, head, baseline) {
  if (!worker) {
    const url = new URL('./assets/tribute-worker.mjs', document.baseURI);
    url.searchParams.set('v', VERSION);
    worker = new Worker(url, { type: 'module' });
    worker.onerror = stop;
    worker.onmessage = ({ data }) => {
      const item = pending.get(data.id);
      if (!item) return;
      pending.delete(data.id);
      clearTimeout(item.timer);
      data.error ? item.reject(Error(data.error)) : item.resolve(data.result);
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence,
      timer = setTimeout(stop, 12000);
    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, state, head, baseline });
  });
}

/** Plain synchronous fallback preserves existing timing for Clint/unapproved/disabled models. */
export function tributeDecision(game, player, stage) {
  const fallback = (stage === 'tribute' ? tributeCard : aiReturnCard)(
    game.hands[player],
    game.L,
  ).id;
  const selected = botModelId(runtime.botModels?.[(player + runtime.network.off) % 4]);
  if (selected === CLINT_RULE_ID) return fallback;
  const head = specialistHead(manifest, botModel(selected));
  if (head == null) return fallback;
  let state, legal;
  try {
    state = tributeObservation(game, player, stage);
    legal = tributeActions(state);
  } catch (error) {
    console.warn('Tribute context fallback:', error.message);
    return fallback;
  }
  if (legal.length === 1) return legal[0];
  let cache = requests.get(game);
  if (!cache) {
    cache = new Map();
    requests.set(game, cache);
  }
  const key = JSON.stringify([game.tok, head, state]);
  if (!cache.has(key))
    cache.set(
      key,
      request(state, head, fallback)
        .then((id) => {
          if (!legal.includes(id)) throw Error('Illegal learned tribute');
          return id;
        })
        .catch((error) => {
          console.warn('Tribute specialist fallback:', error.message);
          return fallback;
        }),
    );
  return cache.get(key);
}
