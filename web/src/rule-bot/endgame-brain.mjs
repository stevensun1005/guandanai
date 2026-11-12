/*
 * Clint 残局大脑 (rules-v2 only): a port of upstream clintsun1977/guandan bot/clint/endgame-brain.js at
 * 2d91ecca950e6617f80e500cd205450112bb40d4 (introduced by 6460e68, widened by 6b8a7eb, 220f245, f03dc3c).
 * Later a2db8ea/6e57485 adds a3-second first-world cap; other historical defaults remain.
 *
 * When every hand holds at most BRAIN.max cards, the cards this seat has not seen (not played, not in its
 * own hand) are dealt at random to the other three seats, each deal weighted by the same public pass/play
 * reading the rules use (inferEvents / eventFactor). In each deal an exact all-hands-open solver gives the
 * round result of every legal play; the rules' play stands unless another play averages at least BRAIN.edge
 * levels better. A search that runs out of time, or whose first deal is too hard, keeps the rules' play.
 *
 * Information boundary: the brain reads only this seat's own hand, public hand counts and the public log
 * (the observation built by runtime.mjs / rule-baseline). Upstream's aiSeesAll(p) true-deal branch (one
 * nickname's computer partner, 7fd07fd) is not ported: this project's rule observations never carry other
 * hands. This is a Clint heuristic search, not a neural network, not online learning and not training.
 */
import { runtime } from '../app/runtime.js';
import { makeDeck, sortHand } from '../core/cards.js';
import { beats, isBomb } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
import { chooseRuleAction, eventFactor, handCounts, inferEvents } from './strategy.js';

const G = () => runtime.game;

/**
 * Upstream settings (f03dc3c): every hand at most `max` cards; `k` deals; `edge` levels better to change
 * the rules' play; `ms` for one decision; `minWorlds` deals needed as evidence; `worldMs` most time per deal;
 * stop early after `minStop` deals once settled by `stopZ` standard errors.
 */
export const BRAIN = Object.freeze({
  max: 12,
  k: 40,
  edge: 0.2,
  ms: 30000,
  minWorlds: 3,
  worldMs: 10000,
  firstMs: 3000,
  minStop: 8,
  stopZ: 2.5,
});
export const BRAIN_STAT = { calls: 0, used: 0, fallback: 0, changed: 0, ms: 0 };

const mcOver = (S) => (!S.h[0].length && !S.h[2].length) || (!S.h[1].length && !S.h[3].length);
// the levels the side of seats 0 and 2 wins (+) or loses (-) in a finished round
function mcReward(S) {
  const out = S.out.slice();
  for (let k = 1; k <= 4; k++) {
    const j = (out[out.length - 1] + k) % 4;
    if (!out.includes(j)) out.push(j);
  }
  const first = out[0],
    pos = out.indexOf((first + 2) % 4),
    up = pos === 1 ? 3 : pos === 2 ? 2 : 1;
  return first % 2 === 0 ? up : -up;
}
const mcPlaysCache = new WeakMap();
function mcPlays(hand, L) {
  let r = mcPlaysCache.get(hand);
  if (!r) {
    r = genPlays(hand, L);
    mcPlaysCache.set(hand, r);
  }
  return r;
}
// leading: any play; following: those that beat the table, and a pass (null)
function mcMoves(S) {
  const all = mcPlays(S.h[S.t], S.L);
  if (!S.tr) return all;
  const cur = S.tr.play,
    mv = [];
  for (const pl of all) if (beats(pl, cur)) mv.push(pl);
  mv.push(null);
  return mv;
}
// the position after the player to move plays `pl` (null: passes)
function mcStep(S, pl) {
  const p = S.t,
    T = { h: S.h.slice(), tr: S.tr, ps: S.ps, t: p, out: S.out, L: S.L };
  if (pl) {
    const ids = new Set(pl.cards.map((c) => c.id));
    T.h[p] = S.h[p].filter((c) => !ids.has(c.id));
    T.tr = { p, play: pl };
    T.ps = 0;
    if (!T.h[p].length) {
      T.out = S.out.concat(p);
      if (mcOver(T)) return T;
    }
  } else T.ps = S.ps + 1;
  const w = T.tr.p;
  let others = 0;
  for (let i = 0; i < 4; i++) if (i !== w && T.h[i].length) others++;
  const next = (i) => {
    for (let k = 1; k <= 4; k++) {
      const j = (i + k) % 4;
      if (T.h[j].length) return j;
    }
    return i;
  };
  if (T.ps >= others) {
    T.t = T.h[w].length ? w : T.h[(w + 2) % 4].length ? (w + 2) % 4 : next(w);
    T.tr = null;
    T.ps = 0;
  } else T.t = next(p);
  return T;
}
const mcNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const ES_SUIT = { S: 0, H: 1, C: 2, D: 3, J: 4 },
  ES_TYPE = {
    single: 0,
    pair: 1,
    triple: 2,
    full: 3,
    straight: 4,
    pairs3: 5,
    trip2: 6,
    bomb: 7,
    sflush: 8,
    jokers: 9,
  };
