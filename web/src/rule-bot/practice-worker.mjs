import { makeDeck, shuffle } from '../core/cards.js';
import { genPlays } from '../core/moves.js';
import { beats } from '../core/combinations.js';
import { decideClintRule, ruleObservation } from './runtime.mjs';
import { finished, solveEndgame, stepPosition } from './practice-endgame.mjs';

export function generate(limit, L) {
  const deadline = performance.now() + 5000;
  for (let attempt = 0; attempt < 20; attempt++) {
    const deck = shuffle(makeDeck());
    let game = {
      hands: [0, 1, 2, 3].map((p) => deck.slice(p * 27, p * 27 + 27)),
      L,
      turn: (Math.random() * 4) | 0,
      out: [],
      trick: null,
      passes: 0,
      log: [],
      tok: attempt,
      round: 1,
    };
    for (let ply = 0; ply < 500; ply++) {
      if (performance.now() >= deadline) throw Error('生成达到5秒上限，请重试或提高张数上限');
      const p = game.turn,
        selected = decideClintRule(ruleObservation(game, p));
      let play = selected && {
        ...selected,
        cards: selected.cards.map((id) => game.hands[p].find((c) => c.id === id)),
      };
      if (play && (!play.cards.every(Boolean) || !beats(play, game.trick?.play))) play = null;
      if (!play && !game.trick) play = genPlays(game.hands[p], L)[0];
      const log = game.log.concat({
        p,
        cards: play?.cards || null,
        lead: !game.trick,
        ...(play ? { type: play.type, value: play.value, n: play.n } : {}),
      });
      game = { ...stepPosition(game, play), log };
      if (finished(game)) break;
      if (game.hands.every((h) => h.length <= limit)) {
        const { hands, turn, out, trick, passes } = game;
        return {
          initial: { hands, turn, out, trick, passes, L },
          prefixPlies: log.length,
          source: 'Clint普通观察续打的模拟残局',
        };
      }
    }
  }
  throw Error('这次没有生成合适残局，请重试或提高张数上限');
}
if (typeof self !== 'undefined')
  self.onmessage = ({ data }) => {
    try {
      if (
        !Number.isInteger(data.limit) ||
        data.limit < 3 ||
        data.limit > 10 ||
        !Number.isInteger(data.L) ||
        data.L < 2 ||
        data.L > 14 ||
        ![2000, 5000, 10000, 30000].includes(data.maxMs)
      )
        throw Error('残局选项无效');
      const fixture = generate(data.limit, data.L);
      self.postMessage({ type: 'position', ...fixture });
      const result = solveEndgame(fixture.initial, { maxMs: data.maxMs });
      self.postMessage({ type: 'result', ...fixture, result });
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error.message || error) });
    }
  };
