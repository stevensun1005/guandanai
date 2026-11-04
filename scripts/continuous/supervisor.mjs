/**
 * Long-running supervisor for continuous training.
 *
 * Starts the learner and N actors, restarts crashed processes, keeps the league and its PFSP
 * statistics, snapshots the latest model on a schedule and runs champion gates. Stop it with
 * Ctrl+C or by creating <run>/STOP; restarting with the same --run resumes where it left off.
 * It never edits src/ai/models.mjs: promoting a champion to the website is a separate decision.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  MAX_ACTORS,
  ensureDirs,
  option,
  readJSON,
  runPaths,
  sha256,
  writeJSON,
} from './lib.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const paths = runPaths(option('run', 'work/continuous/main'));
const hours = Number(option('hours', '0'));
const python = option('python', 'python');
const override = JSON.parse(option('config', '{}'));

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra))
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? merge(base[key] || {}, value)
        : value;
  return out;
}

function event(kind, detail = {}) {
  const record = { t: new Date().toISOString(), kind, ...detail };
  appendFileSync(paths.events, JSON.stringify(record) + '\n');
  console.log(JSON.stringify(record));
}

/** First start: freeze the configuration and publish the initial model as v0, champion and anchor. */
function initialize() {
  ensureDirs(paths);
  if (existsSync(paths.stop)) unlinkSync(paths.stop);
  let config = readJSON(paths.config);
  if (!config) {
    config = merge(DEFAULT_CONFIG, override);
    const initial = resolve(config.initial);
    config.initialSHA256 = sha256(initial);
    config.createdAt = new Date().toISOString();
    writeJSON(paths.config, config);
    copyFileSync(initial, join(paths.models, 'v000000000.onnx'));
    copyFileSync(initial, join(paths.models, 'anchor.onnx'));
    writeJSON(paths.latest, {
      version: 'v000000000',
      file: 'v000000000.onnx',
      sha256: config.initialSHA256,
      step: 0,
      publishedAt: config.createdAt,
    });
    copyFileSync(initial, join(paths.champion, 'champion.onnx'));
    writeJSON(paths.championMeta, {
      version: 'v000000000',
      sha256: config.initialSHA256,
      since: config.createdAt,
      history: [{ version: 'v000000000', at: config.createdAt, reason: 'initial' }],
    });
    copyFileSync(initial, join(paths.league, 'anchor.onnx'));
    writeJSON(paths.leagueMeta, {
      members: [
        {
          id: 'anchor',
          file: 'anchor.onnx',
          sha256: config.initialSHA256,
          addedAt: config.createdAt,
          pinned: true,
        },
      ],
      stats: {},
    });
    event('initialized', { config });
  } else if (Object.keys(override).length) {
    event('config-override-ignored', { reason: 'run already has a frozen config.json' });
  }
  if (!Number.isInteger(config.actors) || config.actors < 1 || config.actors > MAX_ACTORS)
    throw Error('Invalid actor count');
  return config;
}

const config = initialize();
const state = readJSON(paths.status, {}) || {};
state.gateIndex ??= 0;
state.lastSnapshotAt ??= 0;
state.gates ??= [];
state.resultOffsets ??= {};
const children = new Map();
const crashes = new Map();
let stopping = false;
const started = Date.now();

function launch(name, command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    cwd: resolve(here, '../..'),
  });
  let tail = '';
  child.stderr.on('data', (chunk) => (tail = (tail + chunk).slice(-4000)));
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping || name === 'gate') {
      if (name === 'gate') finishGate(code, tail);
      return;
    }
    const now = Date.now();
    const recent = (crashes.get(name) || []).filter(
      (t) => now - t < config.restarts.windowMinutes * 60000,
    );
    recent.push(now);
    crashes.set(name, recent);
    event('process-exit', { name, code, signal, stderr: tail.slice(-1500) });
    if (recent.length > config.restarts.limit) {
      event('stop', { reason: `${name} crashed ${recent.length} times` });
      shutdown(1);
      return;
    }
    setTimeout(() => !stopping && start(name), Math.min(60000, 2000 * 2 ** (recent.length - 1)));
  });
  children.set(name, child);
}

