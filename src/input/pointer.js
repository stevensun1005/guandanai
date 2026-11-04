import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { beats } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
import { isHumanSeat } from '../game/session.js';
import { sortHints } from '../hand/follow-hints.js';
import {
  drawFixZone,
  handGeo,
  handKeys,
  layoutHand,
  placeCard,
  tidyGroup,
} from '../hand/layout.js';
import { orderedHand, renderHand, vertMode } from '../hand/view.js';
import { onPlay } from './actions.js';
import { clearPicked } from './controls.js';
import { testDragMove, testDropMine, testGrouped } from '../replay/session.js';
import { $ } from '../ui/cards.js';
import { renderControls } from '../ui/table.js';

export let handEl;
export let cardEl;

// the cards a tap picks: the card's whole group if it is in one (made with 成组), else the card alone
function groupOf(id) {
  const gr = !runtime.reviewMode && (runtime.game.fixed || []).find((g) => g.includes(id));
  return gr ? gr.filter((x) => runtime.game.hands[0].some((c) => c.id === x)) : [id];
}

function setSel(id, on, lazy) {
  if (on) runtime.selection.add(id);
  else runtime.selection.delete(id);
  // a card being put back down waits out the double-tap window, so a double tap never dips it first
  const show = () => {
    const el = handEl.querySelector(`.card[data-id="${id}"]`);
    if (el) el.classList.toggle('sel', runtime.selection.has(id));
  };
  if (lazy && !on) setTimeout(show, 360);
  else show();
  renderControls();
}

// picking up a selected card carries the whole selection with it, so a combination can be moved as one block
function moveCards(e) {
  if (!runtime.mv.active) {
    if (Math.hypot(e.clientX - runtime.mv.x0, e.clientY - runtime.mv.y0) < 6) return;
    const all = [...handEl.children].map((c) => +c.dataset.id),
      fixed = new Set(runtime.game.fixed.flat()),
      ord = all.filter((i) => !fixed.has(i));
    runtime.mv.ids =
      runtime.selection.has(runtime.mv.id) && runtime.selection.size > 1
        ? all.filter((i) => runtime.selection.has(i))
        : [runtime.mv.id];
    runtime.mv.grab = runtime.mv.ids.indexOf(runtime.mv.id);
    runtime.mv.others = ord.filter((i) => !runtime.mv.ids.includes(i));
    runtime.mv.order = ord;
    // the active zone as it will be with the dragged cards dropped into it
    // (竖式 keeps every card in its rank's column, so there the others just close up without the dragged cards)
    runtime.mv.g = vertMode()
      ? handGeo(runtime.mv.others.length, handKeys(runtime.mv.others))
      : handGeo(runtime.mv.others.length + runtime.mv.ids.length, null);
    runtime.mv.rowOf = runtime.mv.g.counts.flatMap((k, r) => Array(k).fill(r));
    const L = handEl.getBoundingClientRect(),
      el = cardEl(runtime.mv.id);
    runtime.mv.dx = runtime.mv.x0 - L.left - parseFloat(el.style.left);
    runtime.mv.dy = runtime.mv.y0 - L.top - parseFloat(el.style.top);
    runtime.mv.ids.forEach((id, j) => {
      const c = cardEl(id);
      c.classList.add('drag');
      c.style.zIndex = 1000 + j;
    });
    runtime.mv.active = true;
    runtime.lastDown = null;
    drawFixZone(runtime.mv.g);
  }
  const L = handEl.getBoundingClientRect(),
    g = runtime.mv.g,
    k = runtime.mv.ids.length;
  const x = e.clientX - L.left - runtime.mv.dx,
    y = e.clientY - L.top - runtime.mv.dy;
  runtime.mv.ids.forEach((id, j) => {
    const c = cardEl(id);
    c.style.left = x + (j - runtime.mv.grab) * g.cw * 0.36 + 'px';
    c.style.top = y + 'px';
  });
  // over the fixed zone: on a group's cards they will join that group (its tag lights up); anywhere else in the zone
  // (beside the groups, on the tags) they make a new group
  const px = e.clientX - L.left,
    py = e.clientY - L.top,
    fz = $('#fixZone');
  if (g.inFix ? g.inFix(px, py) : px < g.fixEdge) {
    let row = -1;
    if (g.fixAt) row = g.fixAt(px, py);
    else
      g.fixTags.forEach((r, i) => {
        if (py >= r.y - 4 && py < r.y + g.ch && px < r.x - 5) row = i;
      });
    if (runtime.mv.t === 'fix' && runtime.mv.row === row) return;
    runtime.mv.t = 'fix';
    runtime.mv.row = row;
    runtime.mv.others.forEach((id, i) => placeCard(cardEl(id), g.slots[i], 100 + i));
    const lm = $('#landMark');
    if (lm) lm.remove();
    fz.classList.add('over');
    fz.querySelector('.fzl').textContent = row < 0 ? '放下成为新的一组' : '放下加入这一组';
    document
      .querySelectorAll('#fixTags .fzt')
      .forEach((t, i) => t.classList.toggle('hot', i === row));
    Sound.play('deal');
    return;
  }
  if (fz.classList.contains('over')) {
    fz.classList.remove('over');
    fz.querySelector('.fzl').textContent = '成组区';
    document.querySelectorAll('#fixTags .fzt').forEach((t) => t.classList.remove('hot'));
  }
  if (runtime.mv.t === 'fix') runtime.mv.t = null;
  // 竖式: dropped anywhere but the fixed zone, the cards go back to their columns (out of any group they were in)
  if (vertMode()) {
    if (runtime.mv.t !== 'vert') {
      runtime.mv.t = 'vert';
      runtime.mv.others.forEach((id, i) => placeCard(cardEl(id), g.slots[i], 100 + i));
    }
    return;
  }
  const cx = x + g.cw / 2,
    cy = y + g.ch / 2;
  let s = 0,
    best = Infinity;
  g.slots.forEach((sl, i) => {
    const d = (sl.x + g.cw / 2 - cx) ** 2 + ((sl.y + g.ch / 2 - cy) * 1.6) ** 2;
    if (d < best) {
      best = d;
      s = i;
    }
  });
  const t = Math.max(0, Math.min(g.slots.length - k, s - runtime.mv.grab));
  if (t === runtime.mv.t) return;
  runtime.mv.t = t;
  runtime.mv.order = [
    ...runtime.mv.others.slice(0, t),
    ...runtime.mv.ids,
    ...runtime.mv.others.slice(t),
  ];
  runtime.mv.order.forEach((id, i) => {
    if (!runtime.mv.ids.includes(id)) placeCard(cardEl(id), spreadSlot(i), 100 + i);
  });
  showLanding();
  Sound.play('deal');
}

