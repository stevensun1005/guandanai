import { runtime } from '../app/runtime.js';
import { PLACE, TYPE_NAME, sortHand } from '../core/cards.js';
import { isBomb } from '../core/combinations.js';
import { reduceMotion, seatPoint } from '../effects/dealing.js';
import { isPhone, phoneRows, sideBtns } from '../hand/layout.js';
import { miniMode } from '../input/actions.js';
import { handEl } from '../input/pointer.js';
import { $, cardHTML, displayOrder } from './cards.js';
import { isRedSeat, render } from './table.js';

let BIG;
let PHONE_SC;
let TRICK_HOLD_MS;
export let trickHold;
export let pileEl;
let PASS_X;
export let PASS_Y;
let OLD;
let GAP;
let pileT;
let MIN_TS_PC;
let minTS;
let HEAP_R;
let HEAP_SC;

// the open play area between the four plates
export function pileGeo() {
  const L = pileEl().getBoundingClientRect(),
    R = (q) => $(q).getBoundingClientRect();
  // a player's plate, and in the practice table the face-up hand beside it, which the table's cards keep clear of too
  const P = (p) => {
    // (with the count of cards under the plate, where a computer shows it)
    let a = R('#seat' + p + ' .whorow');
    const add = (b) => {
      a = {
        left: Math.min(a.left, b.left),
        right: Math.max(a.right, b.right),
        bottom: Math.max(a.bottom, b.bottom),
      };
    };
    const c = $('#seat' + p + ' .cnt'),
      k = runtime.reviewMode && $('#peek' + p);
    if (c && c.offsetHeight) add(c.getBoundingClientRect());
    if (k && k.offsetHeight) add(k.getBoundingClientRect());
    return a;
  };
  const top = P(2).bottom - L.top;
  const bottom = R('#seat0').top - L.top;
  // the same margin on both sides (a ticking clock widens one plate, which must not push one player's cards in)
  // (on a phone the plates are small and grow by a count badge or a clock while the cards lie there: room is kept for it)
  const side = Math.max(P(3).right - L.left, L.right - P(1).left) + (isPhone() ? 34 : 0);
  const left = side,
    right = L.width - side;
  const cw = $('#pile .probe').offsetWidth || 48;
  const e = R('.emblem'),
    mid = (q) => {
      const r = R(q);
      return r.top + r.height / 2 - L.top;
    };
  // the action column, where it reaches up over the table on the right
  const b = $('#btns'),
    br =
      (sideBtns() || phoneRows()) && !b.hidden && b.offsetHeight ? b.getBoundingClientRect() : null;
  const col = br ? { left: br.left - L.left, top: br.top - L.top } : null;
  return {
    L,
    top,
    bottom,
    left,
    right,
    cx: L.width / 2,
    cy: (top + bottom) / 2,
    hy: e.top + e.height / 2 - L.top,
    sideY: { 1: mid('#seat1 .who'), 3: mid('#seat3 .who') },
    cw,
    ch: cw * runtime.CR,
    col,
    ...((r) =>
      r.height
        ? {
            lp: r.bottom - L.top,
            lpBox: { l: r.left - L.left, r: r.right - L.left, t: r.top - L.top },
          }
        : { lp: 0, lpBox: { l: 0, r: 0, t: 0 } })(R('#lastPlay')),
    near: nearBottom() - L.top,
  };
}

// the players' room changed (the action column or the line under the disc moved): the cards on the table are fitted
// again, the whole trick stepping down in size if they no longer fit
export function pileRefit() {
  const g = pileGeo(),
    last = runtime.pileGroups[runtime.pileGroups.length - 1];
  // as when a play is thrown: the newest play's player must fit, and the right-hand player beside the column
  const who = isPhone() ? [0, 1, 2, 3] : [1, last && last.p];
  while (who.some((q) => q != null && !layoutPlayer(q, g, false)) && runtime.TS > minTS())
    runtime.TS = Math.max(minTS(), runtime.TS * 0.9);
  for (let q = 0; q < 4; q++) layoutPlayer(q, g, true);
}

