import { runtime } from '../app/runtime.js';
import { returnOptions, tributeOptions } from '../core/tribute.js';
import { AIP, handCost } from './hand-value.js';
import { isWild, makeDeck, val } from '../core/cards.js';
import { analyze, beats, isBomb, power } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
import { armPlays, handPower, isCtrl } from '../hand/arrangement.js';
import { hintOrder } from '../hand/hints.js';

let restCost;
export let TALLY_RANKS;
export let tallyKey;
let isTop;
let gamePhase;
export let tributeCard;

// card memory: the cards the other three still hold between them (the deck less your hand and everything played),
// and every play they could make from them; pooling the three hands errs on the safe side
function outside(p) {
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  const plays = genPlays(
    makeDeck().filter((c) => !gone.has(c.id)),
    runtime.game.L,
  );
  return { plays, topBomb: plays.filter(isBomb).reduce((m, x) => Math.max(m, power(x)), 0) };
}

export function tallyPlayed(log, L) {
  const per = [{}, {}, {}, {}];
  for (const e of log)
    if (e.cards)
      for (const c of e.cards) {
        const k = tallyKey(c, L);
        (per[e.p][k] || (per[e.p][k] = [])).push(c);
      }
  return per;
}

// the cards of one rank still out (not played by anyone)
export function tallyLeft(log, L, k) {
  const gone = new Set();
  for (const e of log) if (e.cards) for (const c of e.cards) gone.add(c.id);
  return makeDeck().filter((c) => tallyKey(c, L) === k && !gone.has(c.id));
}

// 牌力 tier for the round, from the hand as dealt (a player's hand is untouched until their first play)
function tierOf(p) {
  const pw = runtime.game.pw || (runtime.game.pw = []);
  if (pw[p] === undefined) pw[p] = handPower(runtime.game.hands[p], runtime.game.L);
  return pw[p] >= AIP.tier1 ? 1 : pw[p] >= AIP.tier2 ? 2 : pw[p] >= AIP.tier3 ? 3 : 4;
}

