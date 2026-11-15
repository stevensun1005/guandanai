/** One bounded, owner-authorized human imitation run; never edits a published model. */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';

export function validateImitationProtocol(p, now = Date.now()) {
  const times = [p.startedAtUTC, p.trainingDeadlineUTC, p.deadlineUTC].map(Date.parse);
  if (
    !times.every(Number.isFinite) ||
    times[0] > now ||
    !(times[0] < times[1]) ||
    p.id !== 'human-imitation-overall-20261115' ||
    !p.humanTrainingAuthorized ||
    p.webDeploymentAuthorized !== false ||
    p.restartExtendsDeadline !== false ||
    p.maxEpochs !== 40 ||
    p.patience !== 4 ||
    p.minDelta !== 0.0001 ||
    Date.parse(p.trainingDeadlineUTC) - Date.parse(p.startedAtUTC) > 3600000 ||
    Date.parse(p.deadlineUTC) - Date.parse(p.startedAtUTC) > 5400000 ||
    !(
      now < Date.parse(p.trainingDeadlineUTC) &&
      Date.parse(p.trainingDeadlineUTC) < Date.parse(p.deadlineUTC)
    )
  )
    throw Error('Invalid bounded human imitation registration');
}

async function main() {
  const root = resolve(process.argv.find((x) => x.startsWith('--run='))?.slice(6));
  const planFile = join(root, 'protocol.json'),
    plan = JSON.parse(readFileSync(planFile, 'utf8')),
    reg = JSON.parse(readFileSync(join(root, 'registration.json'), 'utf8'));
  validateImitationProtocol(plan);
  if (
    sha256(planFile) !== reg.protocolSHA256 ||
    sha256(plan.initialModel) !== plan.initialModelSHA256 ||
    existsSync(join(root, 'STOP')) ||
    existsSync(join(root, 'FINISHED'))
  )
    throw Error('Changed or closed run');
  for (const [file, hash] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, file)) !== hash) throw Error('Frozen source changed');
  const lock = join(root, 'controller.lock');
  closeSync(openSync(lock, 'wx'));
  const log = openSync(join(root, 'controller.log'), 'a'),
    children = [],
    history = [];
  let phase = 'prepare',
    timer,
    awake;
  const tick = () => {
    if (sha256(planFile) !== reg.protocolSHA256)
      writeJSON(join(root, 'STOP'), { reason: 'protocol-changed' });
    if (Date.now() >= Date.parse(plan.trainingDeadlineUTC))
      writeJSON(join(root, 'TRAIN_STOP'), { reason: 'training-cap' });
    if (Date.now() >= Date.parse(plan.deadlineUTC))
      writeJSON(join(root, 'STOP'), { reason: 'overall-cap' });
    if (freemem() < 4 * 2 ** 30 && !existsSync(join(root, 'MEMORY_PAUSE')))
      writeJSON(join(root, 'MEMORY_PAUSE'), { reason: 'four-GiB reserve' });
    if (freemem() >= 5 * 2 ** 30 && existsSync(join(root, 'MEMORY_PAUSE')))
      unlinkSync(join(root, 'MEMORY_PAUSE'));
    let learner = null;
    try {
      learner = JSON.parse(readFileSync(join(root, 'learner-status.json'), 'utf8'));
    } catch {}
    writeJSON(join(root, 'progress.json'), {
      pid: process.pid,
      phase,
      displayName: '真人整体行为模仿（029起点）',
      currentTask: learner?.phase || phase,
      analysis: '真人实际动作监督；不使用少炸/多过牌等手工奖励，不代表胜率',
      nextTask: '验证早停、一次回顾性留出、保存研究包',
      learner,
      history,
      freeMemoryGiB: freemem() / 2 ** 30,
      deadlineUTC: plan.deadlineUTC,
    });
  };
  const run = (cmd, args) =>
    new Promise((ok, fail) => {
      const c = spawn(cmd, args, {
        windowsHide: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, OMP_NUM_THREADS: '1', PYTHONIOENCODING: 'utf-8' },
      });
      const record = { pid: c.pid, command: cmd, args, startedAtUTC: new Date().toISOString() };
      history.push(record);
      children.push(c);
      tick();
      c.once('error', fail);
      c.once('exit', (code, signal) => {
        record.exitCode = code;
        record.signal = signal;
        record.exitedAtUTC = new Date().toISOString();
        code === 0 ? ok() : fail(Error(cmd + ' exited ' + code));
      });
    });
  const stage = async (name, fn) => {
    phase = name;
    tick();
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
  try {
    timer = setInterval(tick, 3000);
    tick();
    awake = run('pwsh.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(plan.sourceRoot, 'ai/research/tools/evaluation-awake.ps1'),
      '-Run',
      root,
    ]);
    awake.catch((e) => {
      writeJSON(join(root, 'STOP'), { reason: 'awake-failed', error: String(e) });
    });
    appendFileSync(
      join(root, 'stages.log'),
      new Date().toISOString() + ' LAUNCH new human-imitation controller\n',
    );
    await stage('data', () =>
      run(process.execPath, [
        join(plan.sourceRoot, 'ai/research/tools/prepare-human-imitation.mjs'),
        '--protocol=' + planFile,
      ]),
    );
    while (
      freemem() < 6 * 2 ** 30 &&
      !existsSync(join(root, 'STOP')) &&
      Date.now() < Date.parse(plan.trainingDeadlineUTC)
    )
      await new Promise((r) => setTimeout(r, 1000));
    if (existsSync(join(root, 'STOP')) || Date.now() >= Date.parse(plan.trainingDeadlineUTC))
      throw Error('No training time/resources remain');
    const script = join(plan.sourceRoot, 'ai/danMCai/training/human_imitation.py');
    await stage('gpu', () =>
      run(plan.python, ['-B', '-X', 'utf8', script, '--protocol', planFile, '--preflight']),
    );
    await stage('fit', () =>
      run(plan.python, ['-B', '-X', 'utf8', script, '--protocol', planFile]),
    );
    const result = JSON.parse(readFileSync(join(root, 'results.json'), 'utf8'));
    if (
      sha256(join(root, 'human-imitation.onnx')) !== result.onnxSHA256 ||
      sha256(join(root, 'best.pt')) !== result.checkpointSHA256
    )
      throw Error('Final network/checkpoint changed');
    writeJSON(join(root, 'package-manifest.json'), {
      sourceCommit: plan.sourceCommit,
      protocolSHA256: reg.protocolSHA256,
      modelSHA256: result.onnxSHA256,
      archiveSHA256: sha256(join(root, 'human-imitation-research.zip')),
      retrospectiveImitationImproved: result.retrospectiveImitationImproved,
      strengthAccepted: false,
      webPublished: false,
    });
    phase = 'complete';
  } catch (e) {
    phase = 'failed';
    writeJSON(join(root, 'STOP'), { reason: 'controller-failure' });
    writeJSON(join(root, 'failure.json'), {
      error: String(e.stack || e),
      atUTC: new Date().toISOString(),
    });
  } finally {
    writeJSON(join(root, 'FINISHED'), { phase, atUTC: new Date().toISOString() });
    if (awake) await awake.catch(() => {});
    clearInterval(timer);
    tick();
    writeJSON(join(root, 'completion-audit.json'), {
      phase,
      children: history,
      verifiedProtocolSHA256: sha256(planFile),
      sourceCommit: plan.sourceCommit,
      atUTC: new Date().toISOString(),
    });
    closeSync(log);
    unlinkSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
