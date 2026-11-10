import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BOT_MODELS,
  DEFAULT_BOT_MODEL,
  NEURAL_DEFAULT_MODEL,
  botModelId,
  botModelName,
  BOT_CHOICES,
  CLINT_RULE_ID,
  MENU_MODE,
  botChoiceId,
  selectableModels,
  validateCatalog,
} from '../../../web/src/ai/model-catalog.mjs';
import { modelBytes, sha256 } from '../../publishing/artifacts.mjs';
import { encodeHistory } from '../../../web/src/ai/history.mjs';
import { history } from '../../guanzero/training/history.mjs';
import { inferPolicy } from '../../../web/src/ai/policy-inference.mjs';

test('model IDs are immutable numbered entries and unknown preferences use the current default', () => {
  const catalog = {
    schema: 1,
    defaultId: NEURAL_DEFAULT_MODEL,
    models: structuredClone(BOT_MODELS),
  };
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

test('the menu offers exactly Clint, the newest GuanZero, the current champion and danMCai-reason', () => {
  const choices = BOT_CHOICES.map((m) => m.id);
  // Immutable archive IDs increase even when unrelated models are registered.
  const generations = BOT_MODELS.filter((m) => m.config.history === 'guanzero-v1')
    .map((m) => m.id)
    .sort((a, b) => Number(b) - Number(a));
  assert.ok(generations.length >= 2);
  // Owner 2026-11-09: four entries; P0 001, the previous champion 012 and older GuanZero
  // generations stay archived in `models` but are no longer offered.
  assert.deepEqual(choices, [CLINT_RULE_ID, generations[0], '017', '9001']);
  for (const retired of ['001', '012', generations[1]]) {
    assert.ok(
      BOT_MODELS.some((m) => m.id === retired),
      `${retired} stays archived`,
    );
    assert.equal(botChoiceId(retired), '9001', `${retired} falls back to the default`);
    assert.equal(botModelId(retired), retired, 'old rooms and records still resolve it');
  }
  // Owner decision 2026-11-09: new players default to the reasoning bot over champion 017.
  assert.equal(DEFAULT_BOT_MODEL, '9001');
  assert.equal(NEURAL_DEFAULT_MODEL, '017');
  assert.equal(botModelName(CLINT_RULE_ID), 'Clint规则机器人');
  assert.equal(botModelName('017'), 'danMCai-v000855042');
  assert.equal(botModelName('9001'), 'danMCai-reason-v000855042');
  assert.match(botModelName(generations[0]), /^guanzero-[a-z0-9-]+-\d+$/);
  assert.equal(botChoiceId('006'), '9001');
  assert.equal(botModelId('006'), '006');
  assert.equal(botChoiceId(CLINT_RULE_ID), CLINT_RULE_ID);
  const catalog = {
    schema: 1,
    defaultId: NEURAL_DEFAULT_MODEL,
    models: structuredClone(BOT_MODELS),
    selection: { mode: MENU_MODE, danMCaiChampions: ['017', '012'] },
  };
  const nextId = String(1 + Math.max(...BOT_MODELS.map((m) => Number(m.id)))).padStart(3, '0');
  const future = {
    ...catalog,
    models: [
      ...catalog.models,
      { ...catalog.models.find((m) => m.id === generations[0]), id: nextId },
    ],
  };
  // a new GuanZero generation replaces the old one; without a search bot there are three entries
  assert.deepEqual(
    selectableModels(future).map((m) => m.id),
    [CLINT_RULE_ID, nextId, '017'],
  );
  assert.throws(() => validateCatalog({ ...catalog, defaultId: '007' }), /champion selection/);
  assert.throws(
    () =>
      validateCatalog({ ...catalog, selection: { ...catalog.selection, mode: 'champions-v1' } }),
    /champion selection/,
  );
  // the menu default must be one of the four entries
  assert.throws(
    () =>
      validateCatalog({
        ...catalog,
        selection: { ...catalog.selection, defaultChoice: '012' },
      }),
    /menu default/,
  );
});

test('selected local champions are backed by accepted gate records with matching model SHA', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../../research/evaluation/champion-selection-mac-20261106/champion.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const models = ['012', '017'].map((id) => BOT_MODELS.find((m) => m.id === id));
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
