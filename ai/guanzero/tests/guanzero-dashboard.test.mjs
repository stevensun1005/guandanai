import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot, createDashboardServer } from '../training/dashboard.mjs';
function fixture() {
  mkdirSync(join(process.cwd(), 'ai/guanzero/runs'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'ai/guanzero/runs/dashboard-test-'));
  for (const part of ['actors', 'learner', 'models', 'shards', 'eval']) mkdirSync(join(root, part));
  const write = (name, data) => writeFileSync(join(root, name), JSON.stringify(data));
  write('config.json', {
    createdAt: new Date(Date.now() - 60000).toISOString(),
    device: 'cuda',
    actors: 1,
    objective: 'adp',
    batchSize: 3200,
    epsilon: 0.01,
    seed: 5,
  });
  write('learner/status.json', {
    pid: process.pid,
    step: 4,
    usedSamples: 12800,
    loss: 2,
    updatedAt: Date.now() / 1000,
    deviceName: 'test GPU',
  });
  write('actors/actor-0.json', {
    pid: process.pid,
    slot: 0,
    matches: 12,
    rows: 16000,
    loadedModel: 3,
    updatedAt: new Date().toISOString(),
  });
  write('models/latest.json', { version: 3, file: 'model.onnx' });
  return { root, write };
}
test('GuanZero dashboard uses live totals and flags stale or stopped training', () => {
  const { root, write } = fixture();
  try {
    const live = snapshot(root);
    assert.equal(live.phase, 'running');
    assert.equal(live.totals.matches, 12);
    assert.equal(live.totals.rows, 16000);
    assert.equal(live.totals.liveActors, 1);
    assert.equal(live.latest.version, 3);
    write('learner/status.json', { pid: process.pid, updatedAt: Date.now() / 1000 - 180 });
    assert.equal(snapshot(root).phase, 'unconfirmed');
    writeFileSync(join(root, 'STOP'), 'stop');
    assert.equal(snapshot(root).phase, 'stopped');
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('GuanZero dashboard treats non-finite learner errors as errors and preserves evaluation sample sizes', () => {
  const { root, write } = fixture();
  try {
    write('learner/status.json', {
      pid: process.pid,
      error: 'Non-finite loss',
      updatedAt: Date.now() / 1000,
    });
    mkdirSync(join(root, 'eval/block-0000'));
    write('eval/block-0000/report.json', {
      index: 0,
      seedStart: 3700000000,
      seedEnd: 3700000001,
      modelSHA256: 'abc',
      results: {
        rule: { matches: 4, wins: 0, losses: 4, draws: 0, clusters: ['omitted'], matchWinRate: 0 },
        clint: {
          matches: 4,
          wins: 1,
          losses: 3,
          draws: 0,
          clusters: ['omitted'],
          matchWinRate: 0.25,
        },
      },
    });
    const s = snapshot(root);
    assert.equal(s.phase, 'error');
    assert.equal(s.evaluations[0].matches, 4);
    assert.equal(s.evaluations[0].clusters, undefined);
    assert.equal(s.evaluations[0].opponentName, '原版规则机器人');
    assert.equal(s.evaluations[0].opponentVersion, 'original');
    assert.equal(s.evaluations[1].opponentName, 'Clint规则机器人');
    assert.equal(s.evaluations[1].matchWinRate, 0.25);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('GuanZero HTTP dashboard is read-only and serves live JSON and local assets', async () => {
  const { root } = fixture(),
    server = createDashboardServer({ run: root });
  const before = readFileSync(join(root, 'config.json'), 'utf8');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(url + '/api/status');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).learner.step, 4);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url + '/', { method: 'POST' })).status, 405);
    assert.equal((await fetch(url + '/config.json')).status, 404);
    const page = await fetch(url + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /GuanZero/);
    assert.equal(readFileSync(join(root, 'config.json'), 'utf8'), before);
    assert.equal(readdirSync(join(root, 'shards')).length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true });
  }
});

test('dashboard accepts Clint supplements only for the same frozen model and paired deals', () => {
  const { root, write } = fixture();
  try {
    mkdirSync(join(root, 'eval/block-0002/clint'), { recursive: true });
    const base = {
      index: 2,
      pairs: 100,
      seedStart: 3700200000,
      seedEnd: 3700200099,
      modelSHA256: 'pinned',
      results: { rule: { matches: 200, wins: 0, losses: 200, draws: 0 } },
    };
    write('eval/block-0002/report.json', base);
    const supplement = {
      ...base,
      completedAt: new Date().toISOString(),
      opponents: { clint: { name: 'Clint规则机器人', version: 'rules-v2' } },
      results: { clint: { matches: 200, wins: 2, losses: 198, draws: 0 } },
    };
    for (const field of [
      { modelSHA256: 'different' },
      { seedStart: 1 },
      { seedEnd: 2 },
      { pairs: 99 },
      { index: 3 },
    ]) {
      write('eval/block-0002/clint/report.json', { ...supplement, ...field });
      assert.equal(snapshot(root).evaluations.length, 1);
    }
    write('eval/block-0002/clint/report.json', supplement);
    const rows = snapshot(root).evaluations;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].opponentVersion, 'original');
    assert.equal(rows[1].opponentVersion, 'rules-v2');
    assert.equal(rows[1].wins, 2);
  } finally {
    rmSync(root, { recursive: true });
  }
});

import { modelLabel, captureModelIdentities } from '../training/model-labels.mjs';
import { createHash } from 'node:crypto';
test('evaluation model names use verified checkpoints and never treat block counters or the latest export as old versions', () => {
  const { root } = fixture();
  try {
    const bytes = Buffer.from('named frozen model'),
      file = join(root, 'models/model-000000078087.onnx');
    writeFileSync(file, bytes);
    const sha = createHash('sha256').update(bytes).digest('hex'),
      identities = {};
    assert.equal(captureModelIdentities(root, identities), true);
    assert.equal(
      modelLabel('guanzero-adp-gpubatch', sha, 'block-0003', identities),
      'guanzero-adp-gpubatch-78087',
    );
    const old = 'a'.repeat(64);
    assert.equal(
      modelLabel('guanzero-adp-gpubatch', old, 'block-0003', identities),
      'guanzero-adp-gpubatch-aaaaaaaaaaaa',
    );
    assert.equal(
      modelLabel('guanzero-adp-gpubatch', old, 'model-000000077262', identities),
      'guanzero-adp-gpubatch-77262',
    );
    const before = readFileSync(join(root, 'config.json'));
    const rows = snapshot(root, identities);
    assert.equal(rows.latest.version, 3);
    assert.deepEqual(readFileSync(join(root, 'config.json')), before);
    assert.throws(
      () => createDashboardServer({ run: root, modelIdentitiesFile: join(root, 'config.json') }),
      /outside the training run/,
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
