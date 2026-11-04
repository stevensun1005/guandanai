/** Read-only local dashboard; independent of the frozen training processes. */
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, readJSON, runPaths } from './lib.mjs';

const project = fileURLToPath(new URL('../..', import.meta.url));
const assets = fileURLToPath(new URL('./dashboard/', import.meta.url));
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const text = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return '';
  }
};

export function dashboardSnapshot(run, workspace = project) {
  const paths = runPaths(run);
  const status = readJSON(paths.status);
  const config = readJSON(paths.config);
  if (!status || !config) throw Error('运行尚未生成状态文件');
  const launcher = readJSON(join(paths.root, 'launcher.json'), {});
  const learner = readJSON(join(paths.learner, 'status.json'), status.learner || {});
  const heartbeatAge = (Date.now() - Date.parse(status.updatedAt)) / 1000;
  const supervisorAlive = alive(status.pid);
  const reporter = readJSON(join(workspace, 'work/continuous/reporter-launcher.json'), {});
  const evidence =
    readJSON(join(workspace, 'work/model-study/docs/evaluation/model-study-progress.json')) ||
    readJSON(join(workspace, 'docs/evaluation/model-study-progress.json'), {});
  const deviceRuns = [];
  const continuousRoot = join(workspace, 'work/continuous');
  for (const directory of readdirSync(continuousRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const root = join(continuousRoot, directory.name);
    const otherConfig = readJSON(join(root, 'config.json'));
    if (!otherConfig?.learner.device || otherConfig.learner.device === 'cpu') continue;
    const other = readJSON(join(root, 'status.json'), {});
    const learning = readJSON(join(root, 'learner/status.json'), {});
    const fresh = Date.now() - Date.parse(other.updatedAt) < 90_000;
    deviceRuns.push({
      name: directory.name,
      device: learning.device || otherConfig.learner.device,
      deviceName: learning.deviceName || '等待设备状态',
      phase: other.stoppedAt ? 'stopped' : alive(other.pid) && fresh ? 'running' : 'unconfirmed',
      elapsedSeconds: other.elapsedSeconds || 0,
      totals: other.totals || {},
      step: learning.step || 0,
      learnerState: learning.state,
      gpuAllocatedBytes: learning.gpuAllocatedBytes,
      actorCount: otherConfig.actors,
    });
  }
  const publications = text(join(workspace, 'work/continuous/reporter.stdout.log'))
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {};
      }
    });
  const lastPublication = publications.findLast((entry) => entry.published === true);
  const evaluations = ['gate', 'anchor'].flatMap((kind) =>
    readdirSync(paths[kind])
      .filter((name) => new RegExp(`^${kind}-\\d+\\.json$`).test(name))
      .sort()
      .slice(-5)
      .map((name) => {
        const report = readJSON(join(paths[kind], name));
        return {
          kind,
          status: report.status,
          challenger: report.challenger.version,
          opponent: report.champion.version,
          pairs: report.pairs.length,
          maxPairs: report.settings.maxPairs,
          wins: report.wins,
          losses: report.losses,
          draws: report.draws,
          score: report.meanScore ?? null,
          interval: report.clusterHoeffding95CI ?? null,
          decision: report.status === 'complete' ? report.decision : null,
        };
      }),
  );
  return {
    observedAt: new Date().toISOString(),
    run: paths.root,
    phase: status.stoppedAt
      ? 'stopped'
      : supervisorAlive && Number.isFinite(heartbeatAge) && heartbeatAge < 90
        ? 'running'
        : 'unconfirmed',
    heartbeatAge,
    supervisorAlive,
    updatedAt: status.updatedAt,
    startedAt: status.startedAt,
    stoppedAt: status.stoppedAt || null,
    stopReason: status.stopReason || null,
    elapsedSeconds: status.elapsedSeconds || 0,
    plannedHours: launcher.hours || null,
    totals: status.totals || {},
    actorCount: config.actors,
    deviceRuns,
    anchorHours: config.anchor?.intervalHours || 3,
    decisionsPerSecond: status.decisionsPerSecond,
    processes: (status.running || []).map((name) => {
      const child =
        name === 'learner'
          ? learner
          : name.startsWith('actor-')
            ? readJSON(join(paths.actors, `${name}.json`), {})
            : null;
      return { name, alive: child ? alive(child.pid) : null };
    }),
    learner,
    latest: status.latest,
    champion: status.champion,
    diskGB: status.diskGB,
    anchorRegressionStreak: status.anchorRegressionStreak || 0,
    nextAnchorAt: status.lastAnchorAt + (config.anchor?.intervalHours || 3) * 3600000,
    evaluations,
    publication: {
      reporterAlive: alive(reporter.pid),
      snapshotAt: evidence.observedUTC || null,
      confirmed: Boolean(lastPublication && lastPublication.fingerprint === evidence.fingerprint),
      intervalSeconds: reporter.intervalSeconds || null,
    },
    events: text(paths.events)
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(-8)
      .map((line) => JSON.parse(line)),
  };
}

export function createDashboardServer({ run, workspace = project }) {
  const staticFiles = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  };
  return createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'",
    );
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      return response.end('Read only');
    }
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api/status') {
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        return response.end(JSON.stringify(dashboardSnapshot(run, workspace)));
      }
      const file = staticFiles[pathname];
      if (!file) {
        response.writeHead(404);
        return response.end('Not found');
      }
      response.setHeader('Content-Type', file[1]);
      response.end(readFileSync(join(assets, file[0])));
    } catch (error) {
      response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(option('port', '8766'));
  createDashboardServer({
    run: option('run', 'work/continuous/main'),
    workspace: resolve(option('workspace', project)),
  }).listen(port, '127.0.0.1', () => console.log(`Training dashboard: http://127.0.0.1:${port}`));
}
