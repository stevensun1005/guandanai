/** Deadline protection for the owner's Nov 7–11 research campaign, independent of training. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { option, readJSON, sha256, writeJSON } from '../../danMCai/training/continuous/lib.mjs';

export const HARD_DEADLINE = '2026-11-11T17:00:00.000Z';
export const COMPUTE_DEADLINE = '2026-11-11T16:45:00.000Z';

export function validateCampaign(campaign) {
  if (
    campaign?.deadlineUTC !== HARD_DEADLINE ||
    campaign.computeDeadlineUTC !== COMPUTE_DEADLINE ||
    campaign.restartExtendsDeadline !== false
  )
    throw Error('Campaign deadline cannot be extended or replaced');
  return campaign;
}

export function researchWindow(campaign, existing, hours, now = Date.now()) {
  validateCampaign(campaign);
  if (!Number.isFinite(hours) || hours <= 0) throw Error('Specify a positive experiment budget');
  const end = Date.parse(COMPUTE_DEADLINE);
  const window = existing ?? {
    startUTC: new Date(now).toISOString(),
    deadlineUTC: new Date(Math.min(now + hours * 3600000, end)).toISOString(),
    requestedHours: hours,
    restartExtendsDeadline: false,
  };
  if (
    window.requestedHours !== hours ||
    window.restartExtendsDeadline !== false ||
    Date.parse(window.deadlineUTC) > end ||
    Date.parse(window.deadlineUTC) !== Math.min(Date.parse(window.startUTC) + hours * 3600000, end)
  )
    throw Error('Cannot alter the saved experiment window');
  const remainingSeconds = (Date.parse(window.deadlineUTC) - now) / 1000;
  if (!(remainingSeconds > 0)) throw Error('Experiment or campaign has expired');
  return { window, remainingSeconds };
}

export function safeRun(campaignRoot, run) {
  const root = realpathSync(join(campaignRoot, 'experiments'));
  const actual = realpathSync(run);
  const name = relative(root, actual);
  if (!name || name.startsWith('..') || isAbsolute(name))
    throw Error('Only dedicated campaign experiments may be registered');
  return actual;
}

export function enforceDeadlines(root, tasks, now = Date.now(), forcedReason = null) {
  const globallyStopped =
    now >= Date.parse(COMPUTE_DEADLINE) || existsSync(join(root, 'STOP')) || forcedReason;
  const stopped = [];
  const rejected = [];
  for (const task of tasks) {
    let run;
    try {
      run = safeRun(root, task.run);
    } catch (error) {
      rejected.push({ id: task.id, reason: error.message });
      continue;
    }
    if (!globallyStopped && now < Date.parse(task.window.deadlineUTC)) continue;
    for (const directory of [run, join(run, 'evaluation')]) {
      if (!existsSync(directory)) continue;
      try {
        safeRun(root, directory);
      } catch (error) {
        rejected.push({ id: task.id, reason: error.message });
        continue;
      }
      const file = join(directory, 'STOP');
      if (!existsSync(file))
        writeJSON(file, {
          reason:
            forcedReason || (globallyStopped ? 'campaign-compute-deadline' : 'experiment-deadline'),
          atUTC: new Date(now).toISOString(),
        });
    }
    stopped.push(task.id);
  }
  return { globallyStopped: Boolean(globallyStopped), stopped, rejected };
}

async function main() {
  const root = resolve(option('campaign', ''));
  const file = join(root, 'campaign.json');
  const campaign = validateCampaign(readJSON(file));
  const digest = sha256(file);
  const registry = join(root, 'tasks.json');
  if (option('register', '')) {
    if (existsSync(join(root, 'STOP'))) throw Error('Campaign is stopped');
    const run = safeRun(root, resolve(option('register', '')));
    const protocol = resolve(option('protocol', ''));
    if (!readJSON(protocol)?.purpose)
      throw Error('Preregister an experiment purpose and protocol first');
    const taskFile = join(run, 'campaign-task.json');
    const existing = readJSON(taskFile);
    const plan = researchWindow(campaign, existing?.window, Number(option('hours', '0')));
    if (existing && (existing.protocolSHA256 !== sha256(protocol) || existing.run !== run))
      throw Error('Registered protocol changed');
    const task = existing ?? {
      id: relative(realpathSync(join(root, 'experiments')), run),
      run,
      protocol,
      protocolSHA256: sha256(protocol),
      window: plan.window,
    };
    if (!existing) writeJSON(taskFile, task);
    const tasks = readJSON(registry, []);
    if (!tasks.some((t) => t.id === task.id)) {
      tasks.push(task);
      writeJSON(registry, tasks);
    }
    console.log(
      JSON.stringify({
        ...task,
        remainingSeconds: plan.remainingSeconds,
        instruction:
          'Launch with this remaining budget; all workers must honor this run STOP. Registration itself starts no training.',
      }),
    );
    return;
  }
  if (!process.argv.includes('--watch')) {
    console.log(JSON.stringify({ campaign, tasks: readJSON(registry, []), startsTraining: false }));
    return;
  }
  const lock = join(root, 'deadline-guardian.lock');
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  let interval, timer;
  let known = [];
  const tick = () => {
    let reason = null;
    try {
      if (sha256(file) !== digest) throw Error('Campaign manifest changed');
      const next = JSON.parse(readFileSync(registry, 'utf8'));
      if (!Array.isArray(next)) throw Error('Invalid campaign task registry');
      for (const task of next)
        researchWindow(
          campaign,
          task.window,
          task.window.requestedHours,
          Math.min(Date.now(), Date.parse(task.window.deadlineUTC) - 1),
        );
      known = next;
    } catch (error) {
      reason = error.message;
    }
    const result = enforceDeadlines(root, known, Date.now(), reason);
    writeJSON(join(root, 'guardian-status.json'), {
      pid: process.pid,
      updatedAtUTC: new Date().toISOString(),
      computeDeadlineUTC: COMPUTE_DEADLINE,
      deadlineUTC: HARD_DEADLINE,
      registeredTasks: known.length,
      ...result,
      failure: reason,
    });
    if (result.globallyStopped) {
      if (!existsSync(join(root, 'STOP')))
        writeJSON(join(root, 'STOP'), { reason: reason || 'campaign-compute-deadline' });
      clearInterval(interval);
      clearTimeout(timer);
      unlinkSync(lock);
    }
  };
  interval = setInterval(tick, 3000);
  timer = setTimeout(tick, Math.max(0, Date.parse(COMPUTE_DEADLINE) - Date.now()));
  tick();
  console.log(
    JSON.stringify({
      guardianPID: process.pid,
      campaignRoot: root,
      computeDeadlineUTC: COMPUTE_DEADLINE,
      deadlineUTC: HARD_DEADLINE,
      startsTraining: false,
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
)
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
