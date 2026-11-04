import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { candidates } from '../src/ai/candidates.js';
import { policyState, decisionContext } from '../src/ai/observation.js';
import { advanceRound } from './lib/simulation.mjs';
import { createMatchRound, advanceMatch } from './lib/match-simulation.mjs';
import { createRuleBaseline } from './lib/rule-baseline.mjs';
import { createPolicyInference } from './lib/policy-inference.mjs';

const option = (name, fallback) =>
  process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const games = Number(option('matches', '64')),
  seed = Number(option('seed', '31000104'));
const output = resolve(option('output', 'work/learning/full-match/data'));
const evaluate = option('evaluate', '0') === '1';
const model = resolve(option('model', 'work/learning/ppo-k4-extended/cycle-12/model/ppo.npz'));
if (!Number.isInteger(games) || games < 1 || !Number.isInteger(seed))
  throw Error('Invalid match collection plan');
mkdirSync(output, { recursive: true });
const manifest = {
  status: 'collecting',
  games,
  completedGames: 0,
  seed,
  objective: 'Whole match from 2 through A; team victory, draw and defeat',
  aFail: 'draw',
  tribute: true,
  rounds: 0,
  decisions: 0,
  afterFirstOutDecisions: 0,
  wins: 0,
  draws: 0,
};
const save = () => writeFileSync(`${output}/rollout.json`, JSON.stringify(manifest, null, 2));
const engine = createPolicyInference({ script: resolve('scripts/match_learning.py') });
try {
  await engine.request({ op: 'init', model, output, seed, options: { games, opponent: 'rule' } });
  for (let episode = 0; episode < games; episode++) {
    const team = episode % 2;
    let match = { levels: [2, 2], lvlTeam: 0, aFails: [0, 0], round: 1, previousOrder: null };
    const history = [];
    for (let r = 0; r < 200; r++) {
      const matchSeed = seed + (evaluate ? Math.floor(episode / 2) : episode);
      const roundSeed = (Math.imul(matchSeed, 1009) + r) >>> 0;
      const game = createMatchRound(roundSeed, match),
        rule = createRuleBaseline(roundSeed ^ 0x6a09e667);
      let result = null;
      for (let turn = 0; turn < 1000; turn++) {
        const p = game.turn;
        let play;
        if (p % 2 !== team) play = rule(game, p);
        else {
          const plays = candidates(game.hands[p], game.L, game.trick?.play);
          let index = 0;
          if (plays.length > 1) {
            const state = policyState(game, p, 0, plays);
            state.context = decisionContext(game, p);
            state.trick = state.context.trick;
            state.actionShapes = plays.map((x) => x && { type: x.type, value: x.value, n: x.n });
            state.match = match;
            if (evaluate) {
              const values = await engine.infer(state);
              index = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
            } else {
              const answer = await engine.request({ op: 'decide', episode, seat: p, state });
              index = answer.index;
            }
            if (!Number.isInteger(index) || index < 0 || index >= plays.length)
              throw Error('Invalid learned action');
            manifest.decisions++;
            if (game.out.length) manifest.afterFirstOutDecisions++;
          }
          play = plays[index];
        }
        result = advanceRound(game, play);
        if (result) break;
      }
      if (!result) throw Error('Round failed to terminate');
      const next = advanceMatch(match, game, result, 'draw');
      history.push({ round: match.round, level: game.L, ...next.result });
      manifest.rounds++;
      match = next;
      if (next.result.win || next.result.draw) {
        const winner = next.result.draw ? null : next.result.team;
        await engine.request({ op: 'finish', episode, winner, points: 0 });
        appendFileSync(
          `${output}/matches.jsonl`,
          JSON.stringify({ episode, seed: seed + episode, neuralTeam: team, winner, history }) +
            '\n',
        );
        if (winner === null) manifest.draws++;
        else if (winner === team) manifest.wins++;
        break;
      }
      if (r === 199) throw Error('Match truncated: no terminal training label assigned');
    }
    manifest.completedGames++;
    save();
    console.log(
      JSON.stringify({
        matches: manifest.completedGames,
        rounds: manifest.rounds,
        decisions: manifest.decisions,
        afterFirstOut: manifest.afterFirstOutDecisions,
      }),
    );
  }
  manifest.status = 'complete';
  save();
} catch (error) {
  manifest.status = 'failed';
  manifest.error = error.message;
  save();
  throw error;
} finally {
  engine.close();
}
