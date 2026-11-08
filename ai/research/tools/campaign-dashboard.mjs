/** Read-only live campaign view; independent of all frozen model code. */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, readJSON, writeJSON } from '../../danMCai/training/continuous/lib.mjs';
import { safeRun } from './research-deadline.mjs';

const root = resolve(option('campaign', ''));
const port = Number(option('port', '8767'));
let last = cpus(),
  cpuPercent = null;
const live = (pid) => {
  try {
    process.kill(pid, 0);
    return !!pid;
  } catch {
    return false;
  }
};
setInterval(() => {
  const current = cpus();
  const sum = (list) =>
    list.reduce((n, c) => n + Object.values(c.times).reduce((a, b) => a + b, 0), 0);
  const idle = (list) => list.reduce((n, c) => n + c.times.idle, 0);
  const delta = sum(current) - sum(last);
  cpuPercent = delta > 0 ? 100 * (1 - (idle(current) - idle(last)) / delta) : null;
  last = current;
}, 3000).unref();
function snapshot() {
  const tasks = readJSON(join(root, 'tasks.json'), []).map((task) => {
    const run = safeRun(root, task.run);
    const state = readJSON(join(run, 'status.json'), {});
    const learner = readJSON(join(run, 'learner/status.json'));
    const config = readJSON(join(run, 'config.json'), {});
    const startingStep = config.parent?.startingStep ?? config.parent?.latest?.step ?? 0;
    const age = (Date.now() - Date.parse(state.updatedAt)) / 1000;
    return {
      id: task.id,
      window: task.window,
      protocolSHA256: task.protocolSHA256,
      state,
      learner,
      startingStep,
      newUpdates: learner ? Math.max(0, learner.step - startingStep) : 0,
      sampler: config.fastActor || null,
      actorInference: Array.from({ length: config.actors || 0 }, (_, slot) => {
        const actor = readJSON(join(run, `actors/actor-${slot}.json`), {});
        return {
          slot,
          provider: actor.inference?.provider || null,
          fallbackReason: actor.inference?.fallbackReason || null,
          sessionLimit: actor.sessionLimit ?? null,
          matches: actor.matches || 0,
        };
      }),
      summary: readJSON(join(run, 'summary.json')),
      heartbeatAgeSeconds: Number.isFinite(age) ? age : null,
      processAlive: live(state.pid),
      stale: !state.stoppedAt && !(live(state.pid) && age < 90),
    };
  });
  const guardian = readJSON(join(root, 'guardian-status.json'));
  const campaign = readJSON(join(root, 'campaign.json'));
  const amendment = readJSON(join(root, 'authorization-20261108.json'));
  const earlyCutoff = readJSON(join(root, 'early-cutoff-status.json'));
  if (amendment) {
    if (
      amendment.deadlineUTC !== '2026-11-11T15:00:00.000Z' ||
      amendment.computeDeadlineUTC !== '2026-11-11T14:45:00.000Z'
    )
      throw Error('Unrecognized earlier authorization');
    campaign.originalDeadlineUTC = campaign.deadlineUTC;
    campaign.deadlineUTC = amendment.deadlineUTC;
    campaign.computeDeadlineUTC = amendment.computeDeadlineUTC;
  }
  return {
    observedAtUTC: new Date().toISOString(),
    campaign,
    earlyCutoff,
    progress: readJSON(join(root, 'progress.json'), {}),
    tasks,
    guardian,
    guardianHealthy:
      !!guardian && live(guardian.pid) && Date.now() - Date.parse(guardian.updatedAtUTC) < 15000,
    resources: {
      availableGiB: freemem() / 1024 ** 3,
      totalGiB: totalmem() / 1024 ** 3,
      machineCPUPercent: cpuPercent,
    },
    historicalAB: {
      url: 'http://127.0.0.1:8766/',
      completedRounds: 24000,
      primaryConclusion: '升级分主指标未分出 A/B 明确强弱',
    },
    webChampion: 'danMCai-v000855042 · 保持不变',
  };
}
createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end('Read only');
  }
  try {
    if (req.url === '/api/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end(JSON.stringify(snapshot()));
    }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(
        readFileSync(fileURLToPath(new URL('./campaign-dashboard.html', import.meta.url))),
      );
    }
    res.writeHead(404);
    res.end('Not found');
  } catch (error) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: error.message }));
  }
}).listen(port, '127.0.0.1', () => {
  writeJSON(join(root, 'dashboard-launcher.json'), {
    pid: process.pid,
    port,
    url: `http://127.0.0.1:${port}/`,
    source: import.meta.url,
  });
  console.log(`Campaign progress: http://127.0.0.1:${port}/`);
});
