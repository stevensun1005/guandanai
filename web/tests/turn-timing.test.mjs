/**
 * Owner rule 2026-11-09: a computer seat has 60 s like a human, reasons at most 50 s from the start
 * of its turn, keeps 10 s for the fallback move, and a fallback never sticks (the next move reasons
 * again). These tests drive the table controller (web/src/ai/controller.js) with fake workers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceRound, createRound } from '../../ai/shared/simulation/simulation.mjs';
import { candidates } from '../src/ai/candidates.js';
import { runtime } from '../src/app/runtime.js';
import { CLINT_RULE_ID } from '../src/ai/model-catalog.mjs';
import { HARD_MS, REASON_MS, CLINT_BRAIN_MS } from '../src/ai/turn-timing.mjs';
import {
  clintBrainSettings,
  decideClintRule,
  RULES_ONLY,
  ruleObservation as ruleObservationOf,
} from '../src/rule-bot/runtime.mjs';
import * as controller from '../src/ai/controller.js';

const workers = [];
let behaviour = {};
class FakeWorker {
  constructor(url) {
    this.url = String(url);
    this.kind = this.url.includes('search-worker') ? 'search' : 'ai';
    this.posted = [];
    this.terminated = false;
    workers.push(this);
  }
  postMessage(message) {
    this.posted.push(message);
    const type = message.type,
      handler = behaviour[`${this.kind}:${type}`];
    if (type === 'init' && !handler) return this.later(message.id, { ready: true });
    handler?.(this, message);
  }
  later(id, result) {
    queueMicrotask(() => !this.terminated && this.onmessage?.({ data: { id, result } }));
  }
  fail(id, error) {
    queueMicrotask(() => !this.terminated && this.onmessage?.({ data: { id, error } }));
  }
  crash() {
    queueMicrotask(() => !this.terminated && this.onerror?.(new Event('error')));
  }
  terminate() {
    this.terminated = true;
  }
}
globalThis.Worker = FakeWorker;
globalThis.document = { baseURI: 'http://localhost/' };
globalThis.location = { protocol: 'http:' };

controller.initialize();
const bot = controller.TableBot;
const flush = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};
const ids = (play) => (play ? play.cards.map((card) => card.id).sort((a, b) => a - b) : null);
const live = (kind) => workers.filter((w) => w.kind === kind && !w.terminated);
const lastPost = (kind, type) =>
  workers
    .filter((w) => w.kind === kind)
    .flatMap((w) => w.posted)
    .filter((m) => m.type === type)
    .at(-1);

/** A position of `band` ('midgame': 21..40 cards on the table) where the mover has a real choice. */
function position(seed, band, tok) {
  const game = createRound(seed);
  for (let ply = 0; ply < 1000; ply++) {
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    const cards = game.hands.reduce((sum, hand) => sum + hand.length, 0);
    const finish = plays.some((play) => play?.cards.length === game.hands[p].length);
    if (band === 'midgame' && cards <= 40 && cards >= 21 && plays.length > 2 && !finish)
      return Object.assign(game, { tok, round: 1, phase: 'play' });
    if (band === 'any' && plays.length > 2 && !finish)
      return Object.assign(game, { tok, round: 1, phase: 'play' });
    if (advanceRound(game, plays[plays.length > 1 && plays[0] === null ? 1 : 0]))
      throw Error('round ended');
  }
  throw Error('no position');
}
function seat(game, model) {
  runtime.game = game;
  runtime.network = { off: 0, mode: 'solo', humans: new Set() };
  runtime.botModels = [model, model, model, model];
  runtime.privateTable = false;
}
/** The rule worker's reply for an observation, as web/src/ai/worker.mjs computes it. */
function ruleReply(worker, message) {
  const { brainMs, ...observation } = message.state;
  worker.later(message.id, decideClintRule(observation, clintBrainSettings(brainMs)));
}

function mockMoveClock(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return (ms) => {
    now += ms;
    t.mock.timers.tick(ms);
  };
}