const ES_SORT = {
  A: (a, b) =>
    b.full - a.full || a.bomb - b.bomb || b.idx.length - a.idx.length || a.value - b.value,
  D: (a, b) =>
    b.full - a.full || a.bomb - b.bomb || b.value - a.value || b.idx.length - a.idx.length,
  F: (a, b) =>
    b.full - a.full || b.idx.length - a.idx.length || a.bomb - b.bomb || b.value - a.value,
};
const ES_PORT = [
  { kill: 1, ordL: 'A', ordF: 'A' },
  { kill: 0, ordL: 'A', ordF: 'F' },
  { kill: 0, ordL: 'D', ordF: 'A' },
  { kill: 1, ordL: 'F', ordF: 'D' },
  { kill: 0, ordL: 'A', ordF: 'A' },
];
/** Exact all-hands-open minimax (alpha-beta, transposition table, bisection on the -3..3 result). */
export class EsSolver {
  constructor(S0, opt = {}, ttMax = 5e6) {
    this.opt = { kill: opt.kill || 0, ordL: opt.ordL || 'A', ordF: opt.ordF || 'A' };
    this.L = S0.L;
    this.ttMax = ttMax;
    this.S0 = {
      h: S0.h.map((h) => sortHand(h.slice(), S0.L)),
      tr: S0.tr,
      ps: S0.ps,
      t: S0.t,
      out: S0.out.slice(),
      L: S0.L,
    };
    this.nodes = 0;
    this.deadline = Infinity;
    this.tt = new Map();
    this.hs = new Map();
    this.infos = [];
    this.kill = [];
    this.vlo = -3;
    this.vhi = 3;
    this.done = false;
    this.value = 0;
    this.hi0 = this.S0.h.map((h) => this.info(h));
  }
  info(h) {
    let k = '';
    for (const c of h) k += c.r * 8 + ES_SUIT[c.s] + ',';
    let o = this.hs.get(k);
    if (!o) {
      const tpl = genPlays(h, this.L).map((pl) => ({
        type: pl.type,
        value: pl.value,
        n: pl.n,
        wu: pl.wu,
        idx: pl.cards.map((c) => h.indexOf(c)),
        full: pl.cards.length === h.length,
        bomb: isBomb(pl),
      }));
      const sg = new Map();
      tpl.forEach((t, i) => {
        t.i = i;
        t.sg = ES_TYPE[t.type] + 16 * (t.value + 128 * t.n);
        sg.set(t.sg, t);
      });
      o = {
        id: this.infos.length,
        tpl,
        order: tpl.slice().sort(ES_SORT[this.opt.ordL]),
        orderF: tpl.slice().sort(ES_SORT[this.opt.ordF]),
        sg,
      };
      this.infos.push(o);
      this.hs.set(k, o);
    }
    return o;
  }
  key(S, hi) {
    const tr = S.tr,
      trs = tr
        ? 1 + tr.p + 4 * (ES_TYPE[tr.play.type] + 16 * (tr.play.value + 128 * tr.play.n))
        : 0;
    let outs = 0;
    for (const x of S.out) outs = outs * 5 + x + 1;
    let a = 0x811c9dc5,
      b = 0x1234567;
    const vs = [hi[0].id, hi[1].id, hi[2].id, hi[3].id, S.t + 4 * S.ps, trs, outs];
    for (const v of vs) {
      a = Math.imul(a ^ v, 0x01000193);
      a ^= a >>> 15;
      b = Math.imul(b + v + 0x9e3779b9, 0x85ebca6b);
      b ^= b >>> 13;
    }
    return (a >>> 0) * 2097152 + (b & 0x1fffff);
  }
  ab(S, hi, alpha, beta, ply) {
    if (mcOver(S)) return mcReward(S);
    if ((++this.nodes & 1023) === 0 && mcNow() > this.deadline) throw 'stop';
    const k = this.key(S, hi),
      e = this.tt.get(k);
    let hint = -1;
    if (e !== undefined) {
      const lo = (e & 7) - 3,
        hg = ((e >> 3) & 7) - 3;
      hint = (e >> 6) - 1;
      if (lo === hg || lo >= beta) return lo;
      if (hg <= alpha) return hg;
      if (lo > alpha) alpha = lo;
      if (hg < beta) beta = hg;
    }
    const a0 = alpha,
      b0 = beta,
      p = S.t,
      max = p % 2 === 0,
      hand = S.h[p],
      inf = hi[p];
    let best = max ? -99 : 99,
      bi = -1;
    const tr = S.tr && S.tr.play,
      mate = S.tr && S.tr.p % 2 === p % 2;
    const tryOne = (t) => {
      const pl = t
        ? { type: t.type, value: t.value, n: t.n, wu: t.wu, cards: t.idx.map((i) => hand[i]) }
        : null;
      const T = mcStep(S, pl),
        hi2 = hi.slice();
      if (pl) hi2[p] = this.info(T.h[p]);
      const v = this.ab(T, hi2, alpha, beta, ply + 1);
      if (max) {
        if (v > best) {
          best = v;
          bi = t ? t.i : -2;
        }
        if (best > alpha) alpha = best;
      } else {
        if (v < best) {
          best = v;
          bi = t ? t.i : -2;
        }
        if (best < beta) beta = best;
      }
      return alpha >= beta;
    };
    const okT = (t) => !tr || beats(t, tr);
    let cut = false;
    if (hint >= 0 && hint < inf.tpl.length && okT(inf.tpl[hint])) cut = tryOne(inf.tpl[hint]);
    else if (hint === -2 && tr) cut = tryOne(null);
    // a pass first when the partner holds the table
    if (!cut && tr && mate && hint !== -2) cut = tryOne(null);
    const kl = this.kill[ply] || (this.kill[ply] = [-1, -1]),
      K = this.opt.kill;
    if (K)
      for (let q = 0; q < 2 && !cut; q++) {
        const t = kl[q] >= 0 ? inf.sg.get(kl[q]) : null;
        if (t && t.i !== hint && okT(t)) {
          cut = tryOne(t);
          if (cut && q === 1) {
            kl[1] = kl[0];
            kl[0] = t.sg;
          }
        }
      }
    if (!cut)
      for (const t of tr ? inf.orderF : inf.order) {
        if (t.i === hint || !okT(t) || (K && (t.sg === kl[0] || t.sg === kl[1]))) continue;
        if (tryOne(t)) {
          cut = true;
          if (K && t.sg !== kl[0]) {
            kl[1] = kl[0];
            kl[0] = t.sg;
          }
          break;
        }
      }
    if (!cut && tr && !mate && hint !== -2) tryOne(null);
    let lo = -3,
      hg = 3;
    if (best <= a0) hg = best;
    else if (best >= b0) lo = best;
    else lo = hg = best;
    if (e !== undefined) {
      lo = Math.max(lo, (e & 7) - 3);
      hg = Math.min(hg, ((e >> 3) & 7) - 3);
    }
    if (this.tt.size >= this.ttMax && e === undefined) this.tt.clear();
    this.tt.set(k, (lo + 3) | ((hg + 3) << 3) | ((bi + 1) << 6));
    return best;
  }
}

