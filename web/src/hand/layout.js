import { runtime } from '../app/runtime.js';
import { TYPE_NAME, sortHand, val } from '../core/cards.js';
import { analyze, isBomb, strength } from '../core/combinations.js';
import { cmpVert, fanMode, renderHand, vertMode } from './view.js';
import { miniMode } from '../input/actions.js';
import { syncHandBtns } from '../input/controls.js';
import { handEl } from '../input/pointer.js';
import { practicePlays } from '../replay/inspector.js';
import { practiceGeo, practiceGrouped } from '../replay/session.js';
import { $, displayOrder } from '../ui/cards.js';
import { phoneRefit, pileRebuild, pileRefit } from '../ui/table-pile.js';
import { placeLastPlay, render } from '../ui/table.js';

export let sideBtns;
let BTN_GAP;
let SPOT_UP;
let actionInset;
let FIX_GAP;
let FIX_TAG;
let PHONE_MQ;
let COARSE_MQ;
let phoneDevice;
let heldSideways;
export let isPhone;
export let phoneRows;
let phoneSwitch;
export let handKeys;

export function handGeo(n, keys) {
  if (practiceGrouped()) return practiceGeo();
  if (isPhone()) return phoneHandGeo(n, keys);
  const el = $('#hand'),
    probe = el.firstElementChild,
    Wall = el.clientWidth;
  // the active cards stay centred under your name, with the action column's room kept free on both sides,
  // as long as the fixed zone fits in the free room on the left; a wider zone pushes them right
  if (sideBtns() && $('#btns').offsetWidth) runtime.colW = $('#btns').offsetWidth;
  const side = sideBtns()
    ? isPhone()
      ? runtime.colW + BTN_GAP
      : actionInset(Wall) + runtime.colW / 2 + BTN_GAP
    : 0;
  const cw = probe.offsetWidth,
    ch = probe.offsetHeight;
  // each group in one row, overlapping just enough to show every card's corner; a long group closes up
  // (in 竖式 each group stands as one column, its cards piled upward, and the next group is another column beside it, the
  // columns just far enough apart to show a rank and suit side by side)
  const vert = vertMode();
  const rows = ((runtime.game && runtime.game.fixed) || []).map((gr) => {
    if (vert)
      return {
        gr,
        cs: gr
          .map((id) => runtime.game.hands[0].find((x) => x.id === id))
          .filter(Boolean)
          .sort(cmpVert),
      };
    const k = gr.length,
      off = k > 1 ? Math.min(cw * 0.42, (Wall * 0.34 - cw) / (k - 1)) : 0;
    return { gr, off, w: cw + off * (k - 1) };
  });
  const vdx =
    vert && rows.length > 1
      ? Math.max(cw * 0.78, Math.min(cw * 1.08, (Wall * 0.34 - cw) / (rows.length - 1)))
      : 0;
  if (vert) rows.forEach((r) => (r.w = cw + vdx * (rows.length - 1)));
  // with no groups yet the zone is an empty frame: on a computer or tablet at least as wide as a group of three with
  // its tag (wider if the free room on the left allows, leaving the button its strip), a narrow strip on a phone,
  // where the button sits in the row under the hand
  const bw = 0; // (成组 stands beside 同花顺 now, so the frame keeps no strip for it)
  // while a round is played the zone only ever grows: it keeps the largest width and height it has had until the next
  // deal (or until the window or the cards change size), so it never shrinks as groups are played out
  // (on a phone the frame instead hugs the cards in it, and an empty one is just a narrow strip)
  const pk = `${runtime.game && runtime.game.round}|${Wall}|${cw}`;
  if (
    runtime.reviewMode ||
    isPhone() ||
    !runtime.game ||
    ['start', 'shuffle', 'cut', 'deal'].includes(runtime.game.phase) ||
    runtime.fixPeak.k !== pk
  )
    runtime.fixPeak = { k: pk, w: 0, h: 0 };
  const fw = (runtime.fixPeak.w = runtime.reviewMode
    ? 0
    : Math.max(
        runtime.fixPeak.w,
        rows.length
          ? Math.max(...rows.map((r) => r.w)) + FIX_TAG
          : isPhone()
            ? 60
            : side
              ? Math.max(Math.round(cw * 1.84 + FIX_TAG), Math.round(side - bw - FIX_GAP))
              : 30,
      ));
  // (the practice table has no fixed zone: its groups are made with 成组 and 拆开)
  const x0 = runtime.reviewMode ? side : Math.max(side, fw + bw + FIX_GAP),
    W = Wall - side - x0;
  // (while dealing there are no ranks to stack yet: 竖式 lays the cards out flat until they are all in)
  const g = fanMode()
    ? fanGeo(n, W, cw, ch, keys)
    : vertMode() && keys
      ? vertGeo(n, W, cw, ch, keys)
      : flatGeo(n, W, cw, ch, keys);
  g.slots = g.slots.map((sl) => ({ ...sl, x: sl.x + x0 }));
  // the groups step down like flat rows (each still shows its row of corners), closer together if there are many
  const lift = ch * 0.22,
    pad = 4,
    base = n ? g.height : 0;
  // 竖式 while playing: the hand area is only as tall as the cards left in it (and the groups still standing), so as cards
  // go out the name bar settles down and the table gains the room; while sorting it keeps its height so nothing jumps
  if (vert && runtime.game && runtime.game.phase === 'play') runtime.fixPeak.h = 0;
  let gap = ch * runtime.ROW_STEP,
    need = 0;
  g.fix = new Map();
  g.fixTags = [];
  if (vert && rows.length) {
    // the columns stand on the bottom, their cards closing up to fit the height the hand area already has (more cards
    // don't push the name bar up and squeeze the cards played on the table); only when even the closest won't fit does
    // the area grow. Each column's tag sits over its top.
    const TP = 25,
      most = Math.max(...rows.map((r) => r.cs.length));
    const dy =
      most > 1
        ? Math.max(
            ch * 0.25,
            Math.min(ch * 0.3, (Math.max(base, runtime.fixPeak.h) - TP - ch - 6) / (most - 1)),
          )
        : ch * 0.3;
    let z = 0;
    rows.forEach((r, i) => {
      const top = TP + (most - r.cs.length) * dy;
      r.cs.forEach((c, j) => g.fix.set(c.id, { x: i * vdx, y: top + j * dy, rot: 0, z: z++ }));
      g.fixTags.push({ x: i * vdx, y: top - TP, gr: r.gr });
    });
    need = TP + ch + (most - 1) * dy + 6;
    // a card dropped on a group's column joins that group, anywhere else in the zone it makes a new one
    g.fixAt = (px) =>
      rows.findIndex((r, i) => px >= i * vdx && px < i * vdx + (i < rows.length - 1 ? vdx : cw));
  } else {
    if (rows.length > 1)
      gap = Math.max(
        ch * 0.3,
        Math.min(gap, (Math.max(base, ch * 2.4) - lift - ch - pad) / (rows.length - 1)),
      );
    rows.forEach((r, i) => {
      const y = lift + i * gap;
      r.gr.forEach((id, j) => g.fix.set(id, { x: j * r.off, y, rot: 0 }));
      g.fixTags.push({ x: r.w + 5, y, gr: r.gr });
    });
    need = lift + ch + (rows.length - 1) * gap + 6;
  }
  // an empty frame stands as tall as the hand (never less than one card and its margin)
  g.fixH = runtime.fixPeak.h = runtime.reviewMode
    ? 0
    : Math.max(runtime.fixPeak.h, rows.length ? need : Math.max(base, ch + 20));
  g.fixW = fw;
  g.cw = cw;
  g.ch = ch;
  g.fixEmpty = !rows.length;
  g.fixEdge = fw + bw / 2 + FIX_GAP / 2;
  g.height = Math.max(base, g.fixH + (rows.length && !vert ? pad : 0));
  // 竖式 stands on the hand area's bottom edge: when cards leave (played, or into the fixed zone) the area keeps its
  // height, and the columns stay down on the bottom row rather than floating up
  if (g.vert) {
    const d = g.height - base;
    g.slots.forEach((sl) => {
      sl.y += d;
    });
  }
  // (and so do the groups' columns, in a frame as tall as the area)
  if (vert && rows.length) {
    const d = g.height - need;
    g.fix.forEach((s) => {
      s.y += d;
    });
    g.fixTags.forEach((t) => {
      t.y += d;
    });
    g.fixH = g.height;
  }
  return g;
}

