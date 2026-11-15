/** A new bounded029 joint-learning run with automatic frozen-final evaluation. */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJSON, writeJSON, sha256 } from '../../danMCai/training/continuous/lib.mjs';

export function validateJointProtocol(p, now = Date.now()) {
  const t = [p.startedAtUTC, p.trainingDeadlineUTC, p.deadlineUTC].map(Date.parse);
  if (
    p.id !== 'human-joint-029-20261115' ||
    p.initialModelSHA256 !== '4f5d8ef453f9627d73130ffccf320b49fff0a77dbed1bf390032a5e66f849768' ||
    !p.humanTrainingAuthorized ||
    p.webDeploymentAuthorized !== false ||
    p.restartExtendsDeadline !== false ||
    !t.every(Number.isFinite) ||
    t[0] > now ||
    t[1] - t[0] !== 4 * 3600000 ||
    t[2] - t[1] !== 3 * 3600000 ||
    now >= t[1]
  )
    throw Error('Invalid new4h+3h joint window');
  const c = p.initialConfig,
    h = c?.humanImitation;
  if (
    c.extrasMode ||
    c.initial !== p.initialModel ||
    c.learner.targetMatchWeight !== 0 ||
    c.learner.anchorWeight !== 0.1 ||
    c.learner.learningRate !== 1e-6 ||
    c.actorMix.self !== 0.5 ||
    c.actorMix.league !== 0.5 ||
    c.actorMix.rule !== 0 ||
    !c.researchNoGate ||
    c.researchSnapshots ||
    !h ||
    h.choiceWeight !== 0.2 ||
    h.candidateAnchorWeight !== 0.1 ||
    h.everyUpdates !== 8 ||
    h.batchDecisions !== 4 ||
    h.maxPasses !== 40
  )
    throw Error('Changed joint objective or frozen neural pool');
  if (
    p.evaluationTemplate.plannedRounds !== 1000 ||
    p.evaluationTemplate.plannedPairs !== 500 ||
    p.heldout.vs029.length !== 500 ||
    p.heldout.vsreason.length !== 500 ||
    new Set([...p.heldout.vs029, ...p.heldout.vsreason]).size !== 1000
  )
    throw Error('Invalid heldout blocks');
}

export function evaluationPlans(p, root, final) {
  const models = {
    ...p.evaluationModels,
    final: {
      localFile: join(root, 'final.onnx'),
      sha256: final.sha256,
      kind: 'Final-window joint terminalQ with human regularization; greedy only',
      config: { stateFeatures: 513, actionFeatures: 54 },
    },
  };
  return ['vs029', 'vsreason', '029vsreason'].map((name) => {
    const raw = name === 'vs029',
      baseline = name === '029vsreason';
    const challenger = baseline ? models.raw029 : models.final,
      opponent = raw ? models.raw029 : models.old017;
    return {
      name,
      plan: {
        ...p.evaluationTemplate,
        id: p.id + '-' + name,
        displayName: baseline
          ? '029起点 vs旧reason（配对控制）'
          : '最终联合模型 vs' + (raw ? '029' : '旧reason'),
        purpose:
          'New final-only complete-round evaluation; no optimization, selection, expansion or deployment',
        sourceRoot: p.sourceRoot,
        sourceCommit: p.sourceCommit,
        sourceSHA256: p.sourceSHA256,
        workers: raw ? 1 : 2,
        resourcePolicy: { ...p.evaluationTemplate.resourcePolicy, workers: raw ? 1 : 2 },
        models: { challenger, reason: opponent, ...(raw ? {} : { belief: models.belief }) },
        ...(raw ? { opponentPolicy: { kind: 'raw' } } : {}),
        finishShortcut: true,
        python: p.python,
        tasks: [
          {
            id: 'head-to-head',
            model: 'challenger',
            opponent: 'reason',
            mixed: false,
            seeds: raw ? p.heldout.vs029 : p.heldout.vsreason,
          },
        ],
        contrasts: [],
        primaryTask: 'head-to-head',
        primaryModel: baseline ? '029' : 'joint-final',
        primaryOpponent: raw ? '029' : 'oldreason9001',
      },
    };
  });
}

