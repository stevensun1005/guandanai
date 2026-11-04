import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboardServer, dashboardSnapshot } from '../scripts/continuous/dashboard.mjs';

test('dashboard is read-only, reports real counts and flags stale training without claiming completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-dashboard-'));
  const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  for (const name of ['gate', 'anchor', 'learner', 'actors']) mkdirSync(join(directory, name));
  save('config.json', { actors: 1, anchor: { intervalHours: 3 } });
  save('launcher.json', { hours: 24 });
  const state = {
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    elapsedSeconds: 3600,
    running: ['learner'],
    totals: { matches: 123, decisions: 456 },
    learner: { pid: process.pid, step: 789 },
    lastAnchorAt: Date.now(),
  };
  save('status.json', state);
  const server = createDashboardServer({ run: directory, workspace: directory });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const before = readFileSync(join(directory, 'status.json'), 'utf8');
    const response = await fetch(base + '/api/status');
    const data = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(data.phase, 'running');
    assert.equal(data.totals.matches, 123);
    assert.equal(data.learner.step, 789);
    assert.equal(data.plannedHours, 24);
    assert.deepEqual(data.evaluations, []);
    assert.equal(data.publication.confirmed, false);
    assert.equal((await fetch(base + '/api/status', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/config.json')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e%2fconfig.json')).status, 404);
    assert.match(await (await fetch(base)).text(), /训练进行到哪了/);
    assert.equal(readFileSync(join(directory, 'status.json'), 'utf8'), before);
    save('status.json', { ...state, updatedAt: '2000-01-01T00:00:00Z' });
    assert.equal(dashboardSnapshot(directory, directory).phase, 'unconfirmed');
    save('status.json', {
      ...state,
      stoppedAt: new Date().toISOString(),
      stopReason: 'anchor-regression',
    });
    const stopped = dashboardSnapshot(directory, directory);
    assert.equal(stopped.phase, 'stopped');
    assert.equal(stopped.stopReason, 'anchor-regression');
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
