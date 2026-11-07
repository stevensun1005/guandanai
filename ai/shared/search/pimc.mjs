/** Development perfect-information Monte Carlo over public-information sampled worlds. */
import { makeDeck } from '../../../web/src/core/cards.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { rolloutOracleRound } from '../../../web/src/coach/oracle.mjs';
import { sampleWorlds } from './belief.mjs';
import { unseenPhysicalCards } from '../../../web/src/analysis/concepts.mjs';

const deck = makeDeck();
const planKey = (play) =>
  play
    ? `${play.type}/${play.value}/${play.n}/` +
      play.cards
        .map((c) => c.id % 54)
        .sort((a, b) => a - b)
        .join(',')
    : 'pass';

export function searchObservation(game, p = game.turn) {
  const plays = candidates(game.hands[p], game.L, game.trick?.play);
  const state = policyState(game, p, 0, plays);
  return {
    ...state,
    player: p,
    levels: game.levels.slice(),
    passes: game.passes,
    out: game.out.slice(),
    log: game.log.map((e) => ({ ...e, cards: e.cards?.map((c) => c.id) || null })),
    trick: game.trick && {
      player: game.trick.player,
      play: {
        type: game.trick.play.type,
        value: game.trick.play.value,
        n: game.trick.play.n,
        wu: game.trick.play.wu || 0,
      },
    },
    actionShapes: plays.map((a) => a && { type: a.type, value: a.value, n: a.n, wu: a.wu || 0 }),
    publicKnownCards: structuredClone(game.publicKnownCards || []),
  };
}

export async function searchRoots(state, infer) {
  if ('hands' in state) throw Error('Search observation must not contain private hands');
  const plays = candidates(
    state.hand.map((id) => deck[id]),
    state.level,
    state.trick?.play,
  );
  const observation = {
    ...state,
    actions: plays.map((a) => a?.cards.map((c) => c.id) || []),
    actionShapes: plays.map((a) => a && { type: a.type, value: a.value, n: a.n, wu: a.wu || 0 }),
  };
  const values = Array.from(await infer(observation));
  if (values.length !== plays.length || !values.every(Number.isFinite))
    throw Error('Invalid search prior');
  const plans = new Map();
  plays.forEach((play, index) => {
    const key = planKey(play),
      old = plans.get(key);
    if (!old || values[index] > old.q) plans.set(key, { key, play, index, q: values[index] });
  });
  const all = [...plans.values()].sort((a, b) => b.q - a.q || a.index - b.index);
  const selected = all.slice(0, 3);
  for (const row of all)
    if ((!row.play || row.play.cards.length === state.hand.length) && !selected.includes(row))
      selected.push(row);
  return {
    roots: selected,
    baseline: all[0].key,
    semanticCandidates: all.length,
    gap: all.length > 1 ? all[0].q - all[1].q : null,
  };
}

/** Identical worlds are memoized, never counted as independent observations in the metadata. */
export async function scoreWorlds(
  state,
  worlds,
  infer,
  { roots = null, stop = () => false, maxPlies = 1000 } = {},
) {
  if ('hands' in state || !worlds.length) throw Error('Invalid world search');
  const started = performance.now(),
    prepared = roots || (await searchRoots(state, infer));
  const unique = new Map(),
    indices = [];
  const unseen = new Set(unseenPhysicalCards(state));
  for (const hands of worlds) {
    if (
      hands.length !== 4 ||
      hands.some((h, p) => h.length !== state.counts[p]) ||
      JSON.stringify(hands[state.p].slice().sort((a, b) => a - b)) !==
        JSON.stringify(state.hand.slice().sort((a, b) => a - b))
    )
      throw Error('World contradicts public observation');
    const other = hands.flatMap((h, p) => (p === state.p ? [] : h));
    if (new Set(other).size !== other.length || other.some((id) => !unseen.has(id)))
      throw Error('Invalid unseen physical allocation');
    for (const { seat, card } of state.publicKnownCards || [])
      if (unseen.has(card) && !hands[seat].includes(card))
        throw Error('World contradicts public tribute');
    const key = JSON.stringify(hands.map((h) => h.slice().sort((a, b) => a - b)));
    if (!unique.has(key)) unique.set(key, { hands, index: unique.size });
    indices.push(unique.get(key).index);
  }
  const baselines = prepared.roots.findIndex((r) => r.key === prepared.baseline);
  const outcomes = await Promise.all(
    [...unique.values()].map(async ({ hands }) => {
      const input = { ...state, hands, player: state.p, level: state.level, levels: state.levels };
      return Promise.all(
        prepared.roots.map(
          async (root) =>
            (await rolloutOracleRound(input, root.play, infer, { maxPlies, stop })).value,
        ),
      );
    }),
  );
  const rows = prepared.roots.map((root, r) => {
    const values = indices.map((i) => outcomes[i][r]),
      diffs = indices.map((i) => outcomes[i][r] - outcomes[i][baselines]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length,
      delta = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const uniqueDiff = outcomes.map((v) => v[r] - v[baselines]);
    const uniqueMean = uniqueDiff.reduce((a, b) => a + b, 0) / uniqueDiff.length;
    const se =
      uniqueDiff.length > 1 && unique.size === worlds.length
        ? Math.sqrt(
            uniqueDiff.reduce((n, x) => n + (x - uniqueMean) ** 2, 0) /
              (uniqueDiff.length - 1) /
              uniqueDiff.length,
          )
        : null;
    const histogram = Object.fromEntries(
      [-3, -2, -1, 1, 2, 3].map((v) => [v, values.filter((x) => x === v).length]),
    );
    return {
      key: root.key,
      action: root.play?.cards.map((c) => c.id) || [],
      shape: root.play && { type: root.play.type, value: root.play.value, n: root.play.n },
      priorQ: root.q,
      mean,
      pairedDelta: delta,
      pairedStandardError: se,
      histogram,
    };
  });
  const selected = rows.reduce((best, row) => (row.mean > best.mean ? row : best), rows[0]);
  return {
    kind: 'simulated-terminal-team-points-not-probability',
    rows,
    selected: selected.key,
    baseline: prepared.baseline,
    gap: prepared.gap,
    semanticCandidates: prepared.semanticCandidates,
    requestedWorlds: worlds.length,
    uniqueWorlds: unique.size,
    elapsedMs: performance.now() - started,
    limitation:
      'Uniform determinizations and all-champion raw continuations; strategy fusion and opponent-model mismatch remain. Standard errors concern sampled unique worlds, not real match outcomes.',
  };
}

export async function searchBelief(state, infer, { worlds = 8, seed, stop, maxPlies } = {}) {
  return scoreWorlds(state, sampleWorlds(state, { count: worlds, seed }), infer, {
    stop,
    maxPlies,
  });
}