// how far down your own cards on the table may reach: to your name plate (or your place label once you are out); the
// message line above the plate is empty nearly all the time, so its room is used too
export function nearBottom() {
  const pl = $('#myPlace'),
    r = (pl.textContent ? pl : $('#mebar .meinfo')).getBoundingClientRect();
  return r.top;
}

// space between two plays of the same player
// Like four people round a square table: each player's cards go straight in front of them.
// The table splits into four zones (a column each for the left and right players, the middle split
// into a far half for your partner and a near half for you), and each player's plays this trick form a
// neat line centred on their own seat: across the table for you and your partner, down the table for the
// players at the sides. A line that runs out of room wraps into a second line closer to the middle.
function zoneFor(p, g) {
  if (phoneRows()) return phoneZone(p, g);
  const side = (g.right - g.left) * 0.27,
    mx0 = g.left + side,
    mx1 = g.right - side;
  const z =
    p === 3
      ? { x0: g.left + PASS_X, x1: mx0, y0: g.top + PASS_Y, y1: g.bottom - PASS_Y }
      : p === 1
        ? { x0: mx1, x1: g.right - PASS_X, y0: g.top + PASS_Y, y1: g.bottom - PASS_Y }
        : p === 2
          ? { x0: mx0, x1: mx1, y0: g.top + PASS_Y, y1: g.cy }
          : {
              x0: mx0,
              x1: mx1,
              y0: g.near - g.lp - 2 * PASS_Y >= g.ch * 0.74 ? Math.max(g.cy, g.lp + PASS_Y) : g.cy,
              y1: g.near - PASS_Y,
            };
  // a side player's cards also stop above the line where it reaches into their part of the table (a narrow screen)
  if (
    (p === 1 || p === 3) &&
    g.lpBox.r > z.x0 &&
    g.lpBox.l < z.x1 &&
    g.lpBox.t - PASS_Y - z.y0 > g.ch
  )
    z.y1 = Math.min(z.y1, g.lpBox.t - PASS_Y);
  // the right-hand player's cards stop above the action column, so they never lie under the buttons
  if (g.col && p === 1 && g.col.left < z.x1)
    z.y1 = Math.max(z.y0 + 20, Math.min(z.y1, g.col.top - PASS_Y));
  // a phone on its side shows the tribute line under the score until the first trick is in: your partner's cards
  // keep below it
  const ti = isPhone() && p === 2 ? $('#tribInfo') : null;
  if (ti && ti.textContent) {
    const r = ti.getBoundingClientRect(),
      x0 = r.left - g.L.left,
      x1 = r.right - g.L.left;
    if (x0 < z.x1 && x1 > z.x0) z.y0 = Math.max(z.y0, r.bottom - g.L.top + PASS_Y);
  }
  // a place label already on the plate (someone just went out) keeps its own room, clear of their last cards
  const lab = p !== 0 && runtime.game.out.includes(p) ? $('#seat' + p + ' .place') : null;
  if (lab && lab.offsetWidth) {
    const w = $('#seat' + p + ' .who').getBoundingClientRect();
    if (p === 2) z.y0 = Math.max(z.y0, w.bottom - g.L.top + 10 + lab.offsetHeight + PASS_Y);
    if (p === 3) z.x0 = Math.max(z.x0, w.right - g.L.left + 12 + lab.offsetWidth + PASS_X);
    if (p === 1) z.x1 = Math.min(z.x1, w.left - g.L.left - 12 - lab.offsetWidth - PASS_X);
  }
  return z;
}

