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
import { encode, cardsArray } from '../../../../web/src/ai/encoding.mjs';
import { encodePolicyExtrasBatch } from '../../../../web/src/ai/policy-features.mjs';
import { ACTION, BELIEF_MARGINALS, STATE, extrasWidth } from './lib.mjs';

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
    // One extras width per batch; every item of a model file shares the run's extras mode.
    const width = Math.max(...items.map((x) => extrasWidth(x.extrasMode)));
    if (items.some((x) => x.extrasMode && extrasWidth(x.extrasMode) !== width))
      throw Error('Mixed extras widths in one batch');
    const extras = width ? new Float32Array(rows * width) : null;
    let row = 0;
    for (const item of items) {
      const encoded = encode(item.state);
      if (item.extrasMode === 'public') extras.set(encodePolicyExtrasBatch(item.state), row * 53);
      else if (item.extrasMode === 'public-belief') {
        // Per candidate row: its 53 public extras, then the decision's 162 belief marginals.
        if (item.marginals?.length !== BELIEF_MARGINALS) throw Error('Missing belief marginals');
        const publicExtras = encodePolicyExtrasBatch(item.state);
        for (let i = 0; i < item.state.actions.length; i++) {
          extras.set(publicExtras.subarray(i * 53, (i + 1) * 53), (row + i) * width);
          extras.set(item.marginals, (row + i) * width + 53);
        }
      }
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
    worker.postMessage(
      {
        id,
        file,
        rows,
        states: states.buffer,
        actions: actions.buffer,
        extras: extras?.buffer,
        extrasWidth: width || null,
      },
      [states.buffer, actions.buffer, ...(extras ? [extras.buffer] : [])],
    );
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
    values(file, state, extrasMode = null, marginals = null) {
      return new Promise((resolve, reject) => {
        if (failure) return reject(failure);
        if (!queues.has(file)) queues.set(file, []);
        queues.get(file).push({ state, resolve, reject, extrasMode, marginals });
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
