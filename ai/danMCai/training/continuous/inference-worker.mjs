/** Worker thread that owns the ONNX sessions, so GPU waits never block the game-logic thread. */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
import { rowsModel } from './onnx-rows.mjs';

const { provider, sessionLimit = 6, maxRows = 4096 } = workerData;
const sessions = new Map();
let active = null;
let fallbackReason = null;

async function create(bytes) {
  if (provider !== 'cpu' && active !== 'cpu') {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [provider],
        intraOpNumThreads: 1,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
        enableCpuMemArena: false,
        enableMemPattern: false,
      });
      active = provider;
      return session;
    } catch (error) {
      fallbackReason = String(error?.message || error);
    }
  }
  active = 'cpu';
  return ort.InferenceSession.create(bytes, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
}

// Score one batch at a time. The cache cap now includes every native session, including
// sessions being created/released; a queued match cannot pin dozens of DirectML arenas.
let sessionsCreated = 0,
  sessionsReleased = 0,
  peakSessions = 0;

async function session(file) {
  if (!sessions.has(file)) {
    while (sessions.size >= sessionLimit) {
      const [key, engine] = sessions.entries().next().value;
      sessions.delete(key);
      await engine.release();
      sessionsReleased++;
    }
    sessions.set(file, await create(rowsModel(readFileSync(file))));
    sessionsCreated++;
    peakSessions = Math.max(peakSessions, sessions.size);
  }
  // Refresh recency so frequently used models stay cached.
  const promise = sessions.get(file);
  sessions.delete(file);
  sessions.set(file, promise);
  return promise;
}

async function score({ id, file, rows, states, actions, extras }) {
  try {
    const engine = await session(file);
    const started = performance.now();
    const stateData = new Float32Array(states),
      actionData = new Float32Array(actions);
    const values = new Float32Array(rows);
    // Even one unusually large legal-action list is scored fully in bounded native batches.
    for (let first = 0; first < rows; first += maxRows) {
      const count = Math.min(maxRows, rows - first);
      const inputs = {
        state: new ort.Tensor('float32', stateData.subarray(first * 513, (first + count) * 513), [
          count,
          513,
        ]),
        actions: new ort.Tensor('float32', actionData.subarray(first * 54, (first + count) * 54), [
          count,
          54,
        ]),
      };
      if (engine.inputNames.includes('extras')) {
        if (!extras) throw Error('Missing registered extras input');
        inputs.extras = new ort.Tensor(
          'float32',
          new Float32Array(extras).subarray(first * 53, (first + count) * 53),
          [count, 53],
        );
      }
      let output;
      try {
        output = await engine.run(inputs);
        values.set(output.values.data, first);
      } finally {
        Object.values(inputs).forEach((tensor) => tensor.dispose());
        if (output) Object.values(output).forEach((tensor) => tensor.dispose());
      }
    }
    parentPort.postMessage(
      {
        id,
        values: values.buffer,
        runMs: performance.now() - started,
        provider: active,
        fallbackReason,
        memory: { sessionCount: sessions.size, sessionsCreated, sessionsReleased, peakSessions },
      },
      [values.buffer],
    );
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
}
let queue = Promise.resolve();
parentPort.on('message', (message) => {
  queue = queue.then(() => score(message));
});
