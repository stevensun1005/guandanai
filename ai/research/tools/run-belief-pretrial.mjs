/** Bounded development feasibility run. Not a strength trial, trainer or online aid. */
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freemem } from 'node:os';
import { createBatchedPool } from '../../danMCai/training/continuous/batch-inference.mjs';
import { readJSON, writeJSON, sha256, option } from '../../danMCai/training/continuous/lib.mjs';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import {
  searchObservation,
  searchRoots,
  searchBelief,
  scoreWorlds,
} from '../../shared/search/pimc.mjs';
import {
  sampleWorlds,
  publicHistoryLogLikelihood,
  likelihoodWeights,
} from '../../shared/search/belief.mjs';
import { scoreOracle, rolloutOracleRound } from '../../../web/src/coach/oracle.mjs';

const argmax = (a) => a.reduce((best, v, i) => (v > a[best] ? i : best), 0);
const mean = (a) => a.reduce((n, x) => n + x, 0) / a.length;
function interval(a) {
  if (!a.length) return null;
  const m = mean(a),
    se =
      a.length > 1
        ? Math.sqrt(a.reduce((n, x) => n + (x - m) ** 2, 0) / (a.length - 1) / a.length)
        : null;
  return {
    n: a.length,
    mean: m,
    standardError: se,
    ci95: se === null ? null : [m - 1.96 * se, m + 1.96 * se],
    method:
      'Normal approximation over one development position per independent deal; not playing-strength uncertainty',
  };
}

