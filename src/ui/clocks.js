import { runtime } from '../app/runtime.js';
import { HURRY_MS } from '../game/clock.js';
import { startTurn } from '../game/turns.js';
import { isPhone } from '../hand/layout.js';
import { $ } from './cards.js';
import { pileGeo } from './table-pile.js';
import { phoneSignTop, syncTribBox } from './table.js';

function placePrepBig() {
  const T = $('#table').getBoundingClientRect(),
    e = $('.emblem').getBoundingClientRect();
  const l = $('#prepL'),
    r = $('#prepR'),
    lw = l.offsetWidth,
    rw = r.offsetWidth;
  const cy = e.top + e.height / 2 - T.top,
    h = Math.max(l.offsetHeight, r.offsetHeight),
    w = lw + rw + 12;
  // the sign and the clock stand side by side, close together, in the middle of the table
  let lx = e.left + e.width / 2 - w / 2,
    rx = lx + lw + 12,
    y = cy;
  // the test version's face-up hands take the room around the disc: the two sit together in the middle of the open table
  if (runtime.reviewMode) {
    const g = pileGeo(),
      w = lw + rw + 12;
    l.style.left = g.cx - w / 2 + 'px';
    r.style.left = g.cx - w / 2 + lw + 12 + 'px';
    l.style.top = g.cy - l.offsetHeight / 2 + 'px';
    r.style.top = g.cy - r.offsetHeight / 2 + 'px';
    return;
  }
  // a phone's box of who paid whom stands over the sign, under your partner's plate: where the two do not fit there
  // (a short screen) the sign steps down to make room
  const tb = $('#tribBox');
  if (isPhone() && tb && !tb.hidden)
    y = Math.max(y, phoneSignTop() + tb.offsetHeight + 8 - T.top + h / 2);
  l.style.left = lx - T.left + 'px';
  r.style.left = rx - T.left + 'px';
  l.style.top = y - l.offsetHeight / 2 + 'px';
  r.style.top = y - r.offsetHeight / 2 + 'px';
  syncTribBox();
}

// the test version's step: after a move the game waits here; the next turn begins with the space bar or 继续
export function testStepGo() {
  if (
    !runtime.reviewMode ||
    !runtime.game ||
    runtime.game.phase !== 'play' ||
    runtime.game.stepWait == null
  )
    return false;
  const p = runtime.game.stepWait;
  runtime.game.stepWait = null;
  runtime.game.turn = p;
  runtime.game.stepGo = true;
  startTurn();
  return true;
}

export function renderClocks() {
  const c = runtime.game.clock;
  for (let p = 0; p < 4; p++) {
    const el = p === 0 ? $('#myClock') : $('#seat' + p + ' .clock');
    const on =
      !!c &&
      (c.who === p ||
        (c.who === 'deck' && c.seat === p) ||
        ((c.who === 'tribute' || c.who === 'return') && c.seats.includes(p)));
    const n = on ? String(Math.max(0, Math.ceil(c.left / 1000))) : '';
    if (el.dataset.n !== n) {
      el.dataset.n = n;
      el.innerHTML = n ? `<b>${n}</b>` : '';
    }
    el.classList.toggle('hurry', on && c.left <= HURRY_MS);
  }
  const prep = !!c && c.who === 'prep';
  $('#prep').hidden = !prep;
  $('#prepBig').hidden = !prep;
  if (prep) {
    $('#prepBigNum').textContent = Math.max(0, Math.ceil(c.left / 1000));
    $('#prepR').classList.toggle('hurry', c.left <= HURRY_MS);
    placePrepBig();
    $('#prepText').textContent =
      (runtime.game.returns && runtime.game.returns.length ? '理牌后还贡，' : '') +
      `${runtime.game.turn === 0 ? '你' : runtime.names[runtime.game.turn]}先出`;
    $('#readyBtn').hidden = (runtime.game.ready || []).includes(0);
  }
}
