import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { createRound, advanceRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { argmax, createModelPool } from '../training/continuous/lib.mjs';
import { labelDecision } from '../endgame/pimc-actor.mjs';
import { positionFromGame, solveEndgame, SolverBudget } from '../endgame/solver.mjs';
import {
  SEARCH,
  createSearchSolver,
  playPaired,
  searchChoice,
  summarize,
} from '../endgame/evaluate.mjs';

const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);
const BASELINE = 'ai/danMCai/models/baseline/policy.onnx';
const CHAMPION =
  '/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx';

// Frozen copy of playPaired from evaluate.mjs at a784b03 (before --policy existed): the default
// student mode must reproduce it exactly.
async function referencePlayPaired(
  seed,
  focalTeam,
  { values, champion, student, threshold, solverCards },
) {
  const game = createRound(seed);
  const stats = {
    endgameDecisions: 0,
    differs: 0,
    solverChecked: 0,
    regretStudent: 0,
    regretChampion: 0,
  };
  for (let ply = 0; ply < 1000; ply++) {
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const state = policyState(game, player, 0, plays);
      const useStudent = player % 2 === focalTeam && remaining(game) <= threshold;
      const base = await values(champion, state);
      if (useStudent) {
        const own = await values(student, state);
        index = argmax(own);
        const championIndex = argmax(base);
        stats.endgameDecisions++;
        if (index !== championIndex) {
          stats.differs++;
          if (remaining(game) <= solverCards) {
            try {
              const solved = solveEndgame(positionFromGame(game), {
                rootPlays: [plays[index], plays[championIndex]],
                maxNodes: 1_500_000,
                maxMs: 3000,
              });
              const best = solveEndgame(positionFromGame(game), {
                maxNodes: 1_500_000,
                maxMs: 3000,
              });
              stats.solverChecked++;
              stats.regretStudent += best.value - solved.actions[0].value;
              stats.regretChampion += best.value - solved.actions[1].value;
            } catch (error) {
              if (!(error instanceof SolverBudget)) throw error;
            }
          }
        }
      } else index = argmax(base);
    }
    const result = advanceRound(game, plays[index]);
    if (result) {
      const points = result.winner === focalTeam ? result.points : -result.points;
      return { points, order: result.order, ...stats };
    }
  }
  throw Error('Round did not terminate');
}

// Deterministic stand-in "networks": a hash of (model name, own hand, candidate).
function hashValues(file, state) {
  return state.actions.map((action) => {
    let h = 2166136261;
    for (const ch of `${file}|${state.hand.join(',')}|${action.join(',')}`)
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) / 2 ** 32;
  });
}

async function pairRows(seeds, config) {
  const rows = [];
  for (const seed of seeds) {
    const a = await playPaired(seed, 0, config);
    const b = await playPaired(seed, 1, config);
    rows.push({ seed, a, b, mean: (a.points + b.points) / 2 });
  }
  return rows;
}

const DEV = [3838122000, 3838122001, 3838122002, 3838122003];

test('default student mode reproduces the original evaluator exactly (stand-in values)', async () => {
  const config = {
    values: async (file, state) => hashValues(file, state),
    champion: 'champion',
    student: 'student',
    threshold: 32,
    solverCards: 12,
  };
  for (const seed of DEV)
    for (const team of [0, 1])
      assert.deepEqual(
        await playPaired(seed, team, config),
        await referencePlayPaired(seed, team, config),
      );
  // An explicit policy=student is the same as the default.
  assert.deepEqual(
    await playPaired(DEV[0], 0, { ...config, policy: 'student' }),
    await referencePlayPaired(DEV[0], 0, config),
  );
});

// Uses the frozen section-68 champion where it exists (this Mac); skipped elsewhere.
test(
  'default student mode reproduces the original evaluator exactly (ONNX models)',
  {
    skip: !existsSync(CHAMPION) && 'champion ONNX not on this machine',
  },
  async () => {
    const pool = await createModelPool(ort, { threads: 1, limit: 2 });
    try {
      const config = {
        values: (file, state) => pool.values(file, state),
        champion: CHAMPION,
        student: BASELINE,
        threshold: 20,
        solverCards: 12,
      };
      for (const seed of DEV.slice(0, 2))
        for (const team of [0, 1])
          assert.deepEqual(
            await playPaired(seed, team, config),
            await referencePlayPaired(seed, team, config),
          );
    } finally {
      await pool.close();
    }
  },
);

test('summarize keeps the original schema in student mode and only adds fields otherwise', async () => {
  const rows = await pairRows(DEV.slice(0, 2), {
    values: async (file, state) => hashValues(file, state),
    champion: 'champion',
    student: 'student',
    threshold: 32,
    solverCards: 0,
  });
  const original = summarize(rows);
  assert.deepEqual(Object.keys(original), [
    'pairs',
    'rounds',
    'focalWins',
    'focalLosses',
    'meanSignedPoints',
    'ci95',
    'interval',
    'studentEndgameDecisions',
    'decisionsDifferentFromChampion',
    'descriptiveExactRegret',
  ]);
  assert.deepEqual(summarize(rows, { policy: 'student' }), original);
  const extended = summarize(rows, { policy: 'champion-check' });
  for (const [key, value] of Object.entries(original)) assert.deepEqual(extended[key], value);
  assert.equal(extended.policy, 'champion-check');
});

