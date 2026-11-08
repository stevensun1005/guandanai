import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validateRecord } from '../src/collection/validate.mjs';
import { captureDeal, captureStart, completedRecord } from '../src/collection/record.mjs';
import { UploadQueue } from '../src/collection/outbox.mjs';
import { collectedRound } from './fixtures/collected-round.mjs';
import worker from '../collector/worker.mjs';
import { humanExamples } from '../../ai/shared/data/tools/human-examples.mjs';

test('collected complete rounds replay every legal action, private hand and result', () => {
  for (let seed = 9301000; seed < 9301008; seed++) {
    const record = collectedRound(seed),
      result = validateRecord(record);
    assert.equal(result.actions.length, record.actions.length);
    assert.deepEqual(result.result.order, record.order);
    assert.equal(result.trust, 'unverified_browser');
    assert.ok(record.actions.some((a) => a.actor === 'human'));
    assert.ok(record.actions.some((a) => a.actor === 'bot'));
    assert.ok(!JSON.stringify(record).includes('nickname'));
  }
});

test('solo, guest, practice and one-person rooms cannot produce collected rounds', () => {
  for (const extra of [{ mode: 'solo' }, { mode: 'guest' }, { practice: true }, { humans: [0] }]) {
    const game = { round: 1, result: { order: [0, 2, 1, 3] } },
      ctx = { mode: 'host', practice: false, humans: [0, 1], ...extra };
    captureDeal(game, ctx);
    captureStart(game, ctx);
    assert.equal(completedRecord(game, ctx), null);
  }
});

test('ingestion rejects unfinished games, forged cards, incorrect actors and arbitrary personal fields', () => {
  const record = collectedRound();
  for (const mutate of [
    (r) => (r.nickname = 'private'),
    (r) => r.actions.pop(),
    (r) => r.order.reverse(),
    (r) => (r.hands[0][0] = r.hands[1][0]),
    (r) => (r.actions[0].seat = (r.actions[0].seat + 1) % 4),
    (r) => (r.actions.find((a) => a.actor === 'bot').actor = 'human'),
    (r) => (r.actions[0].ip = 'private'),
  ]) {
    const value = structuredClone(record);
    mutate(value);
    assert.throws(() => validateRecord(value));
  }
});

test('ingestion accepts an optional room number and seat nicknames, and nothing else personal', () => {
  const record = collectedRound();
  record.room = '4821';
  record.seats.forEach((s, p) => (s.name = s.human ? `玩家${p}` : null));
  const result = validateRecord(record);
  assert.equal(result.room, '4821');
  assert.deepEqual(
    result.seats.map((s) => s.name),
    record.seats.map((s) => s.name),
  );
  assert.ok(!JSON.stringify(humanExamples({ ...record, kind: 'game' })).includes('玩家'));
  for (const mutate of [
    (r) => (r.room = ''),
    (r) => (r.room = 4821),
    (r) => (r.room = 'x'.repeat(17)),
    (r) => (r.seats[0].name = ' padded'),
    (r) => (r.seats[0].name = 'a\nb'),
    (r) => (r.seats[0].name = 'x'.repeat(25)),
    (r) => (r.seats[0].ip = 'private'),
  ]) {
    const value = structuredClone(record);
    mutate(value);
    assert.throws(() => validateRecord(value));
  }
});

test('capture sanitizes room and human-only names before durable replay; examples omit labels', () => {
  const record = collectedRound(9301000, {
    room: ' \u0000' + '房'.repeat(20) + '\n ',
    names: { 0: ' \t房主\n ', 1: '😀'.repeat(30), 2: '电脑不采集' },
  });
  assert.equal(record.room, '房'.repeat(16));
  assert.deepEqual(
    record.seats.map((s) => s.name),
    ['房主', '😀'.repeat(24), null, null],
  );
  const checked = validateRecord(record);
  assert.equal(checked.room, record.room);
  assert.deepEqual(
    checked.seats.map((s) => s.name),
    record.seats.map((s) => s.name),
  );
  const rows = humanExamples({ ...record, kind: 'game' });
  assert.ok(rows.length);
  assert.ok(rows.every((row) => !('room' in row) && !('seats' in row) && !('name' in row)));
  assert.ok(!JSON.stringify(rows).includes('房主'));
  const missing = collectedRound(9301001, { room: '\n', names: { 0: '\t ' } });
  assert.ok(!('room' in missing));
  assert.deepEqual(
    missing.seats.map((s) => s.name),
    [null, null, null, null],
  );
});

