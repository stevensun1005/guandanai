import test from 'node:test';
import assert from 'node:assert/strict';
import { createRound, advanceRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { cardText, rankName } from '../../../web/src/core/cards.js';
import { analyze, beats, strength } from '../../../web/src/core/combinations.js';
import { publicLog, publicLogText } from '../../../web/src/replay/public-log.js';
import { coachObservation, prepareCoachPolicy } from '../../../web/src/coach/evaluation.mjs';
import {
  exporterSeat,
  parseMatchRecord,
  planKey,
  replayDecisions,
  seatsOf,
} from '../tools/human-moves.mjs';

const NAMES = ['测试者', '下家', '对家', '上家'];
const multiset = (cards) => cards.map(cardText).sort().join(' ');

/** Play a random legal round, keeping each mover's true hand and the counts before every move. */
function playRound(seed) {
  const game = createRound(seed),
    random = seededRandom(seed * 7 + 1);
  const truth = [];
  for (let guard = 0; guard < 2000; guard++) {
    const p = game.turn;
    const plays = candidates(game.hands[p], game.L, game.trick?.play);
    const options = game.trick ? [null, ...plays] : plays;
    const play = options[Math.floor(random() * options.length)];
    truth.push({
      p,
      hand: multiset(game.hands[p]),
      counts: game.hands.map((hand) => hand.length),
      lead: !game.trick,
    });
    const result = advanceRound(game, play);
    if (result) return { game, truth, result };
  }
  throw Error('Round did not finish');
}

function exportText(game, result) {
  game.round = 1;
  const winner = result.order[0] % 2;
  return [
    '掼蛋 · 整场公开牌谱',
    '',
    publicLogText(publicLog(game, NAMES, NAMES[0])),
    `名次：${result.order.map((seat) => NAMES[seat]).join(' → ')}`,
    `${winner ? '对方' : '我方'}本局获胜 · 级数 ${rankName(game.L)} → ${rankName(Math.min(14, game.L + result.points))}`,
  ].join('\n');
}

test('a public record rebuilds the hands, counts and coach inputs of every finished seat', () => {
  let checkedSeats = 0;
  for (const seed of [3, 11, 29, 47]) {
    const { game, truth, result } = playRound(seed);
    const rounds = parseMatchRecord(exportText(game, result));
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].entries.length, game.log.length);
    for (const seat of [0, 1, 2, 3]) {
      const player = NAMES[seat];
      const played = game.log.filter((e) => e.p === seat && e.cards).flatMap((e) => e.cards);
      const replay = replayDecisions(rounds, player);
      if (played.length !== 27) {
        assert.deepEqual(replay.decisions, []);
        assert.equal(replay.skipped[0].played, played.length);
        continue;
      }
      checkedSeats++;
      const seats = seatsOf(rounds[0], player);
      for (const [name, at] of Object.entries(seats))
        assert.equal(at, (NAMES.indexOf(name) - seat + 4) % 4, `${player} sees ${name}`);
      const mine = truth.filter((t) => t.p === seat);
      assert.equal(replay.decisions.length, mine.length);
      replay.decisions.forEach((decision, index) => {
        const real = mine[index];
        assert.equal(multiset(decision.game.hands[0]), real.hand, `hand at step ${decision.step}`);
        assert.deepEqual(
          decision.game.hands.map((hand) => hand.length),
          [0, 1, 2, 3].map((k) => real.counts[(k + seat) % 4]),
        );
        assert.equal(decision.lead, real.lead);
        // the coach input built from the replay offers the move that was really made
        const input = prepareCoachPolicy(coachObservation(decision.game));
        const level = decision.game.L,
          current = decision.game.trick?.play;
        const keys = input.actions.map((ids) => {
          const cards = ids.map((id) => decision.game.hands[0].find((c) => c.id === id));
          const shape = cards.length
            ? analyze(cards, level)
                .filter((s) => beats(s, current))
                .sort((a, b) => strength(b) - strength(a))[0]
            : null;
          return planKey(shape, cards, level);
        });
        assert(keys.includes(planKey(decision.reading, decision.actual, level)));
      });
    }
  }
  assert(checkedSeats >= 4, 'enough seats finished to exercise the rebuild');
});

test('the exporter seat comes from the bot labels or an explicit name', () => {
  // 客人 compares their own moves in a record the host exported. The host sits before 客人, so
  // the host's 对家 and 上家 labels are the two computer seats after 客人.
  const seats = { 客人: 0, 对家: 1, 上家: 2, 房主: 3 };
  assert.equal(exporterSeat(seats), 3);
  assert.equal(exporterSeat({ 客人: 0, 房主: 2 }, '房主'), 2);
  assert.equal(exporterSeat({ 客人: 0, 房主: 2 }), 0);
  assert.throws(() => exporterSeat(seats, '路人'));
});

test('unknown cards and records without rounds are rejected', () => {
  assert.throws(() => parseMatchRecord('掼蛋 · 整场公开牌谱'));
  assert.throws(() => parseMatchRecord('掼蛋 · 第 1 局 · 打 2\n1. 甲 领出 单张 · ♠1'));
});