test('Clint: brain overrun or a hung rule worker plays the rules-only move; the next move asks for the brain again', async (t) => {
  const tick = mockMoveClock(t);
  const game = position(731901001, 'any', 501);
  seat(game, CLINT_RULE_ID);
  const p = game.turn;
  // the brain hangs: no reply until the 52 s hard limit
  behaviour = { 'ai:rule': () => {} };
  const started = performance.now();
  let settled;
  const decision = bot.decide(p, { startedAt: started }).then((play) => (settled = { play }));
  await flush();
  const asked = lastPost('ai', 'rule');
  assert.ok(asked.state.brainMs > CLINT_BRAIN_MS - 1000 && asked.state.brainMs <= CLINT_BRAIN_MS);
  tick(HARD_MS - 1500);
  await flush();
  assert.equal(settled, undefined, 'the brain may run until 52 s from the turn start');
  tick(1500);
  await flush();
  await decision;
  assert.equal(lastPost('ai', 'rule'), asked, 'the rules-only move needs no worker request');
  assert.equal(workers.filter((w) => w.kind === 'ai' && w.terminated).length, 1);
  const { brainMs: _, ...observation } = asked.state;
  const expected = decideClintRule(observation, RULES_ONLY);
  assert.deepEqual(
    settled.play && settled.play.cards.map((c) => c.id).sort(),
    expected && expected.cards.slice().sort(),
  );
  assert.equal(bot.clintFallbacks.timeout, 1);
  // not sticky: the next move sends the brain budget again and gets the brain's answer
  behaviour = { 'ai:rule': ruleReply };
  const next = await bot.decide(p, { startedAt: performance.now() - 30_000 });
  assert.equal(lastPost('ai', 'rule').state.brainMs > REASON_MS - 30_000 - 1000, true);
  assert.ok(lastPost('ai', 'rule').state.brainMs <= REASON_MS - 30_000);
  assert.ok(next === null || next.cards.length > 0);
  // a request already past the 50 s mark plays the rules only, and still answers
  await bot.decide(p, { startedAt: performance.now() - REASON_MS - 10 });
  assert.equal(lastPost('ai', 'rule').state.brainMs, 0);
  assert.equal(bot.clintFallbacks.timeout, 1);
});

test('danMCai-reason: 017 is computed alongside the search; a failed or hung search never sticks', async (t) => {
  const tick = mockMoveClock(t);
  const first = position(731901002, 'midgame', 502);
  seat(first, '9001');
  const p = first.turn;
  const plays = candidates(first.hands[p], first.L, first.trick?.play);
  let decideSeen = 0;
  behaviour = {
    'ai:decide': (worker, message) => {
      decideSeen++;
      worker.later(message.id, { index: 1 });
    },
    // 1. the search falls back (budget)
    'search:search': (worker, message) => {
      assert.ok(message.remainingMs > REASON_MS - 1000 && message.remainingMs <= REASON_MS);
      assert.equal(decideSeen, 1, "017's move was requested before the search answered");
      worker.later(message.id, { fallback: true, reason: 'budget' });
    },
  };
  const fallback = await bot.decide(p, { startedAt: performance.now() });
  assert.deepEqual(ids(fallback), ids(plays[1]), 'the fallback is champion 017');
  // 2. the next move (a new turn) searches normally and plays the searched move
  const second = position(731901002, 'midgame', 503);
  seat(second, '9001');
  const pick = 2;
  behaviour['search:search'] = (worker, message) => {
    const play = plays[pick];
    worker.later(message.id, {
      ok: true,
      index: pick,
      championIndex: 1,
      ids: play ? play.cards.map((card) => card.id) : [],
      shape: play ? { type: play.type, value: play.value, n: play.n } : null,
      ms: 5,
    });
  };
  const searched = await bot.decide(p, { startedAt: performance.now() });
  assert.deepEqual(ids(searched), ids(plays[pick]));
  assert.notDeepEqual(ids(plays[pick]), ids(plays[1]));
  // 3. the search worker hangs: replaced at 52 s, 017 plays, and the next move searches again
  const third = position(731901002, 'midgame', 504);
  seat(third, '9001');
  behaviour['search:search'] = () => {};
  let settled;
  const hung = bot.decide(p, { startedAt: performance.now() }).then((play) => (settled = { play }));
  await flush(10);
  tick(HARD_MS - 1);
  await flush();
  assert.equal(settled, undefined);
  tick(1);
  await flush(10);
  await hung;
  assert.deepEqual(ids(settled.play), ids(plays[1]), '017 after the hung search');
  const replaced = workers.filter((w) => w.kind === 'search' && w.terminated).length;
  assert.equal(replaced, 1, 'the hung search worker was replaced');
  const fourth = position(731901002, 'midgame', 505);
  seat(fourth, '9001');
  behaviour['search:search'] = (worker, message) => {
    const play = candidates(fourth.hands[p], fourth.L, fourth.trick?.play)[pick];
    worker.later(message.id, {
      ok: true,
      index: pick,
      championIndex: 1,
      ids: play ? play.cards.map((card) => card.id) : [],
      shape: play ? { type: play.type, value: play.value, n: play.n } : null,
      ms: 5,
    });
  };
  const resumed = await bot.decide(p, { startedAt: performance.now() });
  assert.deepEqual(ids(resumed), ids(plays[pick]));
  assert.equal(live('search').length, 1, 'a fresh search worker searched the next move');
  const stats = bot.searchStats;
  assert.equal(stats.searched, 2);
  assert.deepEqual(stats.fallbacks, { budget: 1, timeout: 1 });
});

