import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck } from '../src/core/cards.js';
import { rankedCoachActions, coachReading } from '../src/coach/evaluation.mjs';
import { scoreOracle } from '../src/coach/oracle.mjs';
import { candidates } from '../src/ai/candidates.js';
import { advanceRound, createRound, seededRandom } from '../../ai/shared/simulation/simulation.mjs';
import {
  privateEligible,
  privateActive,
  privateSeat,
  markPrivateTable,
  privateWasUsed,
  oracleObservation,
} from '../src/private-table/state.mjs';

const deck = makeDeck();
const position = (hands) => ({
  hands: hands.map((hand) => hand.map((rank) => deck[rank - 2])),
  L: 10,
  levels: [10, 7],
  turn: 0,
  log: [],
  out: [],
  trick: null,
  passes: 0,
  phase: 'play',
});
const infer = async (state) => {
  assert(
    !('hands' in state),
    'The unchanged network receives its regular observation, not four private hands',
  );
  return state.actions.map((ids) =>
    ids.length ? -ids.reduce((sum, id) => sum + deck[id].r, 0) / 100 : -10,
  );
};

test('Top 5 merges duplicate rank plans and retains the highest-valued actual suit choice', () => {
  const actions = [[0], [13], [54], [1], []],
    values = [3, 4, 2, 1, 0];
  const before = structuredClone(actions);
  const rows = rankedCoachActions(actions, values, 7);
  assert.deepEqual(
    rows.map((row) => row.ids),
    [[13], [1], []],
  );
  assert.deepEqual(
    rows.map((row) => row.value),
    [4, 1, 0],
  );
  assert.deepEqual(actions, before);
  assert.throws(() => rankedCoachActions([[0]], [NaN], 7));
});

test('Private mode is host-name gated and only applies to self and a computer partner', () => {
  const context = {
    nickname: 'stezer0',
    privateTable: true,
    network: { mode: 'host', humans: new Set([0]) },
  };
  assert(privateActive(context));
  assert.deepEqual(
    [0, 1, 2, 3].map((p) => privateSeat(context, p)),
    [true, false, true, false],
  );
  context.network.humans.add(2);
  assert(!privateSeat(context, 2));
  context.network.mode = 'guest';
  assert(!privateActive(context));
  assert(!privateEligible('solo', 'stezer0'));
  assert(!privateEligible('host', 'Stezer0'));
});

test('Private observations are independent copies and their matches remain excluded after switching off', () => {
  const game = position([[2], [3], [4], [5]]),
    observation = oracleObservation(game);
  const context = { game, nickname: 'stezer0', privateTable: true, network: { mode: 'host' } };
  markPrivateTable(context);
  context.privateTable = false;
  assert(privateWasUsed(game));
  assert(!privateWasUsed(position([[2], [3], [4], [5]])));
  game.hands[1].pop();
  assert.equal(observation.hands[1].length, 1);
});

test('Full-information neural rollouts can overturn their public neural prior using actual counterplay', async () => {
  const game = position([[3, 7], [4], [5], [6]]),
    before = structuredClone(game);
  const result = await scoreOracle(oracleObservation(game), infer, { horizon: 8, maxMs: 10000 });
  const small = result.actions.findIndex((ids) => ids[0] === 1),
    large = result.actions.findIndex((ids) => ids[0] === 5);
  assert.equal(result.values[small], -2);
  assert.equal(result.values[large], 2);
  assert.equal(result.actions[result.values.indexOf(Math.max(...result.values))][0], 5);
  assert.deepEqual(game, before);
});

test('Same public hand/counts, different hidden arrangements produce different completed team-upgrade values', async () => {
  const a = position([[2], [3], [4], [5]]),
    b = position([[2], [5], [4], [3]]);
  const x = await scoreOracle(oracleObservation(a), infer, { horizon: 8 });
  const y = await scoreOracle(oracleObservation(b), infer, { horizon: 8 });
  assert.deepEqual(x.values, [2]);
  assert.deepEqual(y.values, [1]);
});

test('Oracle rejects duplicate private cards and a leading pass before inference', async () => {
  const input = oracleObservation(position([[2], [3], [4], [5]]));
  await assert.rejects(scoreOracle({ ...input, hands: [[0], [0], [2], [3]] }, infer), /Invalid/);
  await assert.rejects(scoreOracle({ ...input, onlyAction: [] }, infer), /Cannot pass/);
});

