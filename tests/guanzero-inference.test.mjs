import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requestFrame, createInferenceClient } from '../scripts/guanzero/inference-client.mjs';
const state = JSON.parse(readFileSync(new URL('./fixtures/positions.json', import.meta.url)))[0];
test('GPU inference protocol preserves signed features, action counts and version IDs', () => {
  const frame = requestFrame(57, state);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.equal(frame.readUInt32LE(4), 57);
  assert.equal(frame.readUInt32LE(8), state.actions.length);
  assert.equal(frame.length, 12 + 1593 + 54 * state.actions.length);
  assert.throws(() => requestFrame(-1, state));
  assert.throws(() => requestFrame(0, { ...state, actions: [] }));
});
test('GPU client rejects an unavailable service without hanging its request queue', async () => {
  const client = createInferenceClient(1, { timeoutMs: 100 });
  try {
    await assert.rejects(client.values(0, state));
    await assert.rejects(client.values(0, state));
  } finally {
    client.close();
  }
});
