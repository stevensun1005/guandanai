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
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { freemem, constants as osConstants, setPriority } from 'node:os';
import { memoryAction } from './resources.mjs';
import { actorTotals as allActorTotals } from './remote.mjs';
import {
  DEFAULT_CONFIG,
  MAX_ACTORS,
  anchorRegression,
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
// Resuming an existing run with different sources or sampler settings is refused unless the
// operator names the change; it is then recorded in config.protocolHistory and events.jsonl.
const protocolChange = option('protocol-change', '');
const protocolSettings = JSON.parse(option('set', '{}'));
if (!Number.isFinite(hours) || hours < 0) throw Error('Invalid hours');
const sourceFiles = [
  ...[
    'supervisor.mjs',
    'actor.mjs',
    'gate.mjs',
    'lib.mjs',
    'learner.py',
    'value_net.py',
    'fast-actor.mjs',
    'batch-inference.mjs',
    'inference-worker.mjs',
    'fast-candidates.mjs',
    'fast-rollout.mjs',
    'onnx-rows.mjs',
    'resources.mjs',
    'remote.mjs',
  ].map((f) => `scripts/continuous/${f}`),
  ...['match-rollout.mjs', 'match-simulation.mjs', 'simulation.mjs', 'rule-baseline.mjs'].map(
    (f) => `scripts/lib/${f}`,
  ),
  ...['cards.js', 'combinations.js', 'moves.js', 'match.js', 'tribute.js'].map(
    (f) => `src/core/${f}`,
  ),
  ...[
    'candidates.js',
    'encoding.mjs',
    'observation.js',
    'rule-policy.js',
    'hand-value.js',
    'habits.js',
  ].map((f) => `src/ai/${f}`),
  'src/hand/arrangement.js',
  'src/hand/hints.js',
  'package-lock.json',
];
function sourceHashes() {
  return Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(resolve(here, '../..', file), 'utf8').replaceAll('\r\n', '\n'))
        .digest('hex'),
    ]),
  );
}
const sourcesAtStart = sourceHashes();

/** Only sampler settings may change through --set; everything else stays frozen. */
function validateProtocolSettings(settings) {
  const allowed = new Set(['actors', 'actorImplementation', 'fastActor', 'resourceBudget']);
  for (const key of Object.keys(settings))
    if (!allowed.has(key)) throw Error(`--set cannot change ${key}`);
  if (
    'actors' in settings &&
    (!Number.isInteger(settings.actors) || settings.actors < 1 || settings.actors > MAX_ACTORS)
  )
    throw Error('Invalid actor count');
  if ('resourceBudget' in settings) {
    const { reserveGB, resumeGB, ...rest } = settings.resourceBudget || {};
    if (
      Object.keys(rest).length ||
      !Number.isFinite(reserveGB) ||
      reserveGB < 2 ||
      !Number.isFinite(resumeGB) ||
      resumeGB <= reserveGB
    )
      throw Error('Invalid memory reserve');
  }
  if (
    'actorImplementation' in settings &&
    !['standard', 'fast'].includes(settings.actorImplementation)
  )
    throw Error('actorImplementation must be standard or fast');
  if ('fastActor' in settings) {
    const { games, provider, ...rest } = settings.fastActor || {};
    if (Object.keys(rest).length) throw Error('fastActor accepts games and provider only');
    if (games !== undefined && (!Number.isInteger(games) || games < 1 || games > 512))
      throw Error('fastActor.games must be 1-512');
    if (provider !== undefined && !['dml', 'cpu'].includes(provider))
      throw Error('fastActor.provider must be dml or cpu');
  }
}

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
    config.sourceSHA256 = sourcesAtStart;
    config.sourceHashConvention = 'UTF-8 text with CRLF normalized to LF';
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
      history: [
        {
          version: 'v000000000',
          sha256: config.initialSHA256,
          at: config.createdAt,
          reason: 'initial',
        },
      ],
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
  const sourcesChanged =
    config.sourceSHA256 && JSON.stringify(config.sourceSHA256) !== JSON.stringify(sourcesAtStart);
  if (protocolChange && (sourcesChanged || Object.keys(protocolSettings).length)) {
    validateProtocolSettings(protocolSettings);
    const previous = {
      sourceSHA256: config.sourceSHA256,
      actors: config.actors,
      resourceBudget: config.resourceBudget || null,
      actorImplementation: config.actorImplementation || 'standard',
      fastActor: config.fastActor || null,
    };
    const status = readJSON(paths.status, {}) || {};
    config = merge(config, protocolSettings);
    config.sourceSHA256 = sourcesAtStart;
    config.protocolHistory = [
      ...(config.protocolHistory || []),
      {
        at: new Date().toISOString(),
        reason: protocolChange,
        elapsedSecondsBefore: status.elapsedSeconds ?? null,
        totalsBefore: status.totals ?? null,
        learnerStepBefore: status.learner?.step ?? null,
        previous,
        settings: protocolSettings,
        changedSources: Object.keys({ ...previous.sourceSHA256, ...sourcesAtStart }).filter(
          (file) => previous.sourceSHA256?.[file] !== sourcesAtStart[file],
        ),
      },
    ];
    writeJSON(paths.config, config);
    event('protocol-change', config.protocolHistory.at(-1));
  }
  if (!Number.isInteger(config.actors) || config.actors < 1 || config.actors > MAX_ACTORS)
    throw Error('Invalid actor count');
  const evaluationOffset = config.evaluationBlockOffset ?? 0;
  if (!Number.isInteger(evaluationOffset) || evaluationOffset < 0 || evaluationOffset >= 1000)
    throw Error('Invalid evaluation seed block offset');
  if (config.sourceSHA256 && JSON.stringify(config.sourceSHA256) !== JSON.stringify(sourcesAtStart))
    throw Error('Run source changed; use a new run directory to keep protocols separate');
  return config;
}