// a phone held upright: one row per player, each as wide as the table - your partner's and then the left-hand
// player's (cards starting from the left) in the room above the side plates, the right-hand player's (cards ending at
// the right) and yours in the room below them (or three rows above and one below, whichever fits). Within its room a
// row is as deep as its player's plays need - a second play that does not fit beside the first goes onto a line of
// its own below it - and the two rows share what is left over. Every row keeps clear of the column of play buttons
function phoneNeed(q, g, w) {
  let used = 0,
    deep = 0,
    depth = 0,
    any = false;
  for (const gr of runtime.pileGroups.filter((x) => x.p === q)) {
    const d = groupDims(gr, g, gr.sc, false);
    if (any && used + GAP + d.w > w) {
      depth += deep + GAP;
      used = 0;
      deep = 0;
    }
    used += (used ? GAP : 0) + d.w;
    deep = Math.max(deep, d.h);
    any = true;
  }
  return any ? depth + deep : 0;
}

function phoneZone(p, g) {
  const R = (q) => $(q).getBoundingClientRect(),
    a = R('#seat3 .whorow'),
    c = R('#seat1 .whorow');
  const t = g.top + PASS_Y,
    b = g.near - PASS_Y,
    X0 = PASS_X,
    X1 = g.L.width - PASS_X;
  const pt = Math.max(t, Math.min(a.top, c.top) - g.L.top - 26),
    pb = Math.min(b, Math.max(a.bottom, c.bottom) - g.L.top + 4);
  const order = [2, 3, 1, 0],
    room = (y0, y1) => ({
      y0,
      y1,
      x1: g.col && g.col.top < y1 ? Math.max(X0 + g.cw, Math.min(X1, g.col.left - PASS_X)) : X1,
    });
  const A = room(t, pt),
    B = room(pb, b),
    need = (q) => phoneNeed(q, g, (order.indexOf(q) < k ? A : B).x1 - X0);
  // two rows above and two below, unless three above and one below (or one and three) is what lets them all fit
  let k = 2;
  for (const kk of [2, 3, 1]) {
    k = kk;
    const up = order.slice(0, k).reduce((s, q) => s + need(q), 0),
      down = order.slice(k).reduce((s, q) => s + need(q), 0);
    if (up <= A.y1 - A.y0 && down <= B.y1 - B.y0) break;
    k = 2;
  }
  const rows = order.indexOf(p) < k ? order.slice(0, k) : order.slice(k),
    r = order.indexOf(p) < k ? A : B;
  const needs = rows.map(need),
    spare = Math.max(0, r.y1 - r.y0 - needs.reduce((s, x) => s + x, 0)) / rows.length;
  let y = r.y0;
  for (let i = 0; i < rows.length; i++) {
    const h = needs[i] + spare;
    if (rows[i] === p) return { x0: X0, x1: r.x1, y0: y, y1: i === rows.length - 1 ? r.y1 : y + h };
    y += h;
  }
}

export function phoneRefit() {
  if (runtime.phoneRefitAsked) return;
  runtime.phoneRefitAsked = true;
  setTimeout(() => {
    runtime.phoneRefitAsked = false;
    if (runtime.pileGroups.length) pileRefit();
  }, 0);
}

function relPoint(pt, g) {
  return { x: pt.x - g.L.left, y: pt.y - g.L.top };
}

function groupDims(gr, g, sc, tag) {
  const cw = g.cw * runtime.TS,
    off = cw * 0.42,
    span = cw + off * (gr.n - 1);
  return {
    off,
    cw,
    ch: cw * runtime.CR,
    w: span * sc + 8,
    h: cw * runtime.CR * sc + (tag ? 26 : 6),
  };
}

