import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from '../../../web/src/app/runtime.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { ruleObservation, decideClintRule } from '../../../web/src/rule-bot/runtime.mjs';
import { createRound, advanceRound } from '../simulation/simulation.mjs';

test('Clint Worker observations read only own physical hand and public counts', () => {
  const game = createRound(9201000);
  game.tok = 1;
  game.round = 1;
  const p = game.turn;
  game.hands = game.hands.map((h, seat) =>
    seat === p
      ? h
      : new Proxy(h, {
          get(t, k) {
            if (k === 'length') return t.length;
            throw Error('Hidden hand access');
          },
        }),
  );
  const obs = ruleObservation(game, p);
  for (let seat = 0; seat < 4; seat++)
    if (seat !== p) assert.equal(Object.keys(obs.hands[seat]).length, 0);
  const previous = runtime.game;
  decideClintRule(obs);
  assert.equal(runtime.game, previous);
});

test('Clint Worker route completes four full rounds with legal physical actions', () => {
  for (let seed = 9201001; seed <= 9201004; seed++) {
    const game = createRound(seed);
    game.tok = seed;
    game.round = 1;
    let finished = false;
    for (let i = 0; i < 1000; i++) {
      const p = game.turn,
        reply = decideClintRule(ruleObservation(game, p));
      const play = reply && {
        ...reply,
        cards: reply.cards.map((id) => game.hands[p].find((c) => c.id === id)),
      };
      if (play) {
        assert.ok(play.cards.every(Boolean));
        assert.ok(beats(play, game.trick?.play));
        assert.ok(
          analyze(play.cards, game.L).some(
            (s) => s.type === play.type && s.value === play.value && s.n === play.n,
          ),
        );
      } else assert.ok(game.trick);
      if (advanceRound(game, play)) {
        finished = true;
        break;
      }
    }
    assert.ok(finished);
  }
});
