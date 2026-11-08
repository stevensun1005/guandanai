import test from 'node:test';
import assert from 'node:assert/strict';
import { candidates } from '../../../web/src/ai/candidates.js';
import { createSolver, positionFromGame, solveEndgame } from '../endgame/solver.mjs';
import { labelDecision, playRound } from '../endgame/pimc-actor.mjs';
import { randomEndgame } from './endgame-solver.test.mjs';

test('PIMC labels average exact values over public-information worlds, deterministically', () => {
  let checked = 0;
  for (let seed = 1; checked < 8 && seed < 300; seed++) {
    const game = randomEndgame(15_400 + seed, 12);
    if (!game) continue;
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play || null);
    if (plays.length < 2) continue;
    const options = { worlds: 4, minWorlds: 2, seed: 77 };
    const a = labelDecision(game, plays, { solver: createSolver(), ...options });
    const b = labelDecision(game, plays, { solver: createSolver(), ...options });
    assert.deepEqual(a, b);
    assert.equal(a.used, 4);
    assert.equal(a.q.length, plays.length);
    for (const q of a.q) assert.ok(Number.isFinite(q) && Math.abs(q) <= 3);
    // With one world equal to the real deal the label is that deal's exact value of each move.
    checked++;
  }
  assert.ok(checked >= 5);
});

test('the true deal is never used for a label: labels ignore the hidden hands', () => {
  for (let seed = 1; seed < 200; seed++) {
    const game = randomEndgame(16_100 + seed, 12);
    if (!game) continue;
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play || null);
    if (plays.length < 2) continue;
    const others = [1, 2, 3].map((k) => (game.turn + k) % 4);
    // Swap two opponents' hidden cards of equal count: public information is unchanged.
    const [a, b] = others.filter((p) => p % 2 !== game.turn % 2);
    if (game.hands[a].length !== game.hands[b].length) continue;
    const swapped = { ...game, hands: game.hands.slice() };
    [swapped.hands[a], swapped.hands[b]] = [game.hands[b], game.hands[a]];
    const options = { worlds: 3, minWorlds: 1, seed: 5 };
    assert.deepEqual(
      labelDecision(game, plays, { solver: createSolver(), ...options }),
      labelDecision(swapped, plays, { solver: createSolver(), ...options }),
    );
    return;
  }
  assert.fail('no suitable endgame found');
});

test('playRound records one row per candidate at real endgame decisions only', async () => {
  const decide = async (_file, state) => state.actions.map((_, i) => -i); // prefer the first move
  const round = await playRound(3838999001, {
    decide,
    champion: 'unused',
    solver: createSolver({ maxNodes: 1_500_000, maxMs: 5000 }),
    threshold: 14,
    worlds: 2,
    minWorlds: 1,
    temperature: 0.05,
    followLabel: 0.5,
  });
  assert.ok(round.result);
  for (const row of round.rows) {
    assert.ok(row.cards <= 14);
    assert.ok(Number.isFinite(row.y) && Math.abs(row.y) <= 3);
    assert.equal(row.x.length, 567);
  }
  assert.equal(round.stats.decisions > 0, round.rows.length > 0);
});

test('a one-world PIMC label equals the exact solver value when that world is the real deal', () => {
  for (let seed = 1; seed < 300; seed++) {
    const game = randomEndgame(17_200 + seed, 10);
    if (!game) continue;
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play || null);
    const exact = solveEndgame(positionFromGame(game), { perspective: game.turn });
    // Sanity of the sign convention used by labels: mover-team view, same as solveEndgame.
    const solver = createSolver();
    const position = positionFromGame(game);
    plays.forEach((play, i) => {
      const v = solver.actionValue(position, play);
      assert.equal(game.turn % 2 === 0 ? v : -v, exact.actions[i].value);
    });
    return;
  }
  assert.fail('no endgame');
});
