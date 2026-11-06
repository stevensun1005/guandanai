/** Paired 500-match development suites beside a read-only frozen trainer. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  copyFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPriority, constants } from 'node:os';
import { modelBytes } from '../../publishing/artifacts.mjs';
import { evaluate } from './evaluate.mjs';
import { DEFAULT_OPPONENTS, THREE_OPPONENT_PANEL } from './opponents.mjs';
import { freezeChampion, championDefinition } from './champion.mjs';
import { ROOT, paths, readJSON, writeJSON, option, sha256, evalSeed } from './lib.mjs';
export const SUITE_PAIRS = 250;
export const SUITE_SEED_INDEX = 5000; // 4,200,000,000+, disjoint from legacy blocks.
import { validSuiteReport } from './suite-reports.mjs';
export { validSuiteReport } from './suite-reports.mjs';
export async function addSuite(
  run,
  manifest,
  { id, model, version, sourceBlock = null, championRoot = ROOT },
) {
  if (!/^[a-z0-9-]+$/.test(id)) throw Error('Invalid development suite ID');
  const p = paths(run),
    directory = join(p.eval, 'development-500'),
    folder = join(directory, id);
  if (manifest.suites.some((s) => s.id === id)) return;
  const digest = sha256(model);
  if (manifest.suites.some((s) => s.modelSHA256 === digest)) return;
  if (existsSync(folder)) throw Error('Unregistered suite folder; preserve evidence and inspect');
  const definition = championDefinition(championRoot);
  // Fetch/validate before reserving a suite folder so a transient download can retry.
  await modelBytes(championRoot, definition.artifact);
  mkdirSync(folder, { recursive: true });
  const champion = await freezeChampion(folder, definition, championRoot);
  copyFileSync(model, join(folder, 'model.onnx'));
  if (sha256(join(folder, 'model.onnx')) !== digest) throw Error('GuanZero freeze changed');
  const index = (manifest.seedIndexBase ?? SUITE_SEED_INDEX) + manifest.suites.length,
    start = evalSeed(index, SUITE_PAIRS);
  const plan = {
    id,
    protocol: 'development-500-v1',
    purpose: 'development-not-heldout-acceptance',
    modelVersion: version,
    modelSHA256: digest,
    sourceBlock,
    index,
    pairs: SUITE_PAIRS,
    seedStart: start,
    seedEnd: start + SUITE_PAIRS - 1,
    opponentPanel: THREE_OPPONENT_PANEL,
    opponents: [...DEFAULT_OPPONENTS],
    champion: champion.metadata,
    createdAt: new Date().toISOString(),
  };
  writeJSON(join(folder, 'plan.json'), plan);
  manifest.suites.push(plan);
  writeJSON(join(directory, 'manifest.json'), manifest);
}
export async function runDevelopmentSuites({
  run,
  fromBlock = 3,
  guardianState = null,
  once = false,
  pollMs = 30000,
  championRoot = ROOT,
}) {
  const p = paths(run),
    directory = join(p.eval, 'development-500');
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, '.lock'),
    status = join(directory, 'status.json');
  if (existsSync(lock)) {
    const old = readJSON(lock);
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') alive = false;
      else throw e;
    }
    if (alive) throw Error('Development suite companion already running');
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  const manifest = readJSON(join(directory, 'manifest.json'), {
    protocol: 'development-500-v1',
    suites: [],
  });
  const state = { pid: process.pid, phase: 'starting', targetMatchesPerOpponent: 500, fromBlock };
  const save = () => writeJSON(status, { ...state, updatedAt: new Date().toISOString() });
  try {
    save();
    if (!manifest.suites.length) {
      const latest = readJSON(join(p.models, 'latest.json'));
      if (!/^model-\d+\.onnx$/.test(latest.file)) throw Error('Unsafe latest model path');
      await addSuite(run, manifest, {
        id: latest.file.slice(0, -5),
        model: join(p.models, latest.file),
        version: latest.file.slice(0, -5),
        championRoot,
      });
    }
    while (!existsSync(join(directory, 'STOP'))) {
      for (const name of readdirSync(p.eval)
        .filter((n) => /^block-\d+$/.test(n) && Number(n.slice(6)) >= fromBlock)
        .sort()) {
        const base = readJSON(join(p.eval, name, 'report.json'), null);
        if (!base?.completedAt || manifest.suites.some((s) => s.sourceBlock === name)) continue;
        const file = join(p.eval, name, 'model.onnx');
        if (sha256(file) !== base.modelSHA256) throw Error('Legacy evaluation frozen SHA mismatch');
        await addSuite(run, manifest, {
          id: name,
          model: file,
          version: name,
          sourceBlock: name,
          championRoot,
        });
      }
      for (const plan of manifest.suites) {
        const folder = join(directory, plan.id),
          champion = { file: join(folder, 'champion.onnx'), metadata: plan.champion };
        const pending = plan.opponents.filter(
          (op) => !validSuiteReport(readJSON(join(folder, op, 'report.json'), null), plan, op),
        );
        state.suite = plan.id;
        state.phase = 'evaluating';
        save();
        // Two single-thread CPU sessions; no training GPU or optimizer access.
        for (let i = 0; i < pending.length; i += 2) {
          const results = await Promise.allSettled(
            pending.slice(i, i + 2).map((op) =>
              evaluate({
                run,
                model: join(folder, 'model.onnx'),
                index: plan.index,
                pairs: plan.pairs,
                opponents: [op],
                champion,
                outputDirectory: join(folder, op),
                resume: true,
              }),
            ),
          );
          const failure = results.find((r) => r.status === 'rejected');
          if (failure) throw failure.reason;
          save();
        }
        if (
          !plan.opponents.every((op) =>
            validSuiteReport(readJSON(join(folder, op, 'report.json'), null), plan, op),
          )
        )
          throw Error('Incomplete development suite; cannot mark complete');
      }
      const guardian = guardianState ? readJSON(guardianState, {}) : {};
      state.phase = guardian.phase === 'complete' ? 'complete' : 'waiting';
      save();
      if (once || state.phase === 'complete') return state;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    state.phase = 'stopped';
    save();
    return state;
  } catch (e) {
    state.phase = 'error';
    state.error = String(e.message || e);
    save();
    throw e;
  } finally {
    unlinkSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  await runDevelopmentSuites({
    run: option('run', 'ai/guanzero/runs/guanzero-adp'),
    fromBlock: Number(option('from-block', '3')),
    guardianState: option('guardian-state'),
    championRoot: option('champion-root', ROOT),
    once: process.argv.includes('--once'),
  });
}