const config = initialize();
const state = readJSON(paths.status, {}) || {};
state.gateIndex ??= config.evaluationBlockOffset ?? 0;
state.lastSnapshotAt ??= 0;
state.gates ??= [];
state.resultOffsets ??= {};
state.anchorIndex ??= config.evaluationBlockOffset ?? 0;
state.anchorChecks ??= [];
state.anchorRegressionStreak ??= 0;
state.lastAnchorAt ??= Date.now();
state.startedAt ??= new Date().toISOString();
const elapsedBeforeStart = state.elapsedSeconds || 0;
state.pid = process.pid;
delete state.stoppedAt;
delete state.stopReason;
const anchorSettings = config.anchor || DEFAULT_CONFIG.anchor;
if (
  !Number.isFinite(anchorSettings.intervalHours) ||
  anchorSettings.intervalHours <= 0 ||
  anchorSettings.pairs !== 150 ||
  !Number.isInteger(anchorSettings.regressionLimit) ||
  anchorSettings.regressionLimit < 2
)
  throw Error('Invalid anchor monitor configuration');
const children = new Map();
const memoryPaused = new Set();
const resourceBudget = config.resourceBudget || { reserveGB: 4, resumeGB: 5 };
let lastMemoryAction = 0;
const crashes = new Map();
let stopping = false;
const started = Date.now();
function persistState() {
  state.elapsedSeconds = elapsedBeforeStart + (Date.now() - started) / 1000;
  state.updatedAt = new Date().toISOString();
  writeJSON(paths.status, { ...readJSON(paths.status, {}), ...state });
}

function launch(name, command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    cwd: resolve(here, '../..'),
  });
  if (child.pid) {
    try {
      setPriority(child.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
    } catch (error) {
      event('priority-warning', { name, message: error.message });
    }
  }
  let tail = '';
  child.stderr.on('data', (chunk) => (tail = (tail + chunk).slice(-4000)));
  child.on('error', (error) => {
    children.delete(name);
    event('stop', { reason: `${name} could not start: ${error.message}` });
    shutdown(1, 'spawn-error');
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    const operatorStop = existsSync(paths.stop);
    if (stopping || operatorStop || name === 'gate' || name === 'anchor') {
      try {
        if (name === 'gate') finishGate(code, tail);
        if (name === 'anchor') finishAnchor(code, tail);
      } catch (error) {
        event('stop', { reason: `Invalid evaluation result: ${error.message}` });
        shutdown(1, 'invalid-evaluation');
      }
      if (operatorStop && !stopping) shutdown(0, 'operator-stop');
      return;
    }
    if (memoryPaused.has(name)) {
      event('memory-pause-complete', { name });
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
      shutdown(1, 'crash-limit');
      return;
    }
    setTimeout(() => !stopping && start(name), Math.min(60000, 2000 * 2 ** (recent.length - 1)));
  });
  children.set(name, child);
}

