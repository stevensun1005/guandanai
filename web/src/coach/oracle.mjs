import { makeDeck } from '../core/cards.js';
import { candidates } from '../ai/candidates.js';
import { policyState } from '../ai/observation.js';
import { advanceRound, seededRandom } from '../../../ai/shared/simulation/simulation.mjs';
import { rankedCoachActions, coachReading, actionKey } from './evaluation.mjs';

const deck = makeDeck();
function restore(input) {
  const all = input.hands?.flat();
  if (
    !all ||
    input.hands.length !== 4 ||
    new Set(all).size !== all.length ||
    all.some((id) => !Number.isInteger(id) || id < 0 || id > 107) ||
    !Number.isInteger(input.player) ||
    input.player < 0 ||
    input.player > 3 ||
    !input.hands[input.player].length ||
    input.hands.some((hand) => hand.length > 27)
  )
    throw Error('Invalid full-information position');
  return {
    hands: input.hands.map((hand) => hand.map((id) => deck[id])),
    L: input.level,
    levels: input.levels.slice(),
    turn: input.player,
    log: input.log.map((entry) => ({
      p: entry.p,
      cards: entry.cards?.map((id) => deck[id]) || null,
    })),
    trick: input.trick && structuredClone(input.trick),
    passes: input.passes,
    out: input.out.slice(),
  };
}
const shapeOf = (play) => play && { type: play.type, value: play.value, n: play.n, wu: play.wu };

/** A rollout move: a legal finish first, otherwise the best or a softmax-sampled network value. */
function chooseMove(plays, estimates, hand, random, temperature, rawArgmax = false) {
  const finish = rawArgmax ? -1 : plays.findIndex((play) => play?.cards.length === hand.length);
  if (finish >= 0) return finish;
  const best = estimates.indexOf(Math.max(...estimates));
  if (!random) return best;
  const weights = estimates.map((value) => Math.exp((value - estimates[best]) / temperature));
  let x = random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
  return best;
}

/** Deterministic seed from the position, so the same position gives the same recommendation. */
function positionSeed(input) {
  let h = 2166136261;
  for (const value of [input.player, input.log.length, ...input.hands.flat()])
    h = Math.imul(h ^ value, 16777619);
  return h >>> 0;
}

/**
 * Full-information neural rollouts, not a separately trained omniscient network.
 *
 * The owner's goal is to win the whole round (final placing and team upgrade points), not to
 * take the next trick. Every candidate is therefore played out to the end of the round: one
 * greedy line first, then softmax-sampled lines while time remains, and its value is the average
 * real team result (±1/±2/±3). A short lookahead scored at the advising seat is computed first
 * and only used for candidates the time budget did not reach. Match-level value (passing A) is a
 * later training stage and is deliberately not used here.
 */
