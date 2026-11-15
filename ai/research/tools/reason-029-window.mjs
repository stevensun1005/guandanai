/** One owner-authorized 029/belief-adaptation window; old experiments are read-only. */
import { fork, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import {
  option,
  readJSON,
  writeJSON,
  sha256,
  createModelPool,
} from '../../danMCai/training/continuous/lib.mjs';
import {
  createReasonBot,
  emptyTally,
  searchSeedOf,
} from '../../danMCai/belief/reason-match-eval.mjs';
import { championChooser, generateBlock, writeBlock } from '../../danMCai/belief/generate.mjs';
import { featureSpec } from '../../danMCai/belief/features.mjs';
import { comparisonRound } from './compare-champion-reason.mjs';
import { SEARCH_BUDGETS } from '../../../web/src/ai/search/constants.mjs';
import { clusterInterval } from './window-dashboard.mjs';

const SELF = fileURLToPath(import.meta.url);
const pause = (ms = 1000) => new Promise((r) => setTimeout(r, ms));
const log = (root, text) =>
  appendFileSync(join(root, 'stages.log'), `${new Date().toISOString()} ${text}\n`);
const stopped = (root, end) => existsSync(join(root, 'STOP')) || Date.now() >= Date.parse(end);
const stopFile = (dir, reason) => {
  if (!existsSync(join(dir, 'STOP')))
    writeJSON(join(dir, 'STOP'), { reason, atUTC: new Date().toISOString() });
};
const session = (file) =>
  ort.InferenceSession.create(file, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    enableCpuMemArena: false,
    enableMemPattern: false,
  });

export const OWNER_WINDOWS = {
  'reason-029-20261114': {
    deadlineUTC: '2026-11-14T18:00:00.000Z',
    trainingDeadlineUTC: '2026-11-14T15:00:00.000Z',
    generationDeadlineUTC: '2026-11-14T14:45:00.000Z',
    evaluationDeadlineUTC: '2026-11-14T17:45:00.000Z',
  },
  'reason-029-continue-20261115': {
    deadlineUTC: '2026-11-15T17:00:00.000Z',
    trainingDeadlineUTC: '2026-11-15T14:00:00.000Z',
    generationDeadlineUTC: '2026-11-15T13:55:00.000Z',
    evaluationDeadlineUTC: '2026-11-15T16:45:00.000Z',
  },
};
export function validateRegistration(plan, reg, now = Date.now()) {
  const window = OWNER_WINDOWS[plan.id];
  if (
    !window ||
    Object.entries(window).some(([key, value]) => reg[key] !== value) ||
    reg.restartExtendsDeadline !== false ||
    now >= Date.parse(reg.evaluationDeadlineUTC)
  )
    throw Error('Invalid or expired fixed owner window');
}

export function segmentSeeds(plan, kind, segment, slot = 0) {
  const slots = plan.generationSlots?.[kind] || 1;
  if (!Number.isInteger(slot) || slot < 0 || slot >= slots) throw Error('Invalid generation slot');
  let all = plan.data[kind];
  if (!Array.isArray(all)) {
    if (sha256(all.localFile) !== all.sha256) throw Error('Frozen data seed file changed');
    all = readJSON(all.localFile)[kind];
  }
  const size = plan.segmentSizes[kind],
    block = kind === 'greedy' ? 25 : 5;
  return all
    .slice(segment * size, (segment + 1) * size)
    .filter((_, i) => Math.floor(i / block) % slots === slot);
}
const dataDirs = (root, plan, kind, segment) =>
  Array.from({ length: plan.generationSlots?.[kind] || 1 }, (_, slot) =>
    join(
      root,
      'segments',
      String(segment),
      'data-' + kind,
      ...((plan.generationSlots?.[kind] || 1) > 1 ? ['part-' + slot] : []),
    ),
  );