test('Ambiguous wild cards use the actual UI legal reading for the current trick', () => {
  const ids = [1, 27, 2, 28, 18, 72],
    trick = { type: 'pairs3', value: 2, n: 6 };
  const play = coachReading(ids, 7, trick);
  assert.equal(play.type, 'pairs3');
  assert.equal(play.value, 3);
  const rows = rankedCoachActions([ids], [1], 7, 5, trick);
  assert.equal(rows[0].shape.type, 'pairs3');
});

// Replays a scored branch and returns whose turn it is at the leaf (null when the round ended).
function leafTurn(observation, rootIds, line) {
  const game = {
    hands: observation.hands.map((hand) => hand.map((id) => deck[id])),
    L: observation.level,
    levels: observation.levels.slice(),
    turn: observation.player,
    log: observation.log.map((e) => ({ p: e.p, cards: e.cards?.map((id) => deck[id]) || null })),
    trick: observation.trick && structuredClone(observation.trick),
    passes: observation.passes,
    out: observation.out.slice(),
  };
  const pick = (p, ids) =>
    ids?.length
      ? candidates(game.hands[p], game.L, game.trick?.play).find(
          (play) =>
            play &&
            play.cards.length === ids.length &&
            play.cards.every((card) => ids.includes(card.id)),
        )
      : null;
  let result = advanceRound(game, pick(observation.player, rootIds));
  for (const step of line) {
    assert.equal(step.p, game.turn, 'each rollout step is played by the seat to move');
    result = advanceRound(game, pick(step.p, step.cards));
  }
  return result ? null : game.turn;
}

test('Every unfinished branch is scored at the advising seat, even after 接风 hands the lead to an opponent', async () => {
  // Seat 1 led its last card and is out; seats 2 and 3 passed. If seat 0 also passes, 接风 gives
  // the lead to seat 3, an opponent, so a fixed four-move horizon would end on an opponent's turn.
  const id = (suit, rank) => ({ S: 0, H: 13, C: 26, D: 39 })[suit] + rank - 2;
  const game = {
    hands: [
      [id('S', 3), id('S', 4), id('H', 3), id('H', 14), id('S', 8)],
      [],
      [id('C', 3), id('C', 4), id('C', 7)],
      [id('D', 2), id('D', 3), id('D', 4), id('D', 5), id('D', 9)],
    ].map((hand) => hand.map((n) => deck[n])),
    L: 10,
    levels: [10, 10],
    turn: 0,
    log: [
      { p: 1, cards: [deck[id('S', 6)]], lead: true },
      { p: 2, cards: null },
      { p: 3, cards: null },
    ],
    out: [1],
    trick: { player: 1, play: { type: 'single', value: 6, n: 1 } },
    passes: 2,
    phase: 'play',
  };
  const observation = oracleObservation(game);
  const result = await scoreOracle(observation, infer, { horizon: 4, maxMs: 10000 });
  assert.equal(result.search.mismatchedLeaves, 0);
  assert.equal(result.lines.length, result.actions.length);
  for (const [i, ids] of result.actions.entries()) {
    const turn = leafTurn(observation, ids, result.lines[i]);
    if (turn !== null) assert.equal(turn, 0, `branch ${i} must end on the advising seat`);
  }
  const pass = result.actions.findIndex((ids) => !ids.length);
  assert(pass >= 0, 'passing to a partner is always evaluated');
  assert(result.lines[pass].length > 3, 'the pass branch continues past the four-move horizon');
});

test('Random mid-round positions never compare leaves from different seats', async () => {
  const random = seededRandom(91);
  let checked = 0;
  for (let seed = 0; seed < 6; seed++) {
    const game = createRound(4_100_000 + seed);
    game.phase = 'play';
    for (let move = 0; move < 30 + seed * 7; move++) {
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
      if (advanceRound(game, plays[Math.floor(random() * plays.length)])) break;
    }
    if (!game.hands[game.turn]?.length || game.out.length >= 2) continue;
    const observation = oracleObservation(game, game.turn);
    const result = await scoreOracle(observation, infer, { horizon: 4, maxRoots: 3, maxMs: 10000 });
    for (const [i, ids] of result.actions.entries()) {
      const turn = leafTurn(observation, ids, result.lines[i]);
      if (turn === null || result.lines[i].length >= 4 + 8 - 1) continue;
      const evaluator = game.hands[observation.player].length
        ? observation.player
        : (observation.player + 2) % 4;
      assert([observation.player, evaluator, (observation.player + 2) % 4].includes(turn));
      checked++;
    }
  }
  assert(checked > 0);
});
