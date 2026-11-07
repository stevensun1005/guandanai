/** Standalone, fully open Clint exercise only. Never imported by neural decisions or training. */
import { analyze, beats } from '../core/combinations.js';
import { makeDeck } from '../core/cards.js';

export const finished = (s) => [0, 1].some((p) => !s.hands[p].length && !s.hands[p + 2].length);
export function finalOrder(s) {
  const order = s.out.slice(),
    last = order.at(-1);
  for (let k = 1; k <= 4; k++) if (!order.includes((last + k) % 4)) order.push((last + k) % 4);
  return order;
}
export function finalPoints(s) {
  const order = finalOrder(s),
    first = order[0],
    mate = order.indexOf((first + 2) % 4);
  return (first % 2 ? -1 : 1) * (mate === 1 ? 3 : mate === 2 ? 2 : 1);
}
export function validatePosition(s) {
  const deck = makeDeck();
  if (
    !Number.isInteger(s.L) ||
    s.L < 2 ||
    s.L > 14 ||
    s.hands?.length !== 4 ||
    s.hands.some((h) => !Array.isArray(h) || h.length > 10) ||
    ![0, 1, 2, 3].includes(s.turn) ||
    !s.hands[s.turn].length ||
    !Array.isArray(s.out) ||
    new Set(s.out).size !== s.out.length ||
    s.out.some((p) => ![0, 1, 2, 3].includes(p) || s.hands[p].length) ||
    s.hands.some((h, p) => !h.length && !s.out.includes(p))
  )
    throw Error('残局状态无效（每家最多10张）');
  const held = s.hands.flat();
  if (
    new Set(held.map((c) => c.id)).size !== held.length ||
    held.some(
      (c) => !Number.isInteger(c.id) || !deck[c.id] || deck[c.id].r !== c.r || deck[c.id].s !== c.s,
    )
  )
    throw Error('残局实体牌无效');
  if (!Number.isInteger(s.passes) || s.passes < 0 || s.passes > 3 || (!s.trick && s.passes))
    throw Error('残局过牌计数无效');
  if (
    s.trick &&
    (![0, 1, 2, 3].includes(s.trick.player) ||
      !s.trick.play?.cards?.length ||
      s.trick.play.cards.some((c) => held.some((h) => h.id === c.id)) ||
      !analyze(s.trick.play.cards, s.L).some(
        (a) =>
          a.type === s.trick.play.type && a.value === s.trick.play.value && a.n === s.trick.play.n,
      ))
  )
    throw Error('残局桌面牌无效');
  return s;
}

