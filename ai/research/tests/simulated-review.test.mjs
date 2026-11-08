import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { playRound } from '../../danMCai/evaluation/evaluate-round-pairs.mjs';
import { compactTrajectory } from '../../danMCai/evaluation/evaluate-decision-trace.mjs';
import { reviewSimulatedRound, runReviewExport } from '../tools/review-simulated-round.mjs';

async function fixture(seed) {
  const seats = Array(4).fill('champion');
  return compactTrajectory(
    await playRound({
      seed,
      seats,
      values: (_, s) => new Float32Array(s.actions.length),
      capture: true,
    }),
    seats,
  );
}

test('offline review preserves archived ties, final points and own-only frames with no calibrated fields', async () => {
  const game = await fixture(2500000549),
    before = JSON.stringify(game);
  const result = await reviewSimulatedRound(game, 0);
  assert.equal(JSON.stringify(game), before);
  assert.equal(result.finalOwnTeamSignedUpgrade, (game.winner === 0 ? 1 : -1) * game.points);
  assert.equal(result.frames.length, game.moves.filter((m) => m.p === 0).length);
  assert.ok(result.frames.some((f) => f.archivedTop5.length));
  for (const frame of result.frames) {
    assert.equal(frame.calibratedDelta, null);
    assert.equal(frame.beliefDelta, null);
    assert.ok(!('hands' in frame) && !('opponentHands' in frame));
    assert.ok(!frame.descriptions.some((s) => /因为|所以|推荐|收益/.test(s)));
    assert.deepEqual(
      frame.archivedTop5.map((x) => ({ q: x.rawRelativeQ, index: x.index })),
      game.moves[frame.turn].top5,
    );
  }
});

test('review rejects human/D1, other model seats, corrupt rankings and unfinished rounds', async () => {
  const game = await fixture(2500000550);
  for (const change of [
    (g) => (g.kind = 'game'),
    (g) => (g.appVersion = 'c1977-test'),
    (g) => (g.seats[1] = 'clint'),
    (g) => g.moves.pop(),
    (g) => (g.initial.hands[0][0] = g.initial.hands[1][0]),
    (g) => g.moves.find((m) => m.top5.length > 1).top5.reverse(),
  ]) {
    const bad = structuredClone(game);
    change(bad);
    await assert.rejects(reviewSimulatedRound(bad, 1));
  }
  let calls = 0;
  await assert.rejects(
    reviewSimulatedRound(game, 1, () => {
      if (++calls === 3) throw Error('STOP');
    }),
    /STOP/,
  );
});

test('registered review STOP precedes input reads and output/lock creation', async () => {
  const run = mkdtempSync(join(tmpdir(), 'review-stop-'));
  try {
    writeFileSync(join(run, 'STOP'), '{}');
    assert.equal((await runReviewExport(run)).phase, 'stopped-before-read');
    assert.equal(existsSync(join(run, 'status.json')), false);
    assert.equal(existsSync(join(run, 'review-export.lock')), false);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
