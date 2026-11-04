import { runtime } from '../app/runtime.js';
import { cmpCards, sortHand, val } from '../core/cards.js';
import { isPhone, layoutHand } from './layout.js';
import { testArrangeMine, testGrouped, testMine } from '../replay/session.js';
import { $, cardHTML } from '../ui/cards.js';
import { renderControls } from '../ui/table.js';

let VERT_SUIT;
export let cmpVert;
export let fanMode;
export let vertMode;
export let arrivals;
let ARRIVE_MS;

export function orderedHand() {
  const h = runtime.game.hands[0],
    byId = new Map(h.map((c) => [c.id, c]));
  runtime.game.fixed = (runtime.game.fixed || [])
    .map((gr) => gr.filter((id) => byId.has(id)))
    .filter((gr) => gr.length);
  const fixed = new Set(runtime.game.fixed.flat()),
    act = h.filter((c) => !fixed.has(c.id));
  const ord = (runtime.game.myOrder || []).filter((id) => byId.has(id) && !fixed.has(id));
  if (ord.length !== act.length) {
    const have = new Set(ord);
    for (const c of sortHand(act, runtime.game.L)) {
      if (have.has(c.id)) continue;
      const i = ord.findIndex((id) => cmpCards(byId.get(id), c, runtime.game.L) > 0);
      if (i < 0) ord.push(c.id);
      else ord.splice(i, 0, c.id);
    }
  }
  runtime.game.myOrder = ord;
  // the test version keeps every card in a group: a card that arrives (a tribute or return) is a group of its own
  if (testGrouped() && ord.length) {
    runtime.game.fixed.push(...ord.map((id) => [id]));
    runtime.game.myOrder = [];
    return runtime.game.fixed.flat().map((id) => byId.get(id));
  }
  // 竖式 shows the active cards rank by rank, each rank's cards top to bottom by suit; the player's own order is kept
  // for the other layouts
  if (vertMode())
    return runtime.game.fixed
      .flat()
      .map((id) => byId.get(id))
      .concat(act.sort(cmpVert));
  return runtime.game.fixed
    .flat()
    .concat(ord)
    .map((id) => byId.get(id));
}

export function renderHand() {
  if (runtime.mv && runtime.mv.active) {
    runtime.mv.dirty = true;
    return;
  } // never rebuild the hand under a card being dragged
  if (runtime.reviewMode) testArrangeMine();
  const el = $('#hand'),
    now = performance.now();
  const fresh = new Set(runtime.game.fresh);
  for (const [id, t] of arrivals) if (now - t > ARRIVE_MS) arrivals.delete(id);
  el.innerHTML = orderedHand()
    .map((c) =>
      cardHTML(
        c,
        runtime.game.L,
        (runtime.selection.has(c.id) ? 'sel ' : '') +
          (fresh.has(c.id) ? 'fresh ' : '') +
          (arrivals.has(c.id) ? 'arrive' : ''),
      ),
    )
    .join('');
  // a rebuilt hand picks the flashing up where it had got to, rather than starting it again
  for (const [id, t] of arrivals) {
    const c = el.querySelector(`.card[data-id="${id}"]`);
    if (c) c.style.animationDelay = -(now - t) + 'ms';
  }
  layoutHand();
  renderControls();
  if (runtime.reviewMode) testMine();
}

export function initialize() {
  // 竖式: ranks from big to small like the sorted hand; a rank's column is stacked up from the bottom 红心, 黑桃, 方块,
  // 梅花 (the wild, a 红心, at the bottom), so it runs 梅花 first, from the top, down to 红心 in front
  VERT_SUIT = { H: 0, S: 1, D: 2, C: 3, J: 4 };
  cmpVert = (a, b) =>
    val(b, runtime.game.L) - val(a, runtime.game.L) ||
    VERT_SUIT[b.s] - VERT_SUIT[a.s] ||
    b.id - a.id;
  runtime.handView = 'fan';
  runtime.handRows = 3;
  runtime.flatRows = 1;
  runtime.flatShown = 1;
  runtime.flatOneFits = true;
  try {
    runtime.handView = localStorage.getItem('guandan-view') || 'fan';
    runtime.handRows = +localStorage.getItem('guandan-rows') || 3;
    runtime.flatRows = +localStorage.getItem('guandan-flatrows') || 1;
  } catch (_) {}
  fanMode = () => !runtime.reviewMode && !isPhone() && runtime.handView === 'fan';
  vertMode = () => !runtime.reviewMode && !isPhone() && runtime.handView === 'vert';
  arrivals = new Map();
  ARRIVE_MS = 4000;
}
