import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { uniqueStraightFlushes } from '../src/hand/straight-flushes.mjs';
import { levelDisplayLabel } from '../src/ui/level-display.mjs';
import { rotateSnapshot } from '../src/network/snapshot.js';
import {
  readHost,
  writeHost,
  clearHost,
  HOST_KEEP_MS,
  HOST_KEY,
} from '../src/network/host-storage.mjs';
import {
  captureDeal,
  captureStart,
  captureAction,
  snapshotRecord,
  restoreRecord,
} from '../src/collection/record.mjs';
import {
  matchIdentity,
  snapshotMatch,
  restoreMatch,
  matchExcluded,
} from '../src/collection/match-link.mjs';
import { rulesPages } from '../src/ui/rules-book.mjs';
const deck = makeDeck(),
  card = (s, r) => deck.find((c) => c.s === s && c.r === r);
test('straight flush UI keeps one physical hand and omits avoidable wild-card substitutions', () => {
  const natural = [3, 4, 5, 6, 7].map((r) => card('S', r)),
    wild = deck.filter((c) => c.s === 'H' && c.r === 2);
  assert.equal(
    uniqueStraightFlushes([...natural, ...wild], 2).filter((x) => x.su === 'S').length,
    1,
  );
  const options = uniqueStraightFlushes([...natural.slice(1), wild[0]], 2).filter(
    (x) => x.su === 'S',
  );
  assert.equal(options.length, 1);
  assert.equal(options[0].s, 4);
  assert.equal(options[0].wu, 1);
});
test('level display holds the played A attempt and rotates its public display snapshot', () => {
  const g = { levels: [14, 9], aFails: [1, 0], lvlTeam: 1, aOut: null };
  assert.equal(levelDisplayLabel(g, 0), 'A1');
  assert.equal(levelDisplayLabel({ ...g, lvlTeam: 0 }, 0), 'A2');
  const x = rotateSnapshot({ ...g, shown: { ...g, levels: [14, 8] } }, 1);
  assert.equal(levelDisplayLabel(x.shown, 1), 'A1');
  assert.equal(x.shown.lvlTeam, 0);
  assert.equal(g.levels[1], 9);
});
test('host restore store expires, rejects another build and tolerates inaccessible storage', () => {
  const values = new Map(),
    storage = {
      getItem: (k) => values.get(k),
      setItem: (k, v) => values.set(k, v),
      removeItem: (k) => values.delete(k),
    };
  const data = {
    version: 'v1',
    code: '1234',
    direction: 'S',
    game: { hands: [[], [], [], []] },
    reservations: [['opaque', { dir: 'E' }]],
  };
  assert.ok(writeHost(storage, data, 1000));
  assert.equal(readHost(storage, 'v1', 1001).reservations[0][0], 'opaque');
  assert.equal(readHost(storage, 'v2', 1001), null);
  assert.equal(readHost(storage, 'v1', 1000 + HOST_KEEP_MS), null);
  assert.equal(readHost(storage, 'v1', 999), null);
  clearHost(storage);
  assert.equal(storage.getItem(HOST_KEY), undefined);
  assert.equal(
    writeHost(
      {
        setItem() {
          throw Error('quota');
        },
      },
      data,
    ),
    false,
  );
});
test('restoration retains anonymous match identity, collection exclusion and prior action provenance', () => {
  const g = {
    round: 1,
    L: 2,
    levels: [2, 2],
    aFails: [0, 0],
    lvlTeam: 0,
    hands: Array.from({ length: 4 }, (_, p) => deck.slice(p * 27, p * 27 + 27)),
    turn: 0,
    clock: null,
  };
  const context = {
    mode: 'host',
    practice: false,
    humans: [0, 1],
    kind: 'test',
    rules: { trib: false, aFail: 'draw' },
    models: [null, null, null, null],
    direction: 'S',
  };
  const identity = matchIdentity(g, { ...context, excluded: true }),
    other = structuredClone(g);
  restoreMatch(other, snapshotMatch(g));
  assert.equal(matchIdentity(other, context).id, identity.id);
  assert.ok(matchExcluded(other));
  captureDeal(g, context);
  captureStart(g, context);
  captureAction(g, 0, null, context);
  const saved = snapshotRecord(g);
  restoreRecord(other, saved, 100);
  captureAction(other, 1, null, { ...context, humans: [0] });
  const restored = snapshotRecord(other);
  assert.equal(restored.pending.id, saved.pending.id);
  assert.deepEqual(
    restored.pending.actions.map((a) => a.actor),
    ['human', 'bot'],
  );
  assert.ok(restored.pending.actions[1].elapsedMs >= restored.pending.actions[0].elapsedMs + 100);
});
test('illustrated rules use table options and keep the unlimited A rule and current clocks', () => {
  const pages = rulesPages({ trib: false, aFail: 'keep' }, 'champion017', 'custom clocks');
  assert.equal(pages.length, 4);
  const text = JSON.stringify(pages);
  assert.ok(text.includes('不限次数'));
  assert.ok(text.includes('本场不进贡'));
  assert.ok(text.includes('custom clocks'));
  assert.ok(text.includes('champion017'));
  assert.ok(
    pages
      .flatMap((p) => p.tabs)
      .flatMap((t) => t.items)
      .filter((i) => i.cards).length > 15,
  );
});

test('voice stop discards calls queued before voice activation and before the old peer is destroyed', async () => {
  const prior = globalThis.document;
  globalThis.document = { querySelectorAll: () => [] };
  try {
    const voice = await import('../src/network/voice.js');
    voice.initialize();
    let closed = 0;
    voice.VC.incoming({
      close() {
        closed++;
      },
    });
    voice.VC.stop();
    assert.equal(closed, 1);
  } finally {
    if (prior === undefined) delete globalThis.document;
    else globalThis.document = prior;
  }
});