function start(name) {
  if (name === 'learner')
    launch(name, python, ['-u', join(here, 'learner.py'), `--run=${paths.root}`]);
  else {
    const slot = Number(name.slice('actor-'.length));
    launch(name, process.execPath, [
      join(here, 'actor.mjs'),
      `--run=${paths.root}`,
      `--slot=${slot}`,
    ]);
  }
}

/** Fold new actor results into PFSP statistics (latest model vs each league member). */
function updateLeague() {
  const league = readJSON(paths.leagueMeta);
  const totals = { matches: 0, decisions: 0, byMode: {} };
  for (const file of readdirSync(paths.actors).filter((f) => f.startsWith('results-'))) {
    const full = join(paths.actors, file);
    const from = state.resultOffsets[file] || 0;
    const size = statSync(full).size;
    if (size <= from) continue;
    const buffer = Buffer.alloc(size - from);
    const fd = openSync(full, 'r');
    readSync(fd, buffer, 0, buffer.length, from);
    closeSync(fd);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) continue;
    state.resultOffsets[file] = from + end + 1;
    const complete = buffer.subarray(0, end).toString('utf8').split('\n');
    for (const line of complete) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.error) continue;
      totals.matches++;
      totals.decisions += r.decisions;
      const mode = (totals.byMode[r.mode] ||= { matches: 0, wins: 0, draws: 0 });
      mode.matches++;
      if (r.winner === null) mode.draws++;
      else if (r.winner === r.team) mode.wins++;
      if (r.mode !== 'league') continue;
      const s = (league.stats[r.opponent] ||= { games: 0, wins: 0, draws: 0 });
      // Exponential forgetting keeps PFSP tracking the current model rather than its ancestors.
      for (const key of ['games', 'wins', 'draws']) s[key] *= 0.995;
      s.games++;
      if (r.winner === null) s.draws++;
      else if (r.winner === r.team) s.wins++;
    }
  }
  writeJSON(paths.leagueMeta, league);
  return totals;
}

function snapshot() {
  const latest = readJSON(paths.latest);
  const league = readJSON(paths.leagueMeta);
  if (latest.step === 0 || league.members.some((m) => m.id === latest.version)) return null;
  const file = `${latest.version}.onnx`;
  copyFileSync(join(paths.models, latest.file), join(paths.league, file));
  league.members.push({
    id: latest.version,
    file,
    sha256: latest.sha256,
    step: latest.step,
    addedAt: new Date().toISOString(),
  });
  while (league.members.length > config.leagueSize) {
    const index = league.members.findIndex((m) => !m.pinned);
    if (index < 0) break;
    const [removed] = league.members.splice(index, 1);
    rmSync(join(paths.league, removed.file), { force: true });
    delete league.stats[removed.id];
  }
  writeJSON(paths.leagueMeta, league);
  state.lastSnapshotAt = Date.now();
  event('snapshot', { version: latest.version, step: latest.step });
  return latest.version;
}

let gateJob = null;
function startGate() {
  const league = readJSON(paths.leagueMeta);
  const champion = readJSON(paths.championMeta);
  const gated = new Set(state.gates.map((g) => g.challenger));
  const candidate = [...league.members]
    .reverse()
    .find((m) => !m.pinned && !gated.has(m.id) && m.id !== champion.version);
  if (!candidate) return;
  const index = state.gateIndex++;
  const output = join(paths.gate, `gate-${String(index).padStart(5, '0')}.json`);
  // Copy the champion so a promotion during the gate cannot change the file under test.
  const championCopy = join(paths.gate, `champion-${index}.onnx`);
  copyFileSync(join(paths.champion, 'champion.onnx'), championCopy);
  gateJob = { index, challenger: candidate.id, champion: champion.version, output, championCopy };
  launch('gate', process.execPath, [
    join(here, 'gate.mjs'),
    `--run=${paths.root}`,
    `--challenger=${join(paths.league, candidate.file)}`,
    `--champion=${championCopy}`,
    `--index=${index}`,
    `--output=${output}`,
  ]);
  event('gate-start', gateJob);
}

