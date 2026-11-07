import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MATCH_KEY,
  matchIdentity,
  rememberMatch,
  readMatch,
  sameMatchStart,
  excludeMatch,
} from '../src/collection/match-link.mjs';
import { initialTableState } from '../src/lobby/start-state.mjs';
import { captureDeal, captureStart, completedRecord } from '../src/collection/record.mjs';
import { makeDeck } from '../src/core/cards.js';

const store = () => {
  const m = new Map();
  return {
    getItem: (k) => m.get(k) || null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
test('resume rotates direction IDs, levels, failed A and tribute order; collection IDs continue monotonically', () => {
  const storage = store(),
    ctx = { mode: 'host', direction: 'S', practice: false, rules: { trib: true, aFail: 'once' } };
  const game = {
    round: 7,
    levels: [14, 8],
    aFails: [1, 0],
    aOut: 0,
    result: { team: 1, order: [1, 3, 0, 2] },
  };
  const identity = matchIdentity(game, ctx);
  assert(rememberMatch(game, ctx, storage));
  const saved = readMatch(storage);
  assert(saved);
  assert.equal(saved.nextRound, 8);
  const rules = { ...ctx.rules, startState: saved.state };
  assert(sameMatchStart(saved, rules));
  for (const direction of ['S', 'E', 'N', 'W']) {
    const g = { round: 1, ...initialTableState(rules, direction) },
      c = { ...ctx, direction, rules };
    c.session = matchIdentity(g, c, saved);
    assert.equal(c.session.id, identity.id);
    assert.equal(c.session.base, 7);
    assert.equal(g.aOut, ['S', 'N'].includes(direction) ? 0 : 1);
    g.L = 8;
    g.hands = [0, 1, 2, 3].map((p) => makeDeck().slice(p * 27, p * 27 + 27));
    g.turn = 0;
    g.trib = [];
    Object.assign(c, {
      humans: [0, 1],
      models: Array(4).fill({ id: 'clint-rule', sha256: null, version: 'rules-v2' }),
      version: 'test',
    });
    captureDeal(g, c);
    captureStart(g, c);
    g.result = { order: [0, 2, 1, 3] };
    const record = completedRecord(g, c);
    assert.equal(record.round, 8);
    assert.equal(record.id, identity.id + ':8');
    assert.equal(
      record.seats[0].id,
      identity.absolutePlayers[['S', 'E', 'N', 'W'].indexOf(direction)],
    );
  }
  assert(!sameMatchStart(saved, { ...rules, trib: false }));
  assert(
    !Object.keys(JSON.parse(storage.getItem(MATCH_KEY))).some((k) =>
      /hand|nick|token|room/i.test(k),
    ),
  );
});
test('private exclusion survives resumed game objects; guests/practice cannot save and over/draw clears', () => {
  const storage = store(),
    ctx = {
      mode: 'host',
      direction: 'S',
      practice: false,
      excluded: true,
      rules: { trib: true, aFail: 'draw' },
    };
  const g = {
    round: 1,
    levels: [3, 2],
    aFails: [0, 0],
    aOut: null,
    result: { team: 0, order: [0, 2, 1, 3] },
  };
  rememberMatch(g, ctx, storage);
  const saved = readMatch(storage);
  assert(saved.excluded);
  const resume = { round: 1 },
    c = { ...ctx, excluded: false, rules: { ...ctx.rules, startState: saved.state } };
  assert(matchIdentity(resume, c, saved).excluded);
  for (const extra of [{ mode: 'guest' }, { practice: true }])
    assert.equal(rememberMatch(g, { ...ctx, ...extra }, storage), false);
  g.result.win = true;
  assert(rememberMatch(g, ctx, storage));
  assert.equal(readMatch(storage), null);
  storage.setItem(MATCH_KEY, '{"id":"forged"}');
  assert.equal(readMatch(storage), null);
});

test('opening private hands immediately excludes saved continuation before another round completes', () => {
  const storage = store(),
    ctx = { mode: 'host', direction: 'S', practice: false, rules: { trib: true, aFail: 'draw' } };
  const g = {
    round: 1,
    levels: [3, 2],
    aFails: [0, 0],
    aOut: null,
    result: { team: 0, order: [0, 2, 1, 3] },
  };
  rememberMatch(g, ctx, storage);
  const saved = readMatch(storage);
  assert.equal(saved.excluded, false);
  const resumed = { round: 1 },
    rules = { ...ctx.rules, startState: saved.state };
  excludeMatch(resumed, storage, saved, rules);
  assert.equal(readMatch(storage).excluded, true);
  assert(matchIdentity({ round: 1 }, { ...ctx, rules }, readMatch(storage)).excluded);
});
