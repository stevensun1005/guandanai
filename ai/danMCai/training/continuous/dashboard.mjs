/** Read-only local dashboard; independent of the frozen training processes. */
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, readJSON, runPaths } from './lib.mjs';
import { actorTotals } from './remote.mjs';

const project = fileURLToPath(new URL('../../../..', import.meta.url));
const rateSamples = [];
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
  const running =
    !status.stoppedAt && supervisorAlive && Number.isFinite(heartbeatAge) && heartbeatAge < 90;
  // Count every actor file, so machines sampling into the shared folder are included.
  const sampled = actorTotals(paths.actors);
  // Actors started through remote-actors.mjs (other machines or fast actors on this one) are not
  // in the supervisor's process list; show the ones that are alive or wrote progress recently.
  const extraActors = sampled.slots
    .filter((slot) => slot >= (config.actors || 0))
    .map((slot) => {
      const actor = readJSON(join(paths.actors, `actor-${slot}.json`), {});
      const age = (Date.now() - Date.parse(actor.updatedAt)) / 1000;
      return {
        name: `actor-${slot}`,
        implementation: actor.actorImplementation || 'standard',
        alive: alive(actor.pid) || age < 180,
      };
    })
    .filter((actor) => actor.alive);
  // The supervisor's rate covers its own slots only, so measure all slots over a rolling window.
  const now = Date.now();
  rateSamples.push({ t: now, decisions: sampled.decisions, step: learner.step || 0 });
  while (rateSamples.length > 2 && now - rateSamples[0].t > 120_000) rateSamples.shift();
  const oldest = rateSamples[0];
  const samplingRate =
    now - oldest.t >= 20_000
      ? ((sampled.decisions - oldest.decisions) * 1000) / (now - oldest.t)
      : null;
  const learnerRate =
    now - oldest.t >= 20_000 && (learner.step || 0) >= oldest.step
      ? (((learner.step || 0) - oldest.step) * 1000) / (now - oldest.t)
      : null;
  const liveTotals = sampled.slots.length
    ? { matches: sampled.matches, decisions: sampled.decisions, rows: sampled.rows }
    : status.totals || {};
  const reporter = readJSON(join(workspace, 'ai/danMCai/runs/reporter-launcher.json'), {});
  const evidence =
    readJSON(
      join(
        workspace,
        'ai/danMCai/workspace/worktrees/model-study/ai/research/evaluation/model-study-progress.json',
      ),
    ) || readJSON(join(workspace, 'ai/research/evaluation/model-study-progress.json'), {});
  const deviceRuns = [];
  const continuousRoot = join(workspace, 'ai/danMCai/runs');
  for (const directory of readdirSync(continuousRoot, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const root = join(continuousRoot, directory.name);
    if (resolve(root) === paths.root) continue;
    const otherConfig = readJSON(join(root, 'config.json'));
    if (!otherConfig?.learner?.device || otherConfig.learner.device === 'cpu') continue;
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
  const publications = text(join(workspace, 'ai/danMCai/runs/reporter.stdout.log'))
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
    independentEvaluation: readJSON(
      join(workspace, 'ai/danMCai/workspace/evaluations/progress.json'),
    ),
    resources: status.resources || null,
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
    elapsedSeconds: (status.elapsedSeconds || 0) + (running ? Math.max(0, heartbeatAge) : 0),
    plannedHours: launcher.hours || null,
    totals: liveTotals,
    device: config.learner?.device || 'cpu',
    cpuBaseline:
      resolve(join(continuousRoot, 'main')) !== paths.root
        ? readJSON(join(continuousRoot, 'main/status.json'))
        : null,
    actorCount: config.actors,
    actorImplementation: config.actorImplementation || 'standard',
    protocolChanges: (config.protocolHistory || []).map(({ at, reason }) => ({ at, reason })),
    deviceRuns,
    anchorHours: config.anchor?.intervalHours || 3,
    decisionsPerSecond: samplingRate ?? status.decisionsPerSecond,
    learnerUpdatesPerSecond: learnerRate,
    extraActorCount: extraActors.length,
    fastActorCount: extraActors.filter((a) => a.implementation === 'fast').length,
    processes: (status.running || [])
      .map((name) => {
        const child =
          name === 'learner'
            ? learner
            : name.startsWith('actor-')
              ? readJSON(join(paths.actors, `${name}.json`), {})
              : null;
        return {
          name,
          alive: child ? alive(child.pid) : null,
          ...(child?.actorImplementation ? { implementation: child.actorImplementation } : {}),
        };
      })
      .concat(running ? extraActors : []),
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
  const primary = existsSync('ai/danMCai/runs/gpu-main/config.json')
    ? 'ai/danMCai/runs/gpu-main'
    : 'ai/danMCai/runs/main';
  createDashboardServer({
    run: option('run', primary),
    workspace: resolve(option('workspace', project)),
  }).listen(port, '127.0.0.1', () => console.log(`Training dashboard: http://127.0.0.1:${port}`));
}