/** Several consecutive failures of every kind, then a healthy move: nothing is sticky. */
test('Clint: consecutive failures (error reply, crash, hang, unusable reply) never stick and never fail the table', async (t) => {
  const tick = mockMoveClock(t);
  const game = position(731901003, 'any', 506);
  seat(game, CLINT_RULE_ID);
  const p = game.turn;
  const { brainMs: _b, ...view } = { ...ruleObservationOf(game, p) };
  const rulesOnly = decideClintRule(view, RULES_ONLY);
  const same = (play) =>
    assert.deepEqual(ids(play), rulesOnly ? rulesOnly.cards.slice().sort((a, b) => a - b) : null);
  const before = bot.clintFallbacks;
  // 1. the worker replies with an error
  behaviour = { 'ai:rule': (worker, message) => worker.fail(message.id, 'brain exploded') };
  same(await bot.decide(p, { startedAt: performance.now() }));
  // 2. the worker crashes (onerror) while thinking
  behaviour = { 'ai:rule': (worker) => worker.crash() };
  same(await bot.decide(p, { startedAt: performance.now() }));
  // 3. the replacement worker never loads: check() is bounded by the turn's 52 s mark
  behaviour = { 'ai:init': () => {} };
  let settled;
  const hung = bot.decide(p, { startedAt: performance.now() }).then((play) => (settled = { play }));
  await flush();
  tick(HARD_MS - 1);
  await flush();
  assert.equal(settled, undefined);
  tick(1);
  await flush(10);
  await hung;
  same(settled.play);
  // 4. an unusable reply (cards not in the hand)
  behaviour = { 'ai:rule': (worker, message) => worker.later(message.id, { cards: [9999] }) };
  tick(60_000); // the hung init request times out and the worker is replaced
  await flush();
  same(await bot.decide(p, { startedAt: performance.now() }));
  // 5. healthy again: the brain budget is sent and the worker's answer is played
  behaviour = { 'ai:rule': ruleReply };
  const posted = workers.flatMap((w) => w.posted).filter((m) => m.type === 'rule').length;
  const healthy = await bot.decide(p, { startedAt: performance.now() });
  const last = lastPost('ai', 'rule');
  assert.equal(
    workers.flatMap((w) => w.posted).filter((m) => m.type === 'rule').length,
    posted + 1,
  );
  assert.ok(last.state.brainMs > CLINT_BRAIN_MS - 1000);
  const { brainMs, ...observation } = last.state;
  const expected = decideClintRule(observation, clintBrainSettings(brainMs));
  assert.deepEqual(ids(healthy), expected ? expected.cards.slice().sort((a, b) => a - b) : null);
  const after = bot.clintFallbacks;
  assert.equal(after.error - before.error + after.timeout - before.timeout, 4);
});

