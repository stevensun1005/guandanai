import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { playRound } from '../../danMCai/evaluation/evaluate-round-pairs.mjs';
import {
  deviationSeats,
  selectDeviation,
  runDeviationPairs,
} from '../../danMCai/evaluation/evaluate-deviation-pairs.mjs';

test('stratified intervention weights recover uniform decision/rank target and balance all focal seats', () => {
  const moves = [
    { p: 0, estimates: [1, 0.99, 0.98, 0.97, 0.8], candidateSHA256: 'a', ownHandCount: 27 },
  ];
  const high = selectDeviation(moves, 0, 'salt', 1, 'self', () => 0.1),
    low = selectDeviation(moves, 0, 'salt', 1, 'self', () => 0.9);
  assert.equal(high.highPairs, 1);
  assert.equal(high.lowPairs, 3);
  assert.equal(high.weight, 1 / 3);
  assert.equal(low.weight, 3);
  assert.equal(0.75 * high.weight + 0.25 * low.weight, 1);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => deviationSeats({ opponent: 'clint', mixed: true }, i).focus),
    [0, 2, 1, 3],
  );
  assert.equal(selectDeviation([], 0, 'salt', 1, 'self'), null);
});
test('exactly one legal lower-ranked action preserves the common prefix and rejects changed candidate fingerprint', async () => {
  const seats = ['champion', 'champion', 'champion', 'champion'],
    values = (_, s) => s.actions.map((_, i) => -i);
  const options = { seed: 1935001, seats, values, capture: true, captureChoices: true };
  const base = await playRound(options),
    turn = base.trace.moves.findIndex((m) => m.estimates?.length > 1),
    move = base.trace.moves[turn];
  const intervention = {
    turn,
    player: move.p,
    index: 1,
    rank: 2,
    candidateSHA256: move.candidateSHA256,
  };
  const changed = await playRound({ ...options, intervention });
  assert.deepEqual(base.trace.moves.slice(0, turn), changed.trace.moves.slice(0, turn));
  assert.equal(changed.trace.moves[turn].chosenIndex, 1);
  assert.equal(changed.interventionApplied, 1);
  assert.equal(changed.interventionQGap, 1);
  assert.deepEqual([...changed.order].sort(), [0, 1, 2, 3]);
  await assert.rejects(
    playRound({ ...options, intervention: { ...intervention, candidateSHA256: 'bad' } }),
    /fingerprint mismatch/,
  );
});
test('registered deviation worker honors actual STOP before inference or output', async () => {
  const run = mkdtempSync(join(tmpdir(), 'deviation-stop-'));
  try {
    const protocol = join(run, 'protocol.json');
    writeFileSync(protocol, JSON.stringify({ evaluationDeadlineUTC: '2026-11-11T16:45:00Z' }));
    writeFileSync(
      join(run, 'campaign-task.json'),
      JSON.stringify({ window: { deadlineUTC: '2026-11-11T16:45:00Z' } }),
    );
    writeFileSync(join(run, 'STOP'), '{}');
    await runDeviationPairs({ protocol, run });
    assert.equal(existsSync(join(run, 'worker-0.json')), false);
    assert.equal(existsSync(join(run, 'deviation-worker-0.lock')), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('isolated Clint opponent and teammate remain deterministic through the forced-action prefix', async () => {
  for (const seats of [
    ['champion', 'clint', 'champion', 'clint'],
    ['champion', 'clint', 'clint', 'clint'],
  ]) {
    const options = {
      seed: 1935002,
      seats,
      capture: true,
      captureChoices: true,
      values: (_, s) => s.actions.map((_, i) => -i),
    };
    const base = await playRound(options),
      choice = selectDeviation(base.trace.moves, 0, 'development-only', 1935002, 'clint');
    assert.ok(choice);
    const changed = await playRound({ ...options, intervention: choice });
    assert.deepEqual(
      base.trace.moves.slice(0, choice.turn),
      changed.trace.moves.slice(0, choice.turn),
    );
    assert.equal(changed.interventionApplied, 1);
  }
});