function dataSummary(root, plan, kind, segment) {
  const parts = dataDirs(root, plan, kind, segment).map((dir) =>
    readJSON(join(dir, 'summary.json')),
  );
  const record = {
    phase: parts.every((p) => p?.phase === 'complete')
      ? 'complete'
      : parts.some((p) => p?.phase === 'failed')
        ? 'failed'
        : parts.some((p) => p?.phase === 'stopped')
          ? 'stopped'
          : 'running',
    rounds: parts.reduce((n, p) => n + (p?.rounds || 0), 0),
    rows: parts.reduce((n, p) => n + (p?.rows || 0), 0),
    parts,
  };
  if (parts.length > 1) {
    mkdirSync(join(root, 'segments', String(segment), 'data-' + kind), { recursive: true });
    writeJSON(join(root, 'segments', String(segment), 'data-' + kind, 'summary.json'), record);
  }
  return parts.length > 1 ? record : parts[0];
}

function verify(root) {
  const plan = readJSON(join(root, 'protocol.json')),
    reg = readJSON(join(root, 'registration.json'));
  if (
    sha256(join(root, 'protocol.json')) !== reg.protocolSHA256 ||
    sha256(join(root, 'authorization.json')) !== reg.authorizationSHA256
  )
    throw Error('Registered protocol/authorization changed');
  for (const [file, hash] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, file)) !== hash) throw Error('Frozen source changed: ' + file);
  if (
    plan.initialCheckpoint &&
    sha256(plan.initialCheckpoint.localFile) !== plan.initialCheckpoint.sha256
  )
    throw Error('Initial checkpoint changed');
  for (const model of Object.values(plan.models))
    if (sha256(model.localFile) !== model.sha256) throw Error('Frozen weights changed');
  return { plan, reg };
}

async function checkpoint(root, end, status) {
  if (stopped(root, end)) throw Error('STOP');
  if (freemem() < 4 * 1024 ** 3) {
    status.phase = 'memory-paused';
    while (freemem() < 5 * 1024 ** 3 && !stopped(root, end)) await pause();
  }
  if (stopped(root, end)) throw Error('STOP');
}

export const playKey = (p) =>
  p
    ? `${p.type}:${p.value}:${p.n}:${p.cards
        .map((c) => c.id)
        .sort((a, b) => a - b)
        .join(',')}`
    : 'pass';

