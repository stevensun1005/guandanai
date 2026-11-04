import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { fxEl } from './celebrations.js';
import { layoutHand } from '../hand/layout.js';
import { practicePeeks } from '../replay/inspector.js';
import { $, cardHTML } from '../ui/cards.js';

export let reduceMotion;

export function fly(p) {
  if (reduceMotion()) return;
  const a = $('.emblem').getBoundingClientRect();
  const t = (p === 0 ? $('#hand') : $('#seat' + p + ' .who .back')).getBoundingClientRect();
  const sx = a.left + a.width / 2,
    sy = a.top + a.height / 2;
  const tx = t.left + t.width / 2 + (p === 0 ? (Math.random() - 0.5) * t.width * 0.5 : 0),
    ty = p === 0 ? t.top + t.height * 0.55 : t.top + t.height / 2;
  const f = document.createElement('div');
  f.className = 'flyer';
  f.style.transform = `translate(${sx}px,${sy}px)`;
  document.body.appendChild(f);
  f.getBoundingClientRect();
  f.style.transform = `translate(${tx}px,${ty}px) rotate(${(Math.random() - 0.5) * 40}deg) scale(${p === 0 ? 1.3 : 0.8})`;
  setTimeout(() => {
    f.style.opacity = '0';
  }, 180);
  setTimeout(() => f.remove(), 300);
}

export function seatPoint(p) {
  const r = (p === 0 ? $('#hand') : $('#seat' + p + ' .who')).getBoundingClientRect();
  return { x: r.left + r.width / 2, y: p === 0 ? r.top + r.height * 0.45 : r.top + r.height / 2 };
}

// a face-up card travels giver -> table centre (pauses so everyone can read it) -> receiver
export function giveAnim(from, to, card, label, start) {
  return new Promise((done) => {
    Sound.play('deal');
    if (reduceMotion()) {
      setTimeout(done, 700);
      return;
    }
    const a = start || seatPoint(from),
      b = seatPoint(to),
      m = $('.emblem').getBoundingClientRect();
    const mx = m.left + m.width / 2,
      my = m.top + m.height / 2;
    const w = document.createElement('div');
    w.className = 'gift';
    // a returned card travels face down, except for the two players it passes between: the receiver sees at once what
    // came back, everyone else when every return is in (both, after a double-down), as the tribute line then names it
    const hide = label === '还贡' && from !== 0 && to !== 0;
    w.innerHTML = `<span class="gl">${runtime.names[from]} ${label}</span>${hide ? '<div class="gback"></div>' : cardHTML(card, runtime.game.L)}`;
    w.style.transform = `translate(${a.x}px,${a.y}px) scale(.55)`;
    w.style.opacity = '0';
    document.body.appendChild(w);
    w.getBoundingClientRect();
    w.style.transform = `translate(${mx}px,${my}px) scale(1)`;
    w.style.opacity = '1';
    setTimeout(() => Sound.play('play'), 550);
    setTimeout(() => {
      w.style.transform = `translate(${b.x}px,${b.y}px) scale(.55)`;
    }, 1500);
    setTimeout(() => {
      w.style.opacity = '0';
    }, 1900);
    setTimeout(() => {
      w.remove();
      done();
    }, 2100);
  });
}

// resisting the tribute: the big jokers are laid face up in the middle under a stamp, then go back to their owners
export function kangAnim(list) {
  return new Promise((done) => {
    Sound.play('gong');
    const m = $('.emblem').getBoundingClientRect(),
      mx = m.left + m.width / 2,
      my = m.top + m.height / 2;
    fxEl('fx-stamp kang', '抗贡', mx, my - 120);
    if (reduceMotion()) {
      setTimeout(done, 2000);
      return;
    }
    const els = list.map(({ g, c }, i) => {
      const a = seatPoint(g),
        w = document.createElement('div');
      w.className = 'gift';
      w.innerHTML = `<span class="gl">${runtime.names[g]}</span>${cardHTML(c, runtime.game.L)}`;
      w.style.transform = `translate(${a.x}px,${a.y}px) scale(.55)`;
      w.style.opacity = '0';
      document.body.appendChild(w);
      w.getBoundingClientRect();
      w.style.transform = `translate(${mx + (i - (list.length - 1) / 2) * 110}px,${my + 20}px) scale(1.15)`;
      w.style.opacity = '1';
      return { w, a };
    });
    setTimeout(() => Sound.play('cardSlap'), 550);
    setTimeout(() => {
      for (const e of els) e.w.style.transform = `translate(${e.a.x}px,${e.a.y}px) scale(.55)`;
    }, 2700);
    setTimeout(() => {
      for (const e of els) e.w.style.opacity = '0';
    }, 3100);
    setTimeout(() => {
      els.forEach((e) => e.w.remove());
      done();
    }, 3300);
  });
}

export function dealView(p, c) {
  if (p === 0) {
    $('#hand').insertAdjacentHTML('beforeend', cardHTML(c, runtime.game.L));
    layoutHand();
  } else if (runtime.reviewMode) practicePeeks();
}

// a count is only announced once a hand is down to 10 or fewer (never while dealing)
export function showCount(el, n) {
  const v = runtime.game.phase !== 'deal' && n > 0 && n <= 10 ? String(n) : '';
  if (el.dataset.n === v) return;
  el.dataset.n = v;
  el.innerHTML = v ? `${v}<small>张</small>` : '';
}

export function initialize() {
  /* ---------- dealing animation ---------- */
  reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
}
