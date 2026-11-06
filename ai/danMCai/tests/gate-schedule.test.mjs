import assert from 'node:assert/strict';
import test from 'node:test';
import {
  selectGateCandidate,
  validateGateSchedule,
} from '../training/continuous/gate-schedule.mjs';

const activatedAt = '2026-11-06T03:00:00.000Z';
const start = Date.parse(activatedAt);
const policy = {
  mode: 'new-first-v1',
  minNewStep: 700,
  activatedAt,
  historicalChampions: 2,
  historyIntervalHours: 3,
};
const members = [
  { id: 'anchor', pinned: true },
  { id: 'v100', step: 100, pinned: true },
  { id: 'v200', step: 200, pinned: true },
  { id: 'v255', step: 255 },
  { id: 'v300', step: 300, pinned: true },
  { id: 'v600', step: 600, pinned: true },
];
const champion = {
  version: 'v600',
  history: [
    { version: 'anchor', reason: 'initial' },
    { version: 'v100', gate: 1 },
    { version: 'v200', gate: 2 },
    { version: 'v300', gate: 3 },
    { version: 'v600', gate: 4 },
  ],
};
const select = (extra = {}) =>
  selectGateCandidate({ members, champion, gates: [], policy, now: start, ...extra });

test('new scheduling idles instead of draining the inherited snapshot backlog', () => {
  assert.equal(select(), null);
  assert.equal(select({ now: start + 2 * 3600000 }), null);
  assert.equal(select({ policy: undefined }).member.id, 'v255');
});

test('the newest cutover-or-later snapshot wins priority over due historical checks', () => {
  const candidates = [...members, { id: 'v800', step: 800 }, { id: 'v700', step: 700 }];
  assert.equal(select({ members: candidates, now: start + 4 * 3600000 }).member.id, 'v800');
  assert.equal(select({ members: [...members, { id: 'v700', step: 700 }] }).category, 'new');
});

test('completed or promoted newest snapshot never causes older snapshots to be backfilled', () => {
  const candidates = [...members, { id: 'v700', step: 700 }, { id: 'v800', step: 800 }];
  assert.equal(select({ members: candidates, gates: [{ challenger: 'v800' }] }), null);
  assert.equal(
    select({
      members: candidates.map((m) => (m.id === 'v800' ? { ...m, pinned: true } : m)),
      champion: { ...champion, version: 'v800' },
    }),
    null,
  );
});

test('historical checks select only the last two real former champions and respect a global interval', () => {
  const now = start + 3 * 3600000;
  assert.equal(select({ now }).member.id, 'v300');
  assert.equal(select({ now }).category, 'historical-champion');
  assert.equal(select({ now, lastHistoricalGateAt: now - 1 }), null);
  const gates = [{ challenger: 'v300', champion: 'v600', code: 0, decision: 'reject' }];
  assert.equal(select({ now, gates }).member.id, 'v200');
  gates.push({ challenger: 'v200', champion: 'v600', code: 0, decision: 'inconclusive' });
  assert.equal(select({ now, gates }), null); // Neither v100 nor ordinary v255 is eligible.
});

test('historical matchups are keyed by champion; interrupted checks preserve retry eligibility', () => {
  const now = start + 3 * 3600000;
  assert.equal(
    select({ now, gates: [{ challenger: 'v300', champion: 'v100', code: 0, decision: 'reject' }] })
      .member.id,
    'v300',
  );
  assert.equal(
    select({ now, gates: [{ challenger: 'v300', champion: 'v600', code: 1, decision: null }] })
      .member.id,
    'v300',
  );
  assert.equal(select({ now, policy: { ...policy, historicalChampions: 0 } }), null);
});

test('gate schedule validation rejects malformed bounds and changes to the gate test', () => {
  validateGateSchedule(undefined);
  validateGateSchedule(policy);
  for (const value of [
    null,
    [],
    { ...policy, minNewStep: 0 },
    { ...policy, historicalChampions: 3 },
    { ...policy, historyIntervalHours: 0.1 },
    { ...policy, activatedAt: 'bad' },
    { ...policy, mu1: 0.6 },
    { ...policy, mode: 'unknown' },
  ])
    assert.throws(() => validateGateSchedule(value), /Invalid gateSchedule/);
});