// the fixed zone's outline (behind the cards) and, beside each group, what kind of play it makes (over them);
// the outline also shows while cards are being dragged, as the place to drop them
export function drawFixZone(g) {
  let z = $('#fixZone'),
    t = $('#fixTags');
  if (!z) {
    z = document.createElement('div');
    z.id = 'fixZone';
    handEl.parentNode.insertBefore(z, handEl);
    t = document.createElement('div');
    t.id = 'fixTags';
    handEl.parentNode.insertBefore(t, handEl.nextSibling);
  }
  const on = !!g;
  z.hidden = t.hidden = $('#fixBtn').hidden = !on;
  if (!on) {
    if (runtime.reviewMode && ['play', 'roundEnd', 'over'].includes(runtime.game?.phase))
      $('#undoBtn').hidden = false;
    return;
  }
  if (runtime.reviewMode && !g.test) {
    z.hidden = t.hidden = true;
    for (const id of ['#fixBtn', '#splitBtn', '#sortBtn', '#undoBtn']) {
      const b = $(id);
      if (b) b.hidden = true;
    }
    return;
  }
  for (const id of ['#splitBtn', '#sortBtn', '#undoBtn']) {
    const b = $(id);
    if (b) b.hidden = false;
  }
  // Practice controls have a fixed viewport dock, independent of the remaining hand.
  if (g.test) {
    z.hidden = t.hidden = true;
    return;
  }
  const L = handEl.offsetLeft,
    T = handEl.offsetTop;
  z.style.left = L - 6 + 'px';
  z.style.top = T + 'px';
  z.style.width = g.fixW + 6 + 'px';
  z.style.height = (g.fixH || handEl.offsetHeight) + 'px';
  z.classList.toggle('empty', g.fixEmpty);
  z.innerHTML =
    `<span class="fzl">成组区</span>` +
    (g.fixEmpty ? '<span class="fzh">把牌拖到这里，或选好牌点“成组”</span>' : '');
  t.style.left = L + 'px';
  t.style.top = T + 'px';
  // the button by the frame's bottom right corner (on a phone it stays in the row under the hand)
  const b = $('#fixBtn'),
    tb = b.parentNode;
  b.style.left = b.style.top = '';
  t.innerHTML = g.fixTags
    .map((r) => {
      const cards = r.gr
        .map((id) => runtime.game.hands[0].find((c) => c.id === id))
        .filter(Boolean);
      const a = analyze(cards, runtime.game.L).sort((x, y) => strength(y) - strength(x))[0];
      const name = !a ? '散牌' : a.type === 'bomb' ? '炸弹' : TYPE_NAME[a.type];
      return `<span class="fzt${!a ? ' loose' : isBomb(a) ? ' boom' : ''}" style="left:${r.x}px;top:${r.y + 3}px">${name}</span>`;
    })
    .join('');
}

