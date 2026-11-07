/** Determinizations from own hand and public information. No actual opponent hands accepted. */
import { unseenPhysicalCards } from '../../../web/src/analysis/concepts.mjs';
import { seededRandom } from '../simulation/simulation.mjs';
import { advanceRound } from '../simulation/simulation.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';

export function sampleWorlds(
  state,
  { count = 8, seed, fixedCards = state.publicKnownCards || [] } = {},
) {
  if (
    'hands' in state ||
    !Number.isInteger(seed) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024
  )
    throw Error('Invalid public belief request');
  if (state.hand.length !== state.counts[state.p]) throw Error('Wrong own count');
  const pool = unseenPhysicalCards(state),
    unseen = new Set(pool),
    fixed = [[], [], [], []],
    assigned = new Set();
  const played = new Set(state.log.flatMap((e) => e.cards || []));
  for (const { seat, card } of fixedCards) {
    if (
      !Number.isInteger(seat) ||
      seat < 0 ||
      seat > 3 ||
      !Number.isInteger(card) ||
      card < 0 ||
      card > 107 ||
      assigned.has(card)
    )
      throw Error('Invalid public fixed card');
    assigned.add(card);
    if (played.has(card)) continue;
    if (seat === state.p) {
      if (!state.hand.includes(card)) throw Error('Contradictory known own card');
    } else {
      if (!unseen.has(card) || fixed[seat].length >= state.counts[seat])
        throw Error('Contradictory public card ownership');
      fixed[seat].push(card);
    }
  }
  const random = seededRandom(seed),
    worlds = [];
  for (let w = 0; w < count; w++) {
    const remaining = pool.filter((id) => !assigned.has(id));
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    const hands = fixed.map((h) => h.slice());
    hands[state.p] = state.hand.slice();
    for (let p = 0; p < 4; p++)
      if (p !== state.p) hands[p].push(...remaining.splice(0, state.counts[p] - hands[p].length));
    if (remaining.length || hands.some((h, p) => h.length !== state.counts[p]))
      throw Error('Belief count mismatch');
    worlds.push(hands);
  }
  return worlds;
}

/** Stable likelihood weights. Low-ESS resampling repeats particles, it does not create evidence. */
export function likelihoodWeights(
  logLikelihoods,
  { temperature = 0.2, essFraction = 0.5, seed = 0 } = {},
) {
  if (
    !logLikelihoods.length ||
    !logLikelihoods.every(Number.isFinite) ||
    temperature < 0.2 ||
    !Number.isFinite(temperature) ||
    !(essFraction > 0 && essFraction <= 1)
  )
    throw Error('Invalid likelihood weighting');
  const maximum = Math.max(...logLikelihoods);
  const unnormalized = logLikelihoods.map((l) => Math.exp(l - maximum));
  const total = unnormalized.reduce((a, b) => a + b, 0),
    weights = unnormalized.map((w) => w / total);
  const ess = 1 / weights.reduce((n, w) => n + w * w, 0);
  const n = weights.length,
    random = seededRandom(seed);
  let indices = weights.map((_, i) => i),
    resampled = false;
  if (ess < n * essFraction) {
    indices = [];
    let index = 0,
      cumulative = weights[0],
      start = random() / n;
    for (let i = 0; i < n; i++) {
      const target = start + i / n;
      while (index < n - 1 && target > cumulative) cumulative += weights[++index];
      indices.push(index);
    }
    resampled = true;
  }
  return {
    weights,
    temperature,
    essBeforeResampling: ess,
    resampled,
    indices,
    distinctSurvivors: new Set(indices).size,
    warning:
      'Resampling may duplicate worlds; uniform output weights do not imply independent information.',
  };
}

/** Diagnostic likelihood of public choices under a sampled deal; never hard-infer from a pass. */
export async function publicHistoryLogLikelihood(
  state,
  hands,
  infer,
  { temperature = 0.2, lastDecisions = 8, stop = () => false } = {},
) {
  if (
    temperature < 0.2 ||
    !Number.isFinite(temperature) ||
    !Number.isInteger(lastDecisions) ||
    lastDecisions < 1
  )
    throw Error('Invalid public-history likelihood');
  const deck = makeDeck(),
    initial = hands.map((h) => h.map((id) => deck[id]));
  for (const e of state.log) for (const id of e.cards || []) initial[e.p].push(deck[id]);
  const game = {
    hands: initial,
    L: state.level,
    levels: state.levels.slice(),
    log: [],
    out: [],
    passes: 0,
    trick: null,
    turn: state.log[0]?.p ?? state.p,
  };
  let total = 0;
  for (let i = 0; i < state.log.length; i++) {
    if (stop()) throw Error('Likelihood stopped');
    const e = state.log[i],
      p = game.turn;
    if (e.p !== p) throw Error('Public history turn mismatch');
    const cards = (e.cards || []).map((id) => deck[id]);
    let play = null;
    if (cards.length) {
      const valid = analyze(cards, game.L).filter((s) => beats(s, game.trick?.play));
      const shapes = e.type
        ? valid.filter((s) => s.type === e.type && s.value === e.value && s.n === e.n)
        : valid;
      if (shapes.length !== 1)
        throw Error('Missing or ambiguous public shape; do not invent likelihood');
      play = { ...shapes[0], cards };
    }
    if (i >= state.log.length - lastDecisions) {
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      const key = (a) =>
        (a?.cards || [])
          .map((c) => c.id)
          .sort((a, b) => a - b)
          .join(',');
      let selected = plays.findIndex((a) => key(a) === key(play));
      if (selected < 0) {
        selected = plays.length;
        plays.push(play);
      }
      const observation = policyState(game, p, 0, plays);
      observation.trick = game.trick && {
        player: game.trick.player,
        play: { type: game.trick.play.type, value: game.trick.play.value, n: game.trick.play.n },
      };
      observation.actionShapes = plays.map(
        (a) => a && { type: a.type, value: a.value, n: a.n, wu: a.wu || 0 },
      );
      const values = Array.from(await infer(observation));
      if (values.length !== plays.length || !values.every(Number.isFinite))
        throw Error('Invalid likelihood scores');
      const max = Math.max(...values);
      total +=
        (values[selected] - max) / temperature -
        Math.log(values.reduce((n, v) => n + Math.exp((v - max) / temperature), 0));
    }
    if (advanceRound(game, play)) throw Error('History already terminal');
  }
  if (game.turn !== state.p || game.hands.some((h, p) => h.length !== state.counts[p]))
    throw Error('Public history endpoint mismatch');
  return total;
}
