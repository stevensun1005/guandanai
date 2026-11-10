import { workerAlive } from './worker-lock.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork, execFileSync } from 'node:child_process';
import { freezeReason, reasonProtocol } from './reason.mjs';
import { setPriority, constants } from 'node:os';
import { modelBytes } from '../../publishing/artifacts.mjs';
import { evaluate } from './evaluate.mjs';
import {
  DEFAULT_OPPONENTS,
  REASON_PANELS,
  MIXED_PANEL,
  MIXED_PAIRS,
  suiteReasonProtocol,
} from './opponents.mjs';
import { freezeClint } from './evaluate-clint.mjs';
import { freezeChampion, championDefinition } from './champion.mjs';
import { ROOT, paths, readJSON, writeJSON, option, sha256, evalSeed } from './lib.mjs';
export const SUITE_PAIRS = 250;
export const SUITE_SEED_INDEX = 5000; // 4,200,000,000+, disjoint from legacy blocks.
import { validSuiteReport } from './suite-reports.mjs';
export { validSuiteReport } from './suite-reports.mjs';
/**
 * Panel of a new batch. The frozen companion that will run it decides the reason protocol (a v1
 * companion freezes v1 identities, a v2 companion v2); the plan's panel follows that identity,
 * and a launcher that names a panel must agree with its companion.
 */
export function reasonPanel(reason, reasonRuntime = null) {
  const panel = reasonRuntime?.opponentPanel ?? reasonProtocol(reason);
  if (!REASON_PANELS.includes(panel)) throw Error('Unknown reason protocol');
  if (suiteReasonProtocol({ opponentPanel: panel }) !== reasonProtocol(reason))
    throw Error('Reason launcher protocol differs from its frozen companion');
  return panel;
}
export async function addSuite(
  run,
  manifest,
  { id, model, version, sourceBlock = null, championRoot = ROOT, reasonRuntime = null },
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
  let freeze = freezeReason,
    freezeBrain = freezeClint;
  if (reasonRuntime) {
    if (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: reasonRuntime.sourceRoot,
        encoding: 'utf8',
      }).trim() !== reasonRuntime.commit
    )
      throw Error('Reason runtime commit changed');
    freeze = (
      await import(
        pathToFileURL(join(reasonRuntime.sourceRoot, 'ai/guanzero/training/reason.mjs')).href
      )
    ).freezeReason;
    if (reasonRuntime.opponentPanel === MIXED_PANEL)
      freezeBrain = (
        await import(
          pathToFileURL(join(reasonRuntime.sourceRoot, 'ai/guanzero/training/evaluate-clint.mjs'))
            .href
        )
      ).freezeClint;
  }
  const reason = await freeze(folder, champion.metadata, championRoot);
  const opponentPanel = reasonPanel(reason, reasonRuntime ?? { opponentPanel: MIXED_PANEL });
  const clint = opponentPanel === MIXED_PANEL ? freezeBrain() : null;
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
    opponentPanel,
    opponents: [...DEFAULT_OPPONENTS],
    ...(clint && { opponentPairs: { ...MIXED_PAIRS }, clint }),
    champion: champion.metadata,
    reason,
    ...(reasonRuntime && {
      evaluationRuntime: {
        commit: reasonRuntime.commit,
        baselineCommit: reasonRuntime.baselineCommit,
      },
    }),
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
  baselineRoot = null,
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
  const state = { pid: process.pid, phase: 'starting', fromBlock };
  const save = () => writeJSON(status, { ...state, updatedAt: new Date().toISOString() });
  let head = null;
  const pinnedElsewhere = (plan) => {
    if (!plan.evaluationRuntime) return false;
    head ??= execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    return head !== plan.evaluationRuntime.commit;
  };
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
        if (existsSync(join(directory, plan.id, 'cancelled.json'))) continue;
        const folder = join(directory, plan.id),
          champion = { file: join(folder, 'champion.onnx'), metadata: plan.champion };
        const pending = plan.opponents.filter(
          (op) => !validSuiteReport(readJSON(join(folder, op, 'report.json'), null), plan, op),
        );
        // Workers refuse a plan pinned to another evaluator checkout; say so before forking.
        if (pending.length && pinnedElsewhere(plan))
          throw Error(
            `Suite ${plan.id} is pinned to evaluator ${plan.evaluationRuntime.commit}; finish it from that checkout`,
          );
        state.suite = plan.id;
        state.targetMatchesByOpponent = Object.fromEntries(
          plan.opponents.map((op) => [op, 2 * (plan.opponentPairs?.[op] ?? plan.pairs)]),
        );
        state.phase = 'evaluating';
        save();
        // Each opponent gets a separate low-priority process, started in the same batch.
        // Baseline opponents keep the original evaluator; reason uses this frozen companion.
        const children = [];
        const results = await Promise.allSettled(
          pending.map(async (op) => {
            while (workerAlive(join(folder, op, '.worker.lock'))) {
              if (validSuiteReport(readJSON(join(folder, op, 'report.json'), null), plan, op))
                return;
              await sleep(5000);
            }
            return new Promise((done, fail) => {
              const child = fork(
                join(ROOT, 'ai/guanzero/training/evaluation-worker.mjs'),
                [
                  `--run=${run}`,
                  `--suite=${plan.id}`,
                  `--opponent=${op}`,
                  ...(baselineRoot ? [`--baseline-root=${baselineRoot}`] : []),
                ],
                { windowsHide: true, stdio: 'inherit' },
              );
              children.push(child);
              child.once('error', fail);
              child.once('exit', (code) =>
                code === 0 ? done() : fail(Error(`${op} worker exited ${code}`)),
              );
            });
          }),
        );
        const failure = results.find((r) => r.status === 'rejected');
        if (failure) throw failure.reason;
        save();
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
    baselineRoot: option('baseline-root', null),
  });
}