export function syncPhone() {
  const on = isPhone(),
    el = document.documentElement;
  el.classList.toggle('phone', on);
  el.classList.toggle('rows', phoneRows());
  el.classList.toggle('side', on && !phoneRows());
  // 成组 stands beside 同花顺; in the practice table it stays at the left end of the hand tools
  const fb = $('#fixBtn');
  if (!runtime.reviewMode && fb.previousElementSibling !== $('#sfBtn')) {
    $('#sfBtn').after(fb);
    fb.style.left = fb.style.top = '';
  } else if (runtime.reviewMode && fb.parentNode !== $('.handtools')) $('.handtools').prepend(fb);
  runtime.CR = on ? 0.86 : 1.4;
  runtime.ROW_STEP = on ? 0.92 : 0.58;
}

// flat rows of about equal length, the player's choice of one to three; a single row too cramped to read becomes two
// a phone's hand: the groups made with 成组 come first, each kept together, from the left of the first row, then the
// other cards, a small gap after each group; in as few rows as keep every card's rank and suit in view - at most three
// upright, two on its side, closing the cards up if they must - and clear of the play buttons at the right
function phoneHandGeo(n, keys) {
  const el = $('#hand'),
    probe = el.firstElementChild,
    Wall = el.clientWidth,
    cw = probe.offsetWidth,
    ch = probe.offsetHeight;
  // (on its side the hand always takes two rows, each card the easier to read)
  const b = $('#btns'),
    W = Wall - (b.hidden ? 0 : b.offsetWidth + 8),
    maxRows = phoneRows() ? 3 : 2,
    cap = phoneRows()
      ? Infinity
      : Math.ceil((n + ((runtime.game && runtime.game.fixed) || []).flat().length) / 2);
  const lift = Math.round(ch * 0.22),
    rowGap = Math.round(ch * runtime.ROW_STEP),
    gapW = Math.round(cw * 0.3);
  const groups = (runtime.game && runtime.game.fixed) || [],
    seq = [];
  groups.forEach((gr) => gr.forEach((id, j) => seq.push({ id, start: j === 0, len: gr.length })));
  for (let i = 0; i < n; i++) seq.push({ id: null, start: i === 0 && seq.length > 0, len: n });
  const fill = (off) => {
    let x = 0,
      r = 0,
      k = 0;
    const pos = [];
    for (const it of seq) {
      // the first row stops at half the cards on its side (a group is not broken for it)
      if (
        r === 0 &&
        x > 0 &&
        (it.id == null || it.start) &&
        k + (it.id != null && it.start ? it.len : 1) > cap
      ) {
        x = 0;
        r++;
      } else if (it.start && x > 0) {
        // a group moves to the next row whole rather than breaking (the other cards may run on)
        const need = it.id != null ? cw + off * (it.len - 1) : cw;
        if (x + gapW + need > W) {
          x = 0;
          r++;
        } else x += gapW;
      } else if (x > 0 && x + cw > W) {
        x = 0;
        r++;
      }
      pos.push({ x, r });
      x += off;
      k++;
    }
    return { pos, rows: r + 1 };
  };
  let best = null;
  for (let R = 1; R <= maxRows && !best; R++)
    for (let f = 0.5; f >= 0.399; f -= 0.02) {
      const t = fill(cw * f);
      if (t.rows <= R) {
        best = t;
        break;
      }
    }
  if (!best)
    for (let f = 0.38; ; f -= 0.02) {
      const t = fill(cw * f);
      if (t.rows <= maxRows || f < 0.21) {
        best = t;
        break;
      }
    }
  const fix = new Map(),
    slots = [],
    counts = Array(best.rows).fill(0);
  best.pos.forEach((q, i) => {
    const sl = { x: q.x, y: lift + q.r * rowGap, rot: 0 };
    if (seq[i].id != null) fix.set(seq[i].id, sl);
    else {
      slots.push(sl);
      counts[q.r]++;
    }
  });
  runtime.flatShown = best.rows;
  runtime.flatOneFits = true;
  return {
    slots,
    fix,
    fixTags: [],
    fixW: 0,
    fixH: 0,
    cw,
    ch,
    counts,
    fixEmpty: true,
    fixEdge: -1,
    inFix: () => false,
    height: lift + ch + (best.rows - 1) * rowGap + 4,
  };
}

