import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOT_MODELS,
  DEFAULT_BOT_MODEL,
  botModelId,
  botModelName,
  validateCatalog,
} from '../src/ai/model-catalog.mjs';
import { modelBytes, sha256 } from '../scripts/lib/web-models.mjs';
import { encodeHistory } from '../src/ai/history.mjs';
import { history } from '../scripts/guanzero/history.mjs';
import { inferPolicy } from '../src/ai/policy-inference.mjs';

test('model IDs are immutable numbered entries and unknown preferences use the current default', () => {
  const catalog = { schema: 1, defaultId: DEFAULT_BOT_MODEL, models: structuredClone(BOT_MODELS) };
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(botModelId('aggressive'), DEFAULT_BOT_MODEL);
  assert.equal(botModelId(BOT_MODELS[0].id), BOT_MODELS[0].id);
  assert.equal(botModelName('001'), 'v000000000');
  for (const model of BOT_MODELS.filter((model) => model.source?.version !== 'P0'))
    assert.equal(
      botModelName(model.id),
      model.config.history === 'guanzero-v1'
        ? `${model.source.run} · ${model.source.step}步`
        : model.source.version,
    );
  assert.throws(() =>
    validateCatalog({ ...catalog, models: [...catalog.models, catalog.models[0]] }),
  );
  assert.throws(() => validateCatalog({ ...catalog, defaultId: '99999' }));
  for (const field of [
    { file: '../escape.onnx' },
    { url: 'https://example.com/model.onnx' },
    { sha256: 'bad' },
  ])
    assert.throws(() =>
      validateCatalog({ ...catalog, models: [{ ...catalog.models[0], ...field }] }),
    );
});

test('cached build models must pass the full SHA before they can be served', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guandan-web-model-'));
  try {
    const bytes = Buffer.from('test weights'),
      sha = sha256(bytes);
    await mkdir(join(root, 'work/web-models'), { recursive: true });
    const file = join(root, 'work/web-models', sha + '.onnx');
    const model = {
      id: '002',
      sha256: sha,
      url: 'https://github.com/stevensun1005/guandanai/releases/download/test/model.onnx',
    };
    await writeFile(file, bytes);
    assert.deepEqual(await modelBytes(root, model), bytes);
    await writeFile(file, 'corrupt');
    await assert.rejects(modelBytes(root, model), /SHA-256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('browser history encoding matches the trained GuanZero layout including passes and finished seats', async () => {
  const positions = JSON.parse(
    await readFile(new URL('./fixtures/positions.json', import.meta.url)),
  );
  for (const state of positions) assert.deepEqual([...encodeHistory(state)], [...history(state)]);
  const state = positions[0];
  const seen = [],
    tensors = [];
  class Tensor {
    constructor(type, data, dims) {
      Object.assign(this, { type, data, dims });
      tensors.push(this);
    }
    dispose() {
      this.disposed = true;
    }
  }
  await inferPolicy(
    { Tensor },
    {
      run: async (inputs) => {
        seen.push(inputs);
        return {
          values: new Tensor(
            'float32',
            Float32Array.from(inputs.actions.data.slice(0, inputs.actions.dims[0]), () => 0),
            [inputs.actions.dims[0], 1],
          ),
        };
      },
    },
    { ...state, actions: [[0], [1]] },
    { history: 'guanzero-v1' },
  );
  assert.deepEqual(seen[0].history.dims, [1, 5, 216]);
  assert.deepEqual([...seen[0].history.data], [...history(state)]);
  assert(tensors.every((tensor) => tensor.disposed));
});
