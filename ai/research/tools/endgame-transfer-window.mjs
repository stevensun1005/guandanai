/** One preregistered endgame transfer window: train, stop audit, paired final/initial/r2 evaluation. */
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { fork, spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';
import { isMain } from '../../danMCai/endgame/platform.mjs';
import { clusterInterval, pathInCommands } from './window-dashboard.mjs';
import { appendFileSync } from 'node:fs';

const SELF = fileURLToPath(import.meta.url);
const sleep = () => new Promise((r) => setTimeout(r, 3000));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const log = (root, text) =>
  appendFileSync(join(root, 'stages.log'), `${new Date().toISOString()} ${text}\n`);
const stop = (root, reason) => {
  for (const dir of [root, join(root, 'train')])
    if (!existsSync(join(dir, 'STOP')))
      writeJSON(join(dir, 'STOP'), { reason, atUTC: new Date().toISOString() });
};

export function validateWindow(plan, reg, now = Date.now()) {
  const start = Date.parse(reg.startUTC);
  if (plan.ownerDeadlineAmendment) {
    const amendment = plan.ownerDeadlineAmendment,
      end = Date.parse(reg.trainingDeadlineUTC);
    if (
      amendment.kind !== 'owner-explicit-deadline-revision' ||
      amendment.trainingDeadlineUTC !== '2026-11-13T10:00:00.000Z' ||
      end !== Date.parse(amendment.trainingDeadlineUTC) ||
      reg.startUTC !== amendment.originalStartUTC ||
      Math.abs(plan.run.hours - (end - start) / 3600000) > 1e-9 ||
      Math.abs(reg.durationHours - (end - start) / 3600000 - 3.25) > 1e-9 ||
      Date.parse(reg.evaluationDeadlineUTC) !== end + 3 * 3600000 ||
      Date.parse(reg.deadlineUTC) !== end + 3.25 * 3600000 ||
      reg.restartExtendsDeadline !== false ||
      !Number.isFinite(start) ||
      now >= end
    )
      throw Error('Invalid or expired explicit5AM training/8AM evaluation window');
    return;
  }
  if (
    plan.run.hours !== 16 ||
    reg.durationHours !== 19.25 ||
    reg.restartExtendsDeadline !== false ||
    Date.parse(reg.trainingDeadlineUTC) !== start + 16 * 3600000 ||
    Date.parse(reg.evaluationDeadlineUTC) !== start + 19 * 3600000 ||
    Date.parse(reg.deadlineUTC) !== start + 19.25 * 3600000 ||
    !Number.isFinite(start) ||
    now >= Date.parse(reg.trainingDeadlineUTC)
  )
    throw Error('Invalid or expired fixed16h training /3h evaluation /15min save registration');
}

async function watch(root) {
  const reg = readJSON(join(root, 'registration.json'));
  while (!existsSync(join(root, 'FINISHED'))) {
    if (Date.now() >= Date.parse(reg.trainingDeadlineUTC) && !existsSync(join(root, 'train/STOP')))
      writeJSON(join(root, 'train/STOP'), {
        reason: 'fixed-training-deadline',
        atUTC: new Date().toISOString(),
      });
    if (Date.now() >= Date.parse(reg.evaluationDeadlineUTC) || existsSync(join(root, 'STOP')))
      stop(root, 'evaluation-cutoff');
    writeJSON(join(root, 'guardian-status.json'), {
      pid: process.pid,
      ...reg,
      updatedAtUTC: new Date().toISOString(),
    });
    if (Date.now() >= Date.parse(reg.deadlineUTC)) return;
    await sleep();
  }
}

async function main(root) {
  if (existsSync(join(root, 'STOP')) || existsSync(join(root, 'FINISHED')))
    throw Error('Window already stopped or finished');
  const lock = join(root, 'controller.lock');
  closeSync(openSync(lock, 'wx'));
  const plan = readJSON(join(root, 'protocol.json')),
    reg = readJSON(join(root, 'registration.json'));
  let phase = 'preparing',
    timer,
    current;
  const observed = new Set();
  const tick = () => {
    const supervisor = readJSON(join(root, 'train/status.json'));
    const learner = readJSON(join(root, 'train/learner/status.json'));
    for (const pid of [
      current?.pid,
      learner?.pid,
      ...(supervisor?.children || []).map((c) => c.pid),
    ])
      if (pid) observed.add(pid);
    writeJSON(join(root, 'process-history.json'), { pids: [...observed] });
    writeJSON(join(root, 'progress.json'), {
      pid: process.pid,
      phase,
      displayName: '029底座尾盘增量迁移',
      currentTask: phase,
      analysis: learner
        ? `继承${learner.inherited?.step || 0}步，新增${learner.step - (learner.inherited?.step || 0)}更新；${learner.ingestedRows}新行`
        : '等待真实学习器状态',
      nextTask:
        phase === 'endgame-train' ? '最终停止审计及独立牌副A/B/C评测' : '按冻结协议执行下一阶段',
      learner,
      deadlineUTC: reg.deadlineUTC,
      updatedAtUTC: new Date().toISOString(),
    });
  };
  const execute = (key, command, args) =>
    new Promise((ok, fail) => {
      phase = key;
      log(root, `START ${key}`);
      tick();
      const fd = openSync(join(root, `${key}.log`), 'a');
      current = spawn(command, args, {
        cwd: plan.sourceRoot,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      current.once('error', fail);
      current.once('exit', (code) => {
        closeSync(fd);
        current = null;
        log(root, `END ${key} rc=${code}`);
        code === 0 ? ok() : fail(Error(`${key} exited ${code}`));
      });
    });
  try {
    validateWindow(plan, reg);
    if (sha256(join(root, 'protocol.json')) !== reg.protocolSHA256)
      throw Error('Protocol registration SHA mismatch');
    if (
      plan.ownerDeadlineAmendment &&
      sha256(join(root, plan.ownerDeadlineAmendment.authorizationFile)) !==
        plan.ownerDeadlineAmendment.authorizationSHA256
    )
      throw Error('Owner deadline authorization SHA mismatch');
    if (plan.recovery) {
      for (const [file, digest] of Object.entries(plan.recovery.files))
        if (sha256(join(root, file)) !== digest)
          throw Error('Recovery checkpoint/data manifest mismatch: ' + file);
    }
    for (const [file, digest] of [
      [plan.local.champion, plan.teacher.sha256],
      [plan.local.checkpoint, plan.learner.init.sha256],
      [plan.local.initialStudent, plan.transfer.initialStudentSHA256],
      [plan.local.r2Student, plan.transfer.r2StudentSHA256],
    ])
      if (sha256(file) !== digest) throw Error('Frozen model/checkpoint changed');
    for (const [f, digest] of Object.entries(plan.sourceSHA256))
      if (sha256(join(plan.sourceRoot, f)) !== digest) throw Error('Frozen source changed: ' + f);
    const guardian = fork(SELF, [`--run=${root}`, '--watch'], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    writeJSON(join(root, 'guardian-launch.json'), { pid: guardian.pid });
    timer = setInterval(tick, 3000);
    await execute('endgame-train', process.execPath, [
      join(plan.sourceRoot, 'ai/danMCai/endgame/run.mjs'),
      `--run=${join(root, 'train')}`,
      `--protocol=${join(root, 'protocol.json')}`,
      `--champion=${plan.local.champion}`,
      `--champion-sha=${plan.teacher.sha256}`,
      `--init-checkpoint=${plan.local.checkpoint}`,
      `--python=${plan.local.python}`,
    ]);
    for (let i = 0; i < 10 && [...observed].some(alive); i++) await sleep();
    let stillAlive = [...observed].filter(alive);
    if (stillAlive.length && process.platform === 'win32') {
      // PIDs can be reused during16h. Verify command scope, never stop an unrelated process.
      const processes = JSON.parse(
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
          ],
          { encoding: 'utf8', windowsHide: true, maxBuffer: 16 << 20 },
        ),
      );
      stillAlive = stillAlive.filter((pid) =>
        processes.some(
          (p) => p.ProcessId === pid && pathInCommands(p.CommandLine || '', join(root, 'train')),
        ),
      );
    }
    writeJSON(join(root, 'process-exit-audit.json'), {
      observedPids: [...observed],
      relatedStillAlive: stillAlive,
      method: 'Node process.kill(pid,0); Windows alivePID command scope rechecked for PID reuse',
    });
    if (stillAlive.length) throw Error('Training processes still alive: ' + stillAlive.join(','));
    await execute('endgame-audit', plan.local.python, [
      '-B',
      '-X',
      'utf8',
      join(plan.sourceRoot, 'ai/danMCai/endgame/stop_audit.py'),
      `--run=${join(root, 'train')}`,
      `--out=${join(root, 'stop-audit.json')}`,
    ]);
    const latest = readJSON(join(root, 'train/models/latest.json'));
    writeJSON(join(root, 'final-model.json'), latest);
    for (const [name, student] of [
      ['A', join(root, 'train/models', latest.file)],
      ['B', plan.local.initialStudent],
      ['C', plan.local.r2Student],
    ]) {
      if (existsSync(join(root, 'STOP'))) break;
      await execute(`endgame-eval-${name}`, process.execPath, [
        join(plan.sourceRoot, 'ai/danMCai/endgame/evaluate.mjs'),
        `--out=${join(root, 'eval-' + name)}`,
        `--student=${student}`,
        `--champion=${plan.local.champion}`,
        `--seeds=${plan.local.seedAudit}`,
        '--pairs=3000',
        '--threshold=32',
        '--solver-cards=18',
        `--workers=${plan.evaluation.workers}`,
        `--deadline=${reg.evaluationDeadlineUTC}`,
        `--stop-file=${join(root, 'STOP')}`,
      ]);
    }
    phase = 'endgame-summary';
    log(root, 'START endgame-summary');
    const rows = {};
    for (const name of ['A', 'B', 'C']) {
      const dir = join(root, 'eval-' + name),
        run = readJSON(join(dir, 'run.json'));
      rows[name] = new Map();
      for (let part = 0; part < (run?.workers || 0); part++)
        for (const row of readJSON(join(dir, `part-${part}.json`)) || []) {
          if (rows[name].has(row.seed)) throw Error('Duplicate evaluation seed');
          rows[name].set(row.seed, row.mean);
        }
    }
    const paired = (a, b) =>
      clusterInterval(
        [...rows[a]].filter(([s]) => rows[b].has(s)).map(([s, v]) => v - rows[b].get(s)),
      );
    const result = {
      complete: ['A', 'B', 'C'].every((n) => rows[n].size === 3000),
      completedPairs: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.size])),
      A: readJSON(join(root, 'eval-A/summary.json')),
      B: readJSON(join(root, 'eval-B/summary.json')),
      C: readJSON(join(root, 'eval-C/summary.json')),
      finalMinusRebasedInitial: paired('A', 'B'),
      finalMinusOriginalR2: paired('A', 'C'),
      rebasedInitialMinusOriginalR2: paired('B', 'C'),
      scope:
        'A final vs029; B transferred initialization vs029; C originalr2 vs029. Same3000 heldout deals, paired seat swap. Incomplete samples are partial, not the full preregistered conclusion. No automatic web deployment.',
      completedAtUTC: new Date().toISOString(),
    };
    writeJSON(join(root, 'results.json'), result);
    log(root, 'END endgame-summary rc=0');
    phase = result.complete ? 'complete' : 'partial';
  } catch (error) {
    phase = 'failed';
    stop(root, String(error));
    writeJSON(join(root, 'failure.json'), { error: String(error.stack || error) });
    throw error;
  } finally {
    clearInterval(timer);
    tick();
    writeJSON(join(root, 'FINISHED'), { phase, atUTC: new Date().toISOString() });
    unlinkSync(lock);
  }
}
if (isMain(import.meta.url)) {
  const root = resolve(option('run', ''));
  (process.argv.includes('--watch') ? watch(root) : main(root)).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
