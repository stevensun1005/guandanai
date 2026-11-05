import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot, createDashboardServer } from '../scripts/guanzero/dashboard.mjs';
function fixture() {
  mkdirSync(join(process.cwd(), 'work/guanzero'), { recursive: true });
  const root = mkdtempSync(join(process.cwd(), 'work/guanzero/dashboard-test-'));
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
      },
    });
    const s = snapshot(root);
    assert.equal(s.phase, 'error');
    assert.equal(s.evaluations[0].matches, 4);
    assert.equal(s.evaluations[0].clusters, undefined);
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
