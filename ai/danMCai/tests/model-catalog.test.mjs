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
  BOT_CHOICES,
  CLINT_RULE_ID,
  botChoiceId,
  selectableModels,
  validateCatalog,
} from '../../../web/src/ai/model-catalog.mjs';
import { modelBytes, sha256 } from '../../publishing/artifacts.mjs';
import { encodeHistory } from '../../../web/src/ai/history.mjs';
import { history } from '../../guanzero/training/history.mjs';
import { inferPolicy } from '../../../web/src/ai/policy-inference.mjs';

test('model IDs are immutable numbered entries and unknown preferences use the current default', () => {
  const catalog = { schema: 1, defaultId: DEFAULT_BOT_MODEL, models: structuredClone(BOT_MODELS) };
  assert.equal(validateCatalog(catalog), catalog);
  assert.equal(botModelId('aggressive'), DEFAULT_BOT_MODEL);
  assert.equal(botModelId(BOT_MODELS[0].id), BOT_MODELS[0].id);
  assert.equal(botModelName('001'), 'danMCai-v000000000');
  for (const model of BOT_MODELS.filter((model) => model.source?.version !== 'P0'))
    assert.equal(
      botModelName(model.id),
      model.config.history === 'guanzero-v1'
        ? `${model.source.run}-${model.source.step}`
        : 'danMCai-' + model.source.version,
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

test('curated menu contains Clint, two GuanZero generations, P0 and the last two gate champions', () => {
  const choices = BOT_CHOICES.map((m) => m.id);
  assert.deepEqual(choices, [CLINT_RULE_ID, '014', '013', '001', '012', '009']);
  assert.equal(DEFAULT_BOT_MODEL, '012');
  assert.equal(botModelName(CLINT_RULE_ID), 'Clint规则机器人');
  assert.equal(botModelName('012'), 'danMCai-v000705434');
  assert.equal(botChoiceId('006'), DEFAULT_BOT_MODEL);
  assert.equal(botModelId('006'), '006');
  assert.equal(botChoiceId(CLINT_RULE_ID), CLINT_RULE_ID);
  const catalog = {
    schema: 1,
    defaultId: DEFAULT_BOT_MODEL,
    models: structuredClone(BOT_MODELS),
    selection: { mode: 'champions-v1', danMCaiChampions: ['012', '009'] },
  };
  const future = {
    ...catalog,
    models: [...catalog.models, { ...catalog.models.find((m) => m.id === '014'), id: '015' }],
  };
  assert.deepEqual(
    selectableModels(future).map((m) => m.id),
    [CLINT_RULE_ID, '015', '014', '001', '012', '009'],
  );
  assert.throws(() => validateCatalog({ ...catalog, defaultId: '007' }), /champion selection/);
});

test('selected local champions are backed by accepted gate records with matching model SHA', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../../research/evaluation/champion-selection-mac-20261105/champion.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const models = ['009', '012'].map((id) => BOT_MODELS.find((m) => m.id === id));
  assert.deepEqual(
    models.map((m) => m.source.version),
    manifest.history.slice(-2).map((x) => x.version),
  );
  for (const model of models) {
    const proof = model.source.champion;
    const bytes = await readFile(new URL('../../../' + proof.evidence, import.meta.url));
    assert.equal(sha256(bytes), proof.evidenceSHA256);
    const gate = JSON.parse(bytes);
    assert.equal(gate.decision, 'accept');
    assert.equal(gate.challenger.sha256, model.sha256);
    assert.equal(gate.challenger.version, model.source.version);
  }
});

test('cached build models must pass the full SHA before they can be served', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guandan-web-model-'));
  try {
    const bytes = Buffer.from('test weights'),
      sha = sha256(bytes);
    await mkdir(join(root, 'ai/publishing/cache'), { recursive: true });
    const file = join(root, 'ai/publishing/cache', sha + '.onnx');
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
    await readFile(new URL('../../shared/fixtures/positions.json', import.meta.url)),
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