// a position's exact result for seats 0 and 2 (-3..3), sharing the solver's table
function esValue(sv, T) {
  if (mcOver(T)) return mcReward(T);
  const hi = T.h.map((h) => sv.info(h));
  let lo = -3,
    hg = 3;
  while (lo < hg) {
    const g = (lo + hg + 1) >> 1,
      v = sv.ab(T, hi, g - 1, g, 0);
    if (v >= g) lo = g;
    else hg = g - 1;
  }
  return lo;
}

/** Upstream brainOn: own turn in the play phase and every hand at most `max` cards. */
export function brainOn(p, settings = BRAIN) {
  const g = G();
  if (!g || g.phase !== 'play' || g.turn !== p) return false;
  for (let i = 0; i < 4; i++) if (g.hands[i].length > settings.max) return false;
  return g.hands[p].length > 0;
}

// one deal: every legal play's exact result, or null if not finished by `until` (three search orders in turn)
function* esWorld(W, legal, until) {
  const svs = [];
  let slice = 250;
  while (mcNow() < until) {
    for (let ci = 0; ci < 3; ci++) {
      const t1 = Math.min(until, mcNow() + slice);
      const sv = svs[ci] || (svs[ci] = new EsSolver(W, ES_PORT[ci], 2e6));
      while (mcNow() < t1) {
        sv.deadline = Math.min(t1, mcNow() + 80);
        try {
          return legal.map((m) => esValue(sv, mcStep(W, m)));
        } catch (e) {
          if (e !== 'stop') throw e;
        }
        yield;
      }
    }
    slice *= 2;
  }
  return null;
}

