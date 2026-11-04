import * as ort from './vendor/ort.wasm.min.mjs';
import { inferPolicy } from './policy-inference.mjs';
import { solvePublicEndgame } from './endgame.js';
import { MODELS } from './models.mjs';
import { profileId, selectProfileAction, usesResponseModel } from './profiles.js';
import { responseCandidates, predictResponses } from './response.mjs';

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

function shapedPlays(state) {
  const hand = new Map(state.context.hand.map((card) => [card.id, card]));
  if (state.actionShapes?.length !== state.actions.length) throw Error('Missing action shapes');
  return state.actions.map((ids, index) =>
    ids.length ? { ...state.actionShapes[index], cards: ids.map((id) => hand.get(id)) } : null,
  );
}

async function decide(state) {
  const engine = await session();
  const started = performance.now();
  const inferred = await inferPolicy(ort, engine, state, MODELS.policy);
  let best = inferred.value,
    index = inferred.index;
  const style = profileId(state.profile);
  const scores = inferred.values;
  const endgame = state.endgame ? solvePublicEndgame(state, scores) : null;
  let responseRisks = null;
  if (endgame) index = endgame.index;
  else if (style !== 'balanced') {
    const plays = shapedPlays(state);
    index = selectProfileAction(plays, scores, style, state.context);
    if (usesResponseModel(style)) {
      const options = responseCandidates(plays, scores, state.context, index);
      if (options) {
        responseRisks = await predictResponses(
          ort,
          await session('response'),
          state.context,
          plays,
          options,
        );
        index = selectProfileAction(plays, scores, style, { ...state.context, responseRisks });
      }
    }
  }
  if (scores) best = scores[index];
  return {
    index,
    value: best,
    candidates: state.actions.length,
    elapsedMs: Math.round(performance.now() - started),
    ...(state.includeValues ? { values: scores, ...(responseRisks ? { responseRisks } : {}) } : {}),
    ...(endgame ? { endgame } : {}),
  };
}
let queue = Promise.resolve();
self.onmessage = (event) => {
  const { id, type, state } = event.data;
  queue = queue.then(async () => {
    try {
      const result = type === 'init' ? (await session(), { ready: true }) : await decide(state);
      self.postMessage({ id, result });
    } catch (error) {
      sessions.clear();
      self.postMessage({ id, error: String(error.message || error) });
    }
  });
};
