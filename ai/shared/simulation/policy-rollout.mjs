import { candidates } from '../../../web/src/ai/candidates.js';
import { decisionContext, policyState } from '../../../web/src/ai/observation.js';
import { advanceRound, createRound } from './simulation.mjs';

/** Roll out the actual game rules; inference receives only the acting seat's information. */
export async function collectPolicyEpisode({
  episode,
  seed,
  engine,
  ruleChoose = null,
  neuralTeam = null,
  explore = { epsilon: 0, temperature: 0 },
}) {
  if (neuralTeam !== null && ![0, 1].includes(neuralTeam)) throw Error('Invalid neural team');
  if (neuralTeam !== null && !ruleChoose) throw Error('Missing rule opponent');
  const game = createRound(seed);
  const stats = { decisions: 0, forced: 0, ruleActions: 0, maxCandidates: 0 };
  for (let turn = 0; turn < 1000; turn++) {
    const seat = game.turn;
    let play;
    if (neuralTeam !== null && seat % 2 !== neuralTeam) {
      play = ruleChoose(game, seat);
      stats.ruleActions++;
    } else {
      const plays = candidates(game.hands[seat], game.L, game.trick?.play);
      if (!plays.length) throw Error('No legal neural actions');
      stats.maxCandidates = Math.max(stats.maxCandidates, plays.length);
      let index = plays.findIndex(
        (candidate) => candidate && candidate.cards.length === game.hands[seat].length,
      );
      if (index < 0 && plays.length === 1) index = 0;
      if (index >= 0) stats.forced++;
      else {
        const state = policyState(game, seat, 0, plays);
        state.context = decisionContext(game, seat);
        state.trick = state.context.trick;
        state.actionShapes = plays.map(
          (candidate) =>
            candidate && {
              type: candidate.type,
              value: candidate.value,
              n: candidate.n,
              wu: candidate.wu,
            },
        );
        const reply = await engine.request({ op: 'decide', episode, seed, seat, state, explore });
        index = reply.index;
        if (!Number.isInteger(index) || index < 0 || index >= plays.length)
          throw Error('Inference selected an invalid action');
        stats.decisions++;
      }
      play = plays[index];
    }
    if (play === undefined) throw Error('Missing action');
    const result = advanceRound(game, play);
    if (result) {
      const saved = await engine.request({
        op: 'finish',
        episode,
        seed,
        neuralTeam,
        ...result,
      });
      return { episode, seed, neuralTeam, ...result, turns: turn + 1, stats, saved };
    }
  }
  throw Error('Training round did not terminate within 1000 turns');
}
