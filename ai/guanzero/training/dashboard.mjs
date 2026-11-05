/** Local, read-only GuanZero progress dashboard. No control endpoints. */
import { opponentDefinition } from './opponents.mjs';
import { createServer } from 'node:http';
import {
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, freemem } from 'node:os';
import { execFile } from 'node:child_process';
import { paths, readJSON, option, actorTotals, stopped } from './lib.mjs';
const assets = fileURLToPath(new URL('./dashboard/', import.meta.url));
function alive(pid) {
  try {
    if (!Number.isInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
function safe(file, fallback = null) {
  try {
    return readJSON(file, fallback);
  } catch {
    return fallback;
  }
}
export function snapshot(run) {
  const p = paths(run),
    config = safe(join(p.root, 'config.json'));
  if (!config) throw Error('尚未开始训练，正在等待运行配置');
  const learner = safe(join(p.learner, 'status.json'), {}),
    latest = safe(join(p.models, 'latest.json'), {}),
    launcher = safe(join(p.root, 'launcher.json'), {});
  const totals = actorTotals(p),
    now = Date.now(),
    stop = stopped(p);
  const learnerAge = learner.updatedAt ? now / 1000 - learner.updatedAt : null;
  const running =
    !stop && alive(learner.pid) && learnerAge !== null && learnerAge < 90 && !learner.error;
  const actors = totals.actors.map((a) => ({
    ...a,
    alive: alive(a.pid) && now - Date.parse(a.updatedAt) < 90000,
    ageSeconds: (now - Date.parse(a.updatedAt)) / 1000,
  }));
  const evaluations = [];
  if (existsSync(p.eval))
    for (const name of readdirSync(p.eval)
      .filter((n) => /^block-\d+$/.test(n))
      .sort()
      .reverse()
      .slice(0, 4)) {
      const original = safe(join(p.eval, name, 'report.json'));
      const supplement = safe(join(p.eval, name, 'clint/report.json'));
      const reports = [original];
      if (
        supplement?.completedAt &&
        original &&
        supplement.modelSHA256 === original.modelSHA256 &&
        supplement.index === original.index &&
        supplement.pairs === original.pairs &&
        supplement.seedStart === original.seedStart &&
        supplement.seedEnd === original.seedEnd &&
        !original.results?.clint
      )
        reports.push(supplement);
      for (const report of reports.filter(Boolean))
        for (const [opponent, r] of Object.entries(report.results)) {
          const { clusters, ...metrics } = r;
          evaluations.push({
            opponent,
            opponentName:
              report.opponents?.[opponent]?.name ||
              (['random', 'rule', 'p0', 'clint'].includes(opponent)
                ? opponentDefinition(opponent).name
                : opponent),
            opponentVersion:
              report.opponents?.[opponent]?.version ||
              (opponent === 'rule' ? 'original' : undefined),
            block: report.index,
            seedStart: report.seedStart,
            seedEnd: report.seedEnd,
            model: report.modelSHA256?.slice(0, 12),
            completedAt: report.completedAt,
            ...metrics,
          });
        }
    }
  const end = running
    ? now
    : learner.updatedAt
      ? learner.updatedAt * 1000
      : Date.parse(config.createdAt);
  const shards = existsSync(p.shards)
    ? readdirSync(p.shards).filter((n) => n.endsWith('.json')).length
    : 0;
  let events = [];
  const log = join(p.root, 'stdout.log');
  if (existsSync(log)) {
    const length = statSync(log).size,
      size = Math.min(length, 16384),
      bytes = Buffer.alloc(size),
      fd = openSync(log, 'r');
    try {
      readSync(fd, bytes, 0, size, length - size);
    } finally {
      closeSync(fd);
    }
    events = bytes
      .toString('utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const e = JSON.parse(line);
          return e.kind && e.kind !== 'match' ? [e] : [];
        } catch {
          return [];
        }
      })
      .slice(-6);
  }
  return {
    inference: safe(join(p.root, 'inference/status.json')),
    observedAt: new Date(now).toISOString(),
    run: p.root,
    name: p.root.split(/[\\/]/).at(-1),
    config: {
      device: config.device,
      actors: config.actors,
      objective: config.objective,
      batchSize: config.batchSize,
      epsilon: config.epsilon,
      seed: config.seed,
    },
    phase: learner.error ? 'error' : stop ? 'stopped' : running ? 'running' : 'unconfirmed',
    learnerAgeSeconds: learnerAge,
    learnerAlive: alive(learner.pid),
    elapsedSeconds: Math.max(0, (end - Date.parse(config.createdAt)) / 1000),
    plannedHours: launcher.hours || null,
    totals: {
      matches: totals.matches,
      rows: totals.rows,
      liveActors: actors.filter((a) => a.alive).length,
    },
    learner,
    latest,
    actors,
    evaluations,
    pendingShards: shards,
    events,
  };
}
export function createDashboardServer({ run }) {
  const history = [];
  let hardware = {
    gpu: null,
    cpuPercent: null,
    ramUsedBytes: totalmem() - freemem(),
    ramTotalBytes: totalmem(),
  };
  let previousCpu = null;
  function sampleCpu() {
    const readings = cpus().map((c) => c.times),
      idle = readings.reduce((s, c) => s + c.idle, 0),
      total = readings.reduce((s, c) => s + Object.values(c).reduce((a, b) => a + b, 0), 0);
    if (previousCpu && total > previousCpu.total)
      hardware.cpuPercent = 100 * (1 - (idle - previousCpu.idle) / (total - previousCpu.total));
    previousCpu = { idle, total };
    hardware.ramUsedBytes = totalmem() - freemem();
  }
  function gpu() {
    execFile(
      'nvidia-smi',
      [
        '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { windowsHide: true, timeout: 3000 },
      (error, out) => {
        if (error) {
          hardware.gpu = null;
          return;
        }
        const [name, utilization, used, total, temperature] = out
          .trim()
          .split(',')
          .map((s) => s.trim());
        hardware.gpu = {
          name,
          utilization: Number(utilization),
          usedMiB: Number(used),
          totalMiB: Number(total),
          temperature: Number(temperature),
        };
      },
    );
  }
  const cpuTimer = setInterval(sampleCpu, 2000),
    gpuTimer = setInterval(gpu, 10000);
  sampleCpu();
  gpu();
  cpuTimer.unref();
  gpuTimer.unref();
  const files = {
    '/': ['index.html', 'text/html'],
    '/style.css': ['style.css', 'text/css'],
    '/app.mjs': ['app.mjs', 'text/javascript'],
  };
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'",
    );
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      return res.end('Read only');
    }
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/status') {
        const status = snapshot(run),
          time = Date.now();
        const previous = history.at(-1);
        if (!previous || time - previous.time >= 1500)
          history.push({
            time,
            step: status.learner.step || 0,
            loss: status.learner.loss ?? null,
            rows: status.totals.rows,
            matches: status.totals.matches,
          });
        while (history.length > 900) history.shift();
        const oldest = history.find((s) => time - s.time < 60000) || history[0],
          seconds = (time - oldest.time) / 1000;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(
          JSON.stringify({
            ...status,
            hardware,
            history,
            rates: {
              samplesPerSecond: seconds > 0 ? (status.totals.rows - oldest.rows) / seconds : null,
              matchesPerMinute:
                seconds > 0 ? (60 * (status.totals.matches - oldest.matches)) / seconds : null,
              updatesPerSecond:
                seconds > 0 ? ((status.learner.step || 0) - oldest.step) / seconds : null,
            },
          }),
        );
      }
      if (!files[pathname]) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const [file, type] = files[pathname];
      res.setHeader('Content-Type', type + '; charset=utf-8');
      res.end(readFileSync(join(assets, file)));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.on('close', () => {
    clearInterval(cpuTimer);
    clearInterval(gpuTimer);
  });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = option('run', 'ai/guanzero/runs/guanzero-adp'),
    port = Number(option('port', '8770'));
  createDashboardServer({ run }).listen(port, '127.0.0.1', () =>
    console.log(`GuanZero dashboard: http://127.0.0.1:${port}`),
  );
}
