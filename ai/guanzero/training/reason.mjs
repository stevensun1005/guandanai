/** Frozen public-information danMCai-reason opponent, using the web desktop policy. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { modelBytes, sha256 as digest } from '../../publishing/artifacts.mjs';
import { searchBotManifest, validateCatalog } from '../../../web/src/ai/model-catalog.mjs';
import {
  SEARCH_BOT_V1,
  SEARCH_BUDGETS,
  NODE_SOLVER_MS,
} from '../../../web/src/ai/search/constants.mjs';
import { searchPayload, restoreGame } from '../../../web/src/ai/search/payload.mjs';
import { KnownCardsError } from '../../../web/src/ai/search/known-cards.mjs';
import { championValues, beliefProbabilities } from '../../../web/src/ai/search/inference.mjs';
import {
  searchBotDecision,
  searchBand,
  remainingCards,
  argmax,
  SearchBudgetError,
} from '../../../web/src/ai/search/core.mjs';
import { createSolver } from '../../danMCai/endgame/solver.mjs';
import { sourceClosure } from './source-closure.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { publicView } from '../../danMCai/belief/features.mjs';
import { readJSON, sha256, ROOT } from './lib.mjs';

export function reasonSources() {
  // Catalog data evolve after publishing; identity is frozen separately in the manifest below.
  return Object.fromEntries(
    Object.entries(
      sourceClosure(fileURLToPath(new URL('./evaluation-worker.mjs', import.meta.url)), ROOT),
    ).filter(([p]) => !p.endsWith('.json')),
  );
}
export function verifyReasonMetadata(reason, champion) {
  const { evaluationSHA256, ...identity } = reason;
  assert.equal(
    digest(Buffer.from(JSON.stringify(identity))),
    evaluationSHA256,
    'Reason evaluation identity',
  );
  assert.equal(reason.id, 'reason');
  assert.equal(reason.mode, 'self');
  assert.equal(
    reason.modelSHA256,
    digest(Buffer.from(JSON.stringify(reason.manifest))),
    'Reason bot manifest SHA',
  );
  assert.equal(
    reason.manifest.base.sha256,
    champion.modelSHA256,
    'Reason base must be frozen champion',
  );
  assert.equal(reason.manifest.base.version, champion.version);
  assert.deepEqual(reason.gate, champion.gate);
  assert.deepEqual(reason.manifest.search, SEARCH_BOT_V1);
  assert.deepEqual(reason.budget, SEARCH_BUDGETS.desktop);
  assert.equal(reason.execution, 'web-desktop-policy-native-onnx-v1');
  assert.equal(reason.manifest.belief.featureVersion, 'belief-v1');
}
export async function freezeReason(folder, champion, root = ROOT) {
  const catalog = validateCatalog(readJSON(join(root, 'web/src/ai/model-catalog.json')));
  const bot = catalog.searchBots
    .filter((b) => b.base === catalog.selection.danMCaiChampions[0])
    .at(-1);
  assert.ok(bot, 'Missing current champion reasoning bot');
  const base = catalog.models.find((m) => m.id === bot.base);
  const manifest = searchBotManifest(bot, base);
  assert.equal(bot.sha256, digest(Buffer.from(JSON.stringify(manifest))));
  const bytes = await modelBytes(root, { ...bot.belief, id: bot.id });
  const identity = {
    id: 'reason',
    name: 'danMCai-reason-' + base.source.version,
    version: bot.version,
    archiveId: bot.id,
    mode: 'self',
    modelSHA256: bot.sha256,
    manifest,
    gate: champion.gate,
    budget: { ...SEARCH_BUDGETS.desktop },
    execution: 'web-desktop-policy-native-onnx-v1',
    sourceSHA256: reasonSources(),
  };
  const reason = { ...identity, evaluationSHA256: digest(Buffer.from(JSON.stringify(identity))) };
  verifyReasonMetadata(reason, champion);
  writeFileSync(join(folder, 'reason-belief.onnx'), bytes, { flag: 'wx' });
  return reason;
}
export function verifyFrozenReason(folder, reason, champion, { sources = false } = {}) {
  verifyReasonMetadata(reason, champion);
  assert.equal(sha256(join(folder, 'champion.onnx')), reason.manifest.base.sha256);
  assert.equal(sha256(join(folder, 'reason-belief.onnx')), reason.manifest.belief.sha256);
  if (sources) assert.deepEqual(reasonSources(), reason.sourceSHA256, 'Reason source changed');
}

/** Only public payload construction reads the full game, never the search/inference engine. */
export function reasonPayload(game, p, seed) {
  return searchPayload(game, p, 0, seed);
}
export function reasonContext(engine, started, band, now = () => performance.now()) {
  return {
    values: engine.values,
    probabilities: engine.probabilities,
    solver: engine.solver,
    solverTimeIsBudget: engine.budget.solverMs < NODE_SOLVER_MS,
    offset: 0,
    now,
    deadline: started + (band === 'midgame' ? engine.budget.midgameMs : engine.budget.endgameMs),
    counter: { inferences: 0 },
  };
}
export async function chooseReason(engine, game, p, seed) {
  const plays = candidates(game.hands[p], game.L, game.trick?.play);
  engine.stats.decisions++;
  const finish = plays.findIndex((a) => a && a.cards.length === game.hands[p].length);
  if (finish >= 0 || plays.length === 1) {
    engine.stats.forced++;
    return plays[finish >= 0 ? finish : 0];
  }
  const state = policyState(game, p, 0, plays),
    base = await engine.values(state),
    championIndex = argmax(base);
  // The web worker clock starts after the caller has its ordinary champion fallback.
  const started = performance.now();
  let masked;
  try {
    masked = restoreGame(reasonPayload(game, p, seed));
  } catch (error) {
    if (!(error instanceof KnownCardsError)) throw error;
    engine.stats.knownCardsFallback++;
    return plays[championIndex];
  }
  const band = searchBand(remainingCards(masked));
  if (!band) {
    engine.stats.baseOnly++;
    return plays[championIndex];
  }
  engine.stats[band]++;
  const ctx = reasonContext(engine, started, band);
  try {
    const result = await searchBotDecision(masked, seed, ctx, engine.params);
    if (result.minWorldsFallback) engine.stats.minWorldsFallback++;
    if (result.index !== championIndex) engine.stats.changedFromChampion++;
    return result.plays[result.index];
  } catch (error) {
    if (!(error instanceof SearchBudgetError)) throw error;
    engine.stats.budgetFallback++;
    return plays[championIndex];
  } finally {
    engine.stats.inferences += ctx.counter.inferences;
    engine.stats.searchMs += performance.now() - started;
  }
}
export async function createReasonEngine(folder, reason, champion) {
  verifyFrozenReason(folder, reason, champion, { sources: true });
  const options = { intraOpNumThreads: 1, interOpNumThreads: 1, executionProviders: ['cpu'] };
  const base = await ort.InferenceSession.create(
    readFileSync(join(folder, 'champion.onnx')),
    options,
  );
  let belief;
  try {
    belief = await ort.InferenceSession.create(
      readFileSync(join(folder, 'reason-belief.onnx')),
      options,
    );
  } catch (error) {
    await base.release();
    throw error;
  }
  const engine = {
    values: championValues(ort, base),
    probabilities: beliefProbabilities(ort, belief, reason.manifest.belief.featureVersion),
    budget: reason.budget,
    params: reason.manifest.search,
    solver: createSolver({
      maxNodes: reason.manifest.search.solverMaxNodes,
      maxMs: reason.budget.solverMs,
      maxTable: reason.budget.solverTable,
    }),
    stats: {
      decisions: 0,
      forced: 0,
      baseOnly: 0,
      midgame: 0,
      endgame: 0,
      minWorldsFallback: 0,
      budgetFallback: 0,
      knownCardsFallback: 0,
      changedFromChampion: 0,
      inferences: 0,
      searchMs: 0,
    },
    close: async () => {
      await base.release();
      await belief.release();
    },
  };
  try {
    const game = createRound(1),
      plays = candidates(game.hands[game.turn], game.L, null);
    await engine.values(policyState(game, game.turn, 0, plays));
    await engine.probabilities(publicView(game, game.turn));
  } catch (error) {
    await engine.close();
    throw error;
  }
  return engine;
}