async function main(root) {
  const file = join(root, 'protocol.json'),
    p = readJSON(file),
    reg = readJSON(join(root, 'registration.json'));
  validateJointProtocol(p);
  if (
    sha256(file) !== reg.protocolSHA256 ||
    sha256(p.initialModel) !== p.initialModelSHA256 ||
    existsSync(join(root, 'STOP')) ||
    existsSync(join(root, 'FINISHED'))
  )
    throw Error('Changed or closed run');
  for (const [f, h] of Object.entries(p.sourceSHA256))
    if (sha256(join(p.sourceRoot, f)) !== h) throw Error('Frozen source changed:' + f);
  for (const [f, h] of Object.entries(p.humanDataSHA256))
    if (sha256(join(p.humanData, f)) !== h) throw Error('Human corpus changed');
  for (const m of Object.values(p.evaluationModels))
    if (sha256(m.localFile) !== m.sha256) throw Error('Frozen evaluation model changed');
  if (sha256(join(root, 'heldout-protocol.pending.json')) !== p.heldoutPendingSHA256)
    throw Error('Pending evaluation plan changed');
  const lock = join(root, 'controller.lock');
  closeSync(openSync(lock, 'wx'));
  const train = join(root, 'training');
  mkdirSync(train, { recursive: true });
  if (existsSync(join(train, 'config.json')) || existsSync(join(train, 'learner/checkpoint.pt')))
    throw Error('Fresh training only; do not silently reset/restart');
  const fd = openSync(join(root, 'controller.log'), 'a'),
    children = [],
    active = new Map();
  let phase = 'prepare',
    timer,
    awake;
  const stopped = () => existsSync(join(root, 'STOP')) || Date.now() >= Date.parse(p.deadlineUTC);
  const spawnOne = (exe, args, name) => {
    const c = spawn(exe, args, {
      cwd: p.sourceRoot,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, OMP_NUM_THREADS: '1', PYTHONIOENCODING: 'utf-8' },
    });
    const record = { name, pid: c.pid, args, startedAtUTC: new Date().toISOString() };
    children.push(record);
    const promise = new Promise((ok, fail) => {
      c.once('error', fail);
      c.once('exit', (code, signal) => {
        Object.assign(record, { exitCode: code, signal, exitedAtUTC: new Date().toISOString() });
        active.delete(c.pid);
        code === 0 ? ok() : fail(Error(name + ' exited ' + code));
      });
    });
    promise.catch(() => {}); // Attach immediately; callers still await the original rejection.
    active.set(c.pid, promise);
    return promise;
  };
  const stage = async (name, fn) => {
    if (stopped()) throw Error('Overall STOP/deadline');
    phase = name;
    appendFileSync(join(root, 'stages.log'), new Date().toISOString() + ' START ' + name + '\n');
    try {
      await fn();
      appendFileSync(
        join(root, 'stages.log'),
        new Date().toISOString() + ' END ' + name + ' rc=0\n',
      );
    } catch (e) {
      appendFileSync(
        join(root, 'stages.log'),
        new Date().toISOString() + ' END ' + name + ' rc=1\n',
      );
      throw e;
    }
  };
  const tick = () => {
    if (sha256(file) !== reg.protocolSHA256)
      writeJSON(join(root, 'STOP'), { reason: 'protocol-changed' });
    if (Date.now() >= Date.parse(p.trainingDeadlineUTC) && !existsSync(join(train, 'STOP')))
      writeJSON(join(train, 'STOP'), { reason: 'fixed4h-training-cutoff' });
    if (Date.now() >= Date.parse(p.deadlineUTC) && !existsSync(join(root, 'STOP')))
      writeJSON(join(root, 'STOP'), { reason: 'fixed7h-overall-cutoff' });
    if (stopped())
      for (const dir of [
        train,
        ...['vs029', 'vsreason', '029vsreason'].map((n) => join(root, n)),
      ]) {
        mkdirSync(dir, { recursive: true });
        if (!existsSync(join(dir, 'STOP')))
          writeJSON(join(dir, 'STOP'), { reason: 'parent-stop-or-deadline' });
      }
    const learner = readJSON(join(train, 'learner/status.json')),
      status = readJSON(join(train, 'status.json'));
    const live = {
      phase: learner?.state || phase,
      step: learner?.step || 0,
      ingestedRows: learner?.ingestedRows || 0,
      trainedRows: learner?.trainedRows || 0,
      humanRowsUsed: learner?.humanRowsUsed || 0,
      elapsedFraction: Math.max(
        0,
        Math.min(1, (Date.now() - Date.parse(p.startedAtUTC)) / (4 * 3600000)),
      ),
    };
    writeJSON(join(root, 'joint-live.json'), live);
    writeJSON(join(root, 'train-panel.json'), {
      title: '实际GPU联合训练',
      rows: [
        ['状态', live.phase],
        ['GPU更新', live.step],
        ['实际设备', learner?.deviceName || '等待学习器'],
        ['已摄入终局样本行', live.ingestedRows],
        ['训练抽样行', live.trainedRows],
        ['真人动作曝光', live.humanRowsUsed],
        ['最近真人训练NLL', learner?.humanLoss?.choiceNLL ?? '—'],
        ['采样整场（仅用各单局终局分）', status?.totals?.matches || 0],
        ['目标', '终局MSE为主＋029锚定＋低频小权重真人选择损失'],
      ],
    });
    writeJSON(join(root, 'progress.json'), {
      phase,
      displayName: '029重新开始：真人模仿＋终局收益联合训练',
      analysis: '新Adam/空回放；终局升级分主目标，真人仅训练分组动作；不以战术标签作奖励',
      currentTask: phase === 'train' ? live.phase : phase,
      nextTask: '固定最终模型→真人留出→029/旧reason及起点配对控制→保存',
      trainingDeadlineUTC: p.trainingDeadlineUTC,
      deadlineUTC: p.deadlineUTC,
      learner: live,
      children,
    });
    writeJSON(join(root, 'children.json'), children);
  };
  try {
    tick();
    timer = setInterval(tick, 3000);
    awake = spawnOne(
      'pwsh.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(p.sourceRoot, 'ai/research/tools/evaluation-awake.ps1'),
        '-Run',
        root,
      ],
      'awake',
    );
    for (
      let attempt = 0;
      attempt < 50 && readJSON(join(root, 'awake-status.json'))?.phase !== 'awake';
      attempt++
    )
      await new Promise((r) => setTimeout(r, 100));
    if (readJSON(join(root, 'awake-status.json'))?.phase !== 'awake')
      throw Error('Temporary awake request failed');
    await stage('gpu', () =>
      spawnOne(
        p.python,
        [
          '-B',
          '-X',
          'utf8',
          join(p.sourceRoot, 'ai/danMCai/training/continuous/human_joint.py'),
          '--preflight',
          '--initial',
          p.initialModel,
          '--output',
          join(root, 'gpu-preflight.json'),
        ],
        'gpu-preflight',
      ),
    );
    writeJSON(join(root, 'preflight-panel.json'), {
      rows: [
        ['真实GPU', readJSON(join(root, 'gpu-preflight.json')).device],
        ['合成预检', '联合损失/12组Adam恢复/下一步一致/原生ONNX兼容'],
        ['正式更新', 0],
      ],
    });
    await stage('train', async () => {
      while (
        freemem() < 5 * 2 ** 30 &&
        !stopped() &&
        Date.now() < Date.parse(p.trainingDeadlineUTC)
      )
        await new Promise((r) => setTimeout(r, 1000));
      if (stopped() || Date.now() >= Date.parse(p.trainingDeadlineUTC))
        throw Error('No remaining training window');
      copyFileSync(file, join(train, 'protocol.json'));
      writeJSON(join(train, 'campaign-task.json'), {
        protocol: join(train, 'protocol.json'),
        protocolSHA256: reg.protocolSHA256,
        window: {
          startUTC: p.startedAtUTC,
          deadlineUTC: p.trainingDeadlineUTC,
          requestedHours: 4,
          restartExtendsDeadline: false,
        },
      });
      writeJSON(join(train, 'status.json'), {
        lastSnapshotAt: Date.parse(p.startedAtUTC),
        lastAnchorAt: Date.parse(p.startedAtUTC),
      });
      const hours = (Date.parse(p.trainingDeadlineUTC) - Date.now()) / 3600000;
      await spawnOne(
        process.execPath,
        [
          join(p.sourceRoot, 'ai/danMCai/training/continuous/supervisor.mjs'),
          '--run=' + train,
          '--python=' + p.python,
          '--hours=' + hours,
          '--config=' + JSON.stringify(p.initialConfig),
        ],
        'supervisor',
      );
    });
    await stage('audit', () =>
      spawnOne(
        p.python,
        [
          '-B',
          '-X',
          'utf8',
          join(p.sourceRoot, 'ai/research/tools/audit-research-stop.py'),
          '--run',
          train,
          '--frozen-source',
          p.sourceRoot,
          '--output',
          join(root, 'stop-audit.json'),
        ],
        'stop-audit',
      ),
    );
    const final = readJSON(join(root, 'stop-audit.json')).latest;
    if (!final || !final.step || sha256(join(train, 'models', final.file)) !== final.sha256)
      throw Error('No valid final-window model');
    copyFileSync(join(train, 'models', final.file), join(root, 'final.onnx'));
    await stage('human', () =>
      spawnOne(
        p.python,
        [
          '-B',
          '-X',
          'utf8',
          join(p.sourceRoot, 'ai/research/tools/review-human-joint.py'),
          '--run',
          root,
          '--mode',
          'human',
        ],
        'human-review',
      ),
    );
    // Preserve the original pending protocol; bind final SHA exactly once after the stop audit.
    if (sha256(join(root, 'heldout-protocol.pending.json')) !== p.heldoutPendingSHA256)
      throw Error('Pending evaluation plan changed');
    for (const { name, plan } of evaluationPlans(p, root, final)) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      if (existsSync(join(dir, 'protocol.json'))) throw Error('Evaluation already frozen');
      writeJSON(join(dir, 'protocol.json'), plan);
      writeJSON(join(dir, 'registration.json'), {
        startUTC: p.trainingDeadlineUTC,
        deadlineUTC: p.deadlineUTC,
        durationHours: 3,
        restartExtendsDeadline: false,
        protocolSHA256: sha256(join(dir, 'protocol.json')),
      });
    }
    const evaluate = (name) =>
      stage(name, async () => {
        await spawnOne(
          process.execPath,
          [
            join(p.sourceRoot, 'ai/research/tools/compare-champion-reason.mjs'),
            '--run=' + join(root, name),
          ],
          name,
        );
        if (readJSON(join(root, name, 'status.json'))?.phase !== 'complete')
          throw Error('Incomplete evaluation group: ' + name);
      });
    await Promise.all([evaluate('vs029'), evaluate('vsreason')]);
    // Keep memory headroom: use the same reason worker count sequentially for the shared-deal control.
    await evaluate('029vsreason');
    await stage('summary', () =>
      spawnOne(
        p.python,
        [
          '-B',
          '-X',
          'utf8',
          join(p.sourceRoot, 'ai/research/tools/review-human-joint.py'),
          '--run',
          root,
          '--mode',
          'closeout',
        ],
        'closeout',
      ),
    );
    phase = 'complete';
  } catch (e) {
    phase = 'failed-or-partial';
    writeJSON(join(root, 'failure.json'), {
      error: String(e.stack || e),
      atUTC: new Date().toISOString(),
    });
    writeJSON(join(root, 'STOP'), { reason: 'controller-failed' });
    tick();
  } finally {
    if (phase !== 'complete')
      await Promise.allSettled(
        [...active.entries()]
          .filter(([id]) => children.find((c) => c.pid === id)?.name !== 'awake')
          .map(([, p]) => p),
      );
    writeJSON(join(root, 'FINISHED'), { phase, atUTC: new Date().toISOString() });
    if (awake) await awake.catch(() => {});
    clearInterval(timer);
    tick();
    writeJSON(join(root, 'completion.json'), {
      phase,
      children,
      awake: readJSON(join(root, 'awake-status.json')),
      atUTC: new Date().toISOString(),
      webDefaultChanged: false,
    });
    closeSync(fd);
    unlinkSync(lock);
    if (phase !== 'complete') process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const run = process.argv.find((x) => x.startsWith('--run='))?.slice(6);
  if (!run) throw Error('--run required');
  await main(resolve(run));
}
