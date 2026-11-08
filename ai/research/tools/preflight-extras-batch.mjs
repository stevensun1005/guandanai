/** Same registered synthetic preflight: verify the new batched extras ABI on DirectML. */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { createBatchedPool } from '../../danMCai/training/continuous/batch-inference.mjs';
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

const run = resolve(option('run', '')),
  plan = readJSON(join(run, 'protocol.json')),
  task = readJSON(join(run, 'campaign-task.json'));
if (sha256(join(run, 'protocol.json')) !== task.protocolSHA256)
  throw Error('Unregistered preflight');
const check = () => {
  if (existsSync(join(run, 'STOP')) || Date.now() >= Date.parse(task.window.deadlineUTC))
    throw Error('Preflight stopped');
};
check();
const pool = await createBatchedPool(ort, { provider: 'dml', sessionLimit: 3 });
const reference = await createModelPool(ort, { provider: 'cpu', limit: 3 });
let maxDifference = 0,
  decisions = 0;
try {
  // Already-used development fixture, explicitly not new heldout gameplay or strength evidence.
  const game = createRound(plan.developmentFixtureSeed);
  for (let turn = 0; turn < 12; turn++) {
    check();
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    if (plays.length > 1) {
      const state = analysisState(game, p, plays);
      const updated = join(run, 'public-updated.onnx');
      const values = await pool.values(updated, state, 'public');
      const expected = await reference.values(updated, state, { extraFeatures: 53 });
      for (let k = 0; k < values.length; k++)
        maxDifference = Math.max(maxDifference, Math.abs(values[k] - expected[k]));
      const initial = join(run, 'initial-zero-extras.onnx');
      const zeros = await pool.values(initial, state, 'zero');
      const teacher = await reference.values(plan.teacher, state);
      for (let k = 0; k < zeros.length; k++)
        maxDifference = Math.max(maxDifference, Math.abs(zeros[k] - teacher[k]));
      decisions++;
    }
    if (advanceRound(game, plays[0])) break;
  }
  if (
    !decisions ||
    maxDifference > 1e-4 ||
    pool.stats.provider !== 'dml' ||
    pool.stats.fallbackReason
  )
    throw Error(
      'DirectML extras input preflight failed: ' +
        JSON.stringify({ decisions, maxDifference, inference: pool.stats }),
    );
  writeJSON(join(run, 'batch-results.json'), {
    decisions,
    maxDifference,
    inference: pool.stats,
    newCompletedGames: 0,
    strengthEvidence: false,
  });
} finally {
  await pool.close();
  await reference.close();
}
