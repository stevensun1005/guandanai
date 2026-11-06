import * as ort from './vendor/ort.wasm.min.mjs';
import manifest from './tribute-model.json' with { type: 'json' };
import { selectTribute } from '../../../ai/shared/tribute/select.mjs';
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
let engine;
async function session() {
  if (!engine)
    engine = (async () => {
      if (!manifest.enabled || !/^[\w-]+\.onnx$/.test(manifest.file))
        throw Error('Specialist disabled');
      const response = await fetch(new URL('../models/' + manifest.file, import.meta.url));
      if (!response.ok) throw Error('Specialist download failed');
      const bytes = await response.arrayBuffer(),
        digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
      if (sha !== manifest.sha256) throw Error('Specialist SHA mismatch');
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      if (
        JSON.stringify(s.inputNames) !== '["features"]' ||
        JSON.stringify(s.outputNames) !== '["values"]'
      )
        throw Error('Specialist interface mismatch');
      return s;
    })();
  return engine;
}
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      const result = await selectTribute(
        data.state,
        data.head,
        async (rows, n) => {
          const input = new ort.Tensor('float32', rows, [n, 389]);
          let out;
          try {
            out = await (await session()).run({ features: input });
            return Float32Array.from(out.values.data);
          } finally {
            input.dispose();
            if (out) Object.values(out).forEach((t) => t.dispose());
          }
        },
        data.baseline,
      );
      self.postMessage({ id: data.id, result });
    } catch (e) {
      engine = null;
      self.postMessage({ id: data.id, error: e.message });
    }
  });
};
