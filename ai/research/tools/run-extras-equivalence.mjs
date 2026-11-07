/** Bounded zero-projection compatibility verification. Never creates or updates an optimizer. */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { freemem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import {
  createModelPool,
  option,
  readJSON,
  sha256,
  writeJSON,
} from '../../danMCai/training/continuous/lib.mjs';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { analysisState } from '../../danMCai/evaluation/cooperation-labels.mjs';

export async function runEquivalence(run) {
  const task = readJSON(join(run, 'campaign-task.json')),
    protocol = join(run, 'protocol.json'),
    plan = readJSON(protocol);
  if (!task || sha256(protocol) !== task.protocolSHA256)
    throw Error('Unregistered or changed equivalence protocol');
  const stop = () =>
    existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC);
  const state = {
    pid: process.pid,
    phase: 'development',
    displayName: 'extras零投影学生 · 40000决策等价验证',
    positionUnit: '个等价验证决策',
    completedPositions: 0,
    plannedPositions: 40000,
    optimizerUpdates: 0,
    strengthGames: 0,
    updatedAt: new Date().toISOString(),
  };
  const save = () => {
    state.updatedAt = new Date().toISOString();
    writeJSON(join(run, 'status.json'), state);
  };
  if (stop()) {
    state.phase = 'stopped-before-spawn';
    save();
    return state;
  }
  for (const [file, hash] of Object.entries(plan.sourceSHA256))
    if (sha256(join(plan.sourceRoot, file)) !== hash) throw Error('Frozen source changed: ' + file);
  const teacher = join(run, 'models/champion.onnx'),
    student = join(run, 'models/student.onnx');
  if (sha256(teacher) !== plan.teacherSHA256 || sha256(student) !== plan.studentSHA256)
    throw Error('Frozen model changed');
  const catalog = join(plan.sourceRoot, 'web/src/ai/model-catalog.json');
  const baseline = join(plan.sourceRoot, 'ai/danMCai/models/baseline/policy.onnx');
  const catalogSHA = sha256(catalog),
    baselineSHA = sha256(baseline);
  const pool = await createModelPool(ort, { threads: 1, limit: 2, provider: 'cpu' });
  state.provider = 'CPUExecutionProvider（显式指定，单线程）';
  let maxAbsError = 0,
    exactArgmax = 0,
    tieOnlyMismatches = 0,
    nonTieMismatches = 0,
    valuesCompared = 0,
    phase = 'complete',
    completedDeals = 0,
    minimumAvailableGiB = freemem() / 1024 ** 3;
  const timer = setInterval(save, 3000);
  const launch = async (executable, args, log) => {
    if (stop()) throw Error('Equivalence deadline or STOP');
    const fd = openSync(join(run, log), 'a');
    const child = spawn(executable, args, {
      cwd: plan.sourceRoot,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: { ...process.env, OMP_NUM_THREADS: '1' },
    });
    closeSync(fd);
    const terminator = setInterval(() => {
      if (stop() && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32')
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        else child.kill();
      }
    }, 500);
    try {
      await new Promise((ok, fail) => {
        child.once('error', fail);
        child.once('exit', (code) =>
          code === 0 ? ok() : fail(Error(`Compatibility child exited ${code}: ${log}`)),
        );
      });
    } finally {
      clearInterval(terminator);
    }
  };
  try {
    outer: for (const seed of plan.nativeSeeds) {
      const game = createRound(seed);
      for (let ply = 0; ply < 1000; ply++) {
        if (stop()) throw Error('Equivalence deadline or STOP');
        minimumAvailableGiB = Math.min(minimumAvailableGiB, freemem() / 1024 ** 3);
        if (freemem() < plan.reserveGiB * 1024 ** 3) {
          state.phase = 'waiting-for-memory';
          save();
          while (freemem() < plan.resumeGiB * 1024 ** 3 && !stop())
            await new Promise((r) => setTimeout(r, 1000));
          if (stop()) throw Error('Equivalence deadline or STOP');
          state.phase = 'development';
        }
        const p = game.turn,
          plays = candidates(game.hands[p], game.L, game.trick?.play);
        let chosen = 0;
        if (plays.length > 1) {
          const observation = analysisState(game, p, plays);
          const a = Array.from(await pool.values(teacher, observation));
          const b = Array.from(await pool.values(student, observation, { extraFeatures: 53 }));
          if (a.length !== b.length || !a.every(Number.isFinite) || !b.every(Number.isFinite))
            throw Error('Invalid equivalent outputs');
          const argmax = (values) =>
            values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
          chosen = argmax(a);
          const other = argmax(b);
          if (chosen === other) exactArgmax++;
          else if (a[chosen] === a[other]) tieOnlyMismatches++;
          else nonTieMismatches++;
          for (let i = 0; i < a.length; i++)
            maxAbsError = Math.max(maxAbsError, Math.abs(a[i] - b[i]));
          valuesCompared += a.length;
          state.completedPositions++;
          if (nonTieMismatches || maxAbsError > 1e-4)
            throw Error('Zero-projection equivalence failed; block successor input training');
          if (state.completedPositions === 40000) break outer;
        }
        if (advanceRound(game, plays[chosen])) {
          completedDeals++;
          break;
        }
        if (ply === 999) throw Error('Equivalence trajectory truncated');
      }
      state.completedDeals = completedDeals;
    }
    await pool.close();
    if (state.completedPositions !== 40000) throw Error('Insufficient complete decision fixtures');
    state.phase = 'checking-browser';
    save();
    await launch(
      plan.python,
      [
        join(plan.sourceRoot, 'web/tests/policy_browser_smoke.py'),
        '--model',
        student,
        '--fixture-policy',
        teacher,
        '--fixture-seeds',
        protocol,
        '--raw-fixtures',
        '--strict-argmax',
        '--output',
        join(run, 'browser'),
        '--stop-file',
        join(run, 'STOP'),
        '--deadline',
        task.window.deadlineUTC,
      ],
      'browser.log',
    );
    state.phase = 'checking-publication-compatibility';
    save();
    await launch(
      process.execPath,
      [
        join(plan.sourceRoot, 'ai/publishing/publish-web-model.mjs'),
        `--model=${student}`,
        `--config=${join(run, 'student-config.json')}`,
        '--source=danMCai-zero-extras-equivalence',
        '--version=zero-extras-from-017',
      ],
      'publish-prepare.log',
    );
    if (sha256(catalog) !== catalogSHA || sha256(baseline) !== baselineSHA)
      throw Error('Catalog or baseline changed');
  } catch (e) {
    phase = stop() ? 'incomplete-deadline' : 'failed';
    state.failure = e.stack;
  } finally {
    await pool.close();
    clearInterval(timer);
    const browser = readJSON(join(run, 'browser/report.json'));
    const summary = {
      schema: 1,
      kind: 'zero-projection-equivalence-not-training-or-strength',
      phase,
      protocolSHA256: task.protocolSHA256,
      completedAtUTC: new Date().toISOString(),
      decisions: state.completedPositions,
      completeDevelopmentDeals: completedDeals,
      exactArgmax,
      tieOnlyMismatches,
      nonTieMismatches,
      maxAbsError,
      valuesCompared,
      teacherSHA256: plan.teacherSHA256,
      studentSHA256: plan.studentSHA256,
      provider: 'onnxruntime-node CPU, one thread per session',
      minimumAvailableGiB,
      browser,
      catalogUnchanged: sha256(catalog) === catalogSHA,
      baselineUnchanged: sha256(baseline) === baselineSHA,
      passed:
        phase === 'complete' &&
        state.completedPositions === 40000 &&
        !nonTieMismatches &&
        maxAbsError <= 1e-4 &&
        browser?.positions === 48,
      optimizerUpdates: 0,
      webChampionChanged: false,
      limitations:
        'Equivalent student only. Ordinary oracle extras context remains incomplete; no live deployment, optimizer continuation or online extras training authorized.',
    };
    writeJSON(join(run, 'summary.json'), summary);
    state.phase = phase;
    state.stoppedAt = new Date().toISOString();
    save();
  }
  return state;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url))
  await runEquivalence(resolve(option('run', '')));