// lay out one player's plays; with apply=false it only reports whether they fit in the player's zone
function layoutPlayer(p, g, apply) {
  const groups = runtime.pileGroups.filter((gr) => gr.p === p);
  if (!groups.length) return true;
  // on a phone held upright every player's plays run across their row (see phoneZone)
  const z = zoneFor(p, g),
    across = p === 0 || p === 2 || phoneRows();
  const len = across ? z.x1 - z.x0 : z.y1 - z.y0,
    room = across ? z.y1 - z.y0 : z.x1 - z.x0;
  const items = groups.map((gr) => {
    // only a bomb gets a tag, and it sits on the cards' lower edge, so it takes no room of its own
    // a phone keeps every play at the size it came down at (the whole trick steps down only when it no longer fits)
    const tag = gr.latest && isBomb(gr.play),
      sc = gr.latest || isPhone() ? gr.sc : OLD,
      d = groupDims(gr, g, sc, false);
    return { gr, sc, d, tag, along: across ? d.w : d.h, deep: across ? d.h : d.w };
  });
  const lines = [];
  let line = [],
    used = 0;
  for (const it of items) {
    if (line.length && used + GAP + it.along > len) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length ? GAP : 0) + it.along;
    line.push(it);
  }
  lines.push(line);
  const depth =
    lines.reduce((s, l) => s + Math.max(...l.map((it) => it.deep)), 0) + GAP * (lines.length - 1);
  const fits =
    depth <= room &&
    lines.every((l) => l.reduce((s, it) => s + it.along, 0) + GAP * (l.length - 1) <= len);
  if (!apply) return fits;
  // the first line sits right in front of the player; any further line steps in towards the middle
  const centre = !across
    ? g.sideY[p]
    : p === 3 && phoneRows()
      ? -1e9
      : p === 1 && phoneRows()
        ? 1e9
        : (z.x0 + z.x1) / 2;
  let edge = p === 0 ? z.y1 : p === 2 || across ? z.y0 : p === 3 ? z.x0 : z.x1;
  const dir = p === 0 || (p === 1 && !across) ? -1 : 1;
  pileEl()
    .querySelectorAll('.ktag[data-p="' + p + '"]')
    .forEach((e) => e.remove());
  for (const l of lines) {
    const deep = Math.max(...l.map((it) => it.deep));
    const mid = edge + (dir * deep) / 2;
    const lineLen = l.reduce((s, it) => s + it.along, 0) + GAP * (l.length - 1);
    const lo = across ? z.x0 : z.y0,
      hi = across ? z.x1 : z.y1;
    let pos = Math.max(lo, Math.min(hi - lineLen, centre - lineLen / 2));
    for (const it of l) {
      const c = pos + it.along / 2;
      pos += it.along + GAP;
      const bx = across ? c : mid,
        by = across ? mid : c;
      const cy = by;
      it.gr.els.forEach((el, i) => {
        const k = i - (it.gr.n - 1) / 2;
        el.style.transform = pileT(
          bx + k * it.d.off * it.sc,
          cy + it.gr.dy[i],
          it.gr.rot[i] * (it.gr.latest ? 0.5 : 1),
          0,
          it.sc * runtime.TS,
        );
      });
      if (it.tag) {
        const t = document.createElement('div');
        t.className = 'ktag' + (isBomb(it.gr.play) ? ' boom' : '');
        t.dataset.p = p;
        t.textContent =
          it.gr.play.type === 'bomb' ? `${it.gr.play.n}张炸弹` : TYPE_NAME[it.gr.play.type];
        t.style.left = bx + 'px';
        t.style.top = cy + (it.d.ch * it.sc) / 2 - 4 + 'px';
        t.style.zIndex = 5000;
        pileEl().appendChild(t);
      }
    }
    edge += dir * (deep + GAP);
  }
  return fits;
}

