import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { candidates } from '../src/ai/candidates.js';
import { analyze } from '../src/core/combinations.js';
import { policyState, decisionContext } from '../src/ai/observation.js';
import { createRound, advanceRound, seededRandom } from './lib/simulation.mjs';
import { createRuleBaseline } from './lib/rule-baseline.mjs';
import { createPolicyInference } from './lib/policy-inference.mjs';

const K = 4;
const event = (player, play) => ({
  p: player,
  ids: play?.cards.map((card) => card.id).sort((a, b) => a - b) || [],
  type: play?.type || null,
  value: play?.value ?? null,
  n: play?.n ?? null,
});
function restorePlay(game, record) {
  if (record.p !== game.turn) throw Error('Prefix turn mismatch');
  if (!record.ids.length) return null;
  const hand = new Map(game.hands[game.turn].map((card) => [card.id, card]));
  const cards = record.ids.map((id) => hand.get(id));
  if (cards.some((card) => !card)) throw Error('Recorded action uses unavailable cards');
  const shape = analyze(cards, game.L).find(
    (item) => item.type === record.type && item.value === record.value && item.n === record.n,
  );
  if (!shape) throw Error('Recorded action has invalid shape');
  return { ...shape, cards };
}
function input(game, plays) {
  const state = policyState(game, game.turn, 0, plays);
  state.context = decisionContext(game, game.turn);
  state.trick = state.context.trick;
  state.actionShapes = plays.map(
    (play) => play && { type: play.type, value: play.value, n: play.n, wu: play.wu },
  );
  return state;
}
async function neuralAction(game, infer, stats) {
  const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
  if (!plays.length) throw Error('No legal actions');
  let index = plays.findIndex((play) => play?.cards.length === game.hands[game.turn].length);
  if (index < 0 && plays.length === 1) index = 0;
  if (index >= 0) return { play: plays[index], pivot: null };
  const state = input(game, plays);
  const values = await infer(state);
  if (values.length !== plays.length || values.some((value) => !Number.isFinite(value)))
    throw Error('Invalid proposal values');
  stats.modelDecisions++;
  const ranked = values.map((value, i) => ({ value, index: i })).sort((a, b) => b.value - a.value);
  const indices = ranked.slice(0, K).map((item) => item.index);
  return {
    play: plays[ranked[0].index],
    pivot: {
      state,
      indices,
      actions: indices.map((i) => event(game.turn, plays[i])),
      proposalValues: indices.map((i) => values[i]),
    },
  };
}

/** The full deal stays inside the simulator. Every policy call uses only that seat's view. */
export async function collectCounterfactualDeal({
  seed,
  episode,
  infer,
  neuralTeam = episode % 2,
}) {
  if (![0, 1].includes(neuralTeam)) throw Error('Invalid neural team');
  const random = seededRandom(seed ^ 0x3c6ef372);
  const ruleSeed = seed ^ 0x6a09e667;
  const rule = createRuleBaseline(ruleSeed);
  const game = createRound(seed);
  const prefix = [];
  const stats = {
    modelDecisions: 0,
    baseTurns: 0,
    branchTurns: 0,
    prefixRuleDecisions: 0,
    eligiblePivots: 0,
  };
  let pivot = null;
  for (let turn = 0; turn < 1000; turn++) {
    const player = game.turn;
    let play;
    if (player % 2 !== neuralTeam) play = rule(game, player);
    else {
      const choice = await neuralAction(game, infer, stats);
      play = choice.play;
      if (choice.pivot) {
        stats.eligiblePivots++;
        if (random() < 1 / stats.eligiblePivots)
          pivot = { ...choice.pivot, prefix: prefix.slice(), player };
      }
    }
    prefix.push(event(player, play));
    advanceRound(game, play);
    stats.baseTurns++;
    if (game.out.length) break;
  }
  if (!game.out.length) throw Error('Base round did not reach first-out');
  if (!pivot)
    return { episode, seed, skipped: 'No non-forced neural decision before first-out', stats };
  const baseWinner = game.out[0] % 2;
  const returns = [];
  const branchWinners = [];
  for (const action of pivot.actions) {
    const branch = createRound(seed);
    const branchRule = createRuleBaseline(ruleSeed);
    for (const record of pivot.prefix) {
      if (branch.turn % 2 !== neuralTeam) {
        const repeated = event(branch.turn, branchRule(branch, branch.turn));
        stats.prefixRuleDecisions++;
        if (JSON.stringify(repeated) !== JSON.stringify(record))
          throw Error('Rule prefix replay changed: cache or RNG was not restored');
      }
      advanceRound(branch, restorePlay(branch, record));
      if (branch.out.length) throw Error('Pivot must precede first-out');
    }
    advanceRound(branch, restorePlay(branch, action));
    stats.branchTurns++;
    for (let turn = 0; turn < 1000 && !branch.out.length; turn++) {
      const play =
        branch.turn % 2 === neuralTeam
          ? (await neuralAction(branch, infer, stats)).play
          : branchRule(branch, branch.turn);
      advanceRound(branch, play);
      stats.branchTurns++;
    }
    if (!branch.out.length) throw Error('Counterfactual branch did not reach first-out');
    const winner = branch.out[0] % 2;
    branchWinners.push(winner);
    returns.push(winner === pivot.player % 2 ? 1 : -1);
  }
  if (branchWinners[0] !== baseWinner)
    throw Error('Unchanged root action did not reproduce base winner');
  return {
    episode,
    seed,
    neuralTeam,
    player: pivot.player,
    prefixTurns: pivot.prefix.length,
    state: pivot.state,
    indices: pivot.indices,
    returns,
    proposalValues: pivot.proposalValues,
    baseWinner,
    branchWinners,
    stats,
  };
}

