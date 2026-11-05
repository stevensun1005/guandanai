import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState, decisionContext } from '../../../web/src/ai/observation.js';
import { advanceRound } from './simulation.mjs';
import { createMatchRound, advanceMatch } from './match-simulation.mjs';
import { createRuleBaseline } from './rule-baseline.mjs';

/** All four seats see only their own hand and the public table. */
export async function playMatch({
  seed,
  team,
  mode = 'rule',
  decide,
  infer,
  snapshotInfer = null,
  evaluate = false,
  initialDealSeed = null,
  trainingCritic = false,
  tablePolicy = null,
  ruleVersion = 'original',
}) {
  if (!['rule', 'self', 'snapshot'].includes(mode) || ![0, 1].includes(team))
    throw Error('Invalid match lineup');
  if (mode === 'snapshot' && !snapshotInfer) throw Error('Missing frozen opponent');
  let match = { levels: [2, 2], lvlTeam: 0, aFails: [0, 0], round: 1, previousOrder: null };
  const history = [],
    publicHistory = [],
    stats = {
      rounds: 0,
      decisions: 0,
      afterFirstOutDecisions: 0,
      finishingChoices: 0,
      currentModelSeats: [],
      doubleWins: 0,
      doubleLosses: 0,
      isolatedFirsts: 0,
    };
  const seats = new Set();
  for (let r = 0; r < 200; r++) {
    const roundSeed =
      r === 0 && initialDealSeed !== null
        ? initialDealSeed >>> 0
        : (Math.imul(seed, 1009) + r) >>> 0;
    const game = createMatchRound(roundSeed, match),
      rule = createRuleBaseline(roundSeed ^ 0x6a09e667, { version: ruleVersion });
    if (tablePolicy) {
      game.roundHistory = publicHistory;
      Object.assign(game, {
        aFails: match.aFails,
        lvlTeam: match.lvlTeam,
        round: match.round,
        prevOut: match.previousOrder,
      });
    }
    let result = null;
    for (let turn = 0; turn < 1000; turn++) {
      const p = game.turn,
        opponent = p % 2 !== team;
      let play;
      if (opponent && mode === 'rule') play = rule(game, p);
      else if (tablePolicy && evaluate && !(opponent && mode === 'snapshot'))
        play = await tablePolicy(game, p);
      else {
        const plays = candidates(game.hands[p], game.L, game.trick?.play);
        let index = 0;
        if (plays.length > 1) {
          const state = policyState(game, p, 0, plays);
          state.context = decisionContext(game, p);
          state.trick = state.context.trick;
          state.actionShapes = plays.map((x) => x && { type: x.type, value: x.value, n: x.n });
          state.match = match;
          if ((opponent && mode === 'snapshot') || evaluate) {
            const values = await (opponent && mode === 'snapshot' ? snapshotInfer : infer)(state);
            if (values.length !== plays.length || values.some((v) => !Number.isFinite(v)))
              throw Error('Invalid match scores');
            index = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
          } else {
            index = (
              await decide(
                state,
                trainingCritic
                  ? { hands: game.hands.map((hand) => hand.map((card) => card.id)) }
                  : null,
              )
            ).index;
            stats.decisions++;
            seats.add(p);
            if (game.out.length) stats.afterFirstOutDecisions++;
            if (plays.some((x) => x?.cards.length === game.hands[p].length))
              stats.finishingChoices++;
          }
          if (!Number.isInteger(index) || index < 0 || index >= plays.length)
            throw Error('Invalid learned action');
        }
        play = plays[index];
      }
      result = advanceRound(game, play);
      if (result) break;
    }
    if (!result) throw Error('Round failed to terminate');
    const next = advanceMatch(match, game, result, 'draw');
    if (tablePolicy) publicHistory.push({ log: game.log });
    history.push({ round: match.round, level: game.L, ...next.result });
    stats.rounds++;
    if (result.order[0] % 2 === result.order[1] % 2)
      stats[result.winner === team ? 'doubleWins' : 'doubleLosses']++;
    if (result.winner === team && result.points === 1) stats.isolatedFirsts++;
    match = next;
    if (next.result.win || next.result.draw) {
      stats.currentModelSeats = [...seats].sort();
      return {
        seed,
        neuralTeam: team,
        opponent: mode,
        winner: next.result.draw ? null : next.result.team,
        history,
        stats,
      };
    }
  }
  throw Error('Match truncated: no training reward assigned');
}