function finishGate(code, stderr) {
  const job = gateJob;
  gateJob = null;
  if (!job) return;
  rmSync(job.championCopy, { force: true });
  const report = readJSON(job.output);
  if (stopping || report?.status === 'stopped') {
    state.gateIndex = Math.max(state.gateIndex, job.index + 1);
    event('gate-interrupted', { index: job.index, challenger: job.challenger });
    return;
  }
  const summary = {
    index: job.index,
    challenger: job.challenger,
    champion: job.champion,
    code,
    decision: report?.decision ?? null,
    pairs: report?.pairs.length ?? 0,
    wins: report?.wins ?? 0,
    losses: report?.losses ?? 0,
    draws: report?.draws ?? 0,
    llr: report?.test?.llr ?? null,
    finishedAt: new Date().toISOString(),
  };
  state.gates.push(summary);
  event('gate-finish', code ? { ...summary, stderr: stderr.slice(-1500) } : summary);
  if (summary.decision !== 'accept') return;
  const league = readJSON(paths.leagueMeta);
  const member = league.members.find((m) => m.id === job.challenger);
  if (!member || !existsSync(join(paths.league, member.file))) return;
  copyFileSync(join(paths.league, member.file), join(paths.champion, 'champion.onnx'));
  const meta = readJSON(paths.championMeta);
  meta.history.push({ version: member.id, at: summary.finishedAt, gate: job.index });
  Object.assign(meta, { version: member.id, sha256: member.sha256, since: summary.finishedAt });
  writeJSON(paths.championMeta, meta);
  member.pinned = true; // champions stay in the league as permanent opponents
  writeJSON(paths.leagueMeta, league);
  event('champion', { version: member.id, gate: job.index });
}

function diskUsageGB() {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes += statSync(full).size;
    }
  };
  walk(paths.root);
  return bytes / 1e9;
}

let previousDecisions = null;
function tick() {
  if (stopping) return;
  if (existsSync(paths.stop)) return shutdown(0);
  if (hours && Date.now() - started > hours * 3600000) {
    event('stop', { reason: `time limit ${hours}h reached` });
    return shutdown(0);
  }
  const totals = updateLeague();
  if (Date.now() - state.lastSnapshotAt >= config.snapshotMinutes * 60000) snapshot();
  if (!children.has('gate')) startGate();
  const disk = diskUsageGB();
  if (disk > config.diskLimitGB) {
    event('stop', { reason: `disk usage ${disk.toFixed(1)} GB over limit` });
    return shutdown(1);
  }
  const actors = Array.from({ length: config.actors }, (_, slot) =>
    readJSON(join(paths.actors, `actor-${slot}.json`), {}),
  );
  const decisions = actors.reduce((n, a) => n + (a.decisions || 0), 0);
  const now = Date.now();
  const rate = previousDecisions
    ? (decisions - previousDecisions.value) / ((now - previousDecisions.at) / 1000)
    : null;
  previousDecisions = { value: decisions, at: now };
  state.recent = totals;
  writeJSON(paths.status, {
    ...state,
    pid: process.pid,
    running: [...children.keys()],
    updatedAt: new Date().toISOString(),
    diskGB: Number(disk.toFixed(2)),
    decisionsPerSecond: rate && Number(rate.toFixed(1)),
    totals: {
      matches: actors.reduce((n, a) => n + (a.matches || 0), 0),
      decisions,
      rows: actors.reduce((n, a) => n + (a.rows || 0), 0),
    },
    latest: readJSON(paths.latest),
    champion: readJSON(paths.championMeta),
    learner: readJSON(join(paths.learner, 'status.json')),
  });
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  event('shutdown', { code });
  writeJSON(paths.stop, { at: new Date().toISOString(), code });
  const deadline = Date.now() + 30000;
  const wait = () => {
    if (!children.size || Date.now() > deadline) {
      for (const child of children.values()) child.kill();
      writeJSON(paths.status, {
        ...readJSON(paths.status, {}),
        running: [],
        stoppedAt: new Date().toISOString(),
      });
      process.exit(code);
    }
    setTimeout(wait, 500);
  };
  wait();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
event('start', { actors: config.actors, hours: hours || null, pid: process.pid });
start('learner');
for (let slot = 0; slot < config.actors; slot++) start(`actor-${slot}`);
setInterval(tick, 30000);
setTimeout(tick, 5000);
