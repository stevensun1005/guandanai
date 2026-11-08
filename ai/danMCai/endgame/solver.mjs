/**
 * Exact perfect-information endgame solver for one Guandan round.
 *
 * Given all four remaining hands, it returns the team-minimax value of the round's final
 * result: the signed team upgrade points (+1/+2/+3 or -1/-2/-3) for the team of `perspective`,
 * assuming both teams play perfectly with every hand visible. It scores the whole rest of the
 * round, never a trick, tempo or bomb-saving proxy.
 *
 * This is a research tool. A perfect-information value is NOT what a player who only sees their
 * own hand can achieve; callers that average it over sampled worlds inherit strategy fusion.
 */
import { candidates } from '../../../web/src/ai/candidates.js';

const VALUES = [-3, -2, -1, 1, 2, 3];
const MIN = -3,
  MAX = 3;

export class SolverBudget extends Error {
  constructor(nodes) {
    super('Endgame solver budget exhausted');
    this.nodes = nodes;
  }
}

const faceKey = (hand) =>
  hand
    .map((card) => card.r * 4 + 'SHCDJ'.indexOf(card.s))
    .sort((a, b) => a - b)
    .join('.');
const shapeKey = (play) => (play ? `${play.type}:${play.value}:${play.n}` : '-');

/** Snapshot a live simulation game into the solver's immutable position format. */
export function positionFromGame(game) {
  return {
    hands: game.hands.map((hand) => hand.slice()),
    L: game.L,
    turn: game.turn,
    trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
    passes: game.passes || 0,
    out: game.out.slice(),
  };
}

const active = (position, seat) => position.hands[seat].length > 0;
function nextActive(position, seat) {
  for (let step = 1; step <= 4; step++)
    if (active(position, (seat + step) % 4)) return (seat + step) % 4;
  throw Error('No active seat');
}

/**
 * Apply one action with the same rules as advanceRound in ai/shared/simulation/simulation.mjs.
 * Returns { position } or { result: { winner, points, order } } without mutating the input.
 */
export function step(position, play) {
  const player = position.turn;
  const hands = position.hands.slice();
  let { trick, passes } = position;
  const out = position.out.slice();
  if (play) {
    // The two physical copies of a face are interchangeable (candidates() also dedupes by face),
    // so remove by face: a cached play built from an equal-face hand stays valid.
    const remaining = hands[player].slice();
    for (const card of play.cards) {
      const index = remaining.findIndex((held) => held.r === card.r && held.s === card.s);
      if (index < 0) throw Error('Solver play does not come from the moving hand');
      remaining.splice(index, 1);
    }
    hands[player] = remaining;
    if (!hands[player].length) out.push(player);
    trick = { player, play };
    passes = 0;
  } else {
    if (!trick) throw Error('Cannot pass on lead');
    passes++;
  }
  const next = { hands, L: position.L, turn: player, trick, passes, out };
  if ((!active(next, 0) && !active(next, 2)) || (!active(next, 1) && !active(next, 3))) {
    const order = out.slice(),
      last = order.at(-1);
    for (let k = 1; k <= 4; k++) if (!order.includes((last + k) % 4)) order.push((last + k) % 4);
    const winner = order[0] % 2;
    const matePosition = order.indexOf((order[0] + 2) % 4);
    return {
      result: { winner, points: matePosition === 1 ? 3 : matePosition === 2 ? 2 : 1, order },
    };
  }
  const owner = trick.player;
  const others = [0, 1, 2, 3].filter((seat) => seat !== owner && active(next, seat)).length;
  if (passes >= others) {
    next.turn = active(next, owner)
      ? owner
      : active(next, (owner + 2) % 4)
        ? (owner + 2) % 4
        : nextActive(next, owner);
    next.trick = null;
    next.passes = 0;
  } else next.turn = nextActive(next, player);
  return { position: next };
}

export const signedPoints = (result, team) =>
  result.winner === team ? result.points : -result.points;

export const remainingCards = (position) =>
  position.hands.reduce((sum, hand) => sum + hand.length, 0);

/**
 * Solve a position. Returns the exact value of every legal root action (from `perspective`'s
 * team view) and the position value, or throws SolverBudget when maxNodes/maxMs is exceeded.
 */
export function solveEndgame(
  position,
  { perspective = position.turn, maxNodes = 2_000_000, maxMs = Infinity, rootPlays = null } = {},
) {
  const team = perspective % 2;
  const started = performance.now();
  const deadline = started + maxMs;
  const table = new Map();
  const legalCache = new Map();
  let nodes = 0;

  function legal(hand, current) {
    const key = faceKey(hand) + '|' + shapeKey(current);
    let plays = legalCache.get(key);
    if (!plays) {
      plays = candidates(hand, position.L, current);
      // Finishing first, larger plays next, pass last: cheap ordering for more cutoffs.
      plays.sort(
        (a, b) =>
          Number(b?.cards.length === hand.length) - Number(a?.cards.length === hand.length) ||
          (b ? b.cards.length : -1) - (a ? a.cards.length : -1),
      );
      if (legalCache.size > 400_000) legalCache.clear();
      legalCache.set(key, plays);
    }
    return plays;
  }

  function key(p) {
    return (
      p.hands.map(faceKey).join('/') +
      `|${p.turn}|${p.trick ? p.trick.player + ':' + shapeKey(p.trick.play) : '-'}|${p.passes}|${p.out.join('')}`
    );
  }

  function value(p, alpha, beta) {
    if (++nodes > maxNodes || ((nodes & 1023) === 0 && performance.now() > deadline))
      throw new SolverBudget(nodes);
    const k = key(p);
    const entry = table.get(k);
    if (entry) {
      if (entry.lower === entry.upper) return entry.lower;
      if (entry.lower >= beta) return entry.lower;
      if (entry.upper <= alpha) return entry.upper;
      alpha = Math.max(alpha, entry.lower);
      beta = Math.min(beta, entry.upper);
    }
    const maximizing = p.turn % 2 === team;
    const plays = legal(p.hands[p.turn], p.trick?.play || null);
    let best = maximizing ? MIN - 1 : MAX + 1;
    const a0 = alpha,
      b0 = beta;
    for (const play of plays) {
      const next = step(p, play);
      const v = next.result ? signedPoints(next.result, team) : value(next.position, alpha, beta);
      if (maximizing) {
        if (v > best) best = v;
        if (best > alpha) alpha = best;
      } else {
        if (v < best) best = v;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }
    const stored = entry ? { ...entry } : { lower: MIN, upper: MAX };
    if (best <= a0) stored.upper = Math.min(stored.upper, best);
    else if (best >= b0) stored.lower = Math.max(stored.lower, best);
    else stored.lower = stored.upper = best;
    table.set(k, stored);
    return best;
  }

  const plays =
    rootPlays ||
    candidates(position.hands[position.turn], position.L, position.trick?.play || null);
  const actions = plays.map((play) => {
    const next = step(position, play);
    return {
      play,
      value: next.result ? signedPoints(next.result, team) : value(next.position, MIN, MAX),
    };
  });
  const maximizing = position.turn % 2 === team;
  const best = actions.reduce(
    (b, a) => (maximizing ? Math.max(b, a.value) : Math.min(b, a.value)),
    maximizing ? -Infinity : Infinity,
  );
  return {
    kind: 'perfect-information-team-minimax-signed-round-points',
    team,
    value: best,
    actions,
    nodes,
    tableSize: table.size,
    elapsedMs: performance.now() - started,
  };
}

export { VALUES };
