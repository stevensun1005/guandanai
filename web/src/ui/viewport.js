import { runtime } from '../app/runtime.js';
import { isPhone, phoneSwitch, layoutHand } from '../hand/layout.js';
import { renderHand } from '../hand/view.js';
import { render, placeLastPlay } from './table.js';
import { centerRank, pileRebuild } from './table-pile.js';

export function alignNamePlates() {
  if (runtime.reviewMode || isPhone() || !runtime.game) {
    document.querySelector('#table')?.style.removeProperty('--mid-drop');
    return;
  }
  const table = document.querySelector('#table'),
    top = document.querySelector('#seat2 .who'),
    mine = document.querySelector('#mebar .meinfo'),
    side = document.querySelector('#seat3 .who');
  if (!top?.offsetHeight || !mine?.offsetHeight || !side?.offsetHeight) return;
  const t = top.getBoundingClientRect(),
    m = mine.getBoundingClientRect(),
    s = side.getBoundingClientRect();
  const delta = (t.top + t.height / 2 + m.top + m.height / 2) / 2 - (s.top + s.height / 2);
  if (Math.abs(delta) < 0.75) return;
  const y = new window.DOMMatrix(getComputedStyle(document.querySelector('#seat3')).transform).m42;
  table.style.setProperty('--mid-drop', y + delta + 'px');
}
export function initialize() {
  let key = '',
    queued = false,
    resizes = 0,
    rotations = 0,
    debug;
  if (location.hash === '#debug') {
    debug = document.createElement('pre');
    debug.id = 'viewportDebug';
    debug.setAttribute('aria-label', '屏幕尺寸诊断');
    document.body.append(debug);
  }
  const check = () => {
    queued = false;
    const next = innerWidth + 'x' + innerHeight;
    if (next !== key) {
      key = next;
      phoneSwitch();
      if (runtime.game) {
        renderHand();
        render();
        layoutHand();
        alignNamePlates();
        centerRank();
        placeLastPlay();
        pileRebuild();
      }
    }
    if (debug) {
      const vv = window.visualViewport;
      debug.textContent = `inner ${next}\nclient ${document.documentElement.clientWidth}x${document.documentElement.clientHeight}\nvisual ${vv ? Math.round(vv.width) + 'x' + Math.round(vv.height) + ' scale ' + vv.scale : 'none'}\norientation ${screen.orientation?.type || '-'}\nresize ${resizes} · orientationchange ${rotations}`;
    }
  };
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(check);
  };
  const rotate = () => {
    for (const ms of [0, 120, 350, 800, 1500]) setTimeout(soon, ms);
  };
  addEventListener('resize', () => {
    resizes++;
    soon();
  });
  addEventListener('orientationchange', () => {
    rotations++;
    rotate();
  });
  screen.orientation?.addEventListener?.('change', rotate);
  window.visualViewport?.addEventListener('resize', soon);
  for (const e of ['fullscreenchange', 'webkitfullscreenchange'])
    document.addEventListener(e, rotate);
  // Safari can report a late dimension change without a final resize event. No viewport writes.
  setInterval(check, 1000);
  soon();
}