// card memory: how likely the partner holds something (not a bomb) that beats this play, dealing them the unseen cards at random
function mateBeatChance(p, cur) {
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

// leading: the two-plays-from-out case, then help a partner about to go out, keep an opponent about to go out from
// getting their kind of play, and otherwise lead from the arranged hand (see pickLead)
function aiLead(p, units, plays, ph) {
  const hand = runtime.game.hands[p],
    L = runtime.game.L;
  // two plays from going out: lead the one nobody can beat, then the other
  if (hand.length <= 16) {
    let o;
    for (const pl of plays) {
      const rest = hand.filter((c) => !pl.cards.includes(c));
      if (analyze(rest, L).length && isTop(pl, o || (o = outside(p)))) return pl;
    }
  }
  // early and middle game the wild cards stay in hand; bombs are led only when nothing else is left
  let pool = units.filter((u) => !isBomb(u) && !(ph !== 'late' && u.wu));
  if (!pool.length) pool = units.filter((u) => !isBomb(u));
  if (!pool.length) return units.slice().sort((a, b) => power(a) - power(b))[0];
  const mateLeft = runtime.game.hands[(p + 2) % 4].length;
  const oppMin = Math.min(
    ...[(p + 1) % 4, (p + 3) % 4].map((i) => runtime.game.hands[i].length || 99),
  );
  // an opponent down to five cards: no three-with-a-pair or straight led (they could go out on one)
  if (AIP.rNoFive && [(p + 1) % 4, (p + 3) % 4].some((i) => runtime.game.hands[i].length === 5)) {
    const q = pool.filter((u) => u.type !== 'full' && u.type !== 'straight');
    if (q.length) pool = q;
  }
  const of = (t) => pool.filter((u) => u.type === t);
  if (AIP.rFeed) {
    const f = feedMate(p, null);
    if (f) return f;
  }
  // partner down to one or two cards: hand them the smallest single or pair
  else
    for (const [n, t] of [
      [1, 'single'],
      [2, 'pair'],
    ])
      if (mateLeft === n && of(t).length)
        return of(t).reduce((m, u) => (u.value < m.value ? u : m));
  // an opponent down to one or two cards: lead something else, or else the largest of that kind
  for (const [n, t] of [
    [1, 'single'],
    [2, 'pair'],
  ])
    if (oppMin === n) {
      const other = pool.filter((u) => u.type !== t);
      if (other.length) return pickLead(other);
      return of(t).reduce((m, u) => (u.value > m.value ? u : m));
    }
  return pickLead(pool);
}

// lead the kind of play you are strong in: where a big one can win the lead back, its smallest one goes first;
// otherwise the smallest play that could not win the lead back anyway
function pickLead(pool) {
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
  return pool.filter((u) => !isCtrl(u)).sort(by)[0] || pool.slice().sort(by)[0];
}

// a three-with-a-pair goes out with the smallest pair the hand can spare (a free pair, or one arranged with another three),
// the larger pairs kept
export function aiDecide(p) {
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

// every bomb there can be, from the smallest up: four of a kind (the level card above the ace), five, the straight
// flushes, six, seven, eight of a kind, the four jokers; a bomb's level is its place in this order
function bombLevels(L) {
  const pw = [];
  for (let n = 4; n <= 8; n++) for (let r = 2; r <= 14; r++) pw.push(n * 100 + (r === L ? 15 : r));
  for (let v = 1; v <= 10; v++) pw.push(550 + v);
  pw.push(10000);
  return pw.sort((a, b) => a - b);
}

// the opponent's bomb on the table: {pl} to bomb it with, {} to let it go, or null when these rules do not decide
function bombBack(p, units, cur, winLeft, ph, mateYet) {
  const mine = units.filter(isBomb),
    over = mine.filter((u) => beats(u, cur)).sort((a, b) => power(a) - power(b));
  if (!over.length) return null;
  const b = over[0],
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

// the cards p has not seen: the other three hands together
function unseenOf(p) {
  const gone = new Set((runtime.game.seen || []).concat(runtime.game.hands[p]).map((c) => c.id));
  return makeDeck().filter((c) => !gone.has(c.id));
}

// whether the unseen cards could make a play of this kind above value v (wild cards filling in): a single, a pair, a
// three-with-a-pair, a straight
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

// your partner (3 if you are 1) down to one, two or five cards: a play they may go out on, led or played over the
// opponent's, never one they surely cannot beat (judged from the unseen cards). 2 is the opponent who plays between you.
// Partner 1 card: the smallest single (the largest such, when 2 is down to one card too). Partner 2 cards: the smallest
// pair, unless 2 also holds two that may be a pair. Partner 5 cards: the smallest three-with-a-pair or straight, unless 2
// also holds five that may be one play (4 holding five does not stop it: your partner plays first). null: nothing to hand
// over, play as usual
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
  const plays = genPlays(hand, L).filter((pl) => beats(pl, cur));
  if (!plays.length) return null;
  const fin = plays.find((pl) => pl.cards.length === hand.length);
  if (fin) return fin;
  const ph = gamePhase(),
    units = armPlays(hand, L);
  if (!cur) return aiLead(p, units, plays, ph);

  const winner = runtime.game.trick.player;
  if (winner % 2 === p % 2) {
    // your partner's single or pair of 10 or below, and the opponent next to play is down to a few cards: top it with
    // an ace or the level card (breaking a pair if need be), so they cannot slip a small card through
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
    return null; // let partner's cards ride
  }
  const winLeft = runtime.game.hands[winner].length;
  const oppMin = Math.min(
    ...[(p + 1) % 4, (p + 3) % 4].map((i) => runtime.game.hands[i].length || 99),
  );
  const urgent = winLeft <= AIP.urgentWin || oppMin <= AIP.urgentOpp;
  let o;
  const out = () => o || (o = outside(p));
  const t = tierOf(p);
  // the partner still gets to play to this trick (the opponent who leads it sits just before you)
  const mateAfter = winner === (p + 3) % 4 && runtime.game.hands[(p + 2) % 4].length > 0;
  let mb;
  const mateCan = () =>
    mateAfter && (mb === undefined ? (mb = mateBeatChance(p, cur) >= AIP.mateBeatProb) : mb);
  // your partner about to go out: a play over the opponent's that they may beat with their last cards
  if (AIP.rFeed) {
    const f = feedMate(p, cur);
    if (f) return f;
  }
  // your partner led a small single, an opponent beat it and your partner plays again after you: they most likely hold the
  // big joker (it is not in your hand and has not been played), so a joker of yours stays in hand
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
  // your partner has not yet had a turn in this trick (and is still in the round)
  const mateYet = () => {
    const m = (p + 2) % 4;
    if (!runtime.game.hands[m].length) return false;
    for (let i = runtime.game.log.length - 1; i >= 0; i--) {
      if (runtime.game.log[i].p === m) return false;
      if (runtime.game.log[i].cards && runtime.game.log[i].lead) break;
    }
    return true;
  };
  // an opponent's bomb: the bomb rules from the player's comments decide first (the older rules only where they say nothing)
  if (AIP.rBombBack && isBomb(cur)) {
    const d = bombBack(p, units, cur, winLeft, ph, mateYet);
    if (d) return d.pl || null;
  }
  // a group of the arranged hand that fits exactly: the smallest one (no wild cards before the late game)
  const early = ph !== 'late';
  const fit = units
    .filter(
      (u) =>
        !isBomb(u) && u.type === cur.type && u.n === cur.n && beats(u, cur) && !(early && u.wu),
    )
    .sort((a, b) => a.value - b.value)[0];
  if (fit && keepJoker(fit)) return null;
  if (fit) {
    let ok = true;
    if (early) {
      // in the middle game, with your partner still to play after this opponent, you may leave it to them
      // (tier 1 never does, tiers 3 and 4 more often)
      const leave = t === 1 ? 0 : t >= 3 ? AIP.leaveWeak : AIP.midLeaveProb;
      // early game, an opponent's single below an ace that only a joker of yours beats (no single of yours that could
      // follow it out), and your partner yet to play to this trick: the joker stays in hand
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
      else if (ph === 'mid' && mateAfter && Math.random() < leave) ok = false;
      else if (isCtrl(fit) && Math.random() < AIP.saveCtrlProb) ok = false;
    }
    if (ok) return fit;
  }
  if (early) {
    // early and middle game: nothing that breaks a group; a bomb only when it nearly finishes the hand
    // (tier 1 also bombs an ace or more), and not when the partner can most likely beat it
    const b = units
      .filter((u) => isBomb(u) && !u.wu && beats(u, cur))
      .sort((a, b) => power(a) - power(b))[0];
    return b &&
      (restCost(hand, b, L) <= AIP.bombRest || (t === 1 && cur.value >= AIP.bombBigVal)) &&
      !mateCan()
      ? b
      : null;
  }
  // late game: break groups if need be, in the hint order, and bomb when it matters
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
    // a play nobody can beat wins the lead back, so it is worth more
    if (!ok && delta <= AIP.topFree && isTop(b.pl, out())) ok = true;
    if (ok) return b.pl;
  }
  const bombs = order.filter(isBomb);
  if (bombs.length) {
    const b = { pl: bombs[0], rc: restCost(hand, bombs[0], L) };
    // left after the bomb: a small single hard to get rid of, while an opponent still holds many cards (and may bomb
    // back): then "nearly out" is no reason to bomb yet
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
    // tier 1 bombs an ace or more every time; tier 4 keeps its bombs for an opponent about to go out
    const want =
      winLeft <= AIP.bombWinLeft ||
      nearOut ||
      (t < 4 &&
        ((isBomb(cur) && winLeft <= AIP.bombOverBomb) ||
          (cur.value >= AIP.bombBigVal && (t === 1 || Math.random() < AIP.bombBigProb)) ||
          (b.rc <= AIP.safeBombRest && isTop(b.pl, out()))));
    if (want && !mateCan()) return b.pl;
  }
  return null;
}

export function aiReturnCard(hand, L) {
  const legal = returnOptions(hand, L);
  let pool = legal.filter((card) => card.r !== L);
  if (!pool.length) pool = legal;
  let best = null,
    bs = 1e9;
  for (const c of pool) {
    const sc =
      handCost(
        hand.filter((x) => x !== c),
        L,
      ) +
      val(c, L) * 0.01;
    if (sc < bs) {
      bs = sc;
      best = c;
    }
  }
  return best;
}

export function initialize() {
  /* ---------- AI ---------- */
  // the computer plays from its arranged hand; late in the round it may break groups, in the hint order
  restCost = (hand, pl, L) =>
    handCost(
      hand.filter((c) => !pl.cards.includes(c)),
      L,
    );
  TALLY_RANKS = (L) =>
    [17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2].filter((k) => k !== L);
  tallyKey = (c, L) => (c.r >= 16 ? c.r : c.r === L ? 15 : c.r);
  isTop = (pl, o) =>
    isBomb(pl) ? power(pl) > o.topBomb : !o.plays.some((x) => !isBomb(x) && beats(x, pl));
  gamePhase = () => {
    const n = runtime.game.hands.map((h) => h.length);
    return n.some((k) => k <= 10) ? 'late' : n.every((k) => k >= 16) ? 'early' : 'mid';
  };
  tributeCard = (hand, L) => tributeOptions(hand, L)[0];
}
