import test from 'node:test';
import assert from 'node:assert/strict';
import { EMOTES, EMOTE_COOLDOWN_MS, createEmoteLimiter, emoteById } from '../src/social/emotes.mjs';

test('the preset catalog has unique ids, both kinds and the classic phrases', () => {
  const ids = EMOTES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.every((id) => /^[ep]\d{2}$/.test(id)));
  assert.equal(EMOTES.filter((entry) => entry.kind === 'emoji').length, 16);
  assert.equal(EMOTES.filter((entry) => entry.kind === 'phrase').length, 12);
  const texts = EMOTES.map((entry) => entry.text);
  assert(texts.includes('给阿姨倒一杯卡布奇诺'));
  assert(texts.some((text) => text.includes('我等的花儿都谢了')));
  assert(
    texts.every((text) => !/[<>&"']/.test(text)),
    'no markup characters in presets',
  );
  assert(Object.isFrozen(EMOTES) && EMOTES.every(Object.isFrozen));
});

test('only preset ids resolve; free text and other values are rejected', () => {
  assert.equal(emoteById('p02').text, '给阿姨倒一杯卡布奇诺');
  for (const value of ['', 'p99', '自由文字', '<img src=x>', 2, null, undefined, {}, ['e01']])
    assert.equal(emoteById(value), null);
});

test('each seat waits out the cooldown independently', () => {
  let now = 1000;
  const allow = createEmoteLimiter(EMOTE_COOLDOWN_MS, () => now);
  assert(allow(1));
  assert(!allow(1), 'a repeat inside the cooldown is refused');
  assert(allow(2), 'another seat is not affected');
  now += EMOTE_COOLDOWN_MS - 1;
  assert(!allow(1));
  now += 1;
  assert(allow(1));
});
