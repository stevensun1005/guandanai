import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePolicyEvaluations } from '../../local/evaluation/analyze-policy-evaluation.mjs';

const outcome = (side, won, points = 1) => ({
  testedSide: side,
  winner: won ? side : 1 - side,
  points,
  won,
  signedPoints: (won ? 1 : -1) * points,
  order: (won ? side : 1 - side) === 0 ? [0, 1, 3, 2] : [1, 0, 2, 3],
});
const pair = (seed, wins) => ({ seed, outcomes: wins.map((won, side) => outcome(side, won)) });

test('paired policy comparison clusters seat assignments and preserves level/team totals', () => {
  const baseline = [pair(21200104, [false, true]), pair(21200105, [true, false])];
  const candidate = [pair(21200105, [true, true]), pair(21200104, [true, true])];
  const report = comparePolicyEvaluations(baseline, candidate);
  assert.equal(report.baselineWinRate.mean, 0.5);
  assert.equal(report.candidateWinRate.mean, 1);
  assert.deepEqual(report.winRateDifference, { mean: 0.5, confidence95: [0.5, 0.5] });
  assert.deepEqual(report.signedPointsDifference, { mean: 1, confidence95: [1, 1] });
  assert.deepEqual(report.pairedOutcomes, {
    bothWin: 2,
    candidateOnlyWins: 2,
    baselineOnlyWins: 0,
    bothLose: 0,
  });
  assert.equal(
    report.byLevel.reduce((sum, level) => sum + level.deals, 0),
    2,
  );
  assert.deepEqual(
    report.byTestedTeam.map((team) => team.baselineWins),
    [1, 1],
  );
  assert.deepEqual(
    report.byTestedTeam.map((team) => team.candidateWins),
    [2, 2],
  );
});

test('policy comparison refuses mismatched seeds, duplicate assignments and corrupted win labels', () => {
  const baseline = [pair(21200104, [true, false]), pair(21200105, [true, false])];
  assert.throws(
    () => comparePolicyEvaluations(baseline, [pair(21200106, [true, false]), baseline[1]]),
    /same deal/,
  );
  const duplicate = structuredClone(baseline);
  duplicate[0].outcomes[1].testedSide = 0;
  assert.throws(() => comparePolicyEvaluations(baseline, duplicate), /Invalid outcome/);
  const corrupted = structuredClone(baseline);
  corrupted[0].outcomes[0].won = false;
  assert.throws(() => comparePolicyEvaluations(baseline, corrupted), /disagree/);
});
