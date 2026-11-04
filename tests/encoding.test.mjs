import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { encode, cardsArray } from '../src/ai/encoding.mjs';

test('browser features match the independent NumPy reference on recorded real positions', () => {
  const states = JSON.parse(
    readFileSync(new URL('./fixtures/positions.json', import.meta.url), 'utf8'),
  );
  const expected = JSON.parse(
    gunzipSync(
      readFileSync(new URL('./fixtures/reference-features.json.gz', import.meta.url)),
    ).toString(),
  );
  for (let i = 0; i < states.length; i++)
    assert.deepEqual(Array.from(encode(states[i])), expected[i], `snapshot ${i}`);
  assert.equal(states.length, 834);
});
test('54 feature positions preserve suits and duplicate deck copies', () => {
  for (let id = 0; id < 54; id++) {
    const a = cardsArray([id]),
      b = cardsArray([id + 54]);
    assert.deepEqual(a, b);
    assert.equal(
      a.reduce((x, y) => x + y),
      1,
    );
  }
  assert.deepEqual(cardsArray([-1]), new Float32Array(54).fill(-1));
});
