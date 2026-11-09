/**
 * Frozen public-information danMCai-reason opponent. Protocol v1 uses the old web desktop budget
 * (3 / 4 s); protocol v2 (owner 2026-11-09) the 50 s move deadline with a champion fallback.
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { modelBytes, sha256 as digest } from '../../publishing/artifacts.mjs';
import { searchBotManifest, validateCatalog } from '../../../web/src/ai/model-catalog.mjs';
import { SEARCH_BOT_V1, NODE_SOLVER_MS } from '../../../web/src/ai/search/constants.mjs';
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
import { createSolver, SolverBudget } from '../../danMCai/endgame/solver.mjs';
import { REASON_V1_PANEL, REASON_V2_PANEL, REASON_OPPONENT_PANEL } from './opponents.mjs';
import { sourceClosure } from './source-closure.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { createRound } from '../../shared/simulation/simulation.mjs';
import { publicView } from '../../danMCai/belief/features.mjs';
import { readJSON, sha256, ROOT } from './lib.mjs';

/**
 * Desktop budget registered with protocol clint-champion-reason-v1 (the web desktop budget until
 * 2026-11-09). The web bot moved to 50 s per move that day (a deployment change); this registered
 * evaluation keeps its frozen budget, and changing it needs a new protocol.
 */
export const REASON_V1_BUDGET = Object.freeze({
  midgameMs: 3000,
  endgameMs: 4000,
  solverMs: 3000,
  solverTable: 300_000,
});

/**
 * Budget of protocol clint-champion-reason-v2 (owner 2026-11-09: a computer move may take up to
 * 60 s like a human's, reasoning stops by 50 s, 10 s stay for the fallback move). The Node
 * harness has no thinking pause or first network load, so the 50 s reasoning deadline starts with
 * the decision itself (before the champion inference). midgameMs = endgameMs = that deadline;
 * every exact-solver call gets min(solverMs, time left to the deadline). Frozen here, independent
 * of later web budget changes.
 */
export const REASON_V2_BUDGET = Object.freeze({
  midgameMs: 50_000,
  endgameMs: 50_000,
  solverMs: 3000,
  solverTable: 300_000,
});
/** Move rule of protocol v2, frozen into every v2 identity (and so into its fingerprint). */
export const REASON_V2_MOVE = Object.freeze({
  moveLimitMs: 60_000,
  reasoningDeadlineMs: 50_000,
  fallbackReserveMs: 10_000,
  clockStart: 'decision-start',
  solverCallMs: 'min(solverMs, deadline - now)',
  fallback: 'frozen-champion-argmax',
  failuresSticky: false,
  statistics: Object.freeze([
    'budgetFallback',
    'knownCardsFallback',
    'minWorldsFallback',
    'solverDeadlineCapped',
    'maxSearchMs',
    'searchesOver3s',
    'searchesOver10s',
    'searchesOver30s',
  ]),
});
/** Exact budget and execution of each registered reason protocol. */
export const REASON_PROTOCOLS = Object.freeze({
  [REASON_V1_PANEL]: Object.freeze({
    budget: REASON_V1_BUDGET,
    execution: 'web-desktop-policy-native-onnx-v1',
  }),
  [REASON_V2_PANEL]: Object.freeze({
    budget: REASON_V2_BUDGET,
    execution: 'move-deadline-50s-native-onnx-v2',
    move: REASON_V2_MOVE,
  }),
});
/** v1 identities predate the field and stay byte-identical; v2 and later name their protocol. */
export const reasonProtocol = (reason) => reason.protocol ?? REASON_V1_PANEL;

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
  // v1 identities never carried `protocol`; an explicit v1 field would be a different identity.
  assert.notEqual(reason.protocol, REASON_V1_PANEL, 'v1 reason identity has no protocol field');
  const protocol = REASON_PROTOCOLS[reasonProtocol(reason)];
  assert.ok(protocol, 'Unknown reason protocol');
  assert.deepEqual(reason.budget, protocol.budget);
  assert.equal(reason.execution, protocol.execution);
  assert.deepEqual(reason.move, protocol.move);
  assert.equal(reason.manifest.belief.featureVersion, 'belief-v1');
}
export async function freezeReason(
  folder,
  champion,
  root = ROOT,
  protocolId = REASON_OPPONENT_PANEL,
) {
  const protocol = REASON_PROTOCOLS[protocolId];
  assert.ok(protocol, 'Unknown reason protocol');
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
    budget: { ...protocol.budget },
    execution: protocol.execution,
    ...(protocolId !== REASON_V1_PANEL && {
      protocol: protocolId,
      move: structuredClone(protocol.move),
    }),
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
  const deadline =
    started + (band === 'midgame' ? engine.budget.midgameMs : engine.budget.endgameMs);
  return {
    values: engine.values,
    probabilities: engine.probabilities,
    solver:
      engine.protocol === REASON_V2_PANEL ? deadlineSolver(engine, deadline, now) : engine.solver,
    solverTimeIsBudget: engine.budget.solverMs < NODE_SOLVER_MS,
    offset: 0,
    now,
    deadline,
    counter: { inferences: 0 },
  };
}