async function generate(root, kind, segment, slot = 0) {
  const { plan, reg } = verify(root),
    out = dataDirs(root, plan, kind, segment)[slot],
    spec = featureSpec('v1');
  mkdirSync(out, { recursive: true });
  if (existsSync(join(out, 'run.json')))
    throw Error('Data already started; do not replay its seeds');
  const seeds = segmentSeeds(plan, kind, segment, slot),
    blockSize = kind === 'greedy' ? 25 : 5;
  if (!Number.isInteger(segment) || segment < 0 || !seeds.length)
    throw Error('Invalid fresh-data segment');
  const previousReport = segment
    ? readJSON(join(root, 'segments', String(segment - 1), 'model/train-report.json'))
    : null;
  const beliefFile = segment
    ? join(root, 'segments', String(segment - 1), 'model/belief.onnx')
    : plan.models.belief.localFile;
  const beliefSHA256 = segment ? previousReport?.onnxSHA256 : plan.models.belief.sha256;
  if (!beliefSHA256 || sha256(beliefFile) !== beliefSHA256)
    throw Error('Segment teacher not frozen');
  const run = {
    featureVersion: spec.version,
    features: spec.features,
    targets: 162,
    layout: spec.layout,
    seeds: [Math.min(...seeds), Math.max(...seeds)],
    band: [1, 80],
    every: 2,
    temperature: 0,
    championSHA256: plan.models.champion.sha256,
    beliefSHA256: kind === 'reason' ? beliefSHA256 : null,
    policy:
      kind === 'reason'
        ? '029 + frozen v1 belief + desktop search, all four seats; no true hands in decision'
        : '029 greedy, all four seats',
    literalSeeds: seeds,
  };
  writeJSON(join(out, 'run.json'), run);
  const status = { pid: process.pid, phase: 'running', rounds: 0, rows: 0, total: seeds.length };
  const save = () =>
    writeJSON(join(out, 'summary.json'), { ...status, updatedAtUTC: new Date().toISOString() });
  let pool, champion, belief, bot, tally, roundSeed;
  try {
    let choose;
    if (kind === 'greedy') {
      pool = await createModelPool(ort, { threads: 1, limit: 1 });
      choose = championChooser((s) => pool.values(plan.models.champion.localFile, s));
    } else {
      champion = await session(plan.models.champion.localFile);
      belief = await session(beliefFile);
      const budget = { ...SEARCH_BUDGETS.desktop };
      choose = async (game, plays) => {
        await checkpoint(root, reg.generationDeadlineUTC, status);
        const play = await bot.decide(
          game,
          game.turn,
          { searchSeed: searchSeedOf(roundSeed) },
          tally,
        );
        const index = plays.findIndex((p) => playKey(p) === playKey(play));
        if (index < 0) throw Error('Search returned an illegal candidate');
        return index;
      };
      choose.startRound = (seed) => {
        if (bot) bot.engine.solver = null;
        global.gc?.();
        roundSeed = seed;
        tally = emptyTally();
        bot = createReasonBot({ ort, championSession: champion, beliefSession: belief, budget });
      };
    }
    for (let i = 0; i < seeds.length; i += blockSize) {
      await checkpoint(root, reg.generationDeadlineUTC, status);
      const blockSeeds = seeds.slice(i, i + blockSize);
      const block = await generateBlock(blockSeeds, {
        choose,
        band: [1, 80],
        every: 2,
        version: 'v1',
      });
      await checkpoint(root, reg.generationDeadlineUTC, status);
      writeBlock(out, blockSeeds[0], blockSeeds.at(-1), block, {
        literalSeeds: blockSeeds,
        dataUse: 'belief training/seed-mod10 validation only',
      });
      status.rounds += blockSeeds.length;
      status.rows += block.rows;
      status.phase = 'running';
      save();
    }
    status.phase = 'complete';
  } catch (e) {
    status.phase = stopped(root, reg.generationDeadlineUTC) ? 'stopped' : 'failed';
    status.error = String(e.stack || e);
    if (status.phase === 'failed') throw e;
  } finally {
    save();
    await pool?.close();
    await champion?.release();
    await belief?.release();
  }
}

