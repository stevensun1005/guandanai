import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { reduceMotion } from './dealing.js';
import { markActor } from '../game/dealing.js';
import { later } from '../game/turns.js';
import { $ } from '../ui/cards.js';
import { pileEl, pileGeo } from '../ui/table-pile.js';

let stackAt;

/* ---------- shuffling and cutting ---------- */
function makeStack(n) {
  const d = document.createElement('div');
  d.className = 'stack';
  for (let i = 0; i < n; i++) {
    const c = document.createElement('div');
    c.className = 'sb';
    c.style.transform = `translate(${-i * 0.7}px,${-i * 0.9}px)`;
    d.appendChild(c);
  }
  return d;
}

export function showDeck() {
  removeDeck();
  const g = pileGeo(),
    d = makeStack(8);
  d.id = 'deck';
  d.style.transition = 'none';
  stackAt(d, g, 0, 0);
  pileEl().appendChild(d);
  d.getBoundingClientRect();
  d.style.transition = '';
}

export function removeDeck() {
  pileEl()
    .querySelectorAll('.stack,.flick')
    .forEach((e) => e.remove());
  markActor(-1);
}

// requestAnimationFrame tween; the callback is dropped if a new game or round has started meanwhile
function tween(dur, step, done) {
  const t0 = performance.now(),
    tok = runtime.game.tok;
  const f = (t) => {
    if (runtime.game.tok !== tok) return;
    const k = Math.min(1, (t - t0) / dur);
    step(k);
    if (k < 1) requestAnimationFrame(f);
    else if (done) done();
  };
  requestAnimationFrame(f);
}

// a plain riffle shuffle: the deck splits into two halves, the cards riffle back together from both sides,
// and the squared deck gets a tap on the table (about a second and a half)
export function animShuffle(done, at) {
  let g = pileGeo();
  if (at) g = { ...g, cx: at.x, hy: at.y };
  const deck = $('#deck');
  if (!deck || reduceMotion()) {
    Sound.play('shuffle');
    later(done, 300);
    return;
  }
  const layer = pileEl(),
    cx = g.cx,
    cy = g.hy,
    cw = g.cw,
    tok = runtime.game.tok;
  const mk = () => {
    const f = document.createElement('div');
    f.className = 'flick';
    f.style.transition = 'none';
    layer.appendChild(f);
    return f;
  };
  const put = (f, x, y, r) => {
    f.style.transform = `translate(${x}px,${y}px) rotate(${r}deg)`;
  };
  deck.style.transition = 'none';
  deck.style.opacity = '0';
  const A = makeStack(4),
    B = makeStack(4),
    split = cw * 0.9;
  for (const st of [A, B]) {
    st.style.transition = 'none';
    stackAt(st, g, 0, 0);
    layer.appendChild(st);
    st.getBoundingClientRect();
    st.style.transition = '';
  }
  stackAt(A, g, -split, 6, -10);
  stackAt(B, g, split, 6, 10);
  Sound.play('riffleLong');
  for (let i = 0; i < 16; i++)
    later(
      () => {
        const f = mk(),
          sx = i % 2 ? split : -split,
          r0 = i % 2 ? 10 : -10;
        tween(
          140,
          (k) => put(f, cx + sx * (1 - k), cy + 6 - 10 * Math.sin(Math.PI * k), r0 * (1 - k)),
          () => f.remove(),
        );
      },
      320 + i * 30,
    );
  later(
    () => {
      stackAt(A, g, 0, 0);
      stackAt(B, g, 0, 0);
      later(() => {
        A.remove();
        B.remove();
        deck.style.transition = '';
        deck.style.opacity = '1';
        stackAt(deck, g, 0, -6);
        later(() => {
          stackAt(deck, g, 0, 0);
          Sound.play('cardSlap');
        }, 140);
        later(() => {
          if (runtime.game.tok === tok) done();
        }, 420);
      }, 300);
    },
    320 + 16 * 30 + 200,
  );
}

// a cut: the top half is lifted off and set down beside, then the bottom half goes on top of it
export function animCut(done, at) {
  let g = pileGeo();
  if (at) g = { ...g, cx: at.x, hy: at.y };
  const deck = $('#deck');
  if (!deck || reduceMotion()) {
    Sound.play('play');
    later(done, 300);
    return;
  }
  const top = makeStack(4);
  top.style.transition = 'none';
  stackAt(top, g, 0, -4);
  top.style.zIndex = 7050;
  pileEl().appendChild(top);
  top.getBoundingClientRect();
  top.style.transition = '';
  const side = g.cw * 1.5;
  later(() => {
    stackAt(top, g, 0, -g.cw * 0.5, -4);
    Sound.play('flick');
  }, 60);
  later(() => Sound.play('cardSlap'), 680);
  later(() => stackAt(top, g, side, 0, 4), 380);
  later(() => {
    deck.style.zIndex = 7080;
    stackAt(deck, g, side, -6, 2);
  }, 760);
  later(() => Sound.play('cardSlap'), 1050);
  later(() => Sound.play('play'), 1450);
  later(() => {
    stackAt(deck, g, 0, 0);
    stackAt(top, g, 0, 4);
  }, 1250);
  later(() => {
    top.remove();
    deck.style.zIndex = '';
    done();
  }, 1650);
}

export function initialize() {
  stackAt = (el, g, dx, dy, rot = 0) => {
    el.style.transform = `translate(${g.cx + dx}px,${g.hy + dy}px) rotate(${rot}deg)`;
  };
}