/**
 * Protocol v2 solver: one exact-solver call never runs past the reasoning deadline. With at least
 * solverMs left it is the shared solver (the Node rule: a clock or node stop skips that world).
 * With less left, the call gets a fresh solver limited to the time left (same exact values; only
 * the transposition table is not shared); a clock stop there is the deadline, not the Node rule,
 * so the whole search is discarded and the champion move is played (SearchBudgetError).
 */
export function deadlineSolver(engine, deadline, now = () => performance.now()) {
  const { solverMs, solverTable } = engine.budget,
    maxNodes = engine.params.solverMaxNodes;
  return {
    actionValue(position, play) {
      const left = deadline - now();
      if (left >= solverMs) return engine.solver.actionValue(position, play);
      if (!(left > 0)) throw new SearchBudgetError('endgame');
      engine.stats.solverDeadlineCapped++;
      const capped = (engine.createSolver ?? createSolver)({
        maxNodes,
        maxMs: left,
        maxTable: solverTable,
      });
      try {
        return capped.actionValue(position, play);
      } catch (error) {
        if (error instanceof SolverBudget && !(error.nodes > maxNodes))
          throw new SearchBudgetError('endgame');
        throw error;
      }
    },
  };
}
export async function chooseReason(engine, game, p, seed) {
  const now = engine.now ?? (() => performance.now()),
    v2 = engine.protocol === REASON_V2_PANEL,
    decisionStart = now();
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
  // v1: the web worker clock starts after the caller has its ordinary champion fallback.
  // v2: the 50 s reasoning deadline counts from the start of the decision.
  const started = v2 ? decisionStart : now();
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
  const ctx = reasonContext(engine, started, band, now);
  try {
    // Each decision has its own deadline and context: a fallback never stops the next search.
    const result = await (engine.decide ?? searchBotDecision)(masked, seed, ctx, engine.params);
    if (result.minWorldsFallback) engine.stats.minWorldsFallback++;
    if (result.index !== championIndex) engine.stats.changedFromChampion++;
    return result.plays[result.index];
  } catch (error) {
    if (!(error instanceof SearchBudgetError)) throw error;
    engine.stats.budgetFallback++;
    return plays[championIndex];
  } finally {
    const elapsed = now() - started;
    engine.stats.inferences += ctx.counter.inferences;
    engine.stats.searchMs += elapsed;
    if (v2) {
      engine.stats.maxSearchMs = Math.max(engine.stats.maxSearchMs, elapsed);
      if (elapsed > 3000) engine.stats.searchesOver3s++;
      if (elapsed > 10_000) engine.stats.searchesOver10s++;
      if (elapsed > 30_000) engine.stats.searchesOver30s++;
    }
  }
}

/** Search counters of a fresh engine; v2 adds the deadline and duration statistics it froze. */
export function reasonStats(protocolId = REASON_V1_PANEL) {
  const stats = {
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
  };
  if (protocolId === REASON_V2_PANEL) for (const key of REASON_V2_MOVE.statistics) stats[key] ??= 0;
  return stats;
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
  const protocol = reasonProtocol(reason);
  const engine = {
    protocol,
    values: championValues(ort, base),
    probabilities: beliefProbabilities(ort, belief, reason.manifest.belief.featureVersion),
    budget: reason.budget,
    params: reason.manifest.search,
    solver: createSolver({
      maxNodes: reason.manifest.search.solverMaxNodes,
      maxMs: reason.budget.solverMs,
      maxTable: reason.budget.solverTable,
    }),
    stats: reasonStats(protocol),
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
