import { validateWindow } from './window.mjs';
import { calendarSlot } from './calendar-slot.mjs';
/** Register one twelve-hour io48 checkpoint using the evaluator pinned by its launcher. */
import {
  mkdirSync,
  linkSync,
  existsSync,
  openSync,
  closeSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { THREE_OPPONENT_PANEL, TWO_OPPONENT_PANEL } from './opponents.mjs';
import { addSuite } from './development-suite.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

export function windowSlot(window, now) {
  const { start, end } = validateWindow(window);
  const final = now >= end;
  const slot = final
    ? Math.ceil((end - start) / (12 * 3600000))
    : Math.floor((now - start) / (12 * 3600000));
  if (slot < 1) throw Error('No evaluation due yet');
  const historical = [5098, 5100, 5101, 5103];
  const index = final && window.extension ? 5150 : (historical[slot - 1] ?? 5120 + slot - 5);
  return { slot, index, final, due: final ? end : start + slot * 12 * 3600000 };
}

async function register(launcherPath, armMidpoint) {
  const base = dirname(realpathSync(launcherPath));
  const { readFileSync } = await import('node:fs');
  const launcher = JSON.parse(readFileSync(launcherPath, 'utf8'));
  const run = realpathSync(launcher.run);
  if (
    dirname(run) !== base ||
    run !== join(base, 'guanzero-adp-io48') ||
    launcher.commit !== 'af2a6835f9dde38c16a8465eb53cbfacfa9e1f52'
  )
    throw Error('Unexpected active run or evaluator');
  const { execFileSync } = await import('node:child_process');
  const sourceRoot = realpathSync(launcher.sourceRoot);
  if (
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !==
    launcher.commit
  )
    throw Error('Frozen evaluator checkout changed');
  const load = (name) => import(pathToFileURL(join(sourceRoot, 'ai/guanzero/training', name)).href);
  const { readJSON, writeJSON, sha256 } = await load('lib.mjs');
  const window = readJSON(join(run, 'window.json'));
  const midpoint = Date.parse(window.midpointAt);
  if (armMidpoint) {
    // The frozen supervisor reuses its named midpoint file and registered plan.
    // Stage both just before its timer, leaving the running trainer untouched.
    const target = midpoint - 30000;
    console.log(JSON.stringify({ action: 'armed', prepareAt: new Date(target).toISOString() }));
    if (Date.now() < target) await sleep(target - Date.now());
    if (Date.now() >= midpoint - 10000) throw Error('Too late to stage the midpoint safely');
  }
  const schedulePath = join(base, 'evaluation-schedule.json');
  const selected =
    !armMidpoint && existsSync(schedulePath)
      ? calendarSlot(window, Date.now(), readJSON(schedulePath))
      : windowSlot(window, armMidpoint ? midpoint : Date.now());
  const { slot, index, due, final } = selected;
  const directory = join(run, 'eval', 'development-500');
  const path = join(directory, 'manifest.json');
  const lock = join(directory, '.window-registration.lock');
  const handle = openSync(lock, 'wx');
  try {
    const manifest = readJSON(path);
    if (!manifest?.suites?.length) throw Error('Missing initial transition suite');
    const existing = manifest.suites.find((p) => p.index === index);
    if (existing && slot !== 2) return { slot, action: 'registered', id: existing.id };
    if (slot === 2 && !armMidpoint) {
      if (!existing || ![THREE_OPPONENT_PANEL, TWO_OPPONENT_PANEL].includes(existing.opponentPanel))
        throw Error('Midpoint registered-opponent plan missing; inspect supervisor');
      return { slot, action: 'midpoint-supervisor', id: existing.id };
    }
    if (Date.now() - due > 2 * 3600000)
      throw Error('Missed freeze window; do not backfill with a newer export');
    if (final && existsSync(join(run, 'supervisor.lock')))
      throw Error('Wait for final training export');
    if (!final && existsSync(join(run, 'STOP'))) throw Error('Training stopped early');
    if (slot > 2 && !existsSync(join(run, 'eval', 'midpoint-complete.json')))
      throw Error('Wait for the midpoint supervisor');
    // The frozen one-shot worker only reads registered suites for this window.
    // The midpoint owns both registration and evaluation during its dedicated slot.
    const latest =
      existing && armMidpoint
        ? { file: existing.modelVersion + '.onnx', version: Number(existing.modelVersion.slice(6)) }
        : readJSON(join(run, 'models', 'latest.json'));
    if (
      !/^model-\d+\.onnx$/.test(latest.file) ||
      Number(latest.file.slice(6, -5)) !== latest.version
    )
      throw Error('Invalid checkpoint identity');
    const model = join(run, 'models', latest.file),
      id = latest.file.slice(0, -5);
    if (armMidpoint && existing) {
      if (![THREE_OPPONENT_PANEL, TWO_OPPONENT_PANEL].includes(existing.opponentPanel))
        throw Error('Midpoint panel mismatch');
      pinMidpoint(run, directory, existing, sha256);
      return { slot, action: 'midpoint-ready', id };
    }
    const digest = sha256(model);
    if (manifest.suites.some((p) => p.modelSHA256 === digest))
      return { slot, action: 'same-weights', sha256: digest };
    manifest.seedIndexBase = index - manifest.suites.length;
    const reasonRuntime = readJSON(join(base, 'reason-evaluation-launcher.json'), null);
    if (!reasonRuntime) throw Error('Missing frozen reason evaluation launcher');
    await addSuite(run, manifest, {
      id,
      version: id,
      model,
      championRoot: window.championRoot,
      reasonRuntime,
    });
    const plan = manifest.suites.at(-1);
    if (plan.index !== index || plan.modelSHA256 !== digest) throw Error('Frozen plan mismatch');
    if (armMidpoint) pinMidpoint(run, directory, plan, sha256);
    if (slot < 2) {
      manifest.seedIndexBase = window.seedIndex - manifest.suites.length;
      writeJSON(path, manifest);
    }
    return { slot, action: 'registered', id, index, sha256: digest, champion: plan.champion.name };
  } finally {
    closeSync(handle);
    unlinkSync(lock);
  }
}

function pinMidpoint(run, directory, plan, sha256) {
  const pinned = join(run, 'eval', 'midpoint-snapshot');
  mkdirSync(pinned, { recursive: true });
  const target = join(pinned, plan.modelVersion + '.onnx');
  if (!existsSync(target)) linkSync(join(directory, plan.id, 'model.onnx'), target);
  if (sha256(target) !== plan.modelSHA256) throw Error('Midpoint snapshot mismatch');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Pass the active dashboard-launcher.json path');
  console.log(
    JSON.stringify(await register(process.argv[2], process.argv.includes('--arm-midpoint'))),
  );
}
