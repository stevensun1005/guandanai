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

const FOLLOWUPS = {
  'human-qfilter-followup-20261118': {
    step: 50424,
    network: '71b9161b5502a81995edc26c9352a6ec02b34b82d00cdcc9417a3ee9c1e22ffa',
    checkpoint: '4cc627c702813c6d32f571207a8b6ec69f8e4bf01671fb49c0b6448d569135aa',
    firstShard: 200000,
    anchorWeight: 0.05,
  },
  'human-qfilter-anchor-20261119': {
    step: 58132,
    network: '1464c45f0617cd0776c861895a366d26f3c30908d4242cd15989d4911df221f2',
    checkpoint: '05e6099f51f2bf74c36ee82a8757628f5ba26f5c58e56074319be9c520a8f517',
    firstShard: 300000,
    anchorWeight: 0.1,
  },
};

export function validateJointProtocol(p, now = Date.now()) {
  const t = [p.startedAtUTC, p.trainingDeadlineUTC, p.deadlineUTC].map(Date.parse);
  const overnight = p.id === 'human-qfilter-overnight-20261115';
  const legacy = p.id === 'human-joint-029-20261115';
  const followup = Object.hasOwn(FOLLOWUPS, p.id) ? FOLLOWUPS[p.id] : null;
  const continuation = p.id === 'human-qfilter-continue-20261116';
  const c = p.initialConfig,
    h = c?.humanImitation;
  if (
    (!legacy && !overnight && !continuation && !followup) ||
    p.initialModelSHA256 !==
      (followup?.network ??
        (continuation
          ? '9e6b98aa1ab6693247903d9d06aab34d435e96ab5e0d0535a6b603061d30bf03'
          : '4f5d8ef453f9627d73130ffccf320b49fff0a77dbed1bf390032a5e66f849768')) ||
    !p.humanTrainingAuthorized ||
    p.webDeploymentAuthorized !== false ||
    p.restartExtendsDeadline !== false ||
    !t.every(Number.isFinite) ||
    t[0] > now ||
    now >= t[1] ||
    t[2] - t[1] !== 3 * 3600000
  )
    throw Error('Invalid registered joint window');
  if (
    continuation &&
    (p.trainingDeadlineUTC !== '2026-11-17T12:00:00.000Z' ||
      p.deadlineUTC !== '2026-11-17T15:00:00.000Z' ||
      t[1] - t[0] > 12 * 3600000 ||
      p.humanWarmupUTC !== '2026-11-17T00:00:00.000Z' ||
      c?.continuation?.sha256 !==
        '815cf52f9aa7319a3d8d1b9e21bc879fd1cb46fa872394f259cd286f6f93c516' ||
      c?.continuation?.shardSequenceStart !== 100000 ||
      c?.parent?.startingStep !== 21833)
  )
    throw Error('Continuation checkpoint or 07Toronto cutoff changed');
  if (
    followup &&
    (t[1] - t[0] !== 2 * 3600000 ||
      p.humanWarmupUTC !== p.startedAtUTC ||
      c?.continuation?.sha256 !== followup.checkpoint ||
      c?.continuation?.shardSequenceStart !== followup.firstShard ||
      c?.parent?.startingStep !== followup.step ||
      p.evaluationModels?.parent?.localFile !== p.initialModel ||
      p.evaluationModels?.parent?.sha256 !== p.initialModelSHA256 ||
      p.heldout?.vsParent?.length !== 500)
  )
    throw Error('Follow-up checkpoint, parent evaluation or two-hour cutoff changed');
  if (
    (continuation || followup) &&
    (c?.actors !== 1 ||
      c?.fastActor?.games !== 16 ||
      c?.fastActor?.sessionLimit !== 2 ||
      c?.learner?.capacity !== 500000 ||
      c?.learner?.learningRate !== 3e-6 ||
      c?.learner?.anchorWeight !== (followup?.anchorWeight ?? 0.05) ||
      h?.choiceWeight !== 0.1 ||
      h?.gateTopK !== 2 ||
      h?.enableAfterUTC !== p.humanWarmupUTC ||
      !h?.compactFeatures ||
      p.evaluationWorkers !== 1)
  )
    throw Error('Continuation objective or resources changed');
  if (legacy && t[1] - t[0] !== 4 * 3600000) throw Error('Legacy4h window changed');
  if (
    overnight &&
    (p.trainingDeadlineUTC !== '2026-11-16T14:00:00.000Z' ||
      p.deadlineUTC !== '2026-11-16T17:00:00.000Z' ||
      p.humanWarmupUTC !== '2026-11-16T08:00:00.000Z' ||
      t[0] >= Date.parse(p.humanWarmupUTC) ||
      t[1] - t[0] > 12 * 3600000)
  )
    throw Error('Tomorrow09:00Toronto cutoff or03:00warmup changed');
  if (
    !c ||
    !h ||
    c.extrasMode ||
    c.initial !== p.initialModel ||
    c.learner.targetMatchWeight !== 0 ||
    c.actorMix.self !== 0.5 ||
    c.actorMix.league !== 0.5 ||
    c.actorMix.rule !== 0 ||
    !c.researchNoGate ||
    c.researchSnapshots ||
    h.candidateAnchorWeight !== 0.1 ||
    h.everyUpdates !== 8 ||
    h.batchDecisions !== 4 ||
    h.maxPasses !== 40
  )
    throw Error('Changed objective or frozen neural pool');
  if (
    legacy &&
    (c.learner.anchorWeight !== 0.1 ||
      c.learner.learningRate !== 1e-6 ||
      h.choiceWeight !== 0.2 ||
      h.gateTopK != null)
  )
    throw Error('Legacy objective changed');
  if (
    overnight &&
    (c.learner.anchorWeight !== 0.05 ||
      c.learner.learningRate !== 3e-6 ||
      h.choiceWeight !== 0.1 ||
      h.gateTopK !== 2 ||
      h.enableAfterUTC !== p.humanWarmupUTC ||
      c.actors !== 2 ||
      c.fastActor.games !== 16 ||
      c.fastActor.sessionLimit !== 3)
  )
    throw Error('Overnight phased objective/resources changed');
  if (
    p.evaluationTemplate.plannedRounds !== 1000 ||
    p.evaluationTemplate.plannedPairs !== 500 ||
    p.heldout.vs029.length !== 500 ||
    p.heldout.vsreason.length !== 500 ||
    new Set([...p.heldout.vs029, ...p.heldout.vsreason, ...(p.heldout.vsParent || [])]).size !==
      (followup ? 1500 : 1000)
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
  const parentStep = p.initialConfig?.parent?.startingStep ?? '';
  const groups = ['vs029', 'vsreason', '029vsreason'];
  if (p.heldout.vsParent) groups.unshift('vsParent');
  return groups.map((name) => {
    const parent = name === 'vsParent';
    const raw = parent || name === 'vs029',
      baseline = name === '029vsreason';
    const challenger = baseline ? models.raw029 : models.final,
      opponent = parent ? models.parent : raw ? models.raw029 : models.old017;
    return {
      name,
      plan: {
        ...p.evaluationTemplate,
        id: p.id + '-' + name,
        displayName: baseline
          ? '029起点 vs旧reason（配对控制）'
          : '最终联合模型 vs' + (parent ? '本轮起点' + parentStep : raw ? '029' : '旧reason'),
        purpose:
          'New final-only complete-round evaluation; no optimization, selection, expansion or deployment',
        sourceRoot: p.sourceRoot,
        sourceCommit: p.sourceCommit,
        sourceSHA256: p.sourceSHA256,
        workers: p.evaluationWorkers || (raw ? 1 : 2),
        resourcePolicy: {
          ...p.evaluationTemplate.resourcePolicy,
          workers: p.evaluationWorkers || (raw ? 1 : 2),
        },
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
            seeds: parent ? p.heldout.vsParent : raw ? p.heldout.vs029 : p.heldout.vsreason,
          },
        ],
        contrasts: [],
        primaryTask: 'head-to-head',
        primaryModel: baseline ? '029' : 'joint-final',
        primaryOpponent: parent ? 'parent' + parentStep : raw ? '029' : 'oldreason9001',
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
  if (p.initialConfigSHA256 && sha256(join(root, 'initial-config.json')) !== p.initialConfigSHA256)
    throw Error('Initial config changed');
  if (
    p.initialConfig.continuation &&
    sha256(p.initialConfig.continuation.file) !== p.initialConfig.continuation.sha256
  )
    throw Error('Continuation checkpoint changed');
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
      writeJSON(join(train, 'STOP'), { reason: 'fixed-training-cutoff' });
    if (Date.now() >= Date.parse(p.deadlineUTC) && !existsSync(join(root, 'STOP')))
      writeJSON(join(root, 'STOP'), { reason: 'fixed7h-overall-cutoff' });
    if (stopped())
      for (const dir of [
        train,
        ...['vsParent', 'vs029', 'vsreason', '029vsreason']
          .filter((n) => n !== 'vsParent' || p.heldout.vsParent)
          .map((n) => join(root, n)),
      ]) {
        mkdirSync(dir, { recursive: true });
        if (!existsSync(join(dir, 'STOP')))
          writeJSON(join(dir, 'STOP'), { reason: 'parent-stop-or-deadline' });
      }
    const learner = readJSON(join(train, 'learner/status.json')),
      status = readJSON(join(train, 'status.json'));
    const inherited = p.initialConfig.parent || {};
    const live = {
      phase: learner?.state || phase,
      step: Math.max(0, (learner?.step || 0) - (inherited.startingStep || 0)),
      cumulativeStep: learner?.step || inherited.startingStep || 0,
      ingestedRows: Math.max(0, (learner?.ingestedRows || 0) - (inherited.ingestedRows || 0)),
      trainedRows: Math.max(0, (learner?.trainedRows || 0) - (inherited.trainedRows || 0)),
      humanRowsUsed: Math.max(0, (learner?.humanRowsUsed || 0) - (inherited.humanRowsUsed || 0)),
      elapsedFraction: Math.max(
        0,
        Math.min(
          1,
          (Date.now() - Date.parse(p.startedAtUTC)) /
            (Date.parse(p.trainingDeadlineUTC) - Date.parse(p.startedAtUTC)),
        ),
      ),
    };
    writeJSON(join(root, 'joint-live.json'), live);
    writeJSON(join(root, 'train-panel.json'), {
      title: '实际GPU联合训练',
      rows: [
        ['状态', live.phase],
        ['本窗新增GPU更新', live.step],
        ['累计GPU更新', live.cumulativeStep],
        ['实际设备', learner?.deviceName || '等待学习器'],
        ['已摄入终局样本行', live.ingestedRows],
        ['训练抽样行', live.trainedRows],
        ['真人模仿梯度标签', live.humanRowsUsed],
        ['真人阶段', learner?.humanLoss?.phase || '等待学习器'],
        [
          '筛选候选/接受/拒绝',
          `${learner?.humanLoss?.attempted || 0} / ${learner?.humanLoss?.accepted || 0} / ${learner?.humanLoss?.rejected || 0}`,
        ],
        ['最近真人训练NLL', learner?.humanLoss?.choiceNLL ?? '—'],
        ['采样整场（仅用各单局终局分）', status?.totals?.matches || 0],
        ['起点价值约束系数', p.initialConfig.learner.anchorWeight],
        ['目标', '终局MSE为主＋固定起点锚定＋低频小权重真人选择损失'],
      ],
    });
    writeJSON(join(root, 'progress.json'), {
      phase,
      displayName: p.displayName || '029重新开始：真人模仿＋终局收益联合训练',
      analysis: p.initialConfig.continuation
        ? '匹配网络/Adam与累计计数续接；新RNG/空回放；固定起点参考，不声称精确回放恢复'
        : '新Adam/空回放；终局升级分主目标，真人仅训练分组动作；不以战术标签作奖励',
      currentTask: phase === 'train' ? live.phase : phase,
      nextTask: '固定最终模型→真人回顾与对照评测→保存',
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
          '--settings',
          join(root, 'initial-config.json'),
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
      if (p.initialConfig.continuation) {
        mkdirSync(join(train, 'learner'), { recursive: true });
        copyFileSync(p.initialConfig.continuation.file, join(train, 'learner/checkpoint.pt'));
        mkdirSync(join(train, 'actors'), { recursive: true });
        writeJSON(join(train, 'actors/actor-0.json'), {
          shardSequence: p.initialConfig.continuation.shardSequenceStart,
        });
      }
      copyFileSync(file, join(train, 'protocol.json'));
      writeJSON(join(train, 'campaign-task.json'), {
        protocol: join(train, 'protocol.json'),
        protocolSHA256: reg.protocolSHA256,
        window: {
          startUTC: p.startedAtUTC,
          deadlineUTC: p.trainingDeadlineUTC,
          requestedHours:
            (Date.parse(p.trainingDeadlineUTC) - Date.parse(p.startedAtUTC)) / 3600000,
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
    if (p.heldout.vsParent) await evaluate('vsParent');
    if (p.evaluationWorkers === 1) {
      await evaluate('vs029');
      await evaluate('vsreason');
    } else await Promise.all([evaluate('vs029'), evaluate('vsreason')]);
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