export async function scoreOracle(
  input,
  infer,
  {
    maxRoots = 8,
    horizon = 4,
    maxExtraPlies = 8,
    maxMs = 2500,
    fullRound = true,
    temperature = 0.03,
    maxSamples = 12,
    priorWeight = 4,
    maxRoundPlies = 600,
    rawArgmax = false,
  } = {},
) {
  const initial = restore(input),
    player = input.player,
    side = player % 2;
  let roots = candidates(initial.hands[player], initial.L, initial.trick?.play);
  const declaredRoots = roots;
  const canonical = new Map();
  for (const play of roots) {
    const cards = play?.cards.map((card) => card.id) || [],
      key = actionKey(cards);
    if (!canonical.has(key))
      canonical.set(key, coachReading(cards, initial.L, initial.trick?.play));
  }
  roots = [...canonical.values()];
  if (input.onlyAction !== undefined) {
    const ids = input.onlyAction;
    if (
      !Array.isArray(ids) ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !input.hands[player].includes(id))
    )
      throw Error('Invalid oracle action');
    if (!ids.length) {
      if (!initial.trick) throw Error('Cannot pass on lead');
      roots = [null];
    } else if (rawArgmax && input.onlyShape) {
      const expected = actionKey(ids);
      const exact = declaredRoots.find(
        (play) =>
          play &&
          actionKey(play.cards.map((c) => c.id)) === expected &&
          play.type === input.onlyShape.type &&
          play.value === input.onlyShape.value &&
          play.n === input.onlyShape.n,
      );
      if (!exact) throw Error('Invalid declared research action');
      roots = [exact];
    } else {
      roots = [coachReading(ids, initial.L, initial.trick?.play)];
    }
  }
  const ids = roots.map((play) => play?.cards.map((card) => card.id) || []);
  const prior = await infer(policyState(initial, player, 0, roots));
  if (prior.length !== roots.length || !prior.every(Number.isFinite))
    throw Error('Invalid oracle prior');
  const selected = rankedCoachActions(ids, prior, initial.L, maxRoots, initial.trick?.play).map(
    (row) => row.index,
  );
  // Always consider passing to a partner and a legal immediate finish, even outside the neural beam.
  for (let i = 0; i < roots.length; i++)
    if (
      (!roots[i] || roots[i].cards.length === initial.hands[player].length) &&
      !selected.includes(i)
    )
      selected.push(i);

  const started = performance.now();
  const late = () => performance.now() - started > maxMs;
  const evaluatorOf = (game) =>
    game.hands[player].length
      ? player
      : game.hands[(player + 2) % 4].length
        ? (player + 2) % 4
        : null;
  const outcome = (result) => (result.winner === side ? 1 : -1) * result.points;
  const record = (move) => ({ p: move.p, cards: move.play?.cards.map((card) => card.id) || null });
  async function step(game, random) {
    const mover = game.turn;
    const plays = candidates(game.hands[mover], game.L, game.trick?.play);
    let index = 0;
    if (plays.length > 1) {
      const estimates = await infer(policyState(game, mover, 0, plays));
      if (estimates.length !== plays.length || !estimates.every(Number.isFinite))
        throw Error('Invalid rollout values');
      index = chooseMove(plays, estimates, game.hands[mover], random, temperature, rawArgmax);
    }
    return { p: mover, play: plays[index] };
  }

  // Phase 1: short lookahead, scored at the advising seat (or the partner after finishing) so
  // that no two candidates are compared through different seats' own optimistic estimates.
  const short = new Map();
  let mismatchedLeaves = 0;
  for (const index of selected) {
    if (short.size >= Math.min(5, selected.length) && late()) break;
    const game = restore(input);
    const line = [];
    let result = advanceRound(game, roots[index]);
    for (let ply = 1; !result && ply < horizon + maxExtraPlies; ply++) {
      if (ply >= horizon && game.turn === evaluatorOf(game)) break;
      const move = await step(game, null);
      line.push(record(move));
      result = advanceRound(game, move.play);
    }
    let value;
    if (result) value = outcome(result);
    else {
      const mover = game.turn;
      const plays = candidates(game.hands[mover], game.L, game.trick?.play);
      const estimates = await infer(policyState(game, mover, 0, plays));
      if (!estimates.length || !estimates.every(Number.isFinite))
        throw Error('Invalid leaf values');
      if (mover !== evaluatorOf(game)) mismatchedLeaves++;
      value = (mover % 2 === side ? 1 : -1) * Math.max(...estimates);
    }
    short.set(index, { value, line });
  }
  const evaluated = [...short.keys()];

  // Phase 2: play every evaluated candidate to the end of the round. The first pass is greedy and
  // always completed for every candidate; sampled passes continue round-robin while time remains.
  const full = new Map(evaluated.map((index) => [index, { total: 0, count: 0, line: null }]));
  const random = seededRandom(positionSeed(input));
  let truncated = 0;
  async function playOut(index, sampled) {
    const game = restore(input);
    const line = [];
    let result = advanceRound(game, roots[index]);
    for (let ply = 1; !result && ply < maxRoundPlies; ply++) {
      const move = await step(game, sampled ? random : null);
      line.push(record(move));
      result = advanceRound(game, move.play);
    }
    if (!result) {
      truncated++;
      return null;
    }
    return { value: outcome(result), line };
  }
  if (fullRound) {
    // Highest short-lookahead candidates first, so the main choices are always covered.
    const order = evaluated.slice().sort((a, b) => short.get(b).value - short.get(a).value);
    for (const index of order) {
      const run = await playOut(index, false);
      if (!run) continue;
      Object.assign(full.get(index), { total: run.value, count: 1, line: run.line });
    }
    while (!late()) {
      let progressed = false;
      for (const index of order) {
        if (late()) break;
        if (full.get(index).count >= maxSamples) continue;
        const run = await playOut(index, true);
        if (!run) continue;
        full.get(index).total += run.value;
        full.get(index).count++;
        progressed = true;
      }
      if (!progressed) break;
    }
  }

  const actions = [],
    values = [],
    shapes = [],
    lines = [],
    rollouts = [],
    outcomes = [];
  for (const index of evaluated) {
    const entry = full.get(index);
    actions.push(ids[index]);
    shapes.push(shapeOf(roots[index]));
    // A single round outcome is very noisy (±1 to ±3), and early in a round the budget allows
    // only a few rollouts. The network's own estimate of the whole-round result for this action
    // acts as a prior worth `priorWeight` rollouts, so a couple of lucky lines cannot outweigh it;
    // as more rollouts finish (typically later in the round) the real results dominate.
    values.push(
      entry.count
        ? (entry.total + priorWeight * prior[index]) / (entry.count + priorWeight)
        : short.get(index).value,
    );
    lines.push(entry.count ? entry.line : short.get(index).line);
    outcomes.push(entry.count ? entry.total / entry.count : null);
    rollouts.push(entry.count);
  }
  return {
    actions,
    values,
    shapes,
    lines,
    rollouts,
    // Pure averaged team results (null when only the short lookahead ran); values add the tie-break.
    outcomes,
    search: {
      candidates: roots.length,
      evaluated: actions.length,
      mode: fullRound ? 'round' : 'short',
      horizon,
      maxPlies: horizon + maxExtraPlies,
      leafSeat: 'advising player, or partner after finishing',
      mismatchedLeaves,
      fullRollouts: rollouts.reduce((a, b) => a + b, 0),
      minRollouts: rollouts.length ? Math.min(...rollouts) : 0,
      truncatedRollouts: truncated,
      maxSamples,
      priorWeight,
      temperature,
      elapsedMs: Math.round(performance.now() - started),
      fullInformation: true,
    },
  };
}

