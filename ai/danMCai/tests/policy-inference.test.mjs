import test from 'node:test';
import assert from 'node:assert/strict';
import { inferPolicy, selectPolicyScores } from '../../../web/src/ai/policy-inference.mjs';
import { encodeMatchFeatures } from '../../../web/src/ai/match-features.mjs';

function state(count = 130) {
  return {
    p: 0,
    hand: [0, 1, 2],
    counts: [3, 5, 6, 7],
    log: [],
    level: 2,
    selfLevel: 2,
    opponentLevel: 2,
    canPass: false,
    trick: null,
    actions: Array.from({ length: count }, () => [0]),
    actionShapes: Array.from({ length: count }, () => ({ type: 'single', value: 15, n: 1 })),
  };
}

function runtime(proposals, logits = null, failure = null) {
  const tensors = [],
    calls = [];
  class Tensor {
    constructor(type, data, dims) {
      if (failure === 'construct-extra' && dims[1] === 53) throw Error('extra allocation failed');
      Object.assign(this, { type, data, dims, disposed: 0 });
      tensors.push(this);
    }
    dispose() {
      this.disposed++;
    }
  }
  let first = 0;
  const engine = {
    async run(inputs) {
      assert.equal(inputs.state.disposed, 0);
      assert.equal(inputs.actions.disposed, 0);
      calls.push(inputs);
      if (failure === 'second-run' && calls.length === 2) throw Error('inference failed');
      const count = inputs.actions.dims[0];
      const output = {
        values: new Tensor('float32', Float32Array.from(proposals.slice(first, first + count)), [
          count,
          1,
        ]),
      };
      if (logits)
        output.policy_logits = new Tensor(
          'float32',
          Float32Array.from(logits.slice(first, first + count)),
          [count, 1],
        );
      first += count;
      return output;
    },
  };
  return { ort: { Tensor }, engine, tensors, calls };
}

const ppo = { extraFeatures: 53, rerankCandidates: 4, temperature: 0.15 };
const disposedOnce = (mock) => assert.ok(mock.tensors.every((tensor) => tensor.disposed === 1));

test('complete policy receives public match progress for every action across batches', async () => {
  const input = state(130);
  input.match = {
    levels: [14, 8],
    aFails: [2, 0],
    lvlTeam: 0,
    round: 18,
    previousOrder: [1, 3, 0, 2],
  };
  const expected = encodeMatchFeatures(input);
  const mock = runtime(Array(130).fill(0.4));
  await inferPolicy(mock.ort, mock.engine, input, { extraFeatures: 61 });
  for (const call of mock.calls) {
    assert.equal(call.extras.dims[1], 61);
    for (let i = 0; i < call.extras.dims[0]; i++)
      assert.deepEqual(call.extras.data.slice(i * 61 + 53, i * 61 + 61), expected);
  }
  assert.deepEqual(expected, new Float32Array([1, 8 / 14, 2 / 3, 0, 1, 0.18, 0, 1]));
  disposedOnce(mock);
  assert.throws(() => encodeMatchFeatures({ ...input, match: null }), /Missing/);
});

test('legacy policy needs no supplemental fields and preserves scores and stable ties across batches', async () => {
  const input = state(257);
  Object.defineProperty(input, 'actionShapes', {
    get: () => assert.fail('Legacy inference read supplemental inputs'),
  });
  const proposals = Array(257).fill(-2);
  proposals[128] = proposals[256] = 4;
  const mock = runtime(proposals);
  const result = await inferPolicy(mock.ort, mock.engine, input);
  assert.deepEqual(result.values, proposals);
  assert.equal(result.index, 128);
  assert.equal(result.value, 4);
  assert.deepEqual(
    mock.calls.map((call) => call.actions.dims[0]),
    [128, 128, 1],
  );
  assert.ok(mock.calls.every((call) => Object.keys(call).join(',') === 'state,actions'));
  disposedOnce(mock);
});

test('PPO ranks globally across batch boundaries and scales only selected log probabilities', async () => {
  const proposals = Array(130).fill(-10),
    logits = Array(130).fill(0);
  for (const [slot, index] of [0, 127, 128, 129].entries()) {
    proposals[index] = 100 - slot;
    logits[index] = slot;
  }
  logits[1] = 1000; // A large actor output cannot admit an action outside global top-K.
  const mock = runtime(proposals, logits);
  const result = await inferPolicy(mock.ort, mock.engine, state(), ppo);
  assert.equal(result.index, 129);
  assert.deepEqual(
    result.values.flatMap((value, index) => (value > -1e8 ? [index] : [])),
    [0, 127, 128, 129],
  );
  assert.ok(
    Math.abs(result.values.reduce((sum, value) => sum + Math.exp(value / 0.15), 0) - 1) < 1e-12,
  );
  assert.ok(Math.abs(result.values[129] - result.values[128] - 0.15) < 1e-12);
  assert.deepEqual(
    mock.calls.map((call) => call.extras.dims),
    [
      [128, 53],
      [2, 53],
    ],
  );
  disposedOnce(mock);
});

test('top-K handles exact ties and fewer candidates, while finished seats preserve proposal units', () => {
  const tied = selectPolicyScores(Array(131).fill(2), Array(131).fill(8), [3, 5, 6, 7], ppo);
  assert.deepEqual(
    tied.flatMap((value, index) => (value > -1e8 ? [index] : [])),
    [0, 1, 2, 3],
  );
  assert.equal(tied[0], tied[3]);
  assert.deepEqual(selectPolicyScores([3], [10], [3, 5, 6, 7], ppo), [0]);
  assert.deepEqual(selectPolicyScores([3, 2], [-9, 9], [3, 0, 6, 7], ppo), [3, 2]);
});

test('residual policy supplies extras without applying proposal-actor selection', async () => {
  const mock = runtime([1, 2]);
  const result = await inferPolicy(mock.ort, mock.engine, state(2), { extraFeatures: 53 });
  assert.deepEqual(result.values, [1, 2]);
  assert.deepEqual(mock.calls[0].extras.dims, [2, 53]);
  disposedOnce(mock);
});

test('inference errors, invalid outputs and tensor allocation errors dispose every allocated tensor', async () => {
  for (const failure of ['second-run', 'construct-extra', 'missing-logits', 'nonfinite']) {
    const values = Array(130).fill(1);
    if (failure === 'nonfinite') values[129] = NaN;
    const mock = runtime(values, failure === 'missing-logits' ? null : Array(130).fill(1), failure);
    await assert.rejects(inferPolicy(mock.ort, mock.engine, state(), ppo));
    disposedOnce(mock);
  }
});

test('unsupported candidate configurations fail before creating tensors', async () => {
  for (const config of [
    { extraFeatures: 52 },
    { rerankCandidates: 4, temperature: 0.15 },
    { ...ppo, rerankCandidates: 3 },
    { ...ppo, temperature: 0 },
  ]) {
    const mock = runtime([1]);
    await assert.rejects(inferPolicy(mock.ort, mock.engine, state(1), config));
    assert.equal(mock.tensors.length, 0);
  }
});
