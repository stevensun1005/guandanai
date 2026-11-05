import { createRound, advanceRound } from '../../../ai/shared/simulation/simulation.mjs';
import { createRuleOpponent } from '../../../ai/shared/simulation/rule-baseline.mjs';
import { roundOutcome } from '../../src/core/match.js';
import {
  captureDeal,
  captureStart,
  captureAction,
  completedRecord,
} from '../../src/collection/record.mjs';

export function collectedRound(seed = 9301000) {
  const game = createRound(seed),
    context = {
      mode: 'host',
      practice: false,
      humans: [0, 1],
      version: '0000000000',
      rules: { trib: true, aFail: 'draw' },
      models: Array.from({ length: 4 }, () => ({
        id: 'clint-rule',
        sha256: null,
        version: 'rules-v2',
      })),
    };
  Object.assign(game, {
    round: 1,
    tok: seed,
    levels: [game.L, 2],
    lvlTeam: 0,
    aFails: [0, 0],
    aOut: null,
    trib: [],
  });
  captureDeal(game, context);
  captureStart(game, context);
  const choose = createRuleOpponent(seed);
  for (let step = 0; step < 1000; step++) {
    const player = game.turn,
      play = choose(game);
    game.clock = { who: player, total: 60000, left: 59000 };
    captureAction(game, player, play, { ...context, automatic: player >= 2 });
    const result = advanceRound(game, play);
    if (result) {
      game.result = roundOutcome(game, result.order).result;
      const record = completedRecord(game, context);
      record.kind = 'test';
      return record;
    }
  }
  throw Error('Fixture did not finish');
}
