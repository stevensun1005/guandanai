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
import { clintBrainSettings, decideClintRule, RULES_ONLY } from '../src/rule-bot/runtime.mjs';
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
    const type = message.type;
    if (type === 'init') return this.later(message.id, { ready: true });
    behaviour[`${this.kind}:${type}`]?.(this, message);
  }
  later(id, result) {
    queueMicrotask(() => !this.terminated && this.onmessage?.({ data: { id, result } }));
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

test('Clint: brain overrun or a hung rule worker plays the rules-only move; the next move asks for the brain again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const game = position(731901001, 'any', 501);
  seat(game, CLINT_RULE_ID);
  const p = game.turn;
  // the brain hangs: no reply until the 52 s hard limit
  behaviour = {
    'ai:rule': (worker, message) => message.state.brainMs === 0 && ruleReply(worker, message),
  };
  const started = performance.now();
  let settled;
  const decision = bot.decide(p, { startedAt: started }).then((play) => (settled = { play }));
  await flush();
  const asked = lastPost('ai', 'rule');
  assert.ok(asked.state.brainMs > CLINT_BRAIN_MS - 1000 && asked.state.brainMs <= CLINT_BRAIN_MS);
  t.mock.timers.tick(HARD_MS - 1500);
  await flush();
  assert.equal(settled, undefined, 'the brain may run until 52 s from the turn start');
  t.mock.timers.tick(1500);
  await flush();
  await decision;
  const rulesOnly = lastPost('ai', 'rule');
  assert.equal(rulesOnly.state.brainMs, 0, 'the rules-only move after the overrun');
  assert.equal(workers.filter((w) => w.kind === 'ai' && w.terminated).length, 1);
  const { brainMs: _, ...observation } = rulesOnly.state;
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
  t.mock.timers.enable({ apis: ['setTimeout'] });
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
  t.mock.timers.tick(HARD_MS - 1);
  await flush();
  assert.equal(settled, undefined);
  t.mock.timers.tick(1);
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