function flatGeo(n, W, cw, ch, keys) {
  let rows = Math.max(1, Math.min(runtime.reviewMode ? 3 : runtime.flatRows, Math.ceil(n / 5)));
  runtime.flatOneFits = !(n > 12 && (W - cw) / (n - 1) < cw * 0.36);
  if (rows === 1 && !runtime.flatOneFits) rows = 2;
  runtime.flatShown = rows;
  const counts = rowCounts(n, keys, rows, [1, 1, 1].slice(0, rows), false);
  const most = Math.max(...counts);
  const off = Math.min(most > 1 ? (W - cw) / (most - 1) : 0, cw * 0.5);
  // each row steps down far enough that the row behind still shows its whole corner: rank and suit
  const lift = Math.round(ch * 0.22),
    rowGap = Math.round(ch * runtime.ROW_STEP);
  const slots = [];
  counts.forEach((k, r) => {
    for (let j = 0; j < k; j++)
      slots.push({ x: (W - (cw + off * (k - 1))) / 2 + j * off, y: lift + r * rowGap, rot: 0 });
  });
  return { slots, cw, ch, counts, height: lift + ch + (counts.length - 1) * rowGap + 4 };
}

// 竖式: one column per rank, side by side (apart if there is room, else overlapping but every corner in view); every
// column stands on the same bottom row and piles upward, each card behind showing its rank and suit above the one in
// front, closer together in a tall column so the hand stays low
function vertGeo(n, W, cw, ch, keys) {
  const cols = [];
  for (let i = 0; i < n; i++) {
    if (!i || keys[i] !== keys[i - 1]) cols.push(0);
    cols[cols.length - 1]++;
  }
  const C = cols.length,
    most = Math.max(1, ...cols);
  const dx = C > 1 ? Math.min(cw * 1.08, (W - cw) / (C - 1)) : 0;
  const dy = most > 1 ? Math.max(ch * 0.25, Math.min(ch * 0.3, (ch * 1.2) / (most - 1))) : 0;
  const lift = Math.round(ch * 0.22),
    x0 = (W - (cw + dx * (C - 1))) / 2;
  const slots = [];
  cols.forEach((k, c) => {
    for (let j = 0; j < k; j++)
      slots.push({ x: x0 + c * dx, y: lift + (most - k + j) * dy, rot: 0 });
  });
  return { slots, cw, ch, counts: [n], vert: true, height: lift + ch + (most - 1) * dy + 4 };
}