test('danMCai-reason: hang, failed load, worker crash and error reply in a row, then the next move searches', async (t) => {
  const tick = mockMoveClock(t);
  const game = position(731901004, 'midgame', 507);
  const p = game.turn;
  const plays = candidates(game.hands[p], game.L, game.trick?.play);
  const pick = plays.findIndex((play, i) => play && i !== 1);
  assert.notDeepEqual(ids(plays[pick]), ids(plays[1]));
  const searched = (worker, message) => {
    const play = plays[pick];
    worker.later(message.id, {
      ok: true,
      index: pick,
      championIndex: 1,
      ids: play.cards.map((card) => card.id),
      shape: { type: play.type, value: play.value, n: play.n },
      ms: 5,
    });
  };
  const champion = (worker, message) => worker.later(message.id, { index: 1 });
  let tok = 600;
  const turn = async (search, extra = {}) => {
    seat(Object.assign(game, { tok: ++tok }), '9001');
    behaviour = { 'ai:decide': champion, 'search:search': search, ...extra };
    return bot.decide(p, { startedAt: performance.now() });
  };
  const stats = () => ({ ...bot.searchStats.fallbacks });
  const before = stats();
  const searchedBefore = bot.searchStats.searched;
  // 1. the search hangs until the 52 s mark: the worker is replaced and 017 plays
  let settled;
  const hung = turn(() => {}).then((play) => (settled = { play }));
  await flush(10);
  tick(HARD_MS);
  await flush(10);
  await hung;
  assert.deepEqual(ids(settled.play), ids(plays[1]));
  // 2. the replacement worker fails to load the networks
  const failedLoad = await turn(searched, {
    'search:init': (worker, message) => worker.fail(message.id, 'fetch failed'),
  });
  assert.deepEqual(ids(failedLoad), ids(plays[1]));
  // 3. the search worker crashes while searching
  assert.deepEqual(ids(await turn((worker) => worker.crash())), ids(plays[1]));
  // 4. the search replies with an error
  assert.deepEqual(
    ids(await turn((worker, message) => worker.fail(message.id, 'oom'))),
    ids(plays[1]),
  );
  const after = stats();
  const failures = Object.keys(after).reduce((n, k) => n + after[k] - (before[k] || 0), 0);
  assert.equal(failures, 4, JSON.stringify({ before, after }));
  assert.equal(bot.searchStats.searched, searchedBefore);
  // 5. healthy: the next move loads (if needed) and plays the searched move
  assert.deepEqual(ids(await turn(searched)), ids(plays[pick]));
  assert.equal(bot.searchStats.searched, searchedBefore + 1);
  assert.equal(live('search').length, 1);
});

test('a20-second room gives a hung reason search12seconds including replacement and then plays017', async (t) => {
  const tick = mockMoveClock(t),
    game = position(731901002, 'midgame', 9901);
  seat(game, '9001');
  runtime.rules = { playMode: '20+60' };
  t.after(() => {
    runtime.rules = {};
  });
  const p = game.turn,
    plays = candidates(game.hands[p], game.L, game.trick?.play);
  let remaining;
  behaviour = {
    'ai:decide': (worker, message) => worker.later(message.id, { index: 1 }),
    'search:search': (_worker, message) => {
      remaining = message.remainingMs;
    },
  };
  let settled;
  const promise = bot
    .decide(p, { startedAt: performance.now() })
    .then((play) => (settled = { play }));
  await flush(10);
  assert.ok(remaining > 0 && remaining <= 10000);
  tick(11999);
  await flush();
  assert.equal(settled, undefined);
  tick(1);
  await flush(10);
  await promise;
  assert.deepEqual(ids(settled.play), ids(plays[1]));
});
