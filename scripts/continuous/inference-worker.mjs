/** Worker thread that owns the ONNX sessions, so GPU waits never block the game-logic thread. */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import * as ort from 'onnxruntime-node';
import { rowsModel } from './onnx-rows.mjs';

const { provider } = workerData;
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
  });
}

// A league can hold dozens of snapshot models and many matches use them at once, so only
// sessions with no batch in flight are ever released.
const LIMIT = 32;
const busy = new Map();

function session(file) {
  if (!sessions.has(file)) {
    for (const [key, promise] of sessions) {
      if (sessions.size < LIMIT) break;
      if (busy.get(key)) continue;
      sessions.delete(key);
      void promise.then((s) => s.release()).catch(() => {});
    }
    sessions.set(file, create(rowsModel(readFileSync(file))));
  }
  // Refresh recency so frequently used models stay cached.
  const promise = sessions.get(file);
  sessions.delete(file);
  sessions.set(file, promise);
  return promise;
}

parentPort.on('message', async ({ id, file, rows, states, actions }) => {
  busy.set(file, (busy.get(file) || 0) + 1);
  try {
    const engine = await session(file);
    const started = performance.now();
    const output = await engine.run({
      state: new ort.Tensor('float32', new Float32Array(states), [rows, 513]),
      actions: new ort.Tensor('float32', new Float32Array(actions), [rows, 54]),
    });
    const values = Float32Array.from(output.values.data);
    parentPort.postMessage(
      {
        id,
        values: values.buffer,
        runMs: performance.now() - started,
        provider: active,
        fallbackReason,
      },
      [values.buffer],
    );
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  } finally {
    busy.set(file, busy.get(file) - 1);
  }
});