// cards held the way people hold 27 of them: two or three concentric fanned rows turning about one point below the hand.
// The back (top) ring is the widest and holds the most cards; each ring in front is smaller and holds fewer,
// and only the corners of a ring show above the one in front of it.
// how many cards go in each ring, back to front: close to 5:4:3 (or 5:4), cut only where the rank changes so a run
// of equal cards always stays in one ring, and preferring splits where each ring holds no more than the one behind it
function rowCounts(n, keys, rows, w, decreasing) {
  if (rows <= 1) return [n];
  const sum = w.reduce((a, b) => a + b, 0);
  const ideal = w.map((x) => (n * x) / sum);
  const edges = [];
  for (let b = 1; b < n; b++) if (!keys || keys[b] !== keys[b - 1]) edges.push(b);
  const cost = (c) => {
    let e = 0;
    c.forEach((k, r) => {
      e += Math.abs(k - ideal[r]);
      if (decreasing && r && k > c[r - 1]) e += 3 * (k - c[r - 1]);
    });
    return e;
  };
  let best = [n],
    bestE = Infinity;
  if (rows === 2) {
    for (const a of edges) {
      const c = [a, n - a],
        e = cost(c);
      if (e < bestE) {
        bestE = e;
        best = c;
      }
    }
  } else {
    for (const a of edges)
      for (const b of edges) {
        if (b <= a) continue;
        const c = [a, b - a, n - b],
          e = cost(c);
        if (e < bestE) {
          bestE = e;
          best = c;
        }
      }
  }
  return best;
}

