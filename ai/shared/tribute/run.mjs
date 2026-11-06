/** Bounded specialist sampling and full-network fitting, independent of both active main trainers. */
import { spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freemem, setPriority, constants } from 'node:os';
import { createHash } from 'node:crypto';
import { continuation } from './neural.mjs';
import { sampleDecision, saveDecision } from './dataset.mjs';
import { readJSON, writeJSON, option } from '../../danMCai/training/continuous/lib.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const sourceHash = (file) =>
  createHash('sha256').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
export const SPECIALIST_SEEDS = {
  smoke: 3799000000,
  train: 3800000000,
  development: 3900000000,
  independent: 4000000000,
};

async function main() {
  const run = resolve(root, option('run', 'ai/danMCai/runs/tribute-20261106')),
    python = option('python', 'python');
  mkdirSync(run, { recursive: true });
  const lock = join(run, 'specialist.lock'),
    oldLock = readJSON(lock);
  if (oldLock) {
    try {
      process.kill(oldLock.pid, 0);
      throw Error('Specialist lock is active');
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
    }
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  try {
    const protocol = readJSON(join(run, 'protocol.json'));
    if (!protocol) throw Error('Prepare and commit a protocol before starting');
    const protocolSHA = hash(join(run, 'protocol.json')),
      deadline = Date.parse(protocol.deadlineUTC);
    if (!Number.isFinite(deadline)) throw Error('Invalid deadline');
    for (const [file, sha] of Object.entries(protocol.sourceSHA256 || {}))
      if (sourceHash(join(root, file)) !== sha)
        throw Error('Frozen specialist source changed: ' + file);
    try {
      setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
    const state = readJSON(join(run, 'progress.json'), {
      iteration: 0,
      trainSeeds: 0,
      developmentSeeds: 0,
      trainingGroups: 0,
      developmentGroups: 0,
      rows: 0,
      completedCounterfactualRounds: 0,
      skippedCases: 0,
    });
    if (state.protocolSHA && state.protocolSHA !== protocolSHA)
      throw Error('Existing specialist protocol changed');
    const previous = state.pid;
    if (previous && !['stopped', 'failed', 'complete', 'awaiting-fusion'].includes(state.stage)) {
      try {
        process.kill(previous, 0);
        throw Error('Specialist already running');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
    }
    Object.assign(state, {
      pid: process.pid,
      kind: 'development-training',
      startedUTC: state.startedUTC || new Date().toISOString(),
      deadlineUTC: protocol.deadlineUTC,
      protocolSHA,
      stage: 'loading',
      sourceModels: protocol.models.map((m) => ({
        id: m.id,
        version: m.source.version,
        sha256: m.sha256,
      })),
    });
    const initialCPU = process.cpuUsage(),
      initialTime = Date.now();
    const save = () =>
      writeJSON(join(run, 'progress.json'), {
        ...state,
        updatedUTC: new Date().toISOString(),
        freeGiB: freemem() / 2 ** 30,
        rssMiB: process.memoryUsage().rss / 2 ** 20,
        cpuCorePercent:
          (100 *
            ((process.cpuUsage(initialCPU).user + process.cpuUsage(initialCPU).system) / 1000)) /
          Math.max(1, Date.now() - initialTime),
      });
    save();
    const teachers = [];
    let lastSave = 0,
      lastFit = Date.now();
    const stop = () => Date.now() >= deadline || existsSync(join(run, 'STOP'));
    async function check() {
      if (stop()) throw Error('SPECIALIST_STOP');
      while (freemem() < 4 * 2 ** 30) {
        state.stage = 'memory-pause';
        save();
        await new Promise((r) => setTimeout(r, 2000));
        if (stop()) throw Error('SPECIALIST_STOP');
      }
      if (Date.now() - lastSave > 5000) {
        lastSave = Date.now();
        for (const [file, sha] of Object.entries(protocol.sourceSHA256 || {}))
          if (sourceHash(join(root, file)) !== sha)
            throw Error('Frozen specialist source changed: ' + file);
        state.stage = 'sampling';
        state.teachers = teachers.map((t) => t.stats);
        save();
      }
    }
    async function train() {
      if (
        stop() ||
        state.trainingGroups < 8 ||
        state.developmentGroups < 4 ||
        freemem() < 5 * 2 ** 30
      )
        return;
      state.stage = 'fitting';
      save();
      await new Promise((ok, fail) => {
        const child = spawn(
          python,
          [
            '-u',
            join(root, 'ai/shared/tribute/train.py'),
            `--run=${run}`,
            '--device=cuda:0',
            '--epochs=20',
          ],
          {
            cwd: root,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
          },
        );
        let output = '';
        child.stdout.on('data', (x) => (output = (output + x).slice(-20000)));
        child.stderr.on('data', (x) => (output = (output + x).slice(-20000)));
        const monitor = setInterval(() => {
          const flag = join(run, 'PAUSE_TRAINER');
          if (freemem() < 4 * 2 ** 30) writeFileSync(flag, 'memory reserve');
          else if (existsSync(flag)) unlinkSync(flag);
        }, 1000);
        child.on('error', (e) => {
          clearInterval(monitor);
          fail(e);
        });
        child.on('exit', (code) => {
          clearInterval(monitor);
          state.learner = readJSON(join(run, 'learner/status.json'));
          state.lastTrainingOutput = output.slice(-4000);
          save();
          code === 0 ? ok() : fail(Error('Specialist learner failed: ' + output.slice(-1500)));
        });
      });
      lastFit = Date.now();
    }
    try {
      for (const model of protocol.models) {
        teachers.push(
          await continuation(root, model, { provider: 'dml', delayMs: protocol.delayMs ?? 0 }),
        );
        save();
      }
      while (!stop()) {
        await check();
        const i = state.iteration++,
          head = Math.floor(i / 2) % 2,
          stage = i % 2 ? 'return' : 'tribute',
          split = Math.floor(i / 4) % 10 === 0 ? 'development' : 'train';
        const counter = split === 'train' ? 'trainSeeds' : 'developmentSeeds',
          seed = SPECIALIST_SEEDS[split] + state[counter]++;
        state.current = { seed, head, stage, split };
        save();
        const sample = await sampleDecision({
          seed,
          head,
          stage,
          teacher: teachers[head],
          check,
          onProgress: (p) => {
            state.current = { ...state.current, ...p };
          },
        });
        if (sample) {
          state.rows += saveDecision(run, split, sample, protocolSHA);
          state[split === 'train' ? 'trainingGroups' : 'developmentGroups']++;
          state.completedCounterfactualRounds += sample.meta.rows;
        } else state.skippedCases++;
        state.teachers = teachers.map((t) => t.stats);
        save();
        if (
          Date.now() - lastFit > 10 * 60000 ||
          (!existsSync(join(run, 'learner/best.json')) &&
            state.trainingGroups >= 8 &&
            state.developmentGroups >= 4)
        )
          await train();
      }
    } catch (error) {
      if (error.message !== 'SPECIALIST_STOP') {
        state.stage = 'failed';
        state.error = error.stack;
        save();
        throw error;
      }
    } finally {
      for (const teacher of teachers) await teacher.close();
    }
    state.stage = 'stopped';
    state.stoppedUTC = new Date().toISOString();
    state.stopReason = Date.now() >= deadline ? 'time-limit' : 'operator-stop';
    state.best = readJSON(join(run, 'learner/best.json'));
    save();
    // The separately versioned integration worker is prepared while frozen sampling runs.
    const finalize =
      protocol.finalizeRoot && join(protocol.finalizeRoot, 'ai/publishing/finalize-tribute.mjs');
    if (state.stopReason === 'time-limit' && finalize && existsSync(finalize)) {
      state.stage = 'fusion-validation';
      save();
      await new Promise((ok, fail) => {
        const child = spawn(process.execPath, [finalize, `--run=${run}`, `--python=${python}`], {
          cwd: protocol.finalizeRoot,
          windowsHide: true,
          stdio: 'inherit',
        });
        child.on('error', fail);
        child.on('exit', (code) => (code === 0 ? ok() : fail(Error('Fusion validation failed'))));
      });
      state.stage = 'complete';
      state.fusion = readJSON(join(run, 'fusion.json'));
      save();
    } else {
      state.stage = 'awaiting-fusion';
      state.note = 'Training stopped at deadline; run finalize-tribute with preserved weights';
      save();
    }
  } finally {
    if (readJSON(lock)?.pid === process.pid) unlinkSync(lock);
  }
}
if (
  process.argv[1] &&
  pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
)
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