/** Enumerate every physical subset and every legal reading; no heuristic candidate pruning. */
export function exactMoves(hand, L, current = null) {
  const plays = [],
    seen = new Set();
  for (let mask = 1; mask < 2 ** hand.length; mask++) {
    const cards = hand.filter((_, i) => mask & (1 << i));
    const faces = cards
      .map((c) => c.r + c.s)
      .sort()
      .join(',');
    for (const a of analyze(cards, L)) {
      if (!beats(a, current)) continue;
      const key = `${a.type}:${a.value}:${a.n}:${faces}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plays.push({ ...a, cards });
    }
  }
  plays.sort((a, b) => b.cards.length - a.cards.length || a.value - b.value);
  if (current) plays.push(null);
  return plays;
}

export function stepPosition(s, play) {
  const p = s.turn,
    t = { ...s, hands: s.hands.slice(), out: s.out.slice() };
  if (play) {
    if (
      !beats(play, s.trick?.play) ||
      !play.cards.every((c) => s.hands[p].some((h) => h.id === c.id))
    )
      throw Error('残局出牌不合法');
    const ids = new Set(play.cards.map((c) => c.id));
    t.hands[p] = s.hands[p].filter((c) => !ids.has(c.id));
    t.trick = { player: p, play };
    t.passes = 0;
    if (!t.hands[p].length) t.out.push(p);
  } else {
    if (!s.trick) throw Error('领牌不能过牌');
    t.passes++;
  }
  if (finished(t)) return t;
  const winner = t.trick.player;
  const next = (seat) => {
    for (let k = 1; k <= 4; k++) if (t.hands[(seat + k) % 4].length) return (seat + k) % 4;
  };
  const others = t.hands.filter((h, i) => i !== winner && h.length).length;
  if (t.passes >= others) {
    t.turn = t.hands[winner].length
      ? winner
      : t.hands[(winner + 2) % 4].length
        ? (winner + 2) % 4
        : next(winner);
    t.trick = null;
    t.passes = 0;
  } else t.turn = next(p);
  return t;
}

/** Exact minimax when complete; a budget exit never returns an approximate "optimal" line. */
export function solveEndgame(
  initial,
  { maxMs = 10000, maxNodes = 2000000, maxEntries = 100000 } = {},
) {
  validatePosition(initial);
  const started = performance.now(),
    deadline = started + maxMs,
    budget = Symbol('budget');
  const memo = new Map(),
    legal = new Map();
  let nodes = 0;
  const shape = (p) => (p ? `${p.type}:${p.value}:${p.n}` : '-');
  const moves = (s) => {
    const hand = s.hands[s.turn],
      k =
        hand
          .map((c) => c.id)
          .sort((a, b) => a - b)
          .join(',') +
        '|' +
        shape(s.trick?.play);
    if (!legal.has(k)) {
      if (legal.size >= 20000) legal.clear();
      legal.set(k, exactMoves(hand, s.L, s.trick?.play));
    }
    return legal.get(k);
  };
  const key = (s) =>
    JSON.stringify([
      s.hands.map((h) => h.map((c) => c.id).sort((a, b) => a - b)),
      s.turn,
      s.trick?.player,
      shape(s.trick?.play),
      s.passes,
      s.out,
    ]);
  function search(s, alpha, beta) {
    if (finished(s)) return finalPoints(s);
    if (++nodes > maxNodes || (nodes % 64 === 1 && performance.now() >= deadline)) throw budget;
    const k = key(s),
      prior = memo.get(k);
    if (prior) {
      if (prior.low === prior.high) return prior.low;
      if (prior.low >= beta) return prior.low;
      if (prior.high <= alpha) return prior.high;
      alpha = Math.max(alpha, prior.low);
      beta = Math.min(beta, prior.high);
    }
    const a0 = alpha,
      b0 = beta,
      max = s.turn % 2 === 0;
    let best = max ? -Infinity : Infinity;
    for (const play of moves(s)) {
      const value = search(stepPosition(s, play), alpha, beta);
      best = max ? Math.max(best, value) : Math.min(best, value);
      if (max) alpha = Math.max(alpha, best);
      else beta = Math.min(beta, best);
      if (alpha >= beta) break;
    }
    const low = best <= a0 ? -3 : best,
      high = best >= b0 ? 3 : best;
    if (memo.size >= maxEntries) memo.clear();
    memo.set(k, { low: Math.max(low, prior?.low ?? -3), high: Math.min(high, prior?.high ?? 3) });
    return best;
  }
  try {
    const value = search(initial, -4, 4),
      line = [];
    let s = initial;
    while (!finished(s)) {
      let found = false;
      for (const play of moves(s)) {
        const next = stepPosition(s, play);
        if (search(next, -4, 4) === value) {
          line.push({ player: s.turn, play });
          s = next;
          found = true;
          break;
        }
      }
      if (!found || line.length > 400) throw Error('残局路线未能验证');
    }
    return {
      complete: true,
      value,
      line,
      order: finalOrder(s),
      nodes,
      elapsedMs: performance.now() - started,
    };
  } catch (error) {
    if (error !== budget) throw error;
    return {
      complete: false,
      line: [],
      value: null,
      nodes,
      elapsedMs: performance.now() - started,
      reason: '达到时间或节点上限，未证明最优',
    };
  }
}