function start(name) {
  if (memoryPaused.has(name)) return;
  if (name === 'learner')
    launch(name, python, ['-u', join(here, 'learner.py'), `--run=${paths.root}`]);
  else {
    const slot = Number(name.slice('actor-'.length));
    const fast = config.actorImplementation === 'fast';
    const pauseFile = join(paths.root, `PAUSE-${name}`);
    if (existsSync(pauseFile)) unlinkSync(pauseFile);
    launch(
      name,
      process.execPath,
      fast
        ? [
            join(here, 'fast-actor.mjs'),
            `--run=${paths.root}`,
            `--slot=${slot}`,
            `--games=${config.fastActor?.games ?? 48}`,
            `--provider=${config.fastActor?.provider ?? 'dml'}`,
            `--stop-file=${pauseFile}`,
          ]
        : [join(here, 'actor.mjs'), `--run=${paths.root}`, `--slot=${slot}`],
    );
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
  persistState(); // A crash must never reuse an evaluation seed block.
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
    `--challenger-version=${candidate.id}`,
    `--champion-version=${champion.version}`,
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
    decision:
      code === 0 && report?.status === 'complete' && report.pairs?.length >= config.gate.minPairs
        ? report.decision
        : null,
    pairs: report?.pairs?.length ?? 0,
    wins: report?.wins ?? 0,
    losses: report?.losses ?? 0,
    draws: report?.draws ?? 0,
    llr: report?.test?.llr ?? null,
    finishedAt: new Date().toISOString(),
  };
  state.gates.push(summary);
  persistState();
  event('gate-finish', code ? { ...summary, stderr: stderr.slice(-1500) } : summary);
  if (summary.decision !== 'accept') return;
  const league = readJSON(paths.leagueMeta);
  const member = league.members.find((m) => m.id === job.challenger);
  if (!member || !existsSync(join(paths.league, member.file))) return;
  copyFileSync(join(paths.league, member.file), join(paths.champion, 'champion.onnx'));
  const meta = readJSON(paths.championMeta);
  meta.history.push({
    version: member.id,
    sha256: member.sha256,
    at: summary.finishedAt,
    gate: job.index,
  });
  Object.assign(meta, { version: member.id, sha256: member.sha256, since: summary.finishedAt });
  writeJSON(paths.championMeta, meta);
  member.pinned = true; // champions stay in the league as permanent opponents
  writeJSON(paths.leagueMeta, league);
  event('champion', { version: member.id, gate: job.index });
}

let anchorJob = null;
function startAnchor() {
  const latest = readJSON(paths.latest);
  if (!latest?.step) return;
  const index = state.anchorIndex++;
  persistState();
  const challengerCopy = join(paths.anchor, `challenger-${index}.onnx`);
  copyFileSync(join(paths.models, latest.file), challengerCopy);
  anchorJob = {
    index,
    challenger: latest.version,
    sha256: sha256(challengerCopy),
    challengerCopy,
    output: join(paths.anchor, `anchor-${String(index).padStart(5, '0')}.json`),
  };
  launch('anchor', process.execPath, [
    join(here, 'gate.mjs'),
    `--run=${paths.root}`,
    '--kind=anchor',
    `--challenger=${challengerCopy}`,
    `--champion=${join(paths.models, 'anchor.onnx')}`,
    `--challenger-version=${latest.version}`,
    '--champion-version=P0-anchor',
    `--index=${index}`,
    `--output=${anchorJob.output}`,
    '--settings={"minPairs":150,"maxPairs":150}',
  ]);
  event('anchor-start', anchorJob);
}

function finishAnchor(code, stderr) {
  const job = anchorJob;
  anchorJob = null;
  if (!job) return;
  const report = readJSON(job.output);
  rmSync(job.challengerCopy, { force: true });
  const complete =
    code === 0 &&
    report?.status === 'complete' &&
    report.kind === 'anchor' &&
    report.pairs?.length === 150 &&
    report.challenger.sha256 === job.sha256 &&
    report.champion.sha256 === config.initialSHA256;
  const trend = anchorRegression(
    state.anchorRegressionStreak,
    complete ? report : null,
    anchorSettings.regressionLimit,
  );
  state.anchorRegressionStreak = trend.streak;
  state.lastAnchorAt = Date.now();
  const summary = {
    index: job.index,
    challenger: job.challenger,
    challengerSHA256: job.sha256,
    anchorSHA256: config.initialSHA256,
    status: complete ? 'complete' : 'incomplete',
    code,
    pairs: report?.pairs?.length || 0,
    wins: report?.wins || 0,
    losses: report?.losses || 0,
    draws: report?.draws || 0,
    meanScore: complete ? report.meanScore : null,
    clusterHoeffding95CI: complete ? report.clusterHoeffding95CI : null,
    regressionStreak: trend.streak,
    finishedAt: new Date().toISOString(),
  };
  state.anchorChecks.push(summary);
  persistState();
  event('anchor-finish', code ? { ...summary, stderr: stderr.slice(-1500) } : summary);
  if (!stopping && trend.stop) {
    const reason = `${trend.streak} consecutive complete anchor checks have 95% upper bounds below 0.5`;
    event('stop', { reason, code: 'anchor-regression' });
    shutdown(1, 'anchor-regression');
  }
}