// the cards in the landing row step aside, the nearest ones most, so a clear gap opens where the dragged cards will go
function spreadSlot(i) {
  const g = runtime.mv.g,
    t = runtime.mv.t,
    k = runtime.mv.ids.length,
    sl = g.slots[i],
    row = runtime.mv.rowOf[t];
  if (runtime.mv.rowOf[i] !== row) return sl;
  const d = i < t ? t - i : i - (t + k - 1),
    shift = g.cw * 0.45 * Math.max(0, 1 - (d - 1) / 4);
  return { ...sl, x: sl.x + (i < t ? -shift : shift) };
}

function showLanding() {
  const g = runtime.mv.g,
    a = g.slots[runtime.mv.t],
    b = g.slots[Math.min(g.slots.length - 1, runtime.mv.t + runtime.mv.ids.length - 1)];
  let m = $('#landMark');
  if (!m) {
    m = document.createElement('div');
    m.id = 'landMark';
    m.className = 'land';
    handEl.parentNode.insertBefore(m, handEl);
  }
  const w =
    (runtime.mv.rowOf[runtime.mv.t] === runtime.mv.rowOf[runtime.mv.t + runtime.mv.ids.length - 1]
      ? b.x - a.x
      : 0) + g.cw;
  m.style.left = handEl.offsetLeft + a.x + 'px';
  m.style.top = handEl.offsetTop + a.y + 'px';
  m.style.width = w + 'px';
  m.style.height = g.ch + 'px';
  m.style.transform = `rotate(${a.rot}deg)`;
}

