import { runtime } from '../app/runtime.js';
import { AIP, UNIT_SCORE } from '../ai/hand-value.js';
import { SUITS, isWild, val } from '../core/cards.js';
import { analyze, isBomb } from '../core/combinations.js';
import { testArm } from '../replay/session.js';

let isSeq;
export let isCtrl;
let armUnit;
let ARM_SHAPES;
let POWER_CUTS;
export let handPower;

export function unitScore(u) {
  const t = UNIT_SCORE[u.type + u.n];
  if (!t) return isBomb(u) ? 2 : 0;
  if (t[u.value] !== undefined) return t[u.value];
  // a value never seen in self-play: the nearest one
  let best = 0,
    d = 99;
  for (const v in t)
    if (Math.abs(v - u.value) < d) {
      d = Math.abs(v - u.value);
      best = t[v];
    }
  return best;
}

export function armScore(units) {
  let s = 0;
  for (const u of units) s += unitScore(u) - (isBomb(u) ? 0 : AIP.armHand);
  return s;
}

// what is left after the runs, rank by rank: four or more make a bomb, a three takes along the pair that gains most (if any),
// unused wild cards are kept as big singles
function armRest(by, jk, wild, L) {
  const units = [],
    pairs = [],
    trips = [];
  if (jk.length === 4) units.push(armUnit('jokers', 99, jk));
  else for (const c of jk) units.push(armUnit('single', c.r, [c])); // two jokers alike are kept as two singles, never a pair
  for (let r = 2; r <= 14; r++) {
    const g = by[r];
    if (!g || !g.length) continue;
    const v = r === L ? 15 : r;
    if (g.length >= 4) units.push(armUnit('bomb', v, g.slice()));
    else if (g.length === 3) trips.push(g.slice());
    else if (g.length === 2) pairs.push(g.slice());
    else units.push(armUnit('single', v, g.slice()));
  }
  pairs.sort((a, b) => val(a[0], L) - val(b[0], L));
  for (const t of trips) {
    const v = val(t[0], L),
      alone = unitScore({ type: 'triple', n: 3, value: v });
    let i = -1,
      gain = 0;
    pairs.forEach((q, k) => {
      const g =
        unitScore({ type: 'full', n: 5, value: v }) +
        AIP.armHand -
        alone -
        unitScore({ type: 'pair', n: 2, value: val(q[0], L) });
      if (g > gain) {
        gain = g;
        i = k;
      }
    });
    units.push(
      i >= 0 ? armUnit('full', v, t.concat(pairs.splice(i, 1)[0])) : armUnit('triple', v, t),
    );
  }
  for (const q of pairs) units.push(armUnit('pair', val(q[0], L), q));
  for (const c of wild) units.push(armUnit('single', 15, [c], 1));
  return units;
}

// a kept wild card joins whatever it improves most: a single becomes a pair, a pair a three, a three or bomb a bigger bomb
function armWilds(units) {
  for (;;) {
    const wi = units.findIndex((u) => u.wu && u.n === 1);
    if (wi < 0) return units;
    const w = units[wi],
      rest = units.filter((_, i) => i !== wi);
    let best = null,
      bs = armScore(units);
    rest.forEach((u, i) => {
      if (u.value >= 16 || !['single', 'pair', 'triple', 'bomb'].includes(u.type)) return;
      const n = u.n + 1,
        cand = rest.slice();
      cand[i] = armUnit(
        n === 2 ? 'pair' : n === 3 ? 'triple' : 'bomb',
        u.value,
        u.cards.concat(w.cards),
        u.wu + 1,
      );
      const s = armScore(cand);
      if (s > bs) {
        bs = s;
        best = cand;
      }
    });
    if (!best) return units;
    units = best;
  }
}

