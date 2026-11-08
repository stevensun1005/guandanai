import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { playRound } from '../../danMCai/evaluation/evaluate-round-pairs.mjs';
import {
  compactTrajectory,
  runDecisionTrace,
} from '../../danMCai/evaluation/evaluate-decision-trace.mjs';

test('compact trajectory preserves complete outcomes and stable tied argmax without private model inputs', async () => {
  const seats = ['champion', 'champion', 'champion', 'champion'];
  const values = (_, s) => {
    assert.equal('hands' in s, false);
    return new Float32Array(s.actions.length);
  };
  const plain = await playRound({ seed: 1934001, seats, values });
  let calls = 0;
  const captured = await playRound({
    seed: 1934001,
    seats,
    values,
    capture: true,
    checkpoint: () => {
      calls++;
    },
  });
  const compact = compactTrajectory(captured, seats);
  assert.deepEqual(compact.order, plain.order);
  assert.equal(compact.points, plain.points);
  assert.equal(calls, compact.moves.length);
  assert.equal(new Set(compact.initial.hands.flat()).size, 108);
  for (const move of compact.moves)
    if (move.top5.length) {
      assert.equal(move.top5[0].index, 0);
      assert.ok(move.top5.length <= 5);
      assert.equal('estimates' in move, false);
    }
});
test('trace STOP is honored within a round and by registered worker before model/data output', async () => {
  let calls = 0;
  await assert.rejects(
    playRound({
      seed: 1934002,
      seats: ['champion', 'champion', 'champion', 'champion'],
      values: (_, s) => new Float32Array(s.actions.length),
      checkpoint: () => {
        if (++calls === 3) throw Error('STOP');
      },
    }),
    /STOP/,
  );
  const run = mkdtempSync(join(tmpdir(), 'trace-stop-'));
  try {
    const protocol = join(run, 'protocol.json');
    writeFileSync(protocol, JSON.stringify({ evaluationDeadlineUTC: '2026-11-11T16:45:00Z' }));
    writeFileSync(
      join(run, 'campaign-task.json'),
      JSON.stringify({ window: { deadlineUTC: '2026-11-11T16:45:00Z' } }),
    );
    writeFileSync(join(run, 'STOP'), '{}');
    await runDecisionTrace({ protocol, run });
    assert.equal(existsSync(join(run, 'worker-0.json')), false);
    assert.equal(existsSync(join(run, 'trace-worker-0.lock')), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
