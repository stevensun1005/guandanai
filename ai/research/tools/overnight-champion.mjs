/** New owner-authorized window. Old campaigns and frozen runtimes are never reopened. */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  statfsSync,
  unlinkSync,
} from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';
import { evaluateRegistered } from './run-round-evaluation.mjs';

export const DEADLINE = '2026-11-12T14:00:00.000Z';
export const COMPUTE = '2026-11-12T13:45:00.000Z';
export function windowFor(existing, hours, now = Date.now()) {
  if (!(hours > 0 && hours <= 7)) throw Error('Invalid budget');
  const window = existing || {
    startUTC: new Date(now).toISOString(),
    deadlineUTC: new Date(Math.min(now + hours * 3600000, Date.parse(COMPUTE))).toISOString(),
    requestedHours: hours,
    restartExtendsDeadline: false,
  };
  if (
    window.requestedHours !== hours ||
    window.restartExtendsDeadline !== false ||
    Date.parse(window.deadlineUTC) !==
      Math.min(Date.parse(window.startUTC) + hours * 3600000, Date.parse(COMPUTE)) ||
    Date.parse(window.deadlineUTC) <= now
  )
    throw Error('Expired or changed window');
  return window;
}
export function promotion(summary) {
  const primary = summary.reports['head-to-head'].signedUpgradePoints;
  const complete = summary.completedRounds === 10000 && summary.completedPairs === 5000;
  const accepted =
    complete &&
    primary.mean > 0.05 &&
    primary.ci[0] > 0 &&
    ['vs-clint', 'vs-p0'].every((k) => summary.secondaryContrasts[k].ci[0] > -0.1);
  return {
    accepted,
    decision: accepted ? 'accept' : 'not-accepted',
    complete,
    primary,
    rule: 'All10000 rounds; primary mean>+.05 and95% lower>0; both common-opponent paired99% lower>-.10. One final checkpoint only; no sample expansion or peak selection.',
  };
}
function stop(run, reason) {
  const file = join(run, 'STOP');
  if (!existsSync(file)) writeJSON(file, { reason, atUTC: new Date().toISOString() });
}
export function register(root, run, hours) {
  if (existsSync(join(root, 'STOP'))) throw Error('Window stopped');
  const path = realpathSync(run),
    base = realpathSync(join(root, 'experiments'));
  if (!path.startsWith(base + '\\') && !path.startsWith(base + '/'))
    throw Error('Dedicated experiments only');
  const file = join(run, 'campaign-task.json'),
    old = readJSON(file);
  const protocol = join(path, 'protocol.json'),
    protocolSHA256 = sha256(protocol);
  if (old && (old.protocolSHA256 !== protocolSHA256 || old.run !== path))
    throw Error('Registered protocol changed');
  const task = old || {
    id: readJSON(protocol).id,
    run: path,
    protocol,
    protocolSHA256,
    window: windowFor(null, hours),
  };
  windowFor(task.window, hours);
  if (!old) writeJSON(file, task);
  const tasks = readJSON(join(root, 'tasks.json'), []);
  if (!tasks.some((t) => t.id === task.id)) {
    tasks.push(task);
    writeJSON(join(root, 'tasks.json'), tasks);
  }
  return task;
}
async function watch(root) {
  const manifest = join(root, 'authorization.json'),
    digest = sha256(manifest);
  const auth = readJSON(manifest);
  if (
    auth.deadlineUTC !== DEADLINE ||
    auth.computeDeadlineUTC !== COMPUTE ||
    auth.restartExtendsDeadline !== false
  )
    throw Error('Invalid new authorization');
  const lock = join(root, 'guardian.lock');
  closeSync(openSync(lock, 'wx'));
  const tick = () => {
    const reason =
      sha256(manifest) !== digest
        ? 'authorization-changed'
        : Date.now() >= Date.parse(COMPUTE)
          ? 'compute-deadline'
          : existsSync(join(root, 'STOP'))
            ? 'owner-stop'
            : null;
    if (reason) stop(root, reason);
    for (const t of readJSON(join(root, 'tasks.json'), [])) {
      if (!realpathSync(t.run).startsWith(realpathSync(join(root, 'experiments')) + '\\'))
        throw Error('Unsafe task path');
      if (reason || Date.now() >= Date.parse(t.window.deadlineUTC))
        stop(t.run, reason || 'task-deadline');
    }
    writeJSON(join(root, 'guardian-status.json'), {
      pid: process.pid,
      updatedAtUTC: new Date().toISOString(),
      deadlineUTC: DEADLINE,
      computeDeadlineUTC: COMPUTE,
      stopped: !!reason,
    });
  };
  try {
    while (Date.now() < Date.parse(DEADLINE)) {
      tick();
      await new Promise((r) => setTimeout(r, 1000));
    }
    tick();
  } catch (error) {
    stop(root, 'guardian-failed');
    for (const t of readJSON(join(root, 'tasks.json'), [])) {
      if (realpathSync(t.run).startsWith(realpathSync(join(root, 'experiments')) + '\\'))
        stop(t.run, 'guardian-failed');
    }
    throw error;
  } finally {
    unlinkSync(lock);
  }
}
export async function run(root) {
  const plan = readJSON(join(root, 'plan.json'));
  if (
    sha256(join(root, 'authorization.json')) !== plan.authorizationSHA256 ||
    existsSync(join(root, 'STOP'))
  )
    throw Error('Authorization changed/stopped');
  if (Date.now() >= Date.parse(COMPUTE)) throw Error('New window expired');
  for (const [f, h] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, f)) !== h) throw Error('Frozen source changed: ' + f);
  const lock = join(root, 'controller.lock');
  closeSync(openSync(lock, 'wx'));
  const state = {
    pid: process.pid,
    phase: 'preparation',
    deadlineUTC: DEADLINE,
    computeDeadlineUTC: COMPUTE,
  };
  const save = () =>
    writeJSON(join(root, 'status.json'), { ...state, updatedAtUTC: new Date().toISOString() });
  const mark = (what, key, rc = '') =>
    appendFileSync(join(root, 'stages.log'), `${new Date().toISOString()} ${what} ${key}${rc}\n`);
  const progress = (phase, analysis, nextTask) => {
    state.phase = phase;
    save();
    writeJSON(join(root, 'progress.json'), {
      phase,
      displayName: 'danMCai · 冠军续训与独立门控',
      currentTask: phase,
      analysis,
      nextTask,
      deadlineUTC: DEADLINE,
      computeDeadlineUTC: COMPUTE,
    });
  };
  const launch = (exe, args, log) =>
    new Promise((ok, fail) => {
      const fd = openSync(join(root, log), 'a');
      const child = spawn(exe, args, {
        cwd: plan.sourceRoot,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, OMP_NUM_THREADS: '1', PYTHONUTF8: '1' },
      });
      closeSync(fd);
      state.childPID = child.pid;
      save();
      child.once('error', fail);
      child.once('exit', (code) =>
        code === 0 ? ok() : fail(Error(`Child exited ${code}: ${log}`)),
      );
    });
  let timer;
  const train = join(root, 'experiments/train'),
    heldout = join(root, 'experiments/heldout');
  try {
    if (existsSync(join(train, 'config.json')) || existsSync(join(heldout, 'protocol.json')))
      throw Error('Existing run; do not restart pipeline or reset clock');
    while (
      freemem() < 5 * 1024 ** 3 &&
      Date.now() < Date.parse(COMPUTE) &&
      !existsSync(join(root, 'STOP'))
    ) {
      progress('memory-paused', '可用内存不足5GiB，等待启动', '训练');
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (existsSync(join(root, 'STOP'))) throw Error('Stopped while waiting for memory');
    const disk = statfsSync(root);
    if (disk.bavail * disk.bsize < 8 * 1024 ** 3) throw Error('Insufficient disk');
    const preflight = join(root, 'experiments/preflight');
    register(root, preflight, 0.25);
    mark('START', 'preflight');
    await launch(
      plan.python,
      [
        '-B',
        join(plan.sourceRoot, 'ai/research/tools/overnight-preflight.py'),
        `--campaign=${root}`,
      ],
      'preflight.log',
    );
    if (!readJSON(join(preflight, 'results.json'))?.passed) throw Error('GPU preflight failed');
    mark('END', 'preflight', ' rc=0');
    const task = register(root, train, 7),
      config = readJSON(join(train, 'initial-config.json'));
    if (
      sha256(join(train, 'initial-config.json')) !== plan.configSHA256 ||
      sha256(config.initial) !== plan.teacherSHA256
    )
      throw Error('Initial configuration/model changed');
    writeJSON(join(train, 'status.json'), {
      lastSnapshotAt: Date.parse(task.window.startUTC),
      lastAnchorAt: Date.parse(task.window.startUTC),
    });
    timer = setInterval(() => {
      if (existsSync(join(root, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC))
        stop(train, 'fixed-training-deadline');
      const league = readJSON(join(train, 'league/league.json'));
      if (
        league &&
        (league.members.length !== 1 || league.members[0].sha256 !== plan.teacherSHA256)
      )
        stop(train, 'opponent-pool-changed');
    }, 1000);
    mark('START', 'train');
    progress(
      'training',
      '017全主干12组参数，新Adam/空回放；半自对弈、半固定017，较低学习率；仅单局最终升级分',
      '停止审计后自动冻结最终模型并独立门控',
    );
    await launch(
      process.execPath,
      [
        join(plan.sourceRoot, 'ai/danMCai/training/continuous/supervisor.mjs'),
        `--run=${train}`,
        `--python=${plan.python}`,
        `--hours=${(Date.parse(task.window.deadlineUTC) - Date.now()) / 3600000}`,
        `--config=${JSON.stringify(config)}`,
      ],
      'training.log',
    );
    clearInterval(timer);
    mark('END', 'train', ' rc=0');
    mark('START', 'audit');
    progress(
      'audit',
      '核对最终网络、12组匹配Adam、种子、源码、全部子进程及保留/待摄入回放',
      '独立留出',
    );
    await launch(
      plan.python,
      [
        '-B',
        join(plan.sourceRoot, 'ai/research/tools/audit-research-stop.py'),
        '--run',
        train,
        '--frozen-source',
        plan.sourceRoot,
        '--output',
        join(root, 'stop-audit.json'),
      ],
      'audit.log',
    );
    mark('END', 'audit', ' rc=0');
    if (Date.now() >= Date.parse(COMPUTE) || existsSync(join(root, 'STOP')))
      throw Error('No evaluation time remains');
    const pending = readJSON(join(root, 'heldout-protocol.pending.json'));
    if (sha256(join(root, 'heldout-protocol.pending.json')) !== plan.pendingSHA256)
      throw Error('Heldout design changed');
    const latest = readJSON(join(train, 'models/latest.json'));
    mkdirSync(join(heldout, 'models'), { recursive: true });
    const model = join(heldout, 'models/latest.onnx');
    copyFileSync(join(train, 'models', latest.file), model);
    if (sha256(model) !== latest.sha256) throw Error('Final network changed');
    pending.models.latest = {
      file: 'models/latest.onnx',
      sha256: latest.sha256,
      version: latest.version,
      step: latest.step,
      config: { stateFeatures: 513, actionFeatures: 54 },
    };
    pending.evaluationDeadlineUTC = new Date(
      Math.min(Date.now() + 2 * 3600000, Date.parse(COMPUTE)),
    ).toISOString();
    pending.frozenAtUTC = new Date().toISOString();
    pending.stopAuditSHA256 = sha256(join(root, 'stop-audit.json'));
    writeJSON(join(heldout, 'protocol.json'), pending);
    register(root, heldout, 2);
    mark('START', 'heldout');
    progress(
      'heldout',
      '仅最终窗口导出；预留新牌副，10000完整单局，逐对手升级分与区间',
      '按预登记规则登记研究冠军或保留负结果',
    );
    await evaluateRegistered(heldout);
    mark('END', 'heldout', ' rc=0');
    const summary = readJSON(join(heldout, 'summary.json'));
    const gate = {
      ...promotion(summary),
      candidate: pending.models.latest,
      incumbentSHA256: plan.teacherSHA256,
      sourceCommit: plan.sourceCommit,
      sourceSHA256: plan.sourceSHA256,
      protocolSHA256: sha256(join(heldout, 'protocol.json')),
      summarySHA256: sha256(join(heldout, 'summary.json')),
      atUTC: new Date().toISOString(),
      scope:
        'Independent fixed single-round research gate; not full-match/human evidence or web publication',
    };
    writeJSON(join(root, 'gate.json'), gate);
    if (gate.accepted) {
      mkdirSync(join(root, 'champion'), { recursive: true });
      copyFileSync(model, join(root, 'champion/champion.onnx'));
      writeJSON(join(root, 'champion/champion.json'), {
        ...pending.models.latest,
        gate: '../gate.json',
        gateSHA256: sha256(join(root, 'gate.json')),
        acceptedAtUTC: gate.atUTC,
        researchOnly: true,
      });
    }
    progress(
      'complete',
      gate.accepted
        ? '完整独立门控通过，已登记新研究冠军；网页未变'
        : '独立门控未通过，不登记冠军；完整证据保留',
      '到9点保存收尾，不续约',
    );
  } catch (e) {
    stop(train, 'pipeline-failed');
    stop(heldout, 'pipeline-failed');
    state.error = String(e.stack || e);
    progress('failed', '流程失败，保留全部现场；不冒称完成或冠军', '检查错误及剩余授权时间');
    throw e;
  } finally {
    clearInterval(timer);
    save();
    unlinkSync(lock);
  }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const root = resolve(option('campaign', ''));
  if (process.argv.includes('--watch')) await watch(root);
  else await run(root);
}