function fanGeo(n, W, cw, ch, keys) {
  const rows = Math.max(1, Math.min(runtime.handRows, Math.ceil(n / 10)));
  const counts = rowCounts(n, keys, rows, [5, 4, 3].slice(0, rows), true);
  const rowGap = ch * runtime.ROW_STEP,
    lift = ch * 0.2;
  // radius at the back ring's top edge, and one angular step shared by every ring
  let r0 = ch * 2.6;
  const step = counts[0] > 1 ? Math.min((cw * 0.6) / r0, 1.2 / (counts[0] - 1)) : 0;
  const wide = 2 * r0 * Math.sin((step * (counts[0] - 1)) / 2) + cw;
  if (wide > W * 0.94) r0 *= (W * 0.94 - cw) / (wide - cw);
  const raw = [];
  let i = 0;
  counts.forEach((k, r) => {
    const rTop = r0 - r * rowGap,
      rc = rTop - ch / 2;
    // smaller rings open up a little so their corners stay readable
    const st = Math.max(step, (cw * 0.42) / rTop);
    for (let j = 0; j < k; j++, i++) {
      const th = (j - (k - 1) / 2) * st;
      raw.push({
        cx: W / 2 + rc * Math.sin(th),
        cy: -rc * Math.cos(th),
        rot: (th * 180) / Math.PI,
      });
    }
  });
  const top = Math.min(...raw.map((s) => s.cy));
  const slots = raw.map((s) => ({ x: s.cx - cw / 2, y: s.cy - top + lift, rot: s.rot }));
  return { slots, cw, ch, counts, height: Math.max(...slots.map((s) => s.y)) + ch + cw * 0.25 };
}

function cardKey(id) {
  const c = runtime.game.hands[0].find((x) => x.id === id);
  return c ? val(c, runtime.game.L) : 0;
}

// a dragged group lands tidied: if it makes a combination it is laid out the way that combination reads
// (a straight runs low to high), otherwise it is sorted by rank
export function tidyGroup(ids) {
  const cards = ids.map((id) => runtime.game.hands[0].find((c) => c.id === id)).filter(Boolean);
  const reads = analyze(cards, runtime.game.L).sort((a, b) => strength(b) - strength(a));
  const out = reads.length
    ? displayOrder({ ...reads[0], cards }, runtime.game.L)
    : sortHand(cards.slice(), runtime.game.L);
  return out.map((c) => c.id);
}

export function placeCard(c, slot, i) {
  const fresh = !c.style.left;
  if (fresh) c.style.transition = 'none';
  c.style.left = slot.x + 'px';
  c.style.top = slot.y + 'px';
  c.style.zIndex = i;
  c.style.setProperty('--rot', slot.rot.toFixed(2) + 'deg');
  if (fresh) {
    c.getBoundingClientRect();
    c.style.transition = '';
  }
}

export function layoutHand() {
  phoneRefit();
  const el = $('#hand'),
    cards = [...el.children],
    n = cards.length;
  el.classList.toggle('fan', fanMode());
  el.classList.toggle('vert', vertMode());
  // while dealing, each card goes straight into its slot in a full 27-card hand,
  // so cards already dealt never shift and the hand's height (and the table above it) stays put
  const dealing =
    runtime.game &&
    (runtime.game.phase === 'deal' ||
      runtime.game.phase === 'shuffle' ||
      runtime.game.phase === 'cut');
  if (!n && !dealing) {
    if (!(runtime.reviewMode && ['play', 'roundEnd', 'over'].includes(runtime.game.phase)))
      el.style.height = '';
    drawFixZone(null);
    placeActionBtns();
    return;
  }
  let probe = null;
  if (!n) {
    probe = document.createElement('div');
    probe.className = 'card';
    probe.style.visibility = 'hidden';
    el.appendChild(probe);
  }
  const fixed = new Set((runtime.game.fixed || []).flat()),
    act = cards.filter((c) => !fixed.has(+c.dataset.id));
  const g = handGeo(
    dealing ? 27 : act.length,
    dealing ? null : handKeys(act.map((c) => +c.dataset.id)),
  );
  if (runtime.reviewMode && ['play', 'roundEnd', 'over'].includes(runtime.game.phase)) {
    const key = [runtime.game.round, innerWidth, innerHeight].join('|');
    if (runtime.practiceHandSize?.key !== key) runtime.practiceHandSize = { key, height: g.height };
    g.height = Math.max(g.height, runtime.practiceHandSize.height);
  } else runtime.practiceHandSize = null;
  if (probe) probe.remove();
  act.forEach((c, i) => placeCard(c, g.slots[i], 100 + i));
  cards
    .filter((c) => fixed.has(+c.dataset.id))
    .forEach((c, i) => {
      const s = g.fix.get(+c.dataset.id);
      placeCard(c, s, s.z ?? i);
    });
  // a phone marks the cards of its groups with a gold edge along the top
  cards.forEach((c) => c.classList.toggle('grp', isPhone() && fixed.has(+c.dataset.id)));
  el.style.height = g.height + 'px';
  drawFixZone(g);
  placeLastPlay();
  placeButtons(g);
  syncHandBtns();
  // (the hand's height moves the table's lower edge, and the box of plays with it)
  if (!runtime.reviewMode && miniMode()) practicePlays();
}

