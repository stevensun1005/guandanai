/** Frozen development equivalence checks, not playing-strength estimates. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { playRound } from '../../danMCai/evaluation/evaluate-round-pairs.mjs';
import { createModelPool } from '../../danMCai/training/continuous/lib.mjs';
import { encode, cardsArray } from '../../../web/src/ai/encoding.mjs';

const [protocolFile, output] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(protocolFile));
const hash = (b) => createHash('sha256').update(b).digest('hex');
for (const [file, sha] of Object.entries(plan.sourceSHA256))
  assert.equal(hash(readFileSync(file)), sha, 'Source changed: ' + file);
assert.equal(hash(readFileSync(plan.model.file)), plan.model.sha256);
const seats = ['m', 'm', 'm', 'm'];
let different = 0,
  captured = 0;
for (const seed of plan.captureSeeds) {
  const args = { seed, seats, values: async (_, s) => new Float32Array(s.actions.length) };
  const old = await playRound(args),
    logged = await playRound({ ...args, capture: true });
  const { trace, ...outcome } = logged;
  assert.deepEqual(outcome, old);
  captured += trace.moves.length;
}
const engine = await ort.InferenceSession.create(plan.model.file, {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
  graphOptimizationLevel: 'all',
});
const pool = await createModelPool(ort, { threads: 1 });
let checkedDecisions = 0,
  maxAbsError = 0;
try {
  for (const seed of plan.baseSeeds) {
    const direct = async (_, s) => {
      const actions = new Float32Array(s.actions.length * 54);
      s.actions.forEach((a, i) => actions.set(cardsArray(a), i * 54));
      const a = new ort.Tensor('float32', encode(s), [1, 513]);
      const b = new ort.Tensor('float32', actions, [s.actions.length, 54]);
      const result = await engine.run({ state: a, actions: b });
      const expected = Float32Array.from(result.values.data);
      const actual = await pool.values(plan.model.file, s, {});
      assert.equal(
        Buffer.compare(
          Buffer.from(expected.buffer),
          Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
        ),
        0,
      );
      checkedDecisions++;
      for (let i = 0; i < actual.length; i++)
        maxAbsError = Math.max(maxAbsError, Math.abs(actual[i] - expected[i]));
      a.dispose();
      b.dispose();
      for (const t of Object.values(result)) t.dispose();
      return expected;
    };
    const old = await playRound({ seed, seats, values: direct });
    const current = await playRound({
      seed,
      seats,
      values: (_, s) => pool.values(plan.model.file, s, {}),
    });
    assert.deepEqual(current, old);
  }
} finally {
  await pool.close();
  await engine.release();
}
writeFileSync(
  output,
  JSON.stringify(
    {
      schema: 1,
      kind: 'development-equivalence-not-strength',
      protocolSHA256: hash(readFileSync(protocolFile)),
      captureSeeds: plan.captureSeeds.length,
      captureOutcomeMismatches: different,
      capturedActions: captured,
      baselineSeeds: plan.baseSeeds.length,
      checkedDecisions,
      maxAbsError,
      byteEqual: true,
      optimizerUpdates: 0,
      webChampionChanged: false,
      completedAtUTC: new Date().toISOString(),
    },
    null,
    2,
  ) + '\n',
);
console.log(readFileSync(output, 'utf8'));