function diskUsageGB() {
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          bytes += statSync(full).size;
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  };
  walk(paths.root);
  return bytes / 1e9;
}

let previousDecisions = null;
function actorTotals() {
  const { slots, ...totals } = allActorTotals(paths.actors);
  return totals;
}
function memoryTick() {
  if (stopping) return;
  const freeBytes = freemem();
  const running = [...children.keys()].filter((name) => name.startsWith('actor-'));
  const action =
    config.actorImplementation === 'fast'
      ? memoryAction({
          freeBytes,
          ...resourceBudget,
          running,
          paused: [...memoryPaused],
          lastActionAt: lastMemoryAction,
        })
      : null;
  if (action) {
    lastMemoryAction = Date.now();
    if (action.type === 'pause') {
      memoryPaused.add(action.actor);
      writeJSON(join(paths.root, `PAUSE-${action.actor}`), {
        reason: 'memory reserve',
        at: new Date().toISOString(),
      });
    } else {
      memoryPaused.delete(action.actor);
      start(action.actor);
    }
    event(`memory-${action.type}`, {
      actor: action.actor,
      freeGB: freeBytes / 1024 ** 3,
      ...resourceBudget,
    });
  }
  state.resources = {
    ...resourceBudget,
    freeGB: freeBytes / 1024 ** 3,
    pausedActors: [...memoryPaused],
    updatedAt: new Date().toISOString(),
  };
  writeJSON(paths.status, { ...readJSON(paths.status, {}), resources: state.resources });
}
function tick() {
  if (stopping) return;
  if (existsSync(paths.stop)) return shutdown(0);
  if (JSON.stringify(sourceHashes()) !== JSON.stringify(sourcesAtStart)) {
    event('stop', { reason: 'sampling or learning source changed during the run' });
    return shutdown(1, 'source-changed');
  }
  if (hours && Date.now() - started > hours * 3600000) {
    event('stop', { reason: `time limit ${hours}h reached` });
    return shutdown(0, 'time-limit');
  }
  const totals = updateLeague();
  if (Date.now() - state.lastSnapshotAt >= config.snapshotMinutes * 60000) snapshot();
  if (!children.has('gate') && !children.has('anchor')) {
    if (Date.now() - state.lastAnchorAt >= anchorSettings.intervalHours * 3600000) startAnchor();
    else startGate();
  }
  const disk = diskUsageGB();
  if (disk > config.diskLimitGB) {
    event('stop', { reason: `disk usage ${disk.toFixed(1)} GB over limit` });
    return shutdown(1, 'disk-limit');
  }
  const currentTotals = actorTotals();
  const decisions = currentTotals.decisions;
  const now = Date.now();
  const rate = previousDecisions
    ? (decisions - previousDecisions.value) / ((now - previousDecisions.at) / 1000)
    : null;
  previousDecisions = { value: decisions, at: now };
  state.recent = totals;
  state.elapsedSeconds = elapsedBeforeStart + (Date.now() - started) / 1000;
  writeJSON(paths.status, {
    ...state,
    pid: process.pid,
    running: [...children.keys()],
    updatedAt: new Date().toISOString(),
    diskGB: Number(disk.toFixed(2)),
    decisionsPerSecond: rate && Number(rate.toFixed(1)),
    totals: currentTotals,
    latest: readJSON(paths.latest),
    champion: readJSON(paths.championMeta),
    learner: readJSON(join(paths.learner, 'status.json')),
  });
}

function shutdown(code, reason = 'operator-stop') {
  if (stopping) return;
  stopping = true;
  state.stopReason = reason;
  persistState();
  event('shutdown', { code });
  writeJSON(paths.stop, { at: new Date().toISOString(), code });
  const deadline = Date.now() + 30000;
  const wait = () => {
    if (!children.size || Date.now() > deadline) {
      for (const child of children.values()) child.kill();
      writeJSON(paths.status, {
        ...readJSON(paths.status, {}),
        elapsedSeconds: elapsedBeforeStart + (Date.now() - started) / 1000,
        totals: actorTotals(),
        latest: readJSON(paths.latest),
        champion: readJSON(paths.championMeta),
        learner: readJSON(join(paths.learner, 'status.json')),
        running: [],
        updatedAt: new Date().toISOString(),
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
function guardedTick() {
  try {
    tick();
  } catch (error) {
    event('stop', { reason: String(error.stack || error) });
    shutdown(1, 'supervisor-error');
  }
}
setInterval(guardedTick, 30000);
setTimeout(guardedTick, 5000);
setInterval(() => {
  try {
    memoryTick();
  } catch (error) {
    event('memory-monitor-warning', { message: error.message });
  }
}, 5000);
