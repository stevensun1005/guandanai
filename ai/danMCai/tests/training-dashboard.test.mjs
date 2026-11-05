import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDashboardServer, dashboardSnapshot } from '../training/continuous/dashboard.mjs';

test('dashboard is read-only, reports real counts and flags stale training without claiming completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'guandan-dashboard-'));
  mkdirSync(join(directory, 'ai/danMCai/runs'), { recursive: true });
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
    resources: { freeGB: 7.5, reserveGB: 6, resumeGB: 8, pausedActors: ['actor-1'] },
  };
  save('status.json', state);
  mkdirSync(join(directory, 'ai/danMCai/runs/gpu-main/learner'), { recursive: true });
  save('ai/danMCai/runs/gpu-main/config.json', { actors: 2, learner: { device: 'cuda:0' } });
  save('ai/danMCai/runs/gpu-main/status.json', { ...state, totals: { matches: 12 } });
  save('ai/danMCai/runs/gpu-main/learner/status.json', {
    step: 34,
    deviceName: 'Test GPU',
    device: 'cuda:0',
  });
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
    assert.equal(data.deviceRuns[0].totals.matches, 12);
    assert.equal(data.deviceRuns[0].step, 34);
    assert.equal(data.deviceRuns[0].deviceName, 'Test GPU');
    assert.equal(data.learner.step, 789);
    assert.deepEqual(data.resources, state.resources);
    assert.equal(data.plannedHours, 24);
    save('schedule.json', { durationHours: 24, deadlineUTC: '2026-11-06T23:00:00Z' });
    const scheduled = await (await fetch(base + '/api/status')).json();
    assert.equal(scheduled.deadlineUTC, '2026-11-06T23:00:00Z');
    assert.equal(scheduled.plannedHours, 24);
    assert.equal(scheduled.samplerProvider, 'cpu');
    assert.deepEqual(data.evaluations, []);
    assert.equal(data.independentEvaluation, null);
    mkdirSync(join(directory, 'ai/danMCai/workspace/evaluations'), { recursive: true });
    save('ai/danMCai/workspace/evaluations/progress.json', {
      phase: 'running',
      completedMatches: 20,
      plannedMatches: 2000,
    });
    assert.equal(
      (await (await fetch(base + '/api/status')).json()).independentEvaluation.completedMatches,
      20,
    );
    assert.equal(data.publication.confirmed, false);
    assert.equal((await fetch(base + '/api/status', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/config.json')).status, 404);
    assert.equal((await fetch(base + '/%2e%2e%2fconfig.json')).status, 404);
    const html = await (await fetch(base)).text();
    assert.match(html, /danMCai 训练观测台/);
    assert.match(html, /后续研究任务/);
    for (const task of ['D1', 'D2', 'D3', 'D4', 'D5']) assert(html.includes(task));
    assert.equal(readFileSync(join(directory, 'status.json'), 'utf8'), before);
    save('actors/actor-0.json', { pid: process.pid, matches: 130, decisions: 900, rows: 900 });
    const live = await (await fetch(base + '/api/status')).json();
    assert.equal(
      live.totals.matches,
      130,
      'Counts read current actors instead of waiting for the supervisor tick',
    );
    assert.equal(JSON.parse(before).totals.matches, 123);
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
