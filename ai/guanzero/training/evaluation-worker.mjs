import { mkdirSync } from 'node:fs';
import { acquireWorkerLock } from './worker-lock.mjs';
/** One opponent process; keeps search CPU work from delaying ordinary opponents. */
import assert from 'node:assert/strict';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setPriority, constants } from 'node:os';
import { readJSON, option, sha256, evalSeed, ROOT } from './lib.mjs';
import { evaluateReason } from './evaluate-reason.mjs';
import { evaluateClint } from './evaluate-clint.mjs';
import { evaluate } from './evaluate.mjs';
import { suiteOpponents, suitePairs, MIXED_PANEL } from './opponents.mjs';
setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL);
const run = resolve(option('run')),
  id = option('suite'),
  op = option('opponent');
assert.match(id, /^[a-z0-9-]+$/);
const folder = join(run, 'eval/development-500', id),
  plan = readJSON(join(folder, 'plan.json'));
assert.deepEqual(plan.opponents, suiteOpponents(plan));
assert.ok(plan.opponents.includes(op));
assert.equal(plan.pairs, 250);
assert.equal(plan.seedStart, evalSeed(plan.index, plan.pairs));
assert.equal(plan.seedEnd, plan.seedStart + 249);
const pairs = suitePairs(plan, op);
if (readJSON(join(folder, 'cancelled.json'), null)) throw Error('Owner cancelled this suite');
assert.equal(sha256(join(folder, 'model.onnx')), plan.modelSHA256);
assert.equal(sha256(join(folder, 'champion.onnx')), plan.champion.modelSHA256);
if (plan.evaluationRuntime)
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    plan.evaluationRuntime.commit,
  );
mkdirSync(join(folder, op), { recursive: true });
const release = acquireWorkerLock(join(folder, op, '.worker.lock'), { suite: id, opponent: op });
try {
  if (op === 'reason') await evaluateReason({ run, folder, plan });
  else if (op === 'clint' && plan.opponentPanel === MIXED_PANEL)
    await evaluateClint({ run, folder, plan });
  else {
    let runEvaluation = evaluate;
    const baseline = option('baseline-root', null);
    if (baseline) {
      assert.equal(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: baseline, encoding: 'utf8' }).trim(),
        'af2a6835f9dde38c16a8465eb53cbfacfa9e1f52',
      );
      runEvaluation = (
        await import(pathToFileURL(join(baseline, 'ai/guanzero/training/evaluate.mjs')).href)
      ).evaluate;
    } else if (plan.evaluationRuntime?.baselineCommit)
      throw Error('Frozen baseline evaluator required');
    await runEvaluation({
      run,
      model: join(folder, 'model.onnx'),
      index: plan.index,
      pairs,
      opponents: [op],
      champion: { file: join(folder, 'champion.onnx'), metadata: plan.champion },
      outputDirectory: join(folder, op),
      resume: true,
    });
  }
} finally {
  release();
}