async function evaluate(root, taskID, slot) {
  const { plan, reg } = verify(root),
    task = plan.tasks.find((t) => t.id === taskID);
  if (!task || !task.slots.includes(slot)) throw Error('Invalid task/slot');
  const final = taskID !== 'baseline-vs-old',
    model = readJSON(join(root, 'model/train-report.json'));
  if (final && !model?.onnxSHA256) throw Error('Final model not frozen');
  if (final && sha256(join(root, 'model/belief.onnx')) !== model.onnxSHA256)
    throw Error('Final belief SHA mismatch');
  const status = {
    pid: process.pid,
    phase: 'running',
    task: taskID,
    completedPairs: 0,
    protocolSHA256: reg.protocolSHA256,
  };
  const save = () =>
    writeJSON(join(root, `worker-${slot}.json`), {
      ...status,
      updatedAtUTC: new Date().toISOString(),
    });
  const output = join(root, `worker-${slot}.jsonl`),
    sessions = [];
  if (
    existsSync(output) &&
    readFileSync(output, 'utf8')
      .split('\n')
      .some((line) => line.trim() && JSON.parse(line).task === taskID)
  )
    throw Error('Task already has output; no duplicate evaluation');
  const lock = join(root, `worker-${slot}.lock`);
  closeSync(openSync(lock, 'wx'));
  try {
    const c = await session(plan.models.champion.localFile),
      old = await session(plan.models.old.localFile),
      b = await session(plan.models.belief.localFile);
    const oldBelief = plan.models.oldBelief ? await session(plan.models.oldBelief.localFile) : b;
    if (oldBelief !== b) sessions.push(oldBelief);
    sessions.push(c, old, b);
    const f = final ? await session(join(root, 'model/belief.onnx')) : b;
    if (final) sessions.push(f);
    const budget = { ...SEARCH_BUDGETS.desktop };
    let lastStatus = 0;
    const check = async () => {
      await checkpoint(root, reg.evaluationDeadlineUTC, status);
      const left = Date.parse(reg.evaluationDeadlineUTC) - Date.now();
      budget.midgameMs = budget.endgameMs = Math.min(50000, left);
      if (Date.now() - lastStatus >= 3000) {
        save();
        lastStatus = Date.now();
      }
    };
    for (let i = task.slots.indexOf(slot); i < task.seeds.length; i += task.slots.length) {
      const seed = task.seeds[i],
        games = [];
      for (const team of [0, 1]) {
        await check();
        const challenger = createReasonBot({ ort, championSession: c, beliefSession: f, budget });
        const opponent = createReasonBot({
          ort,
          championSession: taskID === 'final-vs-baseline' ? c : old,
          beliefSession: taskID === 'final-vs-baseline' ? b : oldBelief,
          budget,
        });
        const tally = emptyTally();
        const raw = (game, p) =>
          challenger.decide(game, p, { searchSeed: searchSeedOf(seed) }, tally);
        const game = await comparisonRound({
          seed,
          team,
          raw,
          reason: opponent,
          checkpoint: check,
        });
        game.seats = [0, 1, 2, 3].map((p) => (p % 2 === team ? task.model : task.opponent));
        game.challengerSearch = tally;
        games.push(game);
        challenger.engine.solver = opponent.engine.solver = null;
        global.gc?.();
      }
      const row = { task: taskID, seed, protocolSHA256: reg.protocolSHA256, games };
      appendFileSync(output, JSON.stringify(row) + '\n');
      appendFileSync(
        join(root, 'panel', taskID, `part-${slot}.jsonl`),
        JSON.stringify({ seed, mean: games.reduce((n, g) => n + g.signedPoints, 0) / 2 }) + '\n',
      );
      status.completedPairs++;
      status.phase = 'running';
      save();
    }
    status.phase = 'complete';
  } catch (e) {
    status.phase = stopped(root, reg.evaluationDeadlineUTC) ? 'stopped' : 'failed';
    status.error = String(e.stack || e);
    if (status.phase === 'failed') throw e;
  } finally {
    save();
    for (const s of sessions) await s.release();
    unlinkSync(lock);
  }
}

async function watch(root) {
  const { reg } = verify(root);
  while (!existsSync(join(root, 'FINISHED'))) {
    let reason;
    if (
      sha256(join(root, 'protocol.json')) !== reg.protocolSHA256 ||
      sha256(join(root, 'authorization.json')) !== reg.authorizationSHA256
    )
      reason = 'registered-files-changed';
    const final = readJSON(join(root, 'final-model.json'));
    if (final && sha256(join(root, 'model/belief.onnx')) !== final.beliefSHA256)
      reason = 'final-evaluation-model-changed';
    if (reason || stopped(root, reg.evaluationDeadlineUTC))
      stopFile(root, reason || 'fixed-evaluation-cutoff');
    if (reason || stopped(root, reg.trainingDeadlineUTC))
      stopFile(join(root, 'model'), reason || 'fixed-training-cutoff');
    writeJSON(join(root, 'guardian-status.json'), {
      pid: process.pid,
      updatedAtUTC: new Date().toISOString(),
      ...reg,
    });
    if (Date.now() >= Date.parse(reg.deadlineUTC)) return;
    await pause();
  }
}

