/** Replay-derived descriptions. No tactical rules, learning targets or score adjustments. */
import { describeAction } from '../../../web/src/analysis/concepts.mjs';
import { policyState } from '../../../web/src/ai/observation.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { validateRecord } from '../../../web/src/collection/validate.mjs';
import { advanceRound } from '../../shared/simulation/simulation.mjs';

const deck = makeDeck();
const key = (cards) =>
  (cards || [])
    .map((c) => (typeof c === 'number' ? c : c.id))
    .sort((a, b) => a - b)
    .join(',');
export function analysisState(game, player, plays) {
  return {
    ...policyState(game, player, 0, plays),
    trick: game.trick && {
      player: game.trick.player,
      play: { type: game.trick.play.type, value: game.trick.play.value, n: game.trick.play.n },
    },
    actionShapes: plays.map((p) => p && { type: p.type, value: p.value, n: p.n, wu: p.wu || 0 }),
  };
}

export async function cooperationLabels(initial, moves, { score = null } = {}) {
  const game = structuredClone(initial),
    labels = [],
    transitions = [];
  let finished = false;
  for (const [index, move] of moves.entries()) {
    if (finished || move.p !== game.turn) throw Error('Invalid replay turn');
    const cards = (move.cards || []).map((c) => deck[typeof c === 'number' ? c : c.id]);
    const shape = cards.length
      ? analyze(cards, game.L).find(
          (s) =>
            beats(s, game.trick?.play) &&
            (!move.type || (s.type === move.type && s.value === move.value && s.n === move.n)),
        )
      : null;
    if (cards.length && !shape) throw Error('Invalid replay action');
    const play = shape && { ...shape, cards },
      p = game.turn;
    const plays = candidates(game.hands[p], game.L, game.trick?.play);
    const state = analysisState(game, p, plays);
    const row = { index, p, ...describeAction(state, play), chosenMinusPassQ: null };
    if (score) {
      let chosen = state.actions.findIndex((a) => key(a) === key(cards));
      if (chosen < 0) {
        chosen = state.actions.length;
        state.actions.push(cards.map((c) => c.id));
        state.actionShapes.push(
          shape && { type: shape.type, value: shape.value, n: shape.n, wu: shape.wu || 0 },
        );
      }
      const values = Array.from(await score(state)),
        pass = state.actions.findIndex((a) => !a.length);
      if (values.length !== state.actions.length || !values.every(Number.isFinite))
        throw Error('Invalid descriptive scores');
      if (pass >= 0) row.chosenMinusPassQ = values[chosen] - values[pass];
    }
    const result = advanceRound(game, play);
    transitions.push({ next: game.turn, reset: !game.trick, result });
    labels.push(row);
    finished = !!result;
  }
  for (const row of labels) {
    const t = transitions[row.index],
      next = labels[row.index + 1];
    // Temporal observations; these names do not assert that the move helped or caused a win.
    row.feedPartner = !!(next && t.reset && t.next === (row.p + 2) % 4 && !next.passed);
    row.opponentReceivesLeadAndFinishesWithinTwoActions = !!(
      row.passed &&
      t.reset &&
      t.next % 2 !== row.p % 2 &&
      labels
        .slice(row.index + 1, row.index + 3)
        .some((l) => l.p === t.next && !l.passed && l.remainingStructure.cards === 0)
    );
  }
  return labels;
}

/** Validate full records for legality, expose only the eligible actor's public observation. */
export async function humanRecordLabels(record, options = {}) {
  if (record.kind !== 'game') return [];
  validateRecord(record);
  const initial = {
    hands: record.hands.map((h) => h.map((id) => deck[id])),
    L: record.level,
    levels: record.match.levels.slice(),
    log: [],
    trick: null,
    passes: 0,
    out: [],
    turn: record.leader,
  };
  // Score only eligible human decisions; never send other seats' private cards to a scorer.
  const eligible = new Set(
    record.actions.flatMap((a, i) => (a.actor === 'human' && a.assisted !== true ? [i] : [])),
  );
  let cursor = 0;
  const labels = await cooperationLabels(
    initial,
    record.actions.map((a) => ({
      p: a.seat,
      cards: a.cards,
      type: a.type,
      value: a.value,
      n: a.n,
    })),
    {
      score: options.score
        ? (state) => {
            const i = cursor++;
            return eligible.has(i) ? options.score(state) : new Float32Array(state.actions.length);
          }
        : null,
    },
  );
  return labels
    .filter((row) => eligible.has(row.index))
    .map((row) => ({
      ...row,
      matchId: record.matchId,
      round: record.round,
      source: 'unverified_browser',
      assisted: false,
    }));
}