function arrange(hand, L) {
  const wild = hand.filter((c) => isWild(c, L)),
    jk = hand.filter((c) => c.r >= 16),
    by = {};
  for (const c of hand) if (!isWild(c, L) && c.r < 16) (by[c.r] || (by[c.r] = [])).push(c);
  const runs = [];
  let best = null,
    bs = -1e9,
    nodes = 0;
  (function dfs(i0, wl) {
    const units = runs.concat(armRest(by, jk, wild.slice(0, wl), L));
    const s = armScore(units);
    if (s > bs) {
      bs = s;
      best = units;
    }
    // each shape may be taken again, but never one listed before the last one taken
    for (let i = i0; i < ARM_SHAPES.length && nodes < AIP.armNodes; i++) {
      const [type, len, need, st, su] = ARM_SHAPES[i];
      let gap = 0;
      for (let q = st; q < st + len; q++) {
        const g = by[q === 1 ? 14 : q] || [];
        gap += su ? (g.some((c) => c.s === su) ? 0 : 1) : Math.max(0, need - g.length);
      }
      if (gap > wl || gap >= len) continue;
      nodes++;
      const cards = [];
      for (let q = st; q < st + len; q++) {
        const g = by[q === 1 ? 14 : q];
        if (!g) continue;
        if (su) {
          const k = g.findIndex((c) => c.s === su);
          if (k >= 0) cards.push(g.splice(k, 1)[0]);
        } else cards.push(...g.splice(g.length - Math.min(need, g.length)));
      }
      const all = cards.concat(wild.slice(wl - gap, wl)),
        a = analyze(all, L).find((a) => a.type === type);
      if (a) {
        runs.push({ ...a, cards: all, wu: gap });
        dfs(i, wl - gap);
        runs.pop();
      }
      for (const c of cards) by[c.r].push(c);
    }
  })(0, wild.length);
  return armWilds(best);
}

// the test version lets the player rearrange a computer's hand while sorting, and the computer then plays from that
export function armPlays(hand, L) {
  return (typeof testArm === 'function' && testArm(hand, L)) || armPlaysRaw(hand, L);
}

export function armPlaysRaw(hand, L) {
  let m = runtime.armCache.get(AIP);
  if (!m) runtime.armCache.set(AIP, (m = new Map()));
  const key =
    L +
    ':' +
    hand
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join();
  let x = m.get(key);
  if (!x || x.round !== runtime.game.hands) {
    if (m.size > 500) m.clear();
    m.set(key, (x = { round: runtime.game.hands, u: arrange(hand, L) }));
  }
  return x.u;
}

// an arrangement's score as 牌力 0-100
export function scorePower(s) {
  const c = POWER_CUTS;
  if (s <= c[0]) return 0;
  for (let i = 1; i < c.length; i++)
    if (s < c[i]) return Math.round(5 * (i - 1 + (s - c[i - 1]) / (c[i] - c[i - 1])));
  return 100;
}

export function initialize() {
  /* ---------- arranging the hand (配牌) and its strength (牌力) ---------- */
  // the computer splits its hand into plays the way a player sorts their cards: it tries the runs, pairs in a row,
  // steel plates and straight flushes the hand allows (a wild card may fill a gap), deals with the rest rank by rank,
  // and keeps the arrangement that scores best: the scores of its plays (UNIT_SCORE), less a little for each play
  isSeq = (t) => t === 'straight' || t === 'pairs3' || t === 'trip2';
  isCtrl = (u) =>
    u.type === 'single'
      ? u.value >= AIP.ctrlSingle
      : u.type === 'pair'
        ? u.value >= AIP.ctrlPair
        : u.type === 'triple' || u.type === 'full'
          ? u.value >= AIP.ctrlTrip
          : isSeq(u.type) && u.value >= AIP.ctrlSeq;
  armUnit = (type, value, cards, wu = 0) => ({ type, value, n: cards.length, cards, wu });
  ARM_SHAPES = [];
  for (const [type, len, need] of [
    ['straight', 5, 1],
    ['pairs3', 3, 2],
    ['trip2', 2, 3],
  ])
    for (let s = 1; s + len - 1 <= 14; s++) ARM_SHAPES.push([type, len, need, s]);
  for (const su of SUITS) for (let s = 1; s <= 10; s++) ARM_SHAPES.push(['sflush', 5, 1, s, su]);
  runtime.armCache = new WeakMap();
  POWER_CUTS = [
    -3.8, -1.13, -0.67, -0.35, -0.09, 0.15, 0.36, 0.56, 0.75, 0.93, 1.12, 1.31, 1.51, 1.71, 1.94,
    2.18, 2.46, 2.76, 3.15, 3.78, 10.25,
  ];
  handPower = (hand, L) => scorePower(armScore(armPlays(hand, L)));
}