export function pileThrow(p, play, origins, animate) {
  const layer = pileEl(),
    g = pileGeo();
  // the previous play settles back, smaller
  const prev = runtime.pileGroups[runtime.pileGroups.length - 1];
  if (prev && prev.latest) {
    prev.latest = false;
    prev.els.forEach((el) => {
      el.classList.remove('cur');
      el.classList.add('old');
      el.style.transitionDelay = '0ms';
    });
    layer.querySelectorAll('.ktag').forEach((e) => e.remove());
  }
  const cards = displayOrder(play, runtime.game.L),
    n = cards.length,
    base = (Math.random() - 0.5) * 8;
  const gr = {
    p,
    play,
    n,
    els: [],
    latest: true,
    sc: BIG,
    rot: cards.map(() => base + (Math.random() - 0.5) * 4),
    dy: cards.map(() => (Math.random() - 0.5) * 4),
  };
  // a phone shows the cards straight away in their places, without the flight and the turn
  const anim = animate && !reduceMotion() && !isPhone();
  const seat = relPoint(seatPoint(p), g);
  cards.forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'pc cur ' + (isRedSeat(p) ? 'tr' : 'tb');
    el.innerHTML = cardHTML(c, runtime.game.L) + '<div class="bk"></div>';
    el.style.zIndex = ++runtime.pileZ;
    if (anim) {
      // your own cards leave your hand face up; everyone else's arrive face down and turn over in flight
      const o = origins && origins[c.id] ? relPoint(origins[c.id], g) : seat;
      el.style.transition = 'none';
      el.style.transform =
        p === 0 ? pileT(o.x, o.y, 0, 0, 1.4) : pileT(o.x, o.y, gr.rot[i] * 3, 180, 0.6);
      layer.appendChild(el);
      el.getBoundingClientRect();
      el.style.transition = '';
      el.style.transitionDelay = i * 30 + 'ms';
    } else {
      el.style.transition = 'none';
      layer.appendChild(el);
    }
    gr.els.push(el);
  });
  runtime.pileGroups.push(gr);
  // the newest play as large as the player's zone allows, and always clearly larger than the earlier plays; if even
  // its smallest size will not fit, the whole trick steps down in size and every player's line is laid out again
  // a phone gives every play of the trick one size, set when the trick opens; if a play does not fit, the whole trick
  // steps down together, so the cards on the table are never of different sizes
  if (isPhone()) {
    gr.sc = runtime.pileGroups.length > 1 ? runtime.pileGroups[0].sc : PHONE_SC;
    while ([0, 1, 2, 3].some((q) => !layoutPlayer(q, g, false)) && runtime.TS > minTS())
      runtime.TS = Math.max(minTS(), runtime.TS * 0.9);
  } else
    for (;;) {
      let ok = false;
      for (const sc of [BIG, 1.4, 1.3, 1.2, 1.1, 1]) {
        gr.sc = sc;
        if (layoutPlayer(p, g, false)) {
          ok = true;
          break;
        }
      }
      if (ok || runtime.TS <= minTS()) break;
      runtime.TS = Math.max(minTS(), runtime.TS * 0.9);
    }
  for (let q = 0; q < 4; q++) layoutPlayer(q, g, true);
  // cards put down without the flight appear right in their places, and only later moves slide
  if (!anim)
    gr.els.forEach((el) => {
      el.getBoundingClientRect();
      el.style.transition = '';
    });
}

function heapSpot(g) {
  const a = Math.random() * Math.PI * 2,
    r = Math.sqrt(Math.random()) * Math.min(HEAP_R, g.L.width * 0.05);
  return pileT(
    g.cx + Math.cos(a) * r,
    g.hy + Math.sin(a) * r * 0.7,
    Math.random() * 360,
    180,
    HEAP_SC,
  );
}

export function pileSweep() {
  const layer = pileEl(),
    g = pileGeo();
  runtime.pileGroups = [];
  runtime.TS = 1;
  layer.querySelectorAll('.ktag').forEach((e) => e.remove());
  // a phone keeps no heap, nor does 极简出牌区: the finished trick simply goes, with no turning over
  if (isPhone() || miniMode() || runtime.cardBack === 'none') {
    layer.querySelectorAll('.pc.cur,.pc.old').forEach((e) => e.remove());
    return;
  }
  layer.querySelectorAll('.pc.cur,.pc.old').forEach((el) => {
    el.classList.remove('cur', 'old');
    el.style.transitionDelay = ((Math.random() * 120) | 0) + 'ms';
    el.style.zIndex = ++runtime.heapZ;
    el.style.transform = heapSpot(g);
  });
}