function* brainCore(p, rulesPl, settings) {
  const st = BRAIN_STAT,
    g = G();
  try {
    if (!brainOn(p, settings)) return rulesPl;
    const S = {
      h: g.hands.map((h) => h.slice()),
      tr: g.trick ? { p: g.trick.player, play: g.trick.play } : null,
      ps: g.passes || 0,
      t: p,
      out: (g.out || []).slice(),
      L: g.L,
    };
    const legal = mcMoves(S);
    if (legal.length < 2) return rulesPl;
    const same = (m, q) =>
      (m === null && q === null) ||
      (m && q && m.cards.length === q.cards.length && m.cards.every((c) => q.cards.includes(c)));
    const ri = legal.findIndex((m) => same(m, rulesPl));
    if (ri < 0) return rulesPl;
    st.calls++;
    const t0 = mcNow(),
      ev = inferEvents(p);
    const gone = new Set((g.seen || []).concat(g.hands[p]).map((c) => c.id));
    const pool = makeDeck().filter((c) => !gone.has(c.id));
    const others = [1, 2, 3].map((k) => (p + k) % 4),
      sizes = others.map((q) => S.h[q].length);
    if (pool.length < sizes.reduce((a, b) => a + b, 0)) return rulesPl;
    const sign = p % 2 === 0 ? 1 : -1,
      S1 = legal.map(() => 0),
      S2 = legal.map(() => 0);
    let wsum = 0,
      w2sum = 0,
      worlds = 0;
    try {
      for (let w = 0; w < settings.k && mcNow() - t0 < settings.ms; w++) {
        const cards = pool.slice();
        for (let i = cards.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [cards[i], cards[j]] = [cards[j], cards[i]];
        }
        const h = S.h.slice();
        let at = 0;
        others.forEach((q, i) => {
          h[q] = sortHand(cards.slice(at, at + sizes[i]), S.L);
          at += sizes[i];
        });
        let wt = 1;
        others.forEach((q) => {
          const ks = handCounts(h[q], S.L);
          for (const x of ev[q]) wt *= eventFactor(x, ks);
        });
        const W = { h, tr: S.tr, ps: S.ps, t: S.t, out: S.out, L: S.L };
        const vals = yield* esWorld(
          W,
          legal,
          Math.min(t0 + settings.ms, mcNow() + (worlds ? settings.worldMs : settings.firstMs)),
        );
        if (!vals) {
          if (!worlds) break;
          continue;
        }
        vals.forEach((v, i) => {
          const d = sign * (v - vals[ri]);
          S1[i] += wt * d;
          S2[i] += wt * d * d;
        });
        wsum += wt;
        w2sum += wt * wt;
        worlds++;
        if (worlds >= settings.minStop && wsum > 0) {
          const neff = (wsum * wsum) / w2sum;
          let win = false,
            none = true;
          for (let i = 0; i < legal.length; i++) {
            if (i === ri) continue;
            const mean = S1[i] / wsum,
              se = Math.sqrt(Math.max(0, S2[i] / wsum - mean * mean) / neff);
            if (mean - settings.edge > settings.stopZ * se) win = true;
            if (mean + settings.stopZ * se >= settings.edge) none = false;
          }
          if (win || none) break;
        }
        yield;
      }
    } finally {
      st.ms += mcNow() - t0;
    }
    if (worlds < settings.minWorlds || !wsum) {
      st.fallback++;
      return rulesPl;
    }
    st.used++;
    const avg = S1.map((x) => x / wsum);
    avg[ri] = settings.edge;
    let bi = ri;
    for (let i = 0; i < legal.length; i++) if (avg[i] > avg[bi] + 1e-9) bi = i;
    if (bi !== ri) st.changed++;
    return bi === ri ? rulesPl : legal[bi];
  } catch (e) {
    console.warn('残局大脑出错，用规则的出法', e);
    return rulesPl;
  }
}

/** Upstream endgameBrain (synchronous): the rules' play, or a better searched play in the endgame. */
export function endgameBrain(p, rulesPl, settings = BRAIN) {
  const gen = brainCore(p, rulesPl, { ...BRAIN, ...settings });
  let r;
  do r = gen.next();
  while (!r.done);
  return r.value;
}

/**
 * The full upstream Clint decision (aiDecide, then the 残局大脑) for the observation in runtime.game.
 * The view must carry phase, turn, passes and out (public) or the brain stays off and only the rules play.
 */
export function chooseClintAction(p, settings = BRAIN) {
  return endgameBrain(p, chooseRuleAction(p), settings);
}
