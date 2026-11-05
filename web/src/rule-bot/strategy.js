import { runtime } from '../app/runtime.js';
import { RULE_SETTINGS as AIP } from './settings.js';
import { armPlays, handPower, isCtrl } from './arrangement.js';
import { handCost } from '../ai/hand-value.js';
import { isWild, makeDeck, val } from '../core/cards.js';
import { analyze, beats, isBomb, power } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
import { hintOrder } from '../hand/hints.js';
const restCost = (hand, pl, L) =>
  handCost(
    hand.filter((c) => !pl.cards.includes(c)),
    L,
  );

function outside(p) {
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  const plays = genPlays(
    makeDeck().filter((c) => !gone.has(c.id)),
    runtime.game.L,
  );
  return { plays, topBomb: plays.filter(isBomb).reduce((m, x) => Math.max(m, power(x)), 0) };
}

const TALLY_RANKS = (L) =>
  [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].filter((k) => k !== L);
const tallyKey = (c, L) => (c.r >= 16 ? c.r : c.r === L ? 15 : c.r);
function tallyPlayed(log, L) {
  const per = [{}, {}, {}, {}];
  for (const e of log)
    if (e.cards)
      for (const c of e.cards) {
        const k = tallyKey(c, L);
        (per[e.p][k] || (per[e.p][k] = [])).push(c);
      }
  return per;
}

function tallyLeft(log, L, k) {
  const gone = new Set();
  for (const e of log) if (e.cards) for (const c of e.cards) gone.add(c.id);
  return makeDeck().filter((c) => tallyKey(c, L) === k && !gone.has(c.id));
}

const isTop = (pl, o) =>
  isBomb(pl) ? power(pl) > o.topBomb : !o.plays.some((x) => !isBomb(x) && beats(x, pl));

function tierOf(p) {
  const pw = runtime.game.pw || (runtime.game.pw = []);
  if (pw[p] === undefined) pw[p] = handPower(runtime.game.hands[p], runtime.game.L);
  return pw[p] >= AIP.tier1 ? 1 : pw[p] >= AIP.tier2 ? 2 : pw[p] >= AIP.tier3 ? 3 : 4;
}

function mateBeatChance(p, cur) {
  if (inferNow(p)) return inferMateBeat(p, cur);
  const n = runtime.game.hands[(p + 2) % 4].length;
  if (!n) return 0;
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  const pool = makeDeck().filter((c) => !gone.has(c.id));
  let k = 0;
  for (let t = 0; t < AIP.mateSamples; t++) {
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    if (genPlays(pool.slice(0, n), runtime.game.L).some((x) => !isBomb(x) && beats(x, cur))) k++;
  }
  return k / AIP.mateSamples;
}

function oppBeatChance(p, cur) {
  if (inferNow(p)) return inferBeat(p, cur, opps(p));
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  const pool = makeDeck().filter((c) => !gone.has(c.id));
  const ns = [(p + 1) % 4, (p + 2) % 4, (p + 3) % 4].map((i) => runtime.game.hands[i].length),
    need = ns[0] + ns[1] + ns[2];
  if (pool.length < need) return 1;
  const N = AIP.mateSamples * 2;
  let k = 0;
  for (let t = 0; t < N; t++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const a = pool.slice(0, ns[0]),
      b = pool.slice(ns[0] + ns[1], need);
    if (
      genPlays(a, runtime.game.L).some((x) => beats(x, cur)) ||
      genPlays(b, runtime.game.L).some((x) => beats(x, cur))
    )
      k++;
  }
  return k / N;
}

function tricksWon(q) {
  const n = [0, 0, 0, 0];
  let last = -1;
  for (const e of runtime.game.log) {
    if (!e.cards) continue;
    if (e.lead && last >= 0) n[last]++;
    last = e.p;
  }
  if (runtime.game.trick && runtime.game.trick.player === last) return n[q];
  return n[q] + (last === q ? 1 : 0);
}

const mateStronger = (p) => {
  const m = (p + 2) % 4,
    n = runtime.game.hands[m].length;
  return (
    n > 0 &&
    (n + AIP.mateGap <= runtime.game.hands[p].length ||
      tricksWon(m) >= tricksWon(p) + AIP.mateTricks)
  );
};

function passStats() {
  const st = [{}, {}, {}, {}];
  let top = null;
  for (const e of runtime.game.log) {
    if (e.cards) {
      top = e;
      (st[e.p][e.type] || (st[e.p][e.type] = { v: [], played: false })).played = true;
    } else if (
      top &&
      top.p % 2 !== e.p % 2 &&
      top.type !== 'bomb' &&
      top.type !== 'sflush' &&
      top.type !== 'jokers'
    )
      (st[e.p][top.type] || (st[e.p][top.type] = { v: [], played: false })).v.push(top.value);
  }
  return st;
}