export async function runPretrial(run) {
  const task = readJSON(join(run, 'campaign-task.json')),
    plan = readJSON(join(run, 'protocol.json'));
  if (!task || sha256(join(run, 'protocol.json')) !== task.protocolSHA256)
    throw Error('Unregistered or changed pretrial');
  for (const [file, hash] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, file)) !== hash) throw Error('Frozen source changed: ' + file);
  const stop = () =>
    existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC);
  const state = {
    pid: process.pid,
    phase: 'development',
    displayName: '信念搜索 · 200个争议位置预试',
    updatedAt: new Date().toISOString(),
    completedPositions: 0,
    plannedPositions: 200,
    optimizerUpdates: 0,
    strengthGames: 0,
    provider: null,
    minimumAvailableGiB: freemem() / 1024 ** 3,
  };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    state.minimumAvailableGiB = Math.min(state.minimumAvailableGiB, freemem() / 1024 ** 3);
    writeJSON(join(run, 'status.json'), state);
  };
  if (stop()) {
    state.phase = 'stopped-before-spawn';
    save();
    return state;
  }
  const model = join(run, 'models/champion.onnx');
  if (sha256(model) !== plan.modelSHA256) throw Error('Champion changed');
  const pool = await createBatchedPool(null, {
    provider: 'dml',
    sessionLimit: 2,
    batchDecisions: 24,
    maxRows: 4096,
  });
  const infer = (s) => pool.values(model, s);
  let timer = setInterval(save, 3000),
    phase = 'complete';
  const rows = [],
    positions = [],
    dealCounters = [];
  let decisions = 0,
    eligible = 0,
    disputed = 0,
    deals = 0,
    greedyChecks = 0;
  const waitMemory = async () => {
    if (freemem() < plan.reserveGiB * 1024 ** 3) {
      state.phase = 'waiting-for-memory';
      save();
      while (freemem() < plan.resumeGiB * 1024 ** 3 && !stop())
        await new Promise((r) => setTimeout(r, 1000));
    }
    if (stop()) throw Error('Fixed development deadline or STOP');
    state.phase = 'development';
  };
  try {
    // Complete each sampled deal; collect at most its first qualifying position.
    for (const seed of plan.dealSeeds) {
      await waitMemory();
      const game = createRound(seed);
      const beforeEligible = eligible,
        beforeDisputed = disputed;
      let selected = null,
        finished = false;
      for (let ply = 0; ply < 1000; ply++) {
        if (stop()) throw Error('Fixed development deadline or STOP');
        const p = game.turn,
          plays = candidates(game.hands[p], game.L, game.trick?.play);
        const observation = searchObservation(game, p),
          values = await infer(observation);
        if (values.length !== plays.length || !Array.from(values).every(Number.isFinite))
          throw Error('Invalid raw teacher values');
        decisions++;
        if (plays.length > 1) {
          const roots = await searchRoots(observation, async () => values);
          if (roots.semanticCandidates > 1) {
            eligible++;
            if (roots.gap < 0.15) {
              disputed++;
              if (!selected && ply >= 8)
                selected = {
                  seed,
                  ply,
                  state: observation,
                  truth: game.hands.map((h) => h.map((c) => c.id)),
                };
            }
          }
        }
        if (advanceRound(game, plays[argmax(Array.from(values))])) {
          finished = true;
          break;
        }
      }
      if (!finished) throw Error('Development deal truncated');
      deals++;
      dealCounters.push([eligible - beforeEligible, disputed - beforeDisputed]);
      if (selected) positions.push(selected);
      state.completedDeals = deals;
      state.collectedPositions = positions.length;
      save();
      if (positions.length === 200) break;
    }
    if (positions.length < 200) phase = 'incomplete-position-sample';
    writeJSON(join(run, 'positions.json'), positions);
    for (const position of positions) {
      await waitMemory();
      const { state: obs, truth, seed } = position;
      if (greedyChecks < 20) {
        const prepared = await searchRoots(obs, infer),
          root = prepared.roots[0];
        const input = {
          ...obs,
          hands: truth,
          player: obs.p,
          onlyAction: root.play?.cards.map((c) => c.id) || [],
          onlyShape: root.play && { type: root.play.type, value: root.play.value, n: root.play.n },
        };
        const direct = await rolloutOracleRound(input, root.play, infer, { stop });
        const control = await scoreOracle(input, infer, {
          priorWeight: 0,
          rawArgmax: true,
          maxMs: 0,
          maxSamples: 1,
          maxRoundPlies: 1000,
        });
        if (
          direct.value !== control.values[0] ||
          JSON.stringify(direct.line) !== JSON.stringify(control.lines[0])
        )
          throw Error('Direct greedy/oracle trace mismatch');
        greedyChecks++;
      }
      const begin = performance.now();
      const uniform = await searchBelief(obs, infer, { worlds: 8, seed: seed ^ 0x4f31a1, stop });
      const searchCallMs = performance.now() - begin;
      const reference = await scoreWorlds(
        obs,
        Array.from({ length: 48 }, () => truth),
        infer,
        { stop },
      );
      rows.push({
        seed,
        ply: position.ply,
        gap: uniform.gap,
        semanticCandidates: uniform.semanticCandidates,
        uniformChoice: uniform.selected,
        baselineChoice: uniform.baseline,
        referenceChoice: reference.selected,
        uniformAgrees: uniform.selected === reference.selected,
        baselineAgrees: uniform.baseline === reference.selected,
        searchCallMs,
        referenceCallMs: reference.elapsedMs,
        requestedReferenceWorlds: 48,
        effectiveReferenceWorlds: reference.uniqueWorlds,
        rows: uniform.rows,
      });
      state.completedPositions = rows.length;
      state.provider = pool.stats.provider;
      save();
      writeJSON(join(run, 'position-results.json'), rows);
    }
    // Separate descriptive phase-B diagnostic, never changes phase-A choices or selection.
    const phaseB = [];
    for (const pos of positions.slice(0, 4)) {
      await waitMemory();
      const worlds = sampleWorlds(pos.state, { count: 8, seed: pos.seed ^ 0x4f31a1 });
      const logLikelihoods = await Promise.all(
        worlds.map((h) =>
          publicHistoryLogLikelihood(pos.state, h, infer, { temperature: 0.2, stop }),
        ),
      );
      phaseB.push({
        seed: pos.seed,
        ...likelihoodWeights(logLikelihoods, { temperature: 0.2, seed: pos.seed ^ 0x10a }),
      });
    }
    writeJSON(join(run, 'phase-b.json'), phaseB);
  } catch (e) {
    phase = stop() ? 'incomplete-deadline' : 'failed';
    state.failure = e.stack;
  } finally {
    clearInterval(timer);
    await pool.close();
    writeJSON(join(run, 'positions.json'), positions);
    writeJSON(join(run, 'position-results.json'), rows);
    const times = rows.map((r) => r.searchCallMs).sort((a, b) => a - b);
    const agreement = interval(rows.map((r) => Number(r.uniformAgrees) - Number(r.baselineAgrees)));
    const disputeFraction = eligible ? disputed / eligible : null;
    const residuals = eligible
      ? interval(dealCounters.map(([n, k]) => k - disputeFraction * n))
      : null;
    const disputeSE =
      residuals?.standardError == null ? null : residuals.standardError / (eligible / deals);
    const result = {
      schema: 1,
      kind: 'development-feasibility-not-independent-strength',
      phase,
      completedAtUTC: new Date().toISOString(),
      protocolSHA256: task.protocolSHA256,
      deals,
      decisions,
      eligibleSemanticDecisions: eligible,
      disputedDecisions: disputed,
      directGreedyChecks: greedyChecks,
      disputeFraction,
      disputeFractionDealCluster95CI:
        disputeSE === null
          ? null
          : [
              Math.max(0, disputeFraction - 1.96 * disputeSE),
              Math.min(1, disputeFraction + 1.96 * disputeSE),
            ],
      completedPositions: rows.length,
      plannedPositions: 200,
      uniformAgreement: rows.length ? mean(rows.map((r) => Number(r.uniformAgrees))) : null,
      baselineAgreement: rows.length ? mean(rows.map((r) => Number(r.baselineAgrees))) : null,
      agreementDifference: agreement,
      callTiming: times.length
        ? {
            n: times.length,
            meanMs: mean(times),
            medianMs: times[Math.floor(times.length / 2)],
            p95Ms: times[Math.ceil(times.length * 0.95) - 1],
            maxMs: times.at(-1),
          }
        : null,
      inference: pool.stats,
      minimumAvailableGiB: state.minimumAvailableGiB,
      gateTo04:
        phase === 'complete' && rows.length === 200 && greedyChecks === 20 && agreement.mean > 0,
      optimizerUpdates: 0,
      strengthGames: 0,
      limitations: [
        'First disputed position after 8 plies per self-play deal, not a representative human sample.',
        'Full-information reference is raw champion continuation, not optimal play; 48 identical worlds are memoized to one effective world.',
        'Only development agreement and observed latency, never a strength claim or web promotion.',
      ],
    };
    writeJSON(join(run, 'summary.json'), result);
    state.phase = phase;
    state.stoppedAt = new Date().toISOString();
    save();
  }
  return state;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await runPretrial(resolve(option('run', '')));
