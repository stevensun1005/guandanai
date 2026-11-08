import test from 'node:test';
import assert from 'node:assert/strict';
import { createRound, advanceRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import {
  positionFromGame,
  step,
  solveEndgame,
  signedPoints,
  remainingCards,
  SolverBudget,
} from '../endgame/solver.mjs';

/** Play legal random moves from a fresh deal until at most `cards` remain; null if the round ends. */
export function randomEndgame(seed, cards) {
  const game = createRound(seed),
    random = seededRandom(seed ^ 0x5bd1e995);
  for (let ply = 0; ply < 1000; ply++) {
    if (remainingCards(game) <= cards) return game;
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    // Prefer real plays so random games actually shrink hands.
    const real = plays.filter(Boolean);
    const pool = real.length && random() < 0.85 ? real : plays;
    if (advanceRound(game, pool[Math.floor(random() * pool.length)])) return null;
  }
  return null;
}

function bruteForce(position, team) {
  const maximizing = position.turn % 2 === team;
  let best = maximizing ? -Infinity : Infinity;
  for (const play of candidates(position.hands[position.turn], position.L, position.trick?.play)) {
    const next = step(position, play);
    const v = next.result ? signedPoints(next.result, team) : bruteForce(next.position, team);
    best = maximizing ? Math.max(best, v) : Math.min(best, v);
  }
  return best;
}

test('solver step reproduces advanceRound turn order, trick reset, 接风 and final points', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const game = createRound(7000 + seed),
      random = seededRandom(seed);
    let position = positionFromGame(game);
    for (let ply = 0; ply < 1000; ply++) {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      const real = plays.filter(Boolean);
      const pool = real.length && random() < 0.8 ? real : plays;
      const play = pool[Math.floor(random() * pool.length)];
      const mine = step(position, play);
      const expected = advanceRound(game, play);
      if (expected) {
        assert.deepEqual(mine.result, expected);
        break;
      }
      assert.ok(mine.position, 'solver ended a round the engine continues');
      position = mine.position;
      assert.equal(position.turn, game.turn);
      assert.equal(position.passes, game.passes);
      assert.deepEqual(position.out, game.out);
      assert.equal(position.trick?.player ?? null, game.trick?.player ?? null);
      const faces = (h) =>
        h
          .map((c) => c.r + c.s)
          .sort()
          .join(',');
      assert.deepEqual(position.hands.map(faces), game.hands.map(faces));
    }
  }
});

test('alpha-beta with transposition table equals exhaustive minimax on small real endgames', () => {
  let checked = 0;
  for (let seed = 1; checked < 25 && seed < 400; seed++) {
    const game = randomEndgame(9100 + seed, 9);
    if (!game) continue;
    const position = positionFromGame(game);
    const team = position.turn % 2;
    const solved = solveEndgame(position);
    assert.equal(solved.value, bruteForce(position, team));
    for (const action of solved.actions) {
      const next = step(position, action.play);
      const exact = next.result ? signedPoints(next.result, team) : bruteForce(next.position, team);
      assert.equal(action.value, exact);
    }
    checked++;
  }
  assert.equal(checked, 25);
});

test('values are signed team points; the other team sees the negation; budgets throw', () => {
  let checked = 0;
  for (let seed = 1; checked < 10 && seed < 400; seed++) {
    const game = randomEndgame(9500 + seed, 12);
    if (!game) continue;
    const position = positionFromGame(game);
    const mine = solveEndgame(position);
    const theirs = solveEndgame(position, { perspective: (position.turn + 1) % 4 });
    assert.ok([-3, -2, -1, 1, 2, 3].includes(mine.value));
    assert.equal(theirs.value, -mine.value);
    assert.equal(mine.value, Math.max(...mine.actions.map((a) => a.value)));
    checked++;
  }
  assert.equal(checked, 10);
  const big = randomEndgame(9001, 60) || positionFromGame(createRound(9001));
  assert.throws(() => solveEndgame(positionFromGame(big), { maxNodes: 50 }), SolverBudget);
});