/** Complete deterministic research continuation; default webpage oracle behavior is unchanged. */
export async function rolloutOracleRound(
  input,
  root,
  infer,
  { maxPlies = 1000, stop = () => false } = {},
) {
  const game = restore(input),
    side = input.player % 2,
    line = [];
  if (stop()) throw Error('Research rollout stopped');
  let result = advanceRound(game, root);
  for (let ply = 1; !result && ply < maxPlies; ply++) {
    if (stop()) throw Error('Research rollout stopped');
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    if (!plays.length) throw Error('No legal continuation');
    let index = 0;
    if (plays.length > 1) {
      const state = policyState(game, p, 0, plays);
      state.trick = game.trick && {
        player: game.trick.player,
        play: { type: game.trick.play.type, value: game.trick.play.value, n: game.trick.play.n },
      };
      state.actionShapes = plays.map(
        (a) => a && { type: a.type, value: a.value, n: a.n, wu: a.wu || 0 },
      );
      const values = Array.from(await infer(state));
      if (values.length !== plays.length || !values.every(Number.isFinite))
        throw Error('Invalid raw rollout scores');
      index = chooseMove(plays, values, game.hands[p], null, 0, true);
    }
    const play = plays[index];
    line.push({ p, cards: play?.cards.map((c) => c.id) || null });
    result = advanceRound(game, play);
  }
  if (!result) throw Error('Research round truncated; no leaf estimate or draw assigned');
  return { value: (result.winner === side ? 1 : -1) * result.points, result, line };
}