async function main(root) {
  const { plan, reg } = verify(root);
  validateRegistration(plan, reg);
  if (!readJSON(join(root, 'gpu-preflight.json'))?.passed)
    throw Error('Actual GPU preflight required');
  if (existsSync(join(root, 'STOP')) || existsSync(join(root, 'FINISHED')))
    throw Error('Closed window; no restart');
  const lock = join(root, 'controller.lock');
  closeSync(openSync(lock, 'wx'));
  mkdirSync(join(root, 'model'), { recursive: true });
  const fd = openSync(join(root, 'controller.log'), 'a'),
    children = [],
    history = [];
  let phase = 'prepare',
    activeSegment = 0,
    guardian,
    timer;
  const tick = () => {
    writeJSON(join(root, 'progress.json'), {
      pid: process.pid,
      phase,
      displayName: '029-reason：029底座＋推断网络适配',
      currentTask: phase,
      analysis: '仅真实分片、GPU更新和逐副结果；未完整验收不称提升',
      nextTask: phase.startsWith('data-')
        ? 'GPU适配推断v1，再独立比较两版reason'
        : '最终独立评测、停止审计与打包',
      deadlineUTC: reg.deadlineUTC,
      children: history,
    });
    const segmentRoot = join(root, 'segments', String(activeSegment));
    const g = dataSummary(root, plan, 'greedy', activeSegment),
      r = dataSummary(root, plan, 'reason', activeSegment),
      m = readJSON(join(segmentRoot, 'model/status.json'));
    if (m?.pid && !history.some((p) => p.pid === m.pid))
      history.push({
        pid: m.pid,
        role: 'actual GPU learner reported by status',
        segment: activeSegment,
      });
    writeJSON(join(root, 'data-panel.json'), {
      rows: [
        ['当前新样本段', activeSegment + 1],
        ['029贪心完整单局 / 样本行', `${g?.rounds || 0} / ${g?.rows || 0}`],
        ['029-reason完整单局 / 样本行', `${r?.rounds || 0} / ${r?.rows || 0}`],
        ['数据生成状态', `${g?.phase || '未开始'} / ${r?.phase || '未开始'}`],
      ],
    });
    writeJSON(join(root, 'train-panel.json'), {
      rows: [
        ['GPU实际设备', m?.device || '等待GPU阶段'],
        ['本段新增优化器更新', m?.newUpdates || 0],
        ['累计更新（含继承）', m?.step || plan.initialCheckpoint?.step || 0],
        ['训练状态', m?.phase || '排队中'],
      ],
    });
    copyFileSync(join(root, 'data-panel.json'), join(root, 'panel', `data-${activeSegment}.json`));
    copyFileSync(
      join(root, 'train-panel.json'),
      join(root, 'panel', `train-${activeSegment}.json`),
    );
    const memoryPause = join(root, 'model/MEMORY_PAUSE');
    if (phase.startsWith('train-') && freemem() < 4 * 1024 ** 3 && !existsSync(memoryPause))
      writeJSON(memoryPause, { reason: 'four-GiB-memory-reserve' });
    if (freemem() >= 5 * 1024 ** 3 && existsSync(memoryPause)) unlinkSync(memoryPause);
  };
  const run = (command, args) =>
    new Promise((ok, fail) => {
      const child = spawn(command, args, {
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, OMP_NUM_THREADS: '1', PYTHONIOENCODING: 'utf-8' },
      });
      children.push(child);
      history.push({ pid: child.pid, command, args });
      tick();
      writeJSON(join(root, 'process-history.json'), { children: history });
      child.once('error', fail);
      child.once('exit', (code) => (code === 0 ? ok() : fail(Error(command + ' exited ' + code))));
    });
  const node = (...args) =>
    run(process.execPath, [
      '--expose-gc',
      '--max-old-space-size=768',
      SELF,
      `--run=${root}`,
      ...args,
    ]);
  const stage = async (key, fn) => {
    phase = key;
    tick();
    log(root, 'START ' + key);
    try {
      await fn();
      tick();
      log(root, 'END ' + key + ' rc=0');
    } catch (e) {
      log(root, 'END ' + key + ' rc=1');
      throw e;
    }
  };
  try {
    guardian = fork(SELF, [`--run=${root}`, '--watch'], {
      windowsHide: true,
      stdio: ['ignore', fd, fd, 'ipc'],
    });
    writeJSON(join(root, 'guardian-launch.json'), { pid: guardian.pid });
    timer = setInterval(tick, 3000);
    const awake = run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(plan.sourceRoot, 'ai/research/tools/reason-029-awake.ps1'),
      '-Run',
      root,
    ]);
    // Fail closed if power protection fails; the helper exits only at FINISHED/deadline.
    awake.catch((e) => {
      stopFile(root, 'awake-helper-failed');
      writeJSON(join(root, 'awake-failure.json'), { error: String(e) });
    });
    const baseline = plan.evaluateAfterTraining
      ? null
      : stage('baseline-vs-old', () =>
          Promise.all(
            plan.tasks
              .find((t) => t.id === 'baseline-vs-old')
              .slots.map((slot) => node('--evaluate=baseline-vs-old', `--slot=${slot}`)),
          ),
        );
    baseline?.catch(() => stopFile(root, 'baseline-failed'));
    let latestModel = null;
    for (
      activeSegment = 0;
      activeSegment < plan.maxSegments && !stopped(root, reg.generationDeadlineUTC);
      activeSegment++
    ) {
      const segmentRoot = join(root, 'segments', String(activeSegment)),
        modelRoot = join(segmentRoot, 'model');
      mkdirSync(modelRoot, { recursive: true });
      await stage(`data-${activeSegment}`, () =>
        Promise.all(
          ['greedy', 'reason'].flatMap((kind) =>
            Array.from({ length: plan.generationSlots?.[kind] || 1 }, (_, slot) =>
              node(`--generate=${kind}`, `--segment=${activeSegment}`, `--generation-slot=${slot}`),
            ),
          ),
        ),
      );
      const totalRows = ['greedy', 'reason'].reduce(
        (n, k) => n + (dataSummary(root, plan, k, activeSegment)?.rows || 0),
        0,
      );
      if (totalRows < 10000 || stopped(root, reg.trainingDeadlineUTC)) break;
      if (existsSync(join(root, 'STOP'))) throw Error('Window stopped');
      await stage(`train-${activeSegment}`, async () => {
        // Allow the eager dataset + GPU minibatches to load without consuming the four-GiB reserve.
        while (
          freemem() < (plan.learnerStartGiB || 7) * 1024 ** 3 &&
          !stopped(root, reg.trainingDeadlineUTC)
        )
          await pause();
        if (stopped(root, reg.trainingDeadlineUTC)) {
          writeJSON(join(modelRoot, 'status.json'), {
            phase: 'stopped',
            newUpdates: 0,
            step:
              readJSON(join(latestModel || root, 'train-report.json'))?.steps ||
              plan.initialCheckpoint?.step ||
              0,
            note: 'Training deadline reached while waiting for memory; retain previous learner',
          });
          return;
        }
        await run(plan.python, [
          '-B',
          '-X',
          'utf8',
          join(plan.sourceRoot, 'ai/danMCai/belief/train.py'),
          `--data=${['greedy', 'reason'].flatMap((k) => dataDirs(root, plan, k, activeSegment)).join(',')}`,
          `--out=${modelRoot}`,
          latestModel
            ? `--initial-checkpoint=${join(latestModel, 'checkpoint.pt')}`
            : plan.initialCheckpoint
              ? `--initial-checkpoint=${plan.initialCheckpoint.localFile}`
              : `--initial-onnx=${plan.models.belief.localFile}`,
          '--device=cuda:0',
          '--threads=1',
          '--batch=4096',
          '--lr=0.00003',
          '--weight-decay=0.01',
          '--dropout=0.2',
          '--input-dropout=0.1',
          '--epochs=12',
          '--minutes=240',
          `--seed=${(plan.optimizerSeed || 2026111429) + activeSegment}`,
          '--eval-every=100',
          `--deadline=${reg.trainingDeadlineUTC}`,
          `--stop-file=${join(root, 'STOP')},${join(root, 'model/STOP')}`,
          `--pause-file=${join(root, 'model/MEMORY_PAUSE')}`,
        ]);
        const report = readJSON(join(modelRoot, 'train-report.json'));
        if (!report?.steps) throw Error('No real optimizer updates');
        latestModel = modelRoot;
        writeJSON(join(segmentRoot, 'completed-model.json'), {
          beliefSHA256: report.onnxSHA256,
          checkpointSHA256: sha256(join(modelRoot, 'checkpoint.pt')),
          cumulativeUpdates: report.steps,
          newUpdates: report.newUpdates,
          stopReason: report.stopReason,
        });
      });
    }
    if (!latestModel) throw Error('No trained final model before cutoff');
    const generatedThroughSegment = existsSync(
      join(dataDirs(root, plan, 'greedy', activeSegment)[0], 'run.json'),
    )
      ? activeSegment
      : activeSegment - 1;
    activeSegment = Number(latestModel.replaceAll('\\', '/').split('/').at(-2));
    for (let i = activeSegment + 1; i < plan.maxSegments; i++) {
      if (i > generatedThroughSegment) log(root, `SKIP data-${i} generation cutoff; not run`);
      log(root, `SKIP train-${i} training cutoff; no updates`);
    }
    // The last chronological learner is frozen, including a time-limited final segment.
    for (const file of ['belief.onnx', 'checkpoint.pt', 'train-report.json', 'status.json'])
      copyFileSync(join(latestModel, file), join(root, 'model', file));
    const report = readJSON(join(root, 'model/train-report.json'));
    writeJSON(join(root, 'final-model.json'), {
      championSHA256: plan.models.champion.sha256,
      beliefSHA256: report.onnxSHA256,
      checkpointSHA256: sha256(join(root, 'model/checkpoint.pt')),
      steps: report.steps,
      initialBeliefSHA256: plan.models.belief.sha256,
      inheritedStep: plan.initialCheckpoint?.step || 0,
      newUpdates: report.steps - (plan.initialCheckpoint?.step || 0),
      untrainedDataSegments: Array.from(
        { length: Math.min(generatedThroughSegment + 1, plan.maxSegments) },
        (_, i) => i,
      )
        .filter((i) => i > activeSegment)
        .map((i) => ({
          segment: i,
          greedy: dataSummary(root, plan, 'greedy', i),
          reason: dataSummary(root, plan, 'reason', i),
          ingestedByLearner: false,
        })),
      selection:
        'Last chronological learner before registered training cutoff; never a validation peak',
      lastSegmentModel: latestModel,
      dataSegments: Array.from({ length: activeSegment + 1 }, (_, i) => ({
        segment: i,
        greedy: dataSummary(root, plan, 'greedy', i),
        reason: dataSummary(root, plan, 'reason', i),
        model: readJSON(join(root, 'segments', String(i), 'completed-model.json')),
      })),
      createdAtUTC: new Date().toISOString(),
    });
    if (plan.evaluateAfterTraining)
      await stage('baseline-and-final-old', () =>
        Promise.all(
          plan.tasks
            .filter((t) => t.id !== 'final-vs-baseline')
            .flatMap((t) => t.slots.map((slot) => node(`--evaluate=${t.id}`, `--slot=${slot}`))),
        ),
      );
    else await baseline;
    await stage('final-evaluation', () =>
      Promise.all(
        plan.tasks
          .filter((t) =>
            plan.evaluateAfterTraining ? t.id === 'final-vs-baseline' : t.id !== 'baseline-vs-old',
          )
          .flatMap((t) => t.slots.map((slot) => node(`--evaluate=${t.id}`, `--slot=${slot}`))),
      ),
    );
    await stage('summarize', async () => {
      await run(plan.python, [
        '-B',
        '-X',
        'utf8',
        join(plan.sourceRoot, 'ai/danMCai/evaluation/summarize-round-pairs.py'),
        '--protocol',
        join(root, 'protocol.json'),
        '--results',
        root,
        '--output',
        join(root, 'summary.json'),
      ]);
      const summary = readJSON(join(root, 'summary.json'));
      const gates = ['final-vs-old', 'final-vs-baseline'].map((id) => {
        const r = summary.reports[id].signedUpgradePoints;
        const z = 2.2414027276;
        return {
          task: id,
          mean: r.mean,
          ci97_5: [r.mean - z * r.standardError, r.mean + z * r.standardError],
        };
      });
      writeJSON(join(root, 'results.json'), {
        complete: true,
        summary,
        finalModel: readJSON(join(root, 'final-model.json')),
        gates,
        accept: gates.every((g) => g.ci97_5[0] > 0),
        scope:
          'Single rounds/no tribute/homogeneous teams; two simultaneous positive97.5% intervals required. No global/raw champion or automatic website claim.',
        webPublished: false,
        atUTC: new Date().toISOString(),
      });
      writeJSON(join(root, 'results-panel.json'), {
        rows: [
          ['实际完成', `${summary.completedPairs}交换对 / ${summary.completedRounds}单局`],
          ...gates.map((g) => [g.task, `${g.mean}，97.5%[${g.ci97_5.join(',')}]`]),
          ['双门槛', gates.every((g) => g.ci97_5[0] > 0) ? '两项均正' : '未通过；不称提升或发布'],
        ],
      });
      // Small reproducible research package; no deals, trajectories or credentials.
      await run(plan.python, [
        '-B',
        '-X',
        'utf8',
        join(plan.sourceRoot, 'ai/research/tools/package-reason-029.py'),
        '--run',
        root,
      ]);
    });
    phase = 'complete';
  } catch (e) {
    phase = stopped(root, reg.evaluationDeadlineUTC) ? 'stopped' : 'failed';
    stopFile(root, 'controller-' + phase);
    writeJSON(join(root, 'failure.json'), {
      phase,
      error: String(e.stack || e),
      atUTC: new Date().toISOString(),
    });
  } finally {
    if (phase !== 'complete') stopFile(root, 'window-ended');
    await Promise.allSettled(
      children
        .filter((c) => c.exitCode === null && c.pid)
        .filter((c) => !c.spawnargs.some((a) => String(a).includes('reason-029-awake')))
        .map((c) => new Promise((r) => c.once('exit', r))),
    );
    if (!existsSync(join(root, 'results.json'))) {
      const tasks = {};
      for (const t of plan.tasks) {
        const rows = [];
        for (let i = 0; i < plan.workers; i++) {
          const file = join(root, `worker-${i}.jsonl`);
          if (existsSync(file))
            for (const line of readFileSync(file, 'utf8').split('\n'))
              if (line.trim()) {
                const row = JSON.parse(line);
                if (row.task === t.id) rows.push(row);
              }
        }
        const points = rows.map((r) => r.games.reduce((n, g) => n + g.signedPoints, 0) / 2);
        tasks[t.id] = {
          plannedPairs: t.seeds.length,
          completedPairs: rows.length,
          rounds: rows.length * 2,
          interval: points.length > 1 ? clusterInterval(points) : null,
        };
      }
      writeJSON(join(root, 'partial-summary.json'), {
        complete: false,
        tasks,
        accept: false,
        note: 'Fixed-time partial sample; no full-strength or promotion conclusion',
        atUTC: new Date().toISOString(),
      });
    }
    writeJSON(join(root, 'FINISHED'), { phase, atUTC: new Date().toISOString() });
    if (guardian && guardian.exitCode === null) await new Promise((r) => guardian.once('exit', r));
    await pause(1500);
    clearInterval(timer);
    tick();
    writeJSON(join(root, 'completion-audit.json'), {
      phase,
      children: history.map((c) => ({
        ...c,
        alive: (() => {
          try {
            process.kill(c.pid, 0);
            return true;
          } catch {
            return false;
          }
        })(),
      })),
      sourceVerified: verify(root).plan.sourceCommit,
      awake: readJSON(join(root, 'awake-status.json')),
      atUTC: new Date().toISOString(),
    });
    closeSync(fd);
    unlinkSync(lock);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const root = resolve(option('run', ''));
  if (process.argv.includes('--watch')) await watch(root);
  else if (option('generate', ''))
    await generate(
      root,
      option('generate'),
      Number(option('segment', '0')),
      Number(option('generation-slot', '0')),
    );
  else if (option('evaluate', '')) await evaluate(root, option('evaluate'), Number(option('slot')));
  else await main(root);
}
