import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  blindKind,
  blindEstimate,
  collectProbeRound,
  runProbeDataset,
} from '../tools/probe-dataset.mjs';
import { playRound } from '../../danMCai/evaluation/evaluate-round-pairs.mjs';

test('blind categories follow actual encoded action slots including out sentinels', () => {
  const x = new Float32Array(567);
  assert.equal(blindKind(x, false), 1);
  assert.equal(blindKind(x, true), 2);
  x.fill(-1, 174, 228);
  assert.equal(blindKind(x, false), 3);
  assert.equal(blindKind(x, true), 4);
  x[120] = 1;
  assert.equal(blindKind(x, true), 0);
  const e = blindEstimate([
    { rows: 10, blindCounts: [5, 5, 0, 0, 0] },
    { rows: 20, blindCounts: [10, 10, 0, 0, 0] },
  ]);
  assert.equal(e.mean, 0.5);
  assert.deepEqual(e.ci95, [0.5, 0.5]);
});

test('privileged probe labels do not enter policies and complete outcomes match raw evaluator', async () => {
  const infer = async (s) => {
    assert.equal('hands' in s, false);
    assert.equal('partnerHasBomb' in s, false);
    return new Float32Array(s.actions.length);
  };
  for (const seed of [934001, 934002, 934003]) {
    const a = await collectProbeRound(seed, infer),
      b = await playRound({ seed, seats: ['x', 'x', 'x', 'x'], values: (_, s) => infer(s) });
    assert.deepEqual(a.outcome.order, b.order);
    assert.equal(a.outcome.points, b.points);
    for (const r of a.rows) {
      assert.equal(r.features.length, 567);
      assert.equal(r.extras.length, 53);
      assert.equal(r.labels[2], a.outcome.order.indexOf(r.metadata[1]) + 1);
      assert.equal(
        r.labels[1],
        a.outcome.points * (a.outcome.winner === r.metadata[1] % 2 ? 1 : -1),
      );
    }
  }
  await assert.rejects(collectProbeRound(1, infer, { stop: () => true }), /STOP/);
});

test('registered probe STOP saves zero decisions without model access or dataset creation', async () => {
  const run = mkdtempSync(join(tmpdir(), 'danmcai-probe-stop-'));
  try {
    const bytes = JSON.stringify({
      displayName: 'probe',
      targetDecisions: 100,
      deadlineUTC: new Date(Date.now() + 60000).toISOString(),
      dataDirectory: join(run, 'data'),
    });
    writeFileSync(join(run, 'protocol.json'), bytes);
    writeFileSync(
      join(run, 'campaign-task.json'),
      JSON.stringify({
        protocolSHA256: createHash('sha256').update(bytes).digest('hex'),
        window: { deadlineUTC: new Date(Date.now() + 60000).toISOString() },
      }),
    );
    writeFileSync(join(run, 'STOP'), '{}');
    const state = await runProbeDataset(run);
    assert.equal(state.completedPositions, 0);
    assert.equal(state.phase, 'stopped-before-spawn');
    assert.equal(existsSync(join(run, 'data')), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