// the button column hugs the right edge of the cards, centred on the hand's height
function placeButtons(g) {
  const b = $('#btns');
  if (!sideBtns()) b.style.left = b.style.top = '';
  // also after turning a phone from sideways to upright, so the big buttons leave their desktop spot
  placeActionBtns();
}

// one action spot for the buttons pressed again and again: shuffle / cut, "done sorting", tribute / return, the hint
// button while playing, and next round. It is measured up from the bottom of the hand area, so it stays put whether
// or not the hand has been dealt; phones keep their own places
export function placeActionBtns() {
  const on = sideBtns(),
    h = $('#hand').getBoundingClientRect();
  // what a phone's layouts set is undone when the screen is no longer one
  {
    const b = $('#btns');
    if (!phoneRows()) b.style.bottom = '';
    if (!(on && isPhone())) b.style.columnGap = '';
  }
  // the practice table's side hands fill the table's sides, so the buttons stand in a row beside your hand instead
  if (runtime.reviewMode) {
    if (!$('#goBtn')) return; // Practice initialization lays out the table before adding its controls.
    const size = getComputedStyle($('#goBtn')),
      width = parseFloat(size.width),
      height = parseFloat(size.height),
      gap = 6,
      left = innerWidth - 16 - width * 3 - gap * 2,
      top = innerHeight - 16 - height * 3 - gap * 2;
    const slots = [
      'fixBtn',
      'splitBtn',
      'sortBtn',
      'undoBtn',
      'hintBtn',
      'clearBtn',
      'playBtn',
      'passBtn',
      'goBtn',
    ];
    for (const [slot, id] of [
      ...slots.entries(),
      [6, 'returnBtn'],
      [8, 'deckBtn'],
      [8, 'readyBtn'],
      [8, 'nextBtn'],
    ]) {
      const e = $('#' + id);
      if (!e) continue;
      if (slot === 8 && id !== 'goBtn') e.classList.add('atcol');
      e.style.left = left + (slot % 3) * (width + gap) + 'px';
      e.style.top = top + Math.floor(slot / 3) * (height + gap) + 'px';
      e.style.transform = 'none';
    }
    return;
  }
  // a phone on its side: the play buttons two by two, their right edge on 复原's and standing just over it
  if (on && isPhone()) {
    const b = $('#btns'),
      w = $('.handwrap').getBoundingClientRect(),
      s = $('#sortBtn').getBoundingClientRect();
    b.style.left = s.right - w.left - b.offsetWidth + 'px';
    const top = s.top - w.top - 6 - b.offsetHeight + 'px';
    if (b.style.top !== top) {
      b.style.top = top;
      if (runtime.pileGroups.length && !b.hidden) pileRefit();
    }
  } else if (on) {
    // the column is placed so its tribute / return button, or else its hint button, stands on the spot
    const b = $('#btns'),
      rb = $('#returnBtn'),
      anchor = rb.hidden ? $('#hintBtn') : rb;
    // in a short window the buttons above the spot could reach the right-hand player's plate: they get smaller
    // (never below 48px) so the column stays clear of it
    const s1 = $('#seat1 .whorow').getBoundingClientRect(),
      cx = h.right - actionInset(h.width),
      gap = 8;
    const above = [...b.children]
      .slice(0, [...b.children].indexOf(anchor))
      .filter((e) => !e.hidden).length;
    let d = 68;
    if (s1.left < cx + d / 2 && s1.right > cx - d / 2) {
      const room = h.bottom - SPOT_UP - (s1.bottom + gap);
      d = Math.max(48, Math.min(68, Math.floor((room - above * gap) / (above + 0.5))));
    }
    if (b.style.getPropertyValue('--d') !== d + 'px') b.style.setProperty('--d', d + 'px');
    b.style.left = h.width - actionInset(h.width) - (b.offsetWidth || runtime.colW) / 2 + 'px';
    const top = h.height - SPOT_UP - anchor.offsetTop - anchor.offsetHeight / 2 + 'px';
    // the column moved (the hand got shorter): the table's cards make way for it again
    if (b.style.top !== top) {
      b.style.top = top;
      if (runtime.pileGroups.length && !b.hidden) pileRefit();
    }
  } else {
    const b = $('#btns');
    b.style.removeProperty('--d');
    // an upright phone: the row of buttons stands just over the hand tools
    b.style.bottom = phoneRows() ? $('.handtools').offsetHeight + 6 + 'px' : '';
    if (!phoneRows()) b.style.left = b.style.top = '';
  }
  for (const id of ['#deckBtn', '#readyBtn', '#nextBtn']) {
    const e = $(id);
    if (!e) continue;
    e.classList.toggle('atcol', on);
    if (!on) {
      e.style.left = e.style.top = '';
      continue;
    }
    e.style.left = h.right - actionInset(h.width) + 'px';
    // while sorting you may also owe a return: 还贡 then takes the spot and 理牌结束 stands just above it
    e.style.top =
      h.bottom -
      SPOT_UP -
      (id === '#readyBtn' && !$('#returnBtn').hidden && !$('#btns').hidden ? 120 : 0) +
      'px';
  }
}

