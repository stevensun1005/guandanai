import { makeDeck } from '../../src/core/cards.js';
import { candidates } from '../../src/ai/candidates.js';
import { beats } from '../../src/core/combinations.js';
import { decisionContext, policyState } from '../../src/ai/observation.js';
import { selectProfileAction } from '../../src/ai/profiles.js';
import { endgameRequest, solvePublicEndgame } from '../../src/ai/endgame.js';

export function seededRandom(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createRound(seed) {
  const random = seededRandom(seed),
    deck = makeDeck();
  for (let index = deck.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [deck[index], deck[other]] = [deck[other], deck[index]];
  }
  const hands = Array.from({ length: 4 }, () => []);
  deck.forEach((card, index) => hands[index % 4].push(card));
  const level = 2 + Math.floor(random() * 13);
  return {
    hands,
    L: level,
    levels: [level, level],
    log: [],
    trick: null,
    passes: 0,
    out: [],
    turn: Math.floor(random() * 4),
  };
}

const active = (game, seat) => game.hands[seat].length > 0;
function nextActive(game, seat) {
  for (let step = 1; step <= 4; step++)
    if (active(game, (seat + step) % 4)) return (seat + step) % 4;
  throw Error('No active seat');
}

export function advanceRound(game, play) {
  const player = game.turn;
  if (play) {
    if (
      !beats(play, game.trick?.play) ||
      new Set(play.cards.map((card) => card.id)).size !== play.cards.length ||
      !play.cards.every((card) => game.hands[player].some((held) => held.id === card.id))
    )
      throw Error('Illegal simulated play');
    game.log.push({
      p: player,
      cards: play.cards,
      type: play.type,
      value: play.value,
      n: play.n,
      lead: !game.trick,
    });
    const ids = new Set(play.cards.map((card) => card.id));
    game.hands[player] = game.hands[player].filter((card) => !ids.has(card.id));
    if (!active(game, player)) game.out.push(player);
    game.trick = { player, play };
    game.passes = 0;
  } else {
    if (!game.trick) throw Error('Cannot pass on lead');
    game.log.push({ p: player, cards: null });
    game.passes++;
  }
  if ((!active(game, 0) && !active(game, 2)) || (!active(game, 1) && !active(game, 3))) {
    const last = game.out.at(-1);
    for (let step = 1; step <= 4; step++)
      if (!game.out.includes((last + step) % 4)) game.out.push((last + step) % 4);
    const winner = game.out[0] % 2;
    const matePosition = game.out.indexOf((game.out[0] + 2) % 4);
    return { winner, points: matePosition === 1 ? 3 : matePosition === 2 ? 2 : 1, order: game.out };
  }
  const winner = game.trick.player;
  const others = [0, 1, 2, 3].filter((seat) => seat !== winner && active(game, seat)).length;
  if (game.passes >= others) {
    game.turn = active(game, winner)
      ? winner
      : active(game, (winner + 2) % 4)
        ? (winner + 2) % 4
        : nextActive(game, winner);
    game.trick = null;
    game.passes = 0;
  } else game.turn = nextActive(game, player);
  return null;
}

export async function simulateRound(
  seed,
  styles,
  infer,
  { onDecision = () => {}, onAction = null, selectAction = selectProfileAction } = {},
) {
  const game = createRound(seed);
  const stats = {
    decisions: 0,
    changed: 0,
    passes: 0,
    bombs: 0,
    cards: 0,
    actions: 0,
    maxCandidates: 0,
    passDelta: 0,
    bombDelta: 0,
    cardDelta: 0,
    valueLoss: 0,
    endgameCalls: 0,
    endgameProofs: 0,
    endgameMs: 0,
  };
  for (let turn = 0; turn < 1000; turn++) {
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    if (!plays.length) throw Error('No legal actions');
    stats.maxCandidates = Math.max(stats.maxCandidates, plays.length);
    let selected = plays.findIndex(
      (play) => play && play.cards.length === game.hands[player].length,
    );
    if (selected < 0 && plays.length === 1) selected = 0;
    if (selected < 0) {
      const state = policyState(game, player, 0, plays);
      const values = await infer(state);
      const style = styles[player];
      const baseline = selectProfileAction(
        plays,
        values,
        'balanced',
        decisionContext(game, player),
      );
      selected = await selectAction(plays, values, style, decisionContext(game, player));
      if (style === 'endgame') {
        state.endgame = endgameRequest(game, player, plays);
        if (state.endgame) {
          stats.endgameCalls++;
          const started = performance.now();
          const solved = solvePublicEndgame(state, values);
          stats.endgameMs += performance.now() - started;
          if (solved) {
            selected = solved.index;
            stats.endgameProofs++;
          }
        }
      }
      if (style !== 'balanced') {
        stats.decisions++;
        if (selected !== baseline) stats.changed++;
        const chosen = plays[selected],
          original = plays[baseline];
        const bomb = (play) => !!play && ['bomb', 'sflush', 'jokers'].includes(play.type);
        stats.passDelta += Number(!chosen) - Number(!original);
        stats.bombDelta += Number(bomb(chosen)) - Number(bomb(original));
        stats.cardDelta += (chosen?.cards.length || 0) - (original?.cards.length || 0);
        stats.valueLoss += values[baseline] - values[selected];
      }
      onDecision({ state, values, selected, baseline, style });
    }
    const play = plays[selected];
    if (styles[player] !== 'balanced') {
      stats.actions++;
      if (!play) stats.passes++;
      else {
        stats.cards += play.cards.length;
        if (['bomb', 'sflush', 'jokers'].includes(play.type)) stats.bombs++;
      }
    }
    if (onAction) onAction({ context: decisionContext(game, player), play });
    const result = advanceRound(game, play);
    if (result) return { ...result, turns: turn + 1, stats };
  }
  throw Error('Round did not terminate within 1000 turns');
}