const dryFor = (st, q, u) => {
  const s = st[q][u.type];
  return !!s && !s.played && s.v.filter((v) => v <= u.value).length >= AIP.dryPasses;
};
function dryUnits(p, pool, st) {
  const ops = [(p + 1) % 4, (p + 3) % 4].filter((q) => runtime.game.hands[q].length);
  return ops.length ? pool.filter((u) => ops.every((q) => dryFor(st, q, u))) : [];
}

function mateLead(p, pool, st) {
  const m = (p + 2) % 4,
    nx = (p + 1) % 4,
    ns = [nx, m, (p + 3) % 4].map((i) => runtime.game.hands[i].length),
    need = ns[0] + ns[1] + ns[2];
  if (!ns[1]) return null;
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  const cards = makeDeck().filter((c) => !gone.has(c.id));
  if (cards.length < need) return null;
  const by = (a, b) => a.value - b.value || b.n - a.n,
    kinds = {};
  for (const u of pool) (kinds[u.type + u.n] || (kinds[u.type + u.n] = [])).push(u);
  const firsts = Object.values(kinds).map((g) => g.slice().sort(by)[0]),
    mc = firsts.map(() => 0),
    nc = firsts.map(() => 0);
  const N = AIP.mateSamples;
  for (let t = 0; t < N; t++) {
    for (let i = 0; i < need; i++) {
      const j = i + Math.floor(Math.random() * (cards.length - i));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
    const nh = genPlays(cards.slice(0, ns[0]), runtime.game.L),
      mh = genPlays(cards.slice(ns[0], ns[0] + ns[1]), runtime.game.L).filter((x) => !isBomb(x));
    firsts.forEach((u, i) => {
      if (mh.some((x) => beats(x, u))) mc[i]++;
      if (ns[0] && nh.some((x) => beats(x, u))) nc[i]++;
    });
  }
  const c = firsts
    .map((u, i) => ({ u, m: mc[i] / N, x: nc[i] / N }))
    .filter((o) => o.m >= AIP.leadMateMin && o.x <= AIP.leadNextMax);
  if (!c.length) return null;
  const dry = AIP.rDry ? c.filter((o) => dryUnits(p, [o.u], st).length) : [];
  return (dry.length ? dry : c).sort((a, b) => b.m - b.x - (a.m - a.x) || by(a.u, b.u))[0].u;
}

const RUNS = { straight: [5, 1], pairs3: [3, 2], trip2: [2, 3] },
  SAME = { single: 1, pair: 2, triple: 3 };

function handCounts(cards, L) {
  const c = new Array(18).fill(0),
    nat = new Array(18).fill(0);
  let w = 0;
  for (const x of cards) {
    if (isWild(x, L)) {
      w++;
      continue;
    }
    c[val(x, L)]++;
    nat[x.r]++;
    if (x.r === 14) nat[1]++;
  }
  return { c, nat, w };
}
const addCounts = (a, b) => ({
  c: a.c.map((x, i) => x + b.c[i]),
  nat: a.nat.map((x, i) => x + b.nat[i]),
  w: a.w + b.w,
});

function holds(k, type, lo, hi, exact) {
  const { c, w } = k,
    need = SAME[type];
  const ok = (x, m) =>
    exact
      ? c[x] === m
      : (c[x] >= m && c[x] < 4) || (x <= 15 && c[x] > 0 && c[x] < 4 && c[x] + w >= m);
  if (need) {
    for (let x = lo + 1; x < hi && x <= 17; x++) if (ok(x, need)) return true;
    return need === 1 && !exact && w > 0 && lo < 15 && hi > 15;
  }
  if (type === 'full') {
    for (let x = lo + 1; x < hi && x <= 15; x++)
      if (ok(x, 3))
        for (let y = 2; y <= 17; y++)
          if (y !== x && (exact ? c[y] === 2 : c[y] >= 2 && c[y] < 4)) return true;
    return false;
  }
  const r = RUNS[type];
  if (r) {
    const [len, m] = r;
    for (let st = lo + 1; st < hi && st + len - 1 <= 14; st++) {
      let gap = 0;
      for (let q = st; q < st + len; q++) gap += Math.max(0, m - k.nat[q]);
      if (gap <= (exact ? 0 : w)) return true;
    }
  }
  return false;
}

function bombsOf(k) {
  const b = [];
  for (let x = 2; x <= 15; x++) {
    const c = k.c[x];
    if (c >= 4 || (c && c + k.w >= 4)) b.push({ type: 'bomb', n: c + k.w, value: x });
  }
  if (k.c[16] === 2 && k.c[17] === 2) b.push({ type: 'jokers', n: 4, value: 99 });
  return b;
}

const canBeat = (k, pl, exact) =>
  isBomb(pl) ? bombsOf(k).some((b) => beats(b, pl)) : holds(k, pl.type, pl.value, 99, exact);

function inferEvents(p) {
  const ev = [[], [], [], []],
    left = [0, 1, 2, 3].map((i) => runtime.game.hands[i].length),
    log = runtime.game.log || [];
  for (const e of log) if (e.cards) left[e.p] += e.cards.length;
  let top = null;
  const known = (t) => SAME[t] || t === 'full';
  for (let i = 0; i < log.length; i++) {
    const e = log[i],
      q = e.p,
      ph = left[q] > 19 ? 0 : left[q] > 10 ? 1 : 2;
    if (e.cards && e.lead) top = null;
    if (q !== p) {
      if (!e.cards) {
        if (top && top.p % 2 !== q % 2 && known(top.e.type))
          ev[q].push({ i, r: 'A', type: top.e.type, v: top.e.value, ph });
      } else if (e.lead) {
        if (known(e.type)) ev[q].push({ i, r: 'C', type: e.type, v: e.value, ph });
      } else if (top && top.p % 2 !== q % 2 && known(e.type) && e.type === top.e.type)
        ev[q].push({ i, r: 'B', type: e.type, v: top.e.value, w: e.value, ph });
    }
    if (e.cards) {
      top = { p: q, e };
      left[q] -= e.cards.length;
    }
  }
  for (let q = 0; q < 4; q++)
    for (const x of ev[q]) {
      const later = [];
      for (let j = x.i; j < log.length; j++)
        if (log[j].p === q && log[j].cards) later.push(...log[j].cards);
      x.k = handCounts(later, runtime.game.L);
    }
  return ev;
}
function eventFactor(x, k) {
  const h = addCounts(k, x.k);
  if (x.r === 'A')
    return holds(h, x.type, x.v, 99, x.ph < 2)
      ? [AIP.infAEarly, AIP.infAMid, AIP.infALate][x.ph]
      : 1;
  if (x.r === 'B')
    return holds(h, x.type, x.v, x.w, true) ? (x.ph < 2 ? AIP.infB : AIP.infBLate) : 1;
  return holds(h, x.type, 1, x.v, true) ? AIP.infC : 1;
}

function inferDeals(p) {
  const log = runtime.game.log || [],
    key = p + ':' + log.length;
  if (
    runtime.game.inf &&
    runtime.game.inf.key === key &&
    runtime.game.inf.hands === runtime.game.hands &&
    runtime.game.inf.aip === AIP
  )
    return runtime.game.inf.deals;
  const L = runtime.game.L,
    others = [1, 2, 3].map((k) => (p + k) % 4);
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  const fixed = new Map(),
    cap = [99, 99, 99, 99];
  for (const t of runtime.game.trib || []) {
    if (t.tc) {
      cap[t.g] = Math.min(cap[t.g], val(t.tc, L));
      if (t.r !== p && !gone.has(t.tc.id)) fixed.set(t.tc.id, t.r);
    }
    if (t.rc && t.g !== p && !gone.has(t.rc.id)) fixed.set(t.rc.id, t.g);
  }
  const pool = makeDeck().filter((c) => !gone.has(c.id)),
    free = pool.filter((c) => !fixed.has(c.id));
  const ev = inferEvents(p),
    deals = [];
  for (let s = 0; s < AIP.inferSamples; s++) {
    const hs = [[], [], []],
      room = others.map((q) => runtime.game.hands[q].length);
    for (const c of pool)
      if (fixed.has(c.id)) {
        const k = others.indexOf(fixed.get(c.id));
        if (k >= 0 && room[k] > 0) {
          hs[k].push(c);
          room[k]--;
        }
      }
    for (let i = free.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [free[i], free[j]] = [free[j], free[i]];
    }
    for (const c of free) {
      let el = [0, 1, 2].filter(
        (k) => room[k] > 0 && (isWild(c, L) || val(c, L) <= cap[others[k]]),
      );
      if (!el.length) el = [0, 1, 2].filter((k) => room[k] > 0);
      if (!el.length) break;
      let r = Math.random() * el.reduce((a, k) => a + room[k], 0),
        k = el[0];
      for (const e of el) {
        if (r < room[e]) {
          k = e;
          break;
        }
        r -= room[e];
      }
      hs[k].push(c);
      room[k]--;
    }
    const ks = hs.map((h) => handCounts(h, L));
    let w = 1;
    others.forEach((q, k) => {
      for (const x of ev[q]) w *= eventFactor(x, ks[k]);
    });
    deals.push({ ks, w });
  }
  runtime.game.inf = { key, hands: runtime.game.hands, aip: AIP, deals };
  return deals;
}
const opps = (p) => [(p + 1) % 4, (p + 3) % 4];

function inferBeat(p, pl, who) {
  const deals = inferDeals(p);
  let s = 0,
    t = 0;
  for (const d of deals) {
    t += d.w;
    if (
      who.some(
        (q) =>
          runtime.game.hands[q].length &&
          canBeat(d.ks[(q - p + 3) % 4], pl, runtime.game.hands[q].length > 10),
      )
    )
      s += d.w;
  }
  return t ? s / t : 0;
}

const inferNow = (p) =>
  AIP.rInfer &&
  (runtime.game.hands[p].length <= 10 ||
    (!!runtime.game.trick && runtime.game.hands[runtime.game.trick.player].length <= 10));

function inferMateBeat(p, cur) {
  const m = (p + 2) % 4;
  if (isBomb(cur) || !runtime.game.hands[m].length) return 0;
  let s = 0,
    t = 0;
  for (const d of inferDeals(p)) {
    t += d.w;
    if (holds(d.ks[(m - p + 3) % 4], cur.type, cur.value, 99, false)) s += d.w;
  }
  return t ? s / t : 0;
}

function builtFulls(units, cur) {
  const L = runtime.game.L,
    pairs = [];
  for (const u of units) {
    if (u.wu || isBomb(u)) continue;
    if (u.type === 'pair' && !isCtrl(u)) pairs.push({ v: u.value, cards: u.cards });
    else if (u.type === 'full') {
      const q = u.cards.filter((c) => val(c, L) !== u.value);
      if (q.length === 2 && !isCtrl({ type: 'pair', value: val(q[0], L) }))
        pairs.push({ v: val(q[0], L), cards: q });
    }
  }
  pairs.sort((a, b) => a.v - b.v);
  const out = [];
  for (const t of units) {
    if (t.type !== 'triple' || t.wu || t.value <= cur.value) continue;
    const q = pairs.find((x) => x.v !== t.value && !x.cards.some((c) => t.cards.includes(c)));
    if (q) out.push({ type: 'full', value: t.value, n: 5, cards: t.cards.concat(q.cards), wu: 0 });
  }
  return out;
}

function mateCeilings(p) {
  const m = (p + 2) % 4,
    lg = runtime.game.log || [],
    out = {};
  let top = null,
    last = null;
  const close = () => {
    if (top && last && last.p === m && !last.cards && top.p % 2 !== m % 2 && !isBomb(top)) {
      const c = out[top.type];
      if (c === undefined || top.value < c) out[top.type] = top.value;
    }
  };
  for (const e of lg) {
    if (e.cards && e.lead) {
      close();
      top = null;
    }
    if (e.cards) top = e;
    last = e;
  }
  return out;
}

const mateLacks = (p, cur) => {
  const c = mateCeilings(p)[cur.type];
  return c !== undefined && c <= cur.value;
};

function plainBomb(list, L) {
  const b = list[0];
  if (!AIP.rBombPlain || !b || !b.wu) return b;
  const lv = bombLevels(L),
    i = lv.indexOf(power(b));
  return list.find((u) => !u.wu && lv.indexOf(power(u)) - i <= AIP.bombPlainGap) || b;
}
function aiLead(p, units, plays, ph) {
  const hand = runtime.game.hands[p],
    L = runtime.game.L;

  if (AIP.rLastGroup) {
    const rest = units.filter((u) => !isBomb(u));
    if (rest.length === 1 && units.some(isBomb)) {
      const oc = [(p + 1) % 4, (p + 3) % 4]
        .map((i) => runtime.game.hands[i].length)
        .filter((n) => n > 0);
      if (!oc.some((n) => n === rest[0].n || n === 4)) return rest[0];
    }
  }

  if (hand.length <= 16) {
    let o;
    for (const pl of plays) {
      const rest = hand.filter((c) => !pl.cards.includes(c));
      if (analyze(rest, L).length && isTop(pl, o || (o = outside(p)))) return pl;
    }
  }

  let pool = units.filter((u) => !isBomb(u) && !(ph !== 'late' && u.wu));
  if (!pool.length) pool = units.filter((u) => !isBomb(u));
  if (!pool.length) return units.slice().sort((a, b) => power(a) - power(b))[0];
  const mateLeft = runtime.game.hands[(p + 2) % 4].length;
  const oppMin = Math.min(
    ...[(p + 1) % 4, (p + 3) % 4].map((i) => runtime.game.hands[i].length || 99),
  );

  if (AIP.rNoFive && [(p + 1) % 4, (p + 3) % 4].some((i) => runtime.game.hands[i].length === 5)) {
    const q = pool.filter((u) => u.type !== 'full' && u.type !== 'straight');
    if (q.length) pool = q;
  }
  const of = (t) => pool.filter((u) => u.type === t);
  if (AIP.rFiveLead) {
    const oc = [(p + 1) % 4, (p + 3) % 4]
      .map((i) => runtime.game.hands[i].length)
      .filter((n) => n > 0);
    const five = (u) => u.n === 5 && (u.type === 'full' || u.type === 'straight');
    if (oc.some((n) => n === 9 || n === 10)) {
      const q = pool.filter((u) => !five(u));
      if (q.length) pool = q;
    } else if (oc.some((n) => n === 7 || n === 8)) {
      const f = pool.filter(five).sort((a, b) => a.value - b.value)[0];
      if (f) return f;
    }
  }
  if (AIP.rFeed) {
    const f = feedMate(p, null);
    if (f) return f;
  } else
    for (const [n, t] of [
      [1, 'single'],
      [2, 'pair'],
    ])
      if (mateLeft === n && of(t).length)
        return of(t).reduce((m, u) => (u.value < m.value ? u : m));

  for (const [n, t] of [
    [1, 'single'],
    [2, 'pair'],
  ])
    if (oppMin === n) {
      const other = pool.filter((u) => u.type !== t);
      if (other.length) return pickLead(other, p);
      return of(t).reduce((m, u) => (u.value > m.value ? u : m));
    }
  const st = AIP.rLeadMate || AIP.rDry ? passStats() : null;

  if (AIP.rLeadMate && tierOf(p) >= 3 && mateStronger(p)) {
    const u = mateLead(p, pool, st);
    if (u) return u;
  }
  if (AIP.rDry) {
    const d = dryUnits(p, pool, st).sort((a, b) => a.value - b.value || b.n - a.n)[0];
    if (d) return d;
  }
  return pickLead(pool, p);
}

function pickLead(pool, p) {
  const kinds = {};
  for (const u of pool) (kinds[u.type + u.n] || (kinds[u.type + u.n] = [])).push(u);
  let best = null,
    most = 0;
  for (const k in kinds) {
    const g = kinds[k].sort((a, b) => a.value - b.value),
      small = g.filter((u) => !isCtrl(u)).length;
    if (!small || small === g.length) continue;
    if (small > most || (small === most && g[0].value < best.value)) {
      most = small;
      best = g[0];
    }
  }
  if (best) return best;
  const by = (a, b) => a.value - b.value || b.n - a.n;

  if (AIP.rLeadPartner && p !== undefined) {
    const m = (p + 2) % 4,
      led = new Set(
        (runtime.game.log || []).filter((e) => e.cards && e.lead && e.p === m).map((e) => e.type),
      );
    const f = pool.filter((u) => led.has(u.type) && !isCtrl(u)).sort(by)[0];
    if (f) return f;
  }
  if (AIP.rSingleLast) {
    const ns = pool.filter((u) => u.type !== 'single');
    if (ns.length) return ns.filter((u) => !isCtrl(u)).sort(by)[0] || ns.sort(by)[0];
  }
  return pool.filter((u) => !isCtrl(u)).sort(by)[0] || pool.slice().sort(by)[0];
}

const gamePhase = (p) => {
  const n = runtime.game.hands[p].length;
  return n > 19 ? 'early' : n > 10 ? 'mid' : 'late';
};

export function chooseRuleAction(p) {
  const pl = aiChoose(p);
  if (
    !AIP.rSmallPair ||
    !pl ||
    pl.type !== 'full' ||
    pl.cards.some((c) => isWild(c, runtime.game.L))
  )
    return pl;
  const L = runtime.game.L,
    trip = pl.cards.filter((c) => val(c, L) === pl.value);
  const now = pl.cards.filter((c) => !trip.includes(c)),
    nowV = Math.min(...now.map((c) => val(c, L)));
  if (trip.length !== 3 || now.length !== 2) return pl;
  const units = armPlays(runtime.game.hands[p], L),
    pairs = [];
  for (const u of units) {
    if (u.type === 'pair' && u.value < 16 && !u.wu) pairs.push(u.cards);
    else if (u.type === 'full' && u !== pl) {
      const q = u.cards.filter((c) => val(c, L) !== u.value);
      if (q.length === 2 && !q.some((c) => isWild(c, L))) pairs.push(q);
    }
  }
  const best = pairs
    .filter((q) => val(q[0], L) < nowV && !q.some((c) => trip.includes(c)))
    .sort((a, b) => val(a[0], L) - val(b[0], L))[0];
  return best
    ? { ...pl, cards: trip.concat(best), wu: trip.filter((c) => isWild(c, L)).length }
    : pl;
}

function bombLevels(L) {
  const pw = [];
  for (let n = 4; n <= 8; n++) for (let r = 2; r <= 14; r++) pw.push(n * 100 + (r === L ? 15 : r));
  for (let v = 1; v <= 10; v++) pw.push(550 + v);
  pw.push(10000);
  return pw.sort((a, b) => a - b);
}

function bombBack(p, units, cur, winLeft, ph, mateYet) {
  const mine = units.filter(isBomb),
    over = mine.filter((u) => beats(u, cur)).sort((a, b) => power(a) - power(b));
  if (!over.length) return null;
  const b = plainBomb(over, runtime.game.L),
    lv = bombLevels(runtime.game.L),
    up = lv.indexOf(power(b)) - lv.indexOf(power(cur));
  if (mine.length === 1) {
    if (ph !== 'late') return {};
    if (winLeft <= AIP.bbOneLeft) return { pl: b };
    if (mateYet() && up >= AIP.bbOneFar) return {};
    return null;
  }
  if (mine.length === 2) {
    if (up <= AIP.bbTwoNear) return { pl: b };
    if (winLeft >= AIP.bbTwoFarMin) return {};
    return null;
  }
  return { pl: b };
}

function unseenOf(p) {
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  return makeDeck().filter((c) => !gone.has(c.id));
}

function couldMake(pool, type, v) {
  const L = runtime.game.L,
    cnt = {},
    rc = {},
    w = pool.filter((c) => isWild(c, L)).length;
  for (const c of pool)
    if (!isWild(c, L)) {
      const x = val(c, L);
      cnt[x] = (cnt[x] || 0) + 1;
      if (c.r < 16) rc[c.r] = (rc[c.r] || 0) + 1;
    }
  const has = (x, k) => (cnt[x] || 0) + (x < 16 ? w : 0) >= k;
  if (type === 'single') return pool.some((c) => val(c, L) > v);
  if (type === 'pair') {
    for (let x = Math.floor(v) + 1; x <= 17; x++) if (has(x, 2)) return true;
    return false;
  }
  if (type === 'full') {
    for (let t = Math.floor(v) + 1; t <= 15; t++)
      if (has(t, 3)) for (let q = 2; q <= 17; q++) if (q !== t && (cnt[q] || 0) >= 2) return true;
    return false;
  }
  if (type === 'straight') {
    for (let s = Math.floor(v) + 1; s <= 10; s++) {
      let gap = 0;
      for (let q = s; q < s + 5; q++) if (!rc[q === 1 ? 14 : q]) gap++;
      if (gap <= w) return true;
    }
    return false;
  }
  return false;
}

function feedMate(p, cur) {
  const m = (p + 2) % 4,
    nx = (p + 1) % 4,
    mn = runtime.game.hands[m].length,
    xn = runtime.game.hands[nx].length;
  if (mn !== 1 && mn !== 2 && mn !== 5) return null;
  const L = runtime.game.L,
    pool = unseenOf(p),
    hand = runtime.game.hands[p];
  const inBomb = new Set(
    armPlays(hand, L)
      .filter(isBomb)
      .flatMap((u) => u.cards.map((c) => c.id)),
  );
  const all = genPlays(hand, L).filter(
    (x) => !isBomb(x) && !x.cards.some((c) => inBomb.has(c.id)) && beats(x, cur),
  );
  const pick = (types, largest) => {
    const c = all
      .filter((x) => types.includes(x.type) && couldMake(pool, x.type, x.value))
      .sort((a, b) => a.value - b.value || b.n - a.n);
    return c.length ? c[largest ? c.length - 1 : 0] : null;
  };
  if (mn === 1) return pick(['single'], xn === 1);
  if (mn === 2) return xn === 2 && couldMake(pool, 'pair', 0) ? null : pick(['pair']);
  if (xn === 5 && (couldMake(pool, 'full', 0) || couldMake(pool, 'straight', 0))) return null;
  return pick(['full', 'straight']);
}
function aiChoose(p) {
  const hand = runtime.game.hands[p],
    L = runtime.game.L,
    cur = runtime.game.trick ? runtime.game.trick.play : null;
  tierOf(p);
  const plays = genPlays(hand, L).filter((pl) => beats(pl, cur));
  if (!plays.length) return null;
  const fin = plays.find((pl) => pl.cards.length === hand.length);

  if (
    fin &&
    AIP.rNeverMateBomb &&
    cur &&
    isBomb(fin) &&
    runtime.game.trick.player !== p &&
    runtime.game.trick.player % 2 === p % 2
  )
    return null;
  if (
    fin &&
    AIP.rMateBomb &&
    cur &&
    isBomb(fin) &&
    runtime.game.trick.player !== p &&
    runtime.game.trick.player % 2 === p % 2 &&
    (isBomb(cur)
      ? AIP.rMateBomb2
      : runtime.game.hands[(p + 1) % 4].length > AIP.mateBombOppMin &&
        runtime.game.hands[(p + 3) % 4].length > AIP.mateBombOppMin &&
        oppBeatChance(p, cur) <= AIP.mateBombMax)
  )
    return null;
  if (fin) return fin;

  let ph = gamePhase(cur ? runtime.game.trick.player : p);
  let units = armPlays(hand, L);
  if (!cur) return aiLead(p, units, plays, ph);
  if (AIP.rBuildFull && cur.type === 'full' && runtime.game.trick.player % 2 !== p % 2)
    units = units.concat(builtFulls(units, cur));

  const winner = runtime.game.trick.player;
  if (winner % 2 === p % 2) {
    const nx = (p + 1) % 4;
    if (
      AIP.rTopMate &&
      (cur.type === 'single' || cur.type === 'pair') &&
      cur.value <= AIP.smallMax &&
      runtime.game.hands[nx].length &&
      runtime.game.hands[nx].length <= AIP.topMateNextMax
    ) {
      const top = plays
        .filter(
          (x) =>
            x.type === cur.type &&
            x.n === cur.n &&
            !isBomb(x) &&
            !x.wu &&
            x.value >= 14 &&
            x.value <= 15,
        )
        .sort((a, b) => a.value - b.value)[0];
      if (top) return top;
    }

    if (AIP.rGoAlong) {
      const along = units
        .filter(
          (u) =>
            !isBomb(u) &&
            !u.wu &&
            u.type === cur.type &&
            u.n === cur.n &&
            beats(u, cur) &&
            !isCtrl(u),
        )
        .sort((a, b) => a.value - b.value)[0];
      if (along) return along;
    }
    return null;
  }
  const winLeft = runtime.game.hands[winner].length;
  const oppMin = Math.min(
    ...[(p + 1) % 4, (p + 3) % 4].map((i) => runtime.game.hands[i].length || 99),
  );
  const urgent = winLeft <= AIP.urgentWin || oppMin <= AIP.urgentOpp;

  if (AIP.rUrgentLate && oppMin <= AIP.urgentOpp) ph = 'late';
  let o;
  const out = () => o || (o = outside(p));
  const t = tierOf(p);

  const mateAfter = winner === (p + 3) % 4 && runtime.game.hands[(p + 2) % 4].length > 0;
  let mb;
  const mateCan = () =>
    mateAfter && (mb === undefined ? (mb = mateBeatChance(p, cur) >= AIP.mateBeatProb) : mb);

  if (AIP.rFeed) {
    const f = feedMate(p, cur);
    if (f) return f;
  }

  const lead = (() => {
    for (let i = runtime.game.log.length - 1; i >= 0; i--)
      if (runtime.game.log[i].cards && runtime.game.log[i].lead) return runtime.game.log[i];
    return null;
  })();
  const mateLed =
    lead &&
    lead.p === (p + 2) % 4 &&
    lead.type === 'single' &&
    lead.value <= AIP.smallMax &&
    mateAfter &&
    winLeft > AIP.urgentWin;
  const bigUnseen =
    hand.filter((c) => c.r === 17).length +
      (runtime.game.seen || []).filter((c) => c.r === 17).length <
    2;
  const keepJoker = (pl) => AIP.rMateJoker && mateLed && pl.value >= 16 && bigUnseen;

  const mateYet = () => {
    const m = (p + 2) % 4;
    if (!runtime.game.hands[m].length) return false;
    for (let i = runtime.game.log.length - 1; i >= 0; i--) {
      if (runtime.game.log[i].p === m) return false;
      if (runtime.game.log[i].cards && runtime.game.log[i].lead) break;
    }
    return true;
  };

  const four = (b) =>
    AIP.rFourBomb && winLeft === 4 && !(isTop(b, out()) && restCost(hand, b, L) <= 1);

  if (AIP.rBombBack && isBomb(cur)) {
    const d = bombBack(p, units, cur, winLeft, ph, mateYet);
    if (d) return d.pl && four(d.pl) ? null : d.pl || null;
  }

  if (AIP.rPureFit) {
    const pure = units
      .filter(
        (u) =>
          !isBomb(u) &&
          !u.wu &&
          u.type === cur.type &&
          u.n === cur.n &&
          beats(u, cur) &&
          !isCtrl(u),
      )
      .sort((a, b) => a.value - b.value)[0];
    if (pure) return pure;
  }

  const early = ph !== 'late';
  const twoBombs = units.filter(isBomb).length >= 2;

  const keepOne = AIP.rOneBomb && units.filter(isBomb).length === 1;

  const keepWildFor = (pl) => {
    if (
      !AIP.rKeepWild ||
      urgent ||
      !mateAfter ||
      ph !== 'late' ||
      pl.cards.length >= hand.length ||
      !pl.cards.some((c) => isWild(c, L))
    )
      return false;
    const cnt = {};
    for (const c of hand) if (!isWild(c, L) && c.r < 16) cnt[c.r] = (cnt[c.r] || 0) + 1;
    return Object.values(cnt).some((n) => n === 3) && inferMateBeat(p, cur) >= AIP.keepWildMate;
  };
  const fit = units
    .filter(
      (u) =>
        !isBomb(u) && u.type === cur.type && u.n === cur.n && beats(u, cur) && !(early && u.wu),
    )
    .sort((a, b) => a.value - b.value)[0];
  if (fit && keepJoker(fit)) return null;
  if (fit) {
    let ok = !keepWildFor(fit);
    if (early) {
      const leave = t === 1 ? 0 : t >= 3 ? AIP.leaveWeak : AIP.midLeaveProb;

      if (
        AIP.rKeepBig &&
        ph === 'early' &&
        fit.type === 'single' &&
        fit.value >= 16 &&
        cur.value < 14 &&
        mateYet() &&
        !units.some((u) => u.type === 'single' && u.value < 16 && beats(u, cur))
      )
        ok = false;
      else if (!AIP.rPureFit && ph === 'mid' && mateAfter && Math.random() < leave) ok = false;
      else if (isCtrl(fit) && Math.random() < AIP.saveCtrlProb) ok = false;
    }
    if (ok) return fit;
  }
  if (early) {
    const b = units
      .filter((u) => isBomb(u) && !u.wu && beats(u, cur))
      .sort((a, b) => power(a) - power(b))[0];
    const twoMid = AIP.rTwoBombs && ph === 'mid' && twoBombs && !isBomb(cur) && isCtrl(cur);
    return b &&
      (restCost(hand, b, L) <= AIP.bombRest ||
        twoMid ||
        (t === 1 &&
          cur.value >= AIP.bombBigVal &&
          (!AIP.rMateEvid || ph !== 'early' || mateLacks(p, cur)))) &&
      !mateCan() &&
      !four(b) &&
      !keepOne
      ? b
      : null;
  }

  const base = handCost(hand, L);
  const order = hintOrder(hand, L, cur, plays);
  const normal = order.filter((pl) => !isBomb(pl));
  if (normal.length) {
    const b = { pl: normal[0] },
      delta = restCost(hand, b.pl, L) - base;
    if (keepJoker(b.pl)) return null;
    let ok =
      delta <= AIP.followFree ||
      urgent ||
      (delta <= AIP.followMaybe && Math.random() < AIP.followMaybeProb);
    if (
      ok &&
      b.pl.value >= 16 &&
      cur.value < AIP.saveJokerCurBelow &&
      !urgent &&
      hand.length > AIP.saveJokerHand &&
      Math.random() < AIP.saveJokerProb
    )
      ok = false;
    const keepWild = keepWildFor(b.pl);
    if (keepWild) ok = false;

    if (!ok && !keepWild && delta <= AIP.topFree && isTop(b.pl, out())) ok = true;
    if (ok) return b.pl;
  }
  const bombs = order.filter(isBomb);
  if (bombs.length) {
    const pb =
      plainBomb(
        bombs.slice().sort((a, b) => power(a) - power(b)),
        L,
      ) || bombs[0];
    const b = { pl: pb, rc: restCost(hand, pb, L) };

    const rest = hand.filter((c) => !b.pl.cards.includes(c)),
      cnt = {};
    for (const c of rest) if (!isWild(c, L) && c.r < 16) cnt[c.r] = (cnt[c.r] || 0) + 1;
    const smallLeft = rest.some(
      (c) => !isWild(c, L) && c.r < 16 && cnt[c.r] === 1 && val(c, L) <= AIP.smallMax,
    );
    const many =
      Math.max(...[(p + 1) % 4, (p + 3) % 4].map((i) => runtime.game.hands[i].length)) >
      AIP.lateBombOppMax;
    const nearOut = b.rc <= AIP.bombRest && !(AIP.rLateBomb && smallLeft && many);

    const mateCant =
      AIP.rMateCant &&
      mateAfter &&
      !isBomb(cur) &&
      cur.value >= AIP.bombBigVal &&
      inferMateBeat(p, cur) <= AIP.mateCantMax;
    const twoLate = AIP.rTwoBombs && twoBombs && !isBomb(cur) && isCtrl(cur);
    const want =
      twoLate ||
      mateCant ||
      winLeft <= AIP.bombWinLeft ||
      nearOut ||
      (t < 4 &&
        ((isBomb(cur) && winLeft <= AIP.bombOverBomb) ||
          (cur.value >= AIP.bombBigVal && (t === 1 || Math.random() < AIP.bombBigProb)) ||
          (b.rc <= AIP.safeBombRest && isTop(b.pl, out()))));

    const wildBomb =
      AIP.rKeepWild &&
      b.pl.cards.some((c) => isWild(c, L)) &&
      mateAfter &&
      inferMateBeat(p, cur) >= AIP.keepWildMate;
    if (want && (twoLate || (!mateCan() && !wildBomb)) && !four(b.pl)) return b.pl;
  }
  return null;
}