test('human examples exclude test and automated actions, keep match splits together and reveal no other hand', () => {
  const record = collectedRound();
  assert.deepEqual(humanExamples(record), []);
  record.kind = 'game';
  const actor = record.actions.find((a) => a.actor === 'human');
  actor.actor = 'timeout';
  actor.model = { id: 'clint-rule', sha256: null, version: 'rules-v2' };
  const rows = humanExamples(record);
  assert.equal(rows.length, record.actions.filter((a) => a.actor === 'human').length);
  assert.equal(new Set(rows.map((row) => row.split)).size, 1);
  for (const row of rows) {
    assert.ok(!('hands' in row.observation));
    assert.ok(row.observation.hand.every((id) => record.hands[row.seat].includes(id)));
    assert.equal(row.trust, 'unverified_browser');
  }
});

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    async list() {
      return structuredClone([...rows.values()]);
    },
    async put(e) {
      rows.set(e.id, structuredClone(e));
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}
test('default upload transport preserves the browser fetch receiver', async () => {
  const original = globalThis.fetch,
    store = memoryStore(),
    payload = collectedRound();
  globalThis.fetch = function () {
    assert.equal(this, globalThis);
    return Promise.resolve(Response.json({ id: payload.id, stored: true }));
  };
  try {
    await new UploadQueue({ store, endpoint: 'https://collector.test/rounds' }).enqueue(payload);
    assert.equal(store.rows.size, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test('outbox survives offline retry and reload, deleting only a matching durable receipt', async () => {
  const store = memoryStore(),
    payload = collectedRound();
  const first = new UploadQueue({
    store,
    endpoint: 'https://collector.test/rounds',
    fetcher: async () => {
      throw Error('offline');
    },
  });
  await first.enqueue(payload);
  assert.equal(store.rows.size, 1);
  const entry = store.rows.get(payload.id);
  entry.nextAttempt = 0;
  const second = new UploadQueue({
    store,
    endpoint: 'https://collector.test/rounds',
    fetcher: async () => Response.json({ id: payload.id, stored: true }),
  });
  await Promise.all([second.flush(), second.flush()]);
  assert.equal(store.rows.size, 0);
  const bad = new UploadQueue({
    store,
    endpoint: 'https://collector.test/rounds',
    fetcher: async () => Response.json({ id: 'wrong', stored: true }),
  });
  await bad.enqueue(payload);
  assert.equal(store.rows.size, 1);
});

test('cloud SQL stores one immutable round, denies public reads and separates test records', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(
    readFileSync(new URL('../collector/migrations/0001_rounds.sql', import.meta.url), 'utf8'),
  );
  const env = {
    EXPORT_TOKEN: 'test-owner-only',
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        return {
          bind(...args) {
            return {
              async first() {
                return statement.get(...args) || null;
              },
              async all() {
                return { results: statement.all(...args) };
              },
              async run() {
                return statement.run(...args);
              },
            };
          },
        };
      },
    },
  };
  const record = collectedRound(9301000, { room: '4821', names: { 0: 'CloudH', 1: 'CloudG' } }),
    post = (value, origin = 'https://stevensun1005.github.io') =>
      new Request('https://collector.test/rounds', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
  assert.equal((await worker.fetch(post(record, 'https://evil.test'), env)).status, 403);
  const saved = await worker.fetch(post(record), env);
  assert.equal(saved.status, 201);
  assert.equal((await saved.json()).stored, true);
  assert.equal((await worker.fetch(post(record), env)).status, 200);
  const conflict = structuredClone(record);
  conflict.kind = 'game';
  assert.equal((await worker.fetch(post(conflict), env)).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM rounds').get().n, 1);
  const payload = JSON.parse(sqlite.prepare('SELECT payload FROM rounds').get().payload);
  assert.equal(payload.room, '4821');
  assert.deepEqual(
    payload.seats.map((s) => s.name),
    ['CloudH', 'CloudG', null, null],
  );
  assert.equal(
    (await worker.fetch(new Request('https://collector.test/admin/export'), env)).status,
    401,
  );
  const headers = { Authorization: 'Bearer test-owner-only' };
  assert.equal(
    (
      await (
        await worker.fetch(new Request('https://collector.test/admin/export', { headers }), env)
      ).json()
    ).records.length,
    0,
  );
  assert.equal(
    (
      await (
        await worker.fetch(
          new Request('https://collector.test/admin/export?includeTests=1', { headers }),
          env,
        )
      ).json()
    ).records.length,
    1,
  );
  sqlite.close();
});