function dropCards() {
  const m = runtime.mv;
  runtime.mv = null;
  const lm = $('#landMark');
  if (lm) lm.remove();
  if (!m.active) {
    if (!m.cancel) {
      const on = !runtime.selection.has(m.id);
      for (const id of groupOf(m.id)) setSel(id, on, true);
      Sound.play('select');
    }
    return;
  }
  if (m.test) {
    testDropMine(m);
    return;
  }
  if (!m.cancel) {
    if (m.t === 'fix') fixCards(m.ids, m.row);
    else if (m.t === 'vert') {
      const f = new Set(runtime.game.fixed.flat()),
        back = m.ids.filter((id) => f.has(id));
      if (back.length) unfixCards(back);
    } else if (m.t != null) {
      // dropped among the active cards: out of any group, and several cards land tidied as a combination reads
      unfixCards(m.ids);
      runtime.game.myOrder = m.order;
      if (m.ids.length > 1) {
        const tidy = tidyGroup(m.ids),
          at = runtime.game.myOrder.indexOf(m.ids[0]);
        const rest = runtime.game.myOrder.filter((id) => !m.ids.includes(id));
        runtime.game.myOrder = [...rest.slice(0, at), ...tidy, ...rest.slice(at)];
      }
    }
  }
  for (const id of m.ids) runtime.selection.delete(id);
  const z = $('#fixZone');
  if (z) z.classList.remove('over');
  if (m.dirty) renderHand();
  else reflowHand();
  Sound.play('play');
}

// the cards move to their new places without being rebuilt, so each one slides there; on your turn the hints follow
// the new zones
export function reflowHand() {
  for (const c of orderedHand()) {
    const el = cardEl(c.id);
    if (el) {
      el.classList.remove('drag');
      el.classList.toggle('sel', runtime.selection.has(c.id));
      handEl.appendChild(el);
    }
  }
  if (runtime.game.phase === 'play' && runtime.game.turn === 0 && isHumanSeat(0)) {
    const cur = runtime.game.trick ? runtime.game.trick.play : null;
    runtime.hints = sortHints(
      genPlays(runtime.game.hands[0], runtime.game.L).filter((pl) => beats(pl, cur)),
    );
    runtime.hintIdx = 0;
  }
  layoutHand();
  renderControls();
}

// cards set aside in the fixed zone: joining the group they were dropped on, or as a group of their own (tidied the way
// the combination reads); unfixCards puts cards back among the active ones, where they slot in by rank
export function fixCards(ids, row) {
  const target = row >= 0 ? runtime.game.fixed[row] : null;
  runtime.game.fixed = runtime.game.fixed.map((gr) =>
    gr === target ? gr : gr.filter((id) => !ids.includes(id)),
  );
  if (target) {
    const i = runtime.game.fixed.indexOf(target);
    runtime.game.fixed[i] = tidyGroup(target.filter((id) => !ids.includes(id)).concat(ids));
  } else runtime.game.fixed.push(tidyGroup(ids));
  runtime.game.fixed = runtime.game.fixed.filter((gr) => gr.length);
  runtime.game.myOrder = (runtime.game.myOrder || []).filter((id) => !ids.includes(id));
}

export function unfixCards(ids) {
  runtime.game.fixed = (runtime.game.fixed || [])
    .map((gr) => gr.filter((id) => !ids.includes(id)))
    .filter((gr) => gr.length);
  runtime.game.myOrder = (runtime.game.myOrder || []).filter((id) => !ids.includes(id));
}