async function main() {
  const option = (name, fallback) =>
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const games = Number(option('games', '100'));
  const seed = Number(option('seed', '21500104'));
  if (!Number.isSafeInteger(games) || games < 1 || !Number.isSafeInteger(seed) || seed < 0)
    throw Error('Invalid games or seed');
  const model = resolve(option('model', 'ai/policy.onnx'));
  const output = resolve(option('output', 'work/learning/counterfactual-smoke'));
  const sourceFiles = [
    'scripts/collect-counterfactual.mjs',
    'scripts/counterfactual_learning.py',
    'scripts/policy_learning.py',
    'scripts/policy_features.py',
    'ai/reference/numpy_engine.py',
    'scripts/lib/simulation.mjs',
    'scripts/lib/rule-baseline.mjs',
    'src/ai/observation.js',
    'src/ai/candidates.js',
    'src/ai/rule-policy.js',
    'src/ai/hand-value.js',
    'src/hand/arrangement.js',
    'src/hand/hints.js',
    'src/core/cards.js',
    'src/core/combinations.js',
    'src/core/moves.js',
  ];
  const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const sourceSHA256 = Object.fromEntries(sourceFiles.map((file) => [file, hash(file)]));
  const summary = {
    version: 1,
    status: 'running',
    games,
    seed,
    seedRange: [seed, seed + games - 1],
    k: K,
    model,
    modelSHA256: hash(model),
    sourceSHA256,
    opponent:
      'Existing unchanged rules; paired branches replay its complete prefix to restore cache and RNG.',
    protocol:
      'One reservoir-sampled non-forced neural decision before first-out per independent deal; top four proposal actions, same simulator deal and prefix, public-only policy inputs; greedy continuations stop at first-out.',
    reward:
      'First-out team win +1, loss -1, relative to pivot seat; keep ties and all sampled actions.',
    completedGames: 0,
    rows: 0,
    pivots: 0,
    skipped: 0,
    branches: 0,
    variedReturnPivots: 0,
    allTiePivots: 0,
    differingFromReference: 0,
    modelDecisions: 0,
    prefixRuleDecisions: 0,
    baseTurns: 0,
    branchTurns: 0,
  };
  mkdirSync(output, { recursive: true });
  const fd = openSync(resolve(output, 'pivots.jsonl'), 'wx');
  const engine = createPolicyInference({ script: resolve('scripts/counterfactual_learning.py') });
  const started = performance.now();
  const save = () => {
    summary.elapsedSeconds = (performance.now() - started) / 1000;
    writeFileSync(resolve(output, 'rollout.json'), JSON.stringify(summary, null, 2) + '\n');
  };
  try {
    save();
    await engine.request({ op: 'init', model, output, seed, games, sourceSHA256 });
    for (let episode = 0; episode < games; episode++) {
      const result = await collectCounterfactualDeal({
        seed: seed + episode,
        episode,
        infer: engine.infer,
      });
      if (result.skipped) summary.skipped++;
      else {
        await engine.request({
          op: 'record',
          episode,
          seed: result.seed,
          state: result.state,
          indices: result.indices,
          returns: result.returns,
        });
        summary.rows++;
        summary.pivots++;
        summary.branches += result.returns.length;
        if (new Set(result.returns).size > 1) summary.variedReturnPivots++;
        else summary.allTiePivots++;
        summary.differingFromReference += result.returns.filter(
          (value) => value !== result.returns[0],
        ).length;
      }
      for (const key of ['modelDecisions', 'prefixRuleDecisions', 'baseTurns', 'branchTurns'])
        summary[key] += result.stats[key];
      const { state, ...audit } = result;
      writeSync(fd, JSON.stringify(audit) + '\n');
      summary.completedGames++;
      if ((episode + 1) % 25 === 0 || episode + 1 === games) {
        save();
        console.log(
          `${episode + 1}/${games} deals · ${summary.rows} pivots · ${summary.variedReturnPivots} differing returns · ${Math.round(summary.elapsedSeconds)}s`,
        );
      }
    }
    await engine.request({ op: 'finalize', status: 'complete' });
    summary.status = 'complete';
    save();
    console.log(JSON.stringify(summary));
  } catch (error) {
    summary.status = 'failed';
    summary.error = error.message;
    save();
    try {
      await engine.request({ op: 'finalize', status: 'failed' });
    } catch {}
    throw error;
  } finally {
    closeSync(fd);
    engine.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
