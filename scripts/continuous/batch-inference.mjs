/**
 * Cross-game batched inference for fast actors.
 *
 * values(file, state) calls are queued; on the next event-loop turn the queued decisions for each
 * model are encoded (one state row per candidate) and sent in groups of `batchDecisions` to a
 * worker thread that runs them on the GPU through DirectML, falling back to the CPU. Because the
 * worker owns the sessions, the game-logic thread keeps advancing the games of one group while
 * the GPU scores another, instead of waiting on every batch.
 */
import { Worker } from 'node:worker_threads';
import { encode, cardsArray } from '../../src/ai/encoding.mjs';
import { ACTION, STATE } from './lib.mjs';

export async function createBatchedPool(
  _ort,
  { provider = 'dml', batchDecisions = 24, maxRows = 4096, sessionLimit = 6 } = {},
) {
  if (!Number.isInteger(sessionLimit) || sessionLimit < 1 || sessionLimit > 32)
    throw Error('Invalid session limit');
  const worker = new Worker(new URL('./inference-worker.mjs', import.meta.url), {
    workerData: { provider, sessionLimit, maxRows },
  });
  const pending = new Map();
  const queues = new Map();
  const stats = {
    batches: 0,
    decisions: 0,
    rows: 0,
    runMs: 0,
    prepareMs: 0,
    inFlightMax: 0,
    provider: null,
    fallbackReason: null,
  };
  let nextId = 0;
  let scheduled = false;
  let failure = null;

  worker.on('message', ({ id, values, runMs, provider: used, fallbackReason, memory, error }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) {
      job.items.forEach((item) => item.reject(Error(error)));
      return;
    }
    const scores = new Float32Array(values);
    stats.runMs += runMs;
    stats.provider = used;
    stats.fallbackReason = fallbackReason;
    if (memory) Object.assign(stats, memory);
    let at = 0;
    for (const item of job.items) {
      const n = item.state.actions.length;
      const slice = scores.slice(at, at + n);
      at += n;
      if (!slice.every(Number.isFinite)) item.reject(Error('Invalid model values'));
      else item.resolve(slice);
    }
  });
  worker.on('error', (error) => {
    failure = error;
    for (const job of pending.values()) job.items.forEach((item) => item.reject(error));
    pending.clear();
  });

  function send(file, items) {
    const prepared = performance.now();
    const rows = items.reduce((n, item) => n + item.state.actions.length, 0);
    const states = new Float32Array(rows * STATE);
    const actions = new Float32Array(rows * ACTION);
    let row = 0;
    for (const item of items) {
      const encoded = encode(item.state);
      for (const ids of item.state.actions) {
        states.set(encoded, row * STATE);
        actions.set(cardsArray(ids), row * ACTION);
        row++;
      }
    }
    stats.prepareMs += performance.now() - prepared;
    const id = ++nextId;
    pending.set(id, { items });
    stats.inFlightMax = Math.max(stats.inFlightMax, pending.size);
    stats.batches++;
    stats.decisions += items.length;
    stats.rows += rows;
    worker.postMessage({ id, file, rows, states: states.buffer, actions: actions.buffer }, [
      states.buffer,
      actions.buffer,
    ]);
  }

  function flush() {
    scheduled = false;
    for (const [file, items] of queues) {
      for (let start = 0; start < items.length;) {
        let end = start,
          rows = 0;
        while (
          end < items.length &&
          end - start < batchDecisions &&
          (end === start || rows + items[end].state.actions.length <= maxRows)
        )
          rows += items[end++].state.actions.length;
        send(file, items.slice(start, end));
        start = end;
      }
    }
    queues.clear();
  }

  return {
    stats,
    values(file, state) {
      return new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        if (!queues.has(file)) queues.set(file, []);
        queues.get(file).push({ state, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          setImmediate(flush);
        }
      });
    },
    async close() {
      await worker.terminate();
    },
  };
}