test('champion-check plays the champion for the focal team: every pair scores exactly 0', async () => {
  const config = {
    values: async (file, state) => hashValues(file, state),
    champion: 'champion',
    student: 'ignored',
    threshold: 32,
    solverCards: 18,
    policy: 'champion-check',
  };
  const rows = await pairRows(DEV, config);
  for (const row of rows) {
    assert.equal(row.mean, 0);
    assert.equal(row.a.differs + row.b.differs, 0);
    assert.equal(row.a.solverChecked + row.b.solverChecked, 0);
  }
  const summary = summarize(rows, { policy: 'champion-check' });
  assert.equal(summary.meanSignedPoints, 0);
  assert.deepEqual(summary.ci95, [0, 0]);
  assert.equal(summary.pairsZero, DEV.length);
  assert.ok(summary.studentEndgameDecisions > 0);
});

function endgameDecision(seed, cards) {
  const game = createRound(seed),
    random = seededRandom(seed ^ 0x2545f491);
  for (let ply = 0; ply < 1000; ply++) {
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    if (remaining(game) <= cards && plays.length > 2) return { game, plays, ply };
    const real = plays.filter(Boolean);
    const pool = real.length && random() < 0.85 ? real : plays;
    if (advanceRound(game, pool[Math.floor(random() * pool.length)])) return null;
  }
  return null;
}

test('searchChoice plays a label-maximal candidate and breaks ties by the champion value', () => {
  let tiedChecked = 0;
  for (let seed = 3838122100; seed < 3838122160 && tiedChecked < 2; seed++) {
    const found = endgameDecision(seed, 14);
    if (!found) continue;
    const { game, plays, ply } = found;
    const label = labelDecision(game, plays, {
      solver: createSearchSolver(),
      worlds: SEARCH.worlds,
      minWorlds: SEARCH.minWorlds,
      seed: (seed * 1009 + ply * 7919) >>> 0,
    });
    if (!label.q) continue;
    const top = Math.max(...label.q);
    const tied = label.q.flatMap((y, i) => (Math.abs(y - top) <= 1e-9 ? [i] : []));
    for (const base of [plays.map((_, i) => i), plays.map((_, i) => -i)]) {
      const choice = searchChoice(game, plays, base, { solver: createSearchSolver(), seed, ply });
      assert.equal(choice.used, label.used);
      assert.equal(choice.tied, tied.length);
      assert.ok(tied.includes(choice.index));
      assert.equal(base[choice.index], Math.max(...tied.map((i) => base[i])));
    }
    if (tied.length > 1) tiedChecked++;
  }
  assert.ok(tiedChecked >= 1, 'no tied decision found');
});

test('pimc-search runs on two development pairs and records search statistics', async () => {
  const pool = await createModelPool(ort, { threads: 1, limit: 2 });
  try {
    const config = {
      values: (file, state) => pool.values(file, state),
      champion: existsSync(CHAMPION) ? CHAMPION : BASELINE,
      threshold: 20,
      solverCards: 18,
      policy: 'pimc-search',
      solver: createSearchSolver(),
    };
    const rows = await pairRows([3838122000, 3838122001], config);
    for (const round of rows.flatMap((row) => [row.a, row.b])) {
      assert.ok([1, 2, 3].includes(Math.abs(round.points)));
      assert.equal(round.searched, round.endgameDecisions);
      assert.ok(round.searchFallbacks <= round.searched);
      assert.ok(round.worldsUsed >= SEARCH.minWorlds * (round.searched - round.searchFallbacks));
      assert.ok(round.worldsUsed <= SEARCH.worlds * round.searched);
      assert.ok(round.searchSeconds >= round.searchMaxSeconds);
      assert.ok(round.differs <= round.searched);
    }
    const summary = summarize(rows, { policy: 'pimc-search' });
    assert.equal(summary.policy, 'pimc-search');
    assert.ok(summary.search.searchedDecisions > 0);
    assert.equal(summary.search.searchedDecisions, summary.studentEndgameDecisions);
    assert.ok(summary.search.secondsPerSearchedDecision > 0);
    assert.equal(summary.search.worlds, 8);
    assert.deepEqual(summary.search.solver, {
      maxNodes: 1_500_000,
      maxMs: 3000,
      maxTable: 1_000_000,
    });
  } finally {
    await pool.close();
  }
  await assert.rejects(
    playPaired(3838122000, 0, { values: async () => [], policy: 'pimc-search', threshold: 20 }),
    /needs a solver/,
  );
  await assert.rejects(playPaired(3838122000, 0, { policy: 'nope' }), /Unknown policy/);
});