export function initialize() {
  /* ---------- input ---------- */
  handEl = $('#hand');
  runtime.lastDown = null;
  runtime.mv = null;
  runtime.sweep = null;
  cardEl = (id) => handEl.querySelector(`.card[data-id="${id}"]`);
  handEl.addEventListener('pointerdown', (e) => {
    if (
      runtime.game.phase !== 'play' &&
      runtime.game.phase !== 'return' &&
      runtime.game.phase !== 'prep' &&
      runtime.game.phase !== 'tribPick'
    )
      return;
    // a tap on the hand's empty felt, beside or between the cards, puts every picked card back
    const el = e.target.closest('.card');
    if (!el) {
      if (e.target === handEl) clearPicked();
      return;
    }
    e.preventDefault();
    const id = +el.dataset.id,
      t = performance.now();
    if (runtime.lastDown && runtime.lastDown.id === id && t - runtime.lastDown.t < 350) {
      // double tap: undo the first tap's toggle, keep this card (or its whole group) in the selection, then play it
      // (paying or returning a tribute card is never done by a double tap: the card is picked and the button pressed)
      runtime.selection = new Set(runtime.lastDown.prev);
      for (const x of groupOf(id)) runtime.selection.add(x);
      runtime.lastDown = null;
      renderHand();
      if (runtime.game.phase === 'play') onPlay();
      return;
    }
    runtime.lastDown = { id, t, prev: [...runtime.selection] };
    // nothing happens until we know what the press is: a tap selects, a drag moves cards
    runtime.mv = { id, x0: e.clientX, y0: e.clientY, t0: t, active: false };
    try {
      handEl.setPointerCapture(e.pointerId);
    } catch (_) {}
  });
  handEl.addEventListener('pointermove', (e) => {
    // a press-and-sweep that starts on an unpicked card picks the cards it passes over; one that starts on a picked card
    // carries the picked cards (into the fixed zone, or to another place) - while sorting as much as while playing, so a
    // bomb or a run can be swept up and dragged into the fixed zone in one go
    if (
      runtime.mv &&
      !runtime.mv.active &&
      !runtime.selection.has(runtime.mv.id) &&
      !testGrouped()
    ) {
      if (Math.hypot(e.clientX - runtime.mv.x0, e.clientY - runtime.mv.y0) < 6) return;
      const id = runtime.mv.id,
        on = !runtime.selection.has(id),
        px = runtime.mv.x0,
        py = runtime.mv.y0;
      runtime.mv = null;
      runtime.lastDown = null;
      runtime.sweep = {
        on,
        seen: new Set([id]),
        last: [...handEl.children].findIndex((c) => +c.dataset.id === id),
        px,
        py,
      };
      setSel(id, on);
      Sound.play('select');
    }
    // the test version's groups: dragged onto another group to join it, or onto a gap to make one of their own
    if (runtime.mv) {
      if (testGrouped()) testDragMove(e);
      else moveCards(e);
      return;
    }
    if (!runtime.sweep) return;
    // 竖式: the hand's order runs down each column, so a sweep picks just the cards it passes over (looked up along the
    // way, as a fast sweep can skip some between two pointer events)
    if (vertMode()) {
      const k = Math.max(
        1,
        Math.ceil(Math.hypot(e.clientX - runtime.sweep.px, e.clientY - runtime.sweep.py) / 6),
      );
      for (let s = 1; s <= k; s++) {
        const t = document.elementFromPoint(
          runtime.sweep.px + ((e.clientX - runtime.sweep.px) * s) / k,
          runtime.sweep.py + ((e.clientY - runtime.sweep.py) * s) / k,
        );
        const el = t && t.closest('#hand .card'),
          id = el && +el.dataset.id;
        if (el && !runtime.sweep.seen.has(id)) {
          runtime.sweep.seen.add(id);
          setSel(id, runtime.sweep.on);
        }
      }
      runtime.sweep.px = e.clientX;
      runtime.sweep.py = e.clientY;
      return;
    }
    const t = document.elementFromPoint(e.clientX, e.clientY);
    const el = t && t.closest('#hand .card');
    if (!el) return;
    // a fast sweep can skip cards between two pointer events, so fill in everything between the last card and this one
    const kids = [...handEl.children],
      i = kids.indexOf(el);
    if (i < 0 || i === runtime.sweep.last) return;
    const step = i > runtime.sweep.last ? 1 : -1;
    for (let j = runtime.sweep.last + step; ; j += step) {
      const id = +kids[j].dataset.id;
      if (!runtime.sweep.seen.has(id)) {
        runtime.sweep.seen.add(id);
        setSel(id, runtime.sweep.on);
      }
      if (j === i) break;
    }
    runtime.sweep.last = i;
  });
  handEl.addEventListener('pointerup', () => {
    if (runtime.mv) dropCards();
    runtime.sweep = null;
  });
  handEl.addEventListener('pointercancel', () => {
    if (runtime.mv) {
      runtime.mv.cancel = true;
      dropCards();
    }
    runtime.sweep = null;
  });
}
