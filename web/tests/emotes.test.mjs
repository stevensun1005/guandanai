import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOT_REPLIES,
  EMOTES,
  EMOTE_COOLDOWN_MS,
  botReply,
  createEmoteLimiter,
  emoteById,
  validTarget,
} from '../src/social/emotes.mjs';

test('the catalog keeps the five emotes, three of them gifts, and the classic phrases', () => {
  const ids = EMOTES.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.every((id) => /^[gep]\d{2}$/.test(id)));
  const pick = (kind) => EMOTES.filter((entry) => entry.kind === kind).map((entry) => entry.label);
  assert.deepEqual(pick('gift'), ['卡布奇诺', '鲜花', '炸弹']);
  assert.deepEqual(pick('emoji'), ['墨镜', '哭']);
  assert.equal(pick('phrase').length, 8);
  for (const signal of ['炸', '留着', '靠你', '稳住'])
    assert(!pick('phrase').some((text) => text.includes(signal)), `no play signal: ${signal}`);
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
  assert.equal(emoteById('g03').text, '💣');
  for (const value of [
    '',
    'p99',
    'p09',
    'p10',
    'e03',
    '自由文字',
    '<img src=x>',
    2,
    null,
    undefined,
    {},
    ['e01'],
  ])
    assert.equal(emoteById(value), null);
});

test('gifts need another seat as receiver; emoji and phrases must not name one', () => {
  const gift = emoteById('g02'),
    emoji = emoteById('e01'),
    phrase = emoteById('p01');
  assert(validTarget(gift, 0, 2));
  assert(validTarget(gift, 3, 0));
  for (const to of [undefined, null, 1, -1, 4, 1.5, '2', {}])
    assert(!validTarget(gift, 1, to), String(to));
  assert(validTarget(emoji, 0, undefined) && validTarget(phrase, 2, null));
  assert(!validTarget(emoji, 0, 1) && !validTarget(phrase, 0, 2));
  assert(!validTarget(null, 0, 1));
});

test('a computer answers a gift by returning it, with sunglasses, or by crying at a bomb', () => {
  assert.deepEqual(Object.keys(BOT_REPLIES).sort(), ['g01', 'g02', 'g03']);
  for (const [gift, replies] of Object.entries(BOT_REPLIES)) {
    assert(replies.includes(gift), 'can throw the same gift back');
    assert(replies.every((id) => emoteById(id)));
    for (const r of [0, 0.49, 0.5, 0.999]) assert(replies.includes(botReply(gift, () => r)));
  }
  assert(BOT_REPLIES.g03.includes('e02'));
  assert(BOT_REPLIES.g01.includes('e01') && BOT_REPLIES.g02.includes('e01'));
  assert.equal(
    botReply('g03', () => 0),
    'g03',
  );
  assert.equal(
    botReply('g03', () => 0.9),
    'e02',
  );
  for (const id of ['e01', 'p01', 'x', undefined]) assert.equal(botReply(id), null);
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
