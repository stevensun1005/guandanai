/** Fixed replay/weight cache microbenchmark. No games, labels or optimizer updates. */
import { Worker } from 'node:worker_threads';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { freemem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { option, readJSON, writeJSON, sha256 } from '../../danMCai/training/continuous/lib.mjs';

const run = resolve(option('run', ''));
const planFile = resolve(option('protocol', ''));
const plan = readJSON(planFile);
const task = readJSON(join(run, 'campaign-task.json'));
if (!task || task.protocolSHA256 !== sha256(planFile))
  throw Error('Registered frozen protocol required');
for (const [file, digest] of Object.entries(plan.sourceSHA256))
  if (sha256(file) !== digest) throw Error('Source changed: ' + file);
for (const model of plan.models)
  if (sha256(model.file) !== model.sha256) throw Error('Weight changed');
if (sha256(plan.input.file) !== plan.input.sha256) throw Error('Replay changed');
const packed = readFileSync(plan.input.file);
if (packed.length < plan.input.rows * 567) throw Error('Too few input rows');
const stateData = new Float32Array(plan.input.rows * 513);
const actionData = new Float32Array(plan.input.rows * 54);
for (let i = 0; i < plan.input.rows; i++) {
  for (let j = 0; j < 513; j++) stateData[i * 513 + j] = packed.readInt8(i * 567 + j);
  for (let j = 0; j < 54; j++) actionData[i * 54 + j] = packed.readInt8(i * 567 + 513 + j);
}
const stopped = () =>
  existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC);
const results = [];
const references = [];
let phase = 'starting',
  current = 0,
  completed = 0,
  minimumAvailableGiB = freemem() / 1024 ** 3;
const startedAtUTC = new Date().toISOString();
const status = (extra = {}) =>
  writeJSON(join(run, 'status.json'), {
    pid: process.pid,
    phase,
    updatedAt: new Date().toISOString(),
    startedAtUTC,
    deadlineUTC: task.window.deadlineUTC,
    displayName: '推理缓存诊断 · 固定回放与权重',
    completedRequests: completed,
    plannedRequests: plan.order.length * plan.trace.length,
    sessionLimit: plan.order[current] ?? null,
    minimumAvailableGiB,
    optimizerUpdates: 0,
    strengthGames: 0,
    ...extra,
  });
try {
  for (current = 0; current < plan.order.length; current++) {
    if (stopped()) {
      phase = 'stopped';
      break;
    }
    const sessionLimit = plan.order[current];
    const worker = new Worker(plan.workerFile, {
      workerData: { provider: plan.provider, sessionLimit, maxRows: 4096 },
    });
    const elapsed = [],
      metadata = [];
    let nextId = 0,
      maxAbsError = 0;
    const values = (file) =>
      new Promise((done, fail) => {
        const id = ++nextId;
        const timer = setTimeout(
          () => finish(Error('Inference request exceeded 30 seconds')),
          30000,
        );
        const onMessage = (message) => {
          if (message.id !== id) return;
          if (message.error) return finish(Error(message.error));
          finish(null, message);
        };
        const onError = (error) => finish(error);
        function finish(error, message) {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          error ? fail(error) : done(message);
        }
        worker.on('message', onMessage);
        worker.once('error', onError);
        const states = stateData.slice().buffer,
          actions = actionData.slice().buffer;
        worker.postMessage({ id, file, rows: plan.input.rows, states, actions }, [states, actions]);
      });
    try {
      phase = 'running';
      status();
      const started = performance.now();
      for (let i = 0; i < plan.trace.length; i++) {
        while (!stopped() && freemem() < 5 * 1024 ** 3) {
          phase = 'waiting-for-memory';
          status();
          await new Promise((done) => setTimeout(done, 1000));
        }
        if (stopped()) {
          phase = 'stopped';
          break;
        }
        phase = 'running';
        const before = performance.now();
        const result = await values(plan.models[plan.trace[i]].file);
        const scores = new Float32Array(result.values);
        if (
          !scores.every(Number.isFinite) ||
          result.provider !== plan.provider ||
          result.fallbackReason
        )
          throw Error('Non-finite values or inference-provider fallback');
        if (current === 0) references.push(scores.slice());
        else
          for (let j = 0; j < scores.length; j++)
            maxAbsError = Math.max(maxAbsError, Math.abs(scores[j] - references[i][j]));
        if (maxAbsError > plan.absoluteTolerance)
          throw Error('Cache configuration changed numerical outputs');
        elapsed.push(performance.now() - before);
        metadata.push(result.memory);
        completed++;
        minimumAvailableGiB = Math.min(minimumAvailableGiB, freemem() / 1024 ** 3);
        if (i % 16 === 0)
          status({
            completedInPhase: i + 1,
            totalPhases: plan.order.length,
            provider: result.provider,
            nativeSessions: result.memory,
          });
      }
      const last = metadata.at(-1);
      const row = {
        phaseIndex: current,
        sessionLimit,
        completedRequests: elapsed.length,
        wallMs: performance.now() - started,
        requestMeanMs: elapsed.reduce((a, b) => a + b, 0) / Math.max(1, elapsed.length),
        sessionsCreated: last?.sessionsCreated,
        sessionsReleased: last?.sessionsReleased,
        peakSessions: last?.peakSessions,
        maxAbsError,
        provider: plan.provider,
      };
      results.push(row);
      appendFileSync(join(run, 'phases.jsonl'), JSON.stringify(row) + '\n');
    } finally {
      await worker.terminate();
    }
    if (phase === 'stopped') break;
  }
  if (completed === plan.order.length * plan.trace.length) phase = 'complete';
  const summary = {
    schema: 1,
    kind: 'fixed-replay-inference-cache-diagnostic-not-end-to-end-or-strength',
    protocolSHA256: sha256(planFile),
    phase,
    completedRequests: completed,
    plannedRequests: plan.order.length * plan.trace.length,
    phases: results,
    minimumAvailableGiB,
    optimizerUpdates: 0,
    strengthGames: 0,
    maxAbsError: Math.max(0, ...results.map((p) => p.maxAbsError)),
    scope: plan.scope,
    completedAtUTC: new Date().toISOString(),
  };
  writeJSON(join(run, 'summary.json'), summary);
  status({ stoppedAt: new Date().toISOString() });
  if (phase !== 'complete') process.exitCode = 2;
} catch (error) {
  phase = 'failed';
  status({ failure: error.stack, stoppedAt: new Date().toISOString() });
  throw error;
}
