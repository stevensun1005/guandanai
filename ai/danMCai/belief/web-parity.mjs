/**
 * Local check (not part of `npm test`; needs the real model files): does the browser port of the
 * belief-search research bot (web/src/ai/search/core.mjs, menu id 9001) make the same decisions as
 * the held-out-tested Node bot (midgame-search.mjs searchDecision / endgameDecision, belief worlds)?
 *
 * Positions: real decisions of champion-017 self-play rounds (all four seats greedy) on a fresh
 * development seed block, at most `--per-band` per band per round, in the midgame band (21-40
 * cards) and the endgame band (<= 20 cards). For each position:
 *   node      the Node research bot, onnxruntime-node, fresh solver with a NODE-ONLY budget
 *             (1.5M nodes, no clock, so skipped worlds are deterministic);
 *   webNode   the browser core with onnxruntime-node and the same solver budget -> must equal node;
 *   webWasm   the browser core with onnxruntime-web WASM (one thread, as Pages) and the same solver
 *             budget, timed without a deadline -> agreement with node and the time distribution;
 *   budget    the browser core with WASM under the DESKTOP budget exactly as the search worker
 *             runs it (deadline, 3 s solver calls, 300k table, persistent solver) -> fallbacks and
 *             agreement with node.
 * Development seeds only, not a strength result.
 *
 *   node ai/danMCai/belief/web-parity.mjs --belief=<belief.onnx> --champion=<bot-017.onnx>
 *        [--start=731950000] [--rounds=100] [--per-band=1] [--out=<json>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeOrt from 'onnxruntime-node';
import { advanceRound, createRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { argmax, createModelPool, sha256 } from '../training/continuous/lib.mjs';
import { createBeliefModel } from './sampler.mjs';
import { assertHeldOut, trainingSeedRanges } from './metrics.mjs';
import { CHAMPION_SHA256, DEFAULTS, endgameDecision, searchDecision } from './midgame-search.mjs';
import { createSolver } from '../endgame/solver.mjs';
import {
  SEARCH_BUDGETS,
  SEARCH_BOT_V1,
  searchBand,
} from '../../../web/src/ai/search/constants.mjs';
import {
  SearchBudgetError,
  remainingCards,
  searchBotDecision,
} from '../../../web/src/ai/search/core.mjs';
import { restoreGame, searchPayload } from '../../../web/src/ai/search/payload.mjs';
import { beliefProbabilities, championValues } from '../../../web/src/ai/search/inference.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => [a.slice(2, a.indexOf('=') < 0 ? undefined : a.indexOf('=')), a.split('=')[1]]),
);
const BELIEF = resolve(args.belief);
const CHAMPION = resolve(args.champion ?? join(REPO, 'web/dist/models/bot-017.onnx'));
const START = Number(args.start ?? 731_950_000),
  ROUNDS = Number(args.rounds ?? 100),
  PER_BAND = Number(args['per-band'] ?? 1);
const RESERVED = {
  H3: [989_000_000, 989_002_999],
  H4: [990_023_757, 990_026_756],
  H5: [990_500_000, 990_502_999],
};

if (sha256(CHAMPION) !== CHAMPION_SHA256) throw Error('Champion is not the frozen 017 copy');
const beliefSHA = sha256(BELIEF);
const report = JSON.parse(readFileSync(join(dirname(BELIEF), 'train-report.json'), 'utf8'));
const block = [START, START + ROUNDS - 1];
assertHeldOut(block, [...trainingSeedRanges(report), ...Object.values(RESERVED)]);

const deterministicSolver = () =>
  createSolver({ maxNodes: SEARCH_BOT_V1.solverMaxNodes, maxMs: Infinity, maxTable: 1e9 });
const pool = await createModelPool(nodeOrt, { threads: 1, limit: 1 });
const nodeBelief = await createBeliefModel(nodeOrt, BELIEF, { featureVersion: 'belief-v1' });
const nodeChampion = await nodeOrt.InferenceSession.create(CHAMPION, {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: 'all',
});
const nodeBeliefSession = await nodeOrt.InferenceSession.create(BELIEF, {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: 'all',
});
const webDist = join(REPO, 'node_modules/onnxruntime-web/dist/');
const webOrt = await import(webDist + 'ort.wasm.min.mjs');
webOrt.env.wasm.numThreads = 1;
webOrt.env.wasm.wasmPaths = webDist;
const webOptions = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
const wasmChampion = await webOrt.InferenceSession.create(readFileSync(CHAMPION), webOptions);
const wasmBelief = await webOrt.InferenceSession.create(readFileSync(BELIEF), webOptions);
const engines = {
  node: {
    values: championValues(nodeOrt, nodeChampion),
    probabilities: beliefProbabilities(nodeOrt, nodeBeliefSession, 'belief-v1'),
  },
  wasm: {
    values: championValues(webOrt, wasmChampion),
    probabilities: beliefProbabilities(webOrt, wasmBelief, 'belief-v1'),
  },
};
const desktop = SEARCH_BUDGETS.desktop;
const budgetSolver = createSolver({
  maxNodes: SEARCH_BOT_V1.solverMaxNodes,
  maxMs: desktop.solverMs,
  maxTable: desktop.solverTable,
});

const nodeCfg = (solver) => ({
  ...DEFAULTS,
  worldsSource: 'belief',
  endgame: 'pimc',
  endgameWorlds: 'belief',
  champion: CHAMPION,
  values: (file, state) => pool.values(file, state),
  belief: nodeBelief,
  solver,
});
async function web(engine, game, seed, { solver, deadlineMs } = {}) {
  const started = performance.now();
  const ctx = {
    ...engines[engine],
    solver,
    offset: 0,
    now: () => performance.now(),
    deadline: deadlineMs === undefined ? undefined : started + deadlineMs,
  };
  const masked = restoreGame(searchPayload(game, game.turn, 0, seed));
  try {
    const d = await searchBotDecision(masked, seed, ctx);
    return { index: d.index, d, ms: performance.now() - started };
  } catch (error) {
    if (error instanceof SearchBudgetError)
      return { index: null, fallback: true, ms: performance.now() - started };
    throw error;
  }
}

let peakHeap = 0;
const sampleHeap = () => (peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed));
const rows = [];
for (let seed = START; seed <= block[1]; seed++) {
  const game = createRound(seed);
  const taken = { midgame: 0, endgame: 0 };
  for (let ply = 0; ply < 1000; ply++) {
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[p].length);
    if (index < 0 && plays.length === 1) index = 0;
    const band = searchBand(remainingCards(game));
    if (index < 0 && band && taken[band] < PER_BAND && (ply + seed) % 4 === 0) {
      taken[band]++;
      const fn = band === 'midgame' ? searchDecision : endgameDecision;
      const node = await fn(game, seed, nodeCfg(deterministicSolver()));
      sampleHeap();
      const webNode = await web('node', game, seed, { solver: deterministicSolver() });
      const webWasm = await web('wasm', game, seed, { solver: deterministicSolver() });
      sampleHeap();
      const budget = await web('wasm', game, seed, {
        solver: budgetSolver,
        deadlineMs: band === 'midgame' ? desktop.midgameMs : desktop.endgameMs,
      });
      sampleHeap();
      const row = {
        seed,
        ply,
        band,
        cards: remainingCards(game),
        candidates: plays.length,
        championIndex: node.championIndex,
        node: node.index,
        nodeDiffersFromChampion: node.index !== node.championIndex,
        nodeMinWorldsFallback: band === 'endgame' ? node.fallback : undefined,
        nodeMs: Math.round(node.ms),
        webNode: webNode.index,
        webNodeExact:
          webNode.index === node.index &&
          (band === 'endgame'
            ? webNode.d.used === node.used
            : JSON.stringify(webNode.d.means) === JSON.stringify(node.means)),
        webWasm: webWasm.index,
        wasmMs: Math.round(webWasm.ms),
        budget: budget.index,
        budgetFallback: !!budget.fallback,
        budgetMs: Math.round(budget.ms),
      };
      rows.push(row);
      process.stderr.write(JSON.stringify(row) + '\n');
    }
    if (index < 0) index = argmax(await pool.values(CHAMPION, policyState(game, p, 0, plays)));
    if (advanceRound(game, plays[index])) break;
  }
}

const quantile = (values, q) => {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
function summary(list) {
  const n = list.length,
    count = (f) => list.filter(f).length;
  const wasm = list.map((r) => r.wasmMs);
  return {
    decisions: n,
    nodeDiffersFromChampion: count((r) => r.nodeDiffersFromChampion),
    webNodeExactlyEqual: count((r) => r.webNodeExact),
    webWasmSameDecision: count((r) => r.webWasm === r.node),
    webWasmMs: { p50: quantile(wasm, 0.5), p95: quantile(wasm, 0.95), max: Math.max(...wasm) },
    nodeMs: {
      p50: quantile(
        list.map((r) => r.nodeMs),
        0.5,
      ),
      max: Math.max(...list.map((r) => r.nodeMs)),
    },
    desktopBudget: {
      fallbacks: count((r) => r.budgetFallback),
      sameDecisionAsNode: count((r) => r.budget === r.node),
      sameDecisionAsNodeWhenCompleted: count((r) => !r.budgetFallback && r.budget === r.node),
      completed: count((r) => !r.budgetFallback),
      ms: {
        p50: quantile(
          list.map((r) => r.budgetMs),
          0.5,
        ),
        p95: quantile(
          list.map((r) => r.budgetMs),
          0.95,
        ),
      },
    },
    wasmOverDesktopBudget: count(
      (r) => r.wasmMs > (r.band === 'midgame' ? desktop.midgameMs : desktop.endgameMs),
    ),
  };
}
const result = {
  purpose:
    'browser port parity and latency of the belief-search research bot (menu 9001); development seeds, not a strength result',
  generatedAt: new Date().toISOString(),
  seeds: block,
  reservedSeedsAvoided: { beliefTraining: trainingSeedRanges(report), ...RESERVED },
  championSHA256: CHAMPION_SHA256,
  beliefSHA256: beliefSHA,
  node: process.version,
  machine: 'shared research Mac under load (window-2 workers running); times are upper-biased',
  solverForParity: { maxNodes: SEARCH_BOT_V1.solverMaxNodes, maxMs: 'none', fresh: 'per decision' },
  desktopBudget: desktop,
  midgame: summary(rows.filter((r) => r.band === 'midgame')),
  endgame: summary(rows.filter((r) => r.band === 'endgame')),
  all: summary(rows),
  peakHeapMB: Math.round(peakHeap / 2 ** 20),
  rows,
};
const { rows: _, ...printed } = result;
console.log(JSON.stringify(printed, null, 2));
if (args.out) writeFileSync(resolve(args.out), JSON.stringify(result, null, 2) + '\n');
await pool.close();
await nodeBelief.close();
