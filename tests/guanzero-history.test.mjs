import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode, cardsArray } from '../src/ai/encoding.mjs';
import { replay, history } from '../scripts/guanzero/history.mjs';
const positions = JSON.parse(readFileSync(new URL('./fixtures/positions.json', import.meta.url)));
test('GuanZero replay matches the frozen encoder on every fixture', () => {
  let sentinels = 0;
  for (const state of positions) {
    const { histories, sequence, out } = replay(state.log);
    const features = encode(state),
      mate = (state.p + 2) % 4;
    const lastMate = histories[mate].length && !out.includes(mate) ? histories[mate].at(-1) : [-1];
    assert.deepEqual(
      features.slice(120, 174),
      cardsArray(sequence.length ? sequence.at(-1) : [-1]),
    );
    assert.deepEqual(features.slice(174, 228), cardsArray(lastMate));
    const h = history(state);
    assert.equal(h.length, 1080);
    assert.ok(h.every((v) => [-1, 0, 1, 2].includes(v)));
    sentinels += sequence.filter((a) => a[0] === -1).length;
  }
  assert.ok(sentinels > 0);
});