export function initialize() {
  sideBtns = () => matchMedia('(min-width:561px)').matches;
  BTN_GAP = 18;
  runtime.colW = 90;
  SPOT_UP = 226;
  actionInset = (w) => Math.min(150, Math.max(runtime.colW / 2 + 16, w * 0.12));
  FIX_GAP = 14;
  FIX_TAG = 46;
  runtime.fixPeak = { k: '', w: 0, h: 0 };
  runtime.ROW_STEP = 0.58;
  runtime.CR = 1.4;
  PHONE_MQ = matchMedia('(max-width:560px)');
  COARSE_MQ = matchMedia('(pointer: coarse)');
  phoneDevice = () => COARSE_MQ.matches && Math.min(screen.width, screen.height) <= 500;
  heldSideways = () =>
    screen.orientation && screen.orientation.type
      ? screen.orientation.type.startsWith('landscape')
      : typeof window.orientation === 'number'
        ? Math.abs(window.orientation) === 90
        : innerWidth > innerHeight;
  isPhone = () => !runtime.reviewMode && (PHONE_MQ.matches || phoneDevice());
  // each turn clock stands beside its plate, never inside it (so the plate keeps its size): after the plate, or before
  // it for the right-hand player, whose plate is on the right of its row
  for (const q of [1, 2, 3]) {
    const w = $('#seat' + q + ' .who'),
      c = w.querySelector('.clock');
    if (q === 1) w.before(c);
    else w.after(c);
  }
  $('#mebar .meinfo').after($('#myClock'));
  phoneRows = () => isPhone() && (phoneDevice() ? !heldSideways() : innerHeight > innerWidth);
  syncPhone();
  phoneSwitch = () => {
    const was = document.documentElement.className;
    syncPhone();
    if (document.documentElement.className !== was && runtime.game) {
      renderHand();
      render();
      pileRebuild();
    }
  };
  addEventListener('resize', phoneSwitch);
  addEventListener('orientationchange', phoneSwitch);
  PHONE_MQ.addEventListener('change', phoneSwitch);
  handKeys = (ids) => ids.map(cardKey);
}