// redraw the pile from state (page update or window resize), without animation
export function pileRebuild() {
  const layer = pileEl(),
    g = pileGeo();
  layer.querySelectorAll('.pc,.ktag').forEach((e) => e.remove());
  runtime.pileZ = 1000;
  runtime.heapZ = 1;
  runtime.pileGroups = [];
  runtime.TS = 1;
  for (
    let i = 0;
    i < (isPhone() || runtime.cardBack === 'none' ? 0 : runtime.game.heapN || 0);
    i++
  ) {
    const el = document.createElement('div');
    el.className = 'pc';
    el.innerHTML = '<div class="bk"></div>';
    el.style.zIndex = ++runtime.heapZ;
    el.style.transform = heapSpot(g);
    layer.appendChild(el);
  }
  for (const t of runtime.game.trickPlays || []) pileThrow(t.p, t.play, null, false);
  for (const r of runtime.game.rest || []) restLayout(r.p, r.cards, null, false);
}

// the end of a round: a player left holding cards (last place, or third and last in a double-down) lays them face up
// in front of their seat, sorted, in overlapping rows that each still show the corners of the row behind
export function showRest(p) {
  const cards = runtime.game.hands[p];
  if (!cards.length) return;
  let origins = null;
  if (p === 0) {
    origins = {};
    for (const c of cards) {
      const el = handEl.querySelector(`.card[data-id="${c.id}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        origins[c.id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
    }
  }
  const shown = sortHand(cards.slice(), runtime.game.L);
  (runtime.game.rest || (runtime.game.rest = [])).push({ p, cards: shown });
  runtime.game.hands[p] = [];
  render();
  restLayout(p, shown, origins, true);
}

function restLayout(p, cards, origins, animate) {
  const layer = pileEl(),
    g = pileGeo(),
    z = zoneFor(p, g),
    n = cards.length;
  // nothing else is on the table now, so the cards may spread wider than a play would: across the whole table for
  // you and your partner, up to the middle for the players at the sides
  if (p === 0 || p === 2) {
    z.x0 = g.left + PASS_X;
    z.x1 = g.right - PASS_X;
  } else if (p === 3) z.x1 = g.cx - GAP;
  else z.x0 = g.cx + GAP;
  // a narrow screen leaves no room beside a side player's plate (their place label takes it): their cards go
  // below the plate instead, reaching from the table's edge to the middle
  let under = false;
  if ((p === 1 || p === 3) && z.x1 - z.x0 < g.cw * 1.6) {
    const w = $('#seat' + p + ' .whorow').getBoundingClientRect();
    under = true;
    z.y0 = w.bottom - g.L.top + PASS_Y;
    z.y1 = g.bottom - PASS_Y;
    if (p === 3) {
      z.x0 = PASS_X;
      z.x1 = g.cx - GAP;
    } else {
      z.x0 = g.cx + GAP;
      z.x1 = g.L.width - PASS_X;
    }
  }
  const W = z.x1 - z.x0,
    H = z.y1 - z.y0;
  // the largest size at which the rows fit the player's part of the table
  let s, cw, ch, off, counts;
  for (s of [1.2, 1.1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4]) {
    cw = g.cw * s;
    ch = cw * runtime.CR;
    off = cw * 0.42;
    // rows of about equal length
    const rows = Math.ceil(n / Math.max(1, Math.floor((W - cw) / off) + 1)),
      per = Math.ceil(n / rows);
    counts = Array.from({ length: rows }, (_, r) => Math.min(per, n - r * per));
    if (ch + (rows - 1) * ch * runtime.ROW_STEP <= H) break;
  }
  const rowW = (k) => cw + off * (k - 1),
    widest = rowW(Math.max(...counts)),
    h = ch + (counts.length - 1) * ch * runtime.ROW_STEP;
  // right in front of the player: against the near edge of their part of the table
  const cx = p === 3 ? z.x0 + widest / 2 : p === 1 ? z.x1 - widest / 2 : (z.x0 + z.x1) / 2;
  const top =
    p === 2 || under
      ? z.y0
      : p === 0
        ? z.y1 - h
        : Math.max(z.y0, Math.min(z.y1 - h, g.sideY[p] - h / 2));
  const seat = relPoint(seatPoint(p), g),
    anim = animate && !reduceMotion() && !isPhone();
  let i = 0;
  counts.forEach((k, r) => {
    for (let j = 0; j < k; j++, i++) {
      const c = cards[i],
        el = document.createElement('div');
      el.className = 'pc rest ' + (isRedSeat(p) ? 'tr' : 'tb');
      el.innerHTML = cardHTML(c, runtime.game.L) + '<div class="bk"></div>';
      el.style.zIndex = ++runtime.pileZ;
      const to = pileT(
        cx - rowW(k) / 2 + cw / 2 + j * off,
        top + ch / 2 + r * ch * runtime.ROW_STEP,
        0,
        0,
        s,
      );
      if (anim) {
        const o = origins && origins[c.id] ? relPoint(origins[c.id], g) : seat;
        el.style.transition = 'none';
        el.style.transform =
          p === 0
            ? pileT(o.x, o.y, 0, 0, 1.4)
            : pileT(o.x, o.y, (Math.random() - 0.5) * 20, 180, 0.6);
        layer.appendChild(el);
        el.getBoundingClientRect();
        el.style.transition = '';
        el.style.transitionDelay = i * 25 + 'ms';
      } else layer.appendChild(el);
      el.style.transform = to;
    }
  });
}

// a place label only appears once the end-of-round reveal reaches it
export function showPlace(el, place) {
  const on = place >= 0 && place < (runtime.game.reveal || 0);
  el.textContent = on ? PLACE[place] : '';
  el.dataset.place = place;
}

// the rank sits in the middle of the disc by its ink, not by its type box (which would leave every figure a little
// low, and the tail of a Q or the hook of a J lower still)
export function centerRank() {
  const r = $('#curLv'),
    e = $('.emblem');
  r.style.translate = '';
  const er = e.getBoundingClientRect();
  if (!er.width) return;
  const cs = getComputedStyle(r),
    c = (centerRank.cv || (centerRank.cv = document.createElement('canvas'))).getContext('2d');
  c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const m = c.measureText(r.textContent),
    p = document.createElement('span');
  p.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
  r.appendChild(p);
  const base = p.getBoundingClientRect().top;
  p.remove();
  const rr = r.getBoundingClientRect();
  const dy =
    base + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2 - (er.top + er.height / 2);
  const dx =
    rr.left + (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2 - (er.left + er.width / 2);
  r.style.translate = `${(-dx).toFixed(1)}px ${(-dy).toFixed(1)}px`;
}

export function initialize() {
  /* ---------- the table pile: plays are thrown face up into the middle, a finished trick is turned face down onto the heap ---------- */
  runtime.pileZ = 1000;
  /* ---------- the table pile: plays are thrown face up into the middle, a finished trick is turned face down onto the heap ---------- */
  runtime.heapZ = 1;
  BIG = 1.5;
  PHONE_SC = 1.3;
  TRICK_HOLD_MS = 2200;
  trickHold = () =>
    TRICK_HOLD_MS +
    Math.min(
      3300,
      150 *
        Math.max(
          0,
          (runtime.game.trickPlays || []).reduce((s, t) => s + t.play.cards.length, 0) - 6,
        ),
    );
  pileEl = () => $('#pile');
  PASS_X = 12;
  PASS_Y = 10;
  OLD = 0.85;
  GAP = 10;
  runtime.phoneRefitAsked = false;
  if (window.ResizeObserver) new ResizeObserver(phoneRefit).observe($('#table'));
  pileT = (x, y, rot, flip, sc = 1) =>
    `perspective(800px) translate(${x}px,${y}px) rotate(${rot}deg) rotateY(${flip}deg) scale(${sc})`;
  runtime.pileGroups = [];
  runtime.TS = 1;
  MIN_TS_PC = 0.55;
  minTS = () => (isPhone() ? 0.3 : MIN_TS_PC);
  HEAP_R = 26;
  HEAP_SC = 0.7;
  if (document.fonts) document.fonts.ready.then(() => centerRank());
}
