import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { reduceMotion, seatPoint } from './dealing.js';
import { $ } from '../ui/cards.js';
import { isPhone } from '../hand/layout.js';

let VICTORY_MS;

/* ---------- finishing celebrations ---------- */
export function fxEl(cls, text, x, y) {
  const e = document.createElement('div');
  e.className = 'fx ' + cls;
  e.textContent = text;
  e.style.left = x + 'px';
  e.style.top = y + 'px';
  document.body.appendChild(e);
  e.addEventListener('animationend', () => e.remove());
  setTimeout(() => e.remove(), 4000);
  return e;
}

function particles(spawn, step, ms) {
  if (reduceMotion()) return;
  const cv = document.createElement('canvas');
  cv.className = 'fx-canvas';
  cv.width = innerWidth;
  cv.height = innerHeight;
  document.body.appendChild(cv);
  const cx = cv.getContext('2d'),
    ps = [],
    t0 = performance.now();
  const frame = (t) => {
    if (runtime.fxCut > t0) {
      cv.remove();
      return;
    }
    const age = t - t0;
    spawn(ps, age);
    cx.clearRect(0, 0, cv.width, cv.height);
    for (let i = ps.length - 1; i >= 0; i--) {
      if (!step(cx, ps[i], age)) ps.splice(i, 1);
    }
    if (age < ms || ps.length) requestAnimationFrame(frame);
    else cv.remove();
  };
  requestAnimationFrame(frame);
}

function confetti(x, y) {
  const css = getComputedStyle(document.documentElement);
  const cols = ['--gold', '--latest', '--red', '--card', '--warn'].map((v) =>
    css.getPropertyValue(v).trim(),
  );
  let fired = false;
  particles(
    (ps) => {
      if (fired) return;
      fired = true;
      for (let i = 0; i < 160; i++) {
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2,
          v = 6 + Math.random() * 9;
        ps.push({
          x,
          y,
          vx: Math.cos(a) * v,
          vy: Math.sin(a) * v,
          r: Math.random() * 6,
          vr: (Math.random() - 0.5) * 0.4,
          w: 5 + Math.random() * 6,
          h: 3 + Math.random() * 5,
          c: cols[i % cols.length],
          life: 1,
        });
      }
    },
    (cx, p) => {
      p.vy += 0.25;
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      p.life -= 0.006;
      cx.save();
      cx.globalAlpha = Math.max(0, p.life);
      cx.translate(p.x, p.y);
      cx.rotate(p.r);
      cx.fillStyle = p.c;
      cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      cx.restore();
      return p.life > 0 && p.y < innerHeight + 20;
    },
    400,
  );
}

// rockets rise from the bottom of the screen and burst over the given spots, one every gap ms or so for ms
function fireworks(spots, ms = 3000, gap = 240) {
  const css = getComputedStyle(document.documentElement);
  const cols = ['--gold', '--latest', '--red', '--card', '--warn'].map((v) =>
    css.getPropertyValue(v).trim(),
  );
  let all = null,
    next = 0,
    n = 0;
  particles(
    (ps, age) => {
      all = ps;
      if (age > ms || age < next) return;
      next = age + gap + Math.random() * gap * 0.9;
      const s = spots[n++ % spots.length];
      const x = Math.min(
        innerWidth - 40,
        Math.max(40, s.x + (Math.random() - 0.5) * innerWidth * 0.4),
      );
      const ty = Math.max(
        50,
        Math.min(s.y, innerHeight * 0.6) - 80 - Math.random() * innerHeight * 0.25,
      );
      ps.push({
        rocket: true,
        x,
        y: innerHeight + 10,
        ty,
        vy: -(innerHeight + 10 - ty) / 34,
        c: cols[n % cols.length],
      });
    },
    (cx, p) => {
      if (p.rocket) {
        p.y += p.vy;
        cx.fillStyle = p.c;
        cx.fillRect(p.x - 1.5, p.y, 3, 12);
        if (p.y > p.ty) return true;
        Sound.play('pop');
        for (let i = 0; i < 80; i++) {
          const a = Math.random() * Math.PI * 2,
            v = 1 + Math.random() * 5;
          all.push({ x: p.x, y: p.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c: p.c, life: 1 });
        }
        return false;
      }
      p.vy += 0.05;
      p.vx *= 0.98;
      p.vy *= 0.98;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.011;
      cx.globalAlpha = Math.max(0, p.life);
      cx.fillStyle = p.c;
      cx.beginPath();
      cx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      cx.fill();
      cx.globalAlpha = 1;
      return p.life > 0;
    },
    ms,
  );
}

// rain slanting down the whole screen, for ms
function rain(ms) {
  particles(
    (ps, age) => {
      if (age > ms) return;
      for (let i = 0; i < 5; i++)
        ps.push({
          x: Math.random() * (innerWidth + 200),
          y: -30,
          v: 11 + Math.random() * 7,
          l: 14 + Math.random() * 14,
          a: 0.25 + Math.random() * 0.35,
        });
    },
    (cx, p) => {
      p.x -= p.v * 0.18;
      p.y += p.v;
      cx.strokeStyle = `rgba(160,195,230,${p.a})`;
      cx.lineWidth = 1.4;
      cx.beginPath();
      cx.moveTo(p.x, p.y);
      cx.lineTo(p.x + p.l * 0.18, p.y - p.l);
      cx.stroke();
      return p.y < innerHeight + 30;
    },
    ms,
  );
}

// confetti falling from the top of the screen, swaying, for ms
function confettiRain(ms) {
  const css = getComputedStyle(document.documentElement);
  const cols = ['--gold', '--latest', '--red', '--card', '--warn'].map((v) =>
    css.getPropertyValue(v).trim(),
  );
  particles(
    (ps, age) => {
      if (age > ms) return;
      for (let i = 0; i < 3; i++)
        ps.push({
          x: Math.random() * innerWidth,
          y: -10,
          vx: (Math.random() - 0.5) * 1.5,
          vy: 1.5 + Math.random() * 2.5,
          r: Math.random() * 6,
          vr: (Math.random() - 0.5) * 0.3,
          w: 6 + Math.random() * 6,
          h: 4 + Math.random() * 5,
          c: cols[(Math.random() * cols.length) | 0],
          ph: Math.random() * 6,
        });
    },
    (cx, p, age) => {
      p.vy = Math.min(p.vy + 0.02, 4.5);
      p.x += p.vx + Math.sin(age / 300 + p.ph) * 0.8;
      p.y += p.vy;
      p.r += p.vr;
      cx.save();
      cx.translate(p.x, p.y);
      cx.rotate(p.r);
      cx.fillStyle = p.c;
      cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      cx.restore();
      return p.y < innerHeight + 20;
    },
    ms,
  );
}

export function victory(team, done) {
  const won = team === 0,
    m = $('#table').getBoundingClientRect(),
    tok = runtime.game.tok;
  const bg = document.createElement('div');
  bg.className = won ? 'fx-rays' : 'fx-dusk';
  document.body.appendChild(bg);
  const b = document.createElement('div');
  b.className = 'fx fx-champ' + (won ? '' : ' lost');
  b.innerHTML = won
    ? '<b>全场胜利</b><small>打 A 过关</small><i>点任意处看结果</i>'
    : '<b>惜败</b><small>下一场再来</small><i>点任意处看结果</i>';
  b.style.left = m.left + m.width / 2 + 'px';
  b.style.top = m.top + m.height * 0.42 + 'px';
  document.body.appendChild(b);
  let over = false;
  const at = (ms, fn) =>
    setTimeout(() => {
      if (!over) fn();
    }, ms);
  if (won) {
    Sound.play('victory');
    at(4000, () => Sound.play('fanfare'));
    at(7500, () => Sound.play('victory'));
    const W = innerWidth,
      H = innerHeight;
    fireworks(
      [
        ...[team, team + 2].map(seatPoint),
        { x: W * 0.2, y: H * 0.3 },
        { x: W * 0.5, y: H * 0.2 },
        { x: W * 0.8, y: H * 0.3 },
      ],
      VICTORY_MS - 1500,
      150,
    );
    confettiRain(VICTORY_MS - 2000);
  } else {
    Sound.play('sad');
    at(4500, () => Sound.play('lose'));
    at(8000, () => Sound.play('sad'));
    $('#app').classList.add('gloom');
    rain(VICTORY_MS - 1500);
    at(700, () => cryAt(0));
    at(1500, () => cryAt(2));
    at(6000, () => {
      cryAt(0);
      cryAt(2);
    });
  }
  const end = () => {
    if (over) return;
    over = true;
    runtime.fxCut = performance.now();
    bg.remove();
    b.remove();
    $('#app').classList.remove('gloom');
    removeEventListener('pointerdown', end, true);
    if (runtime.game.tok === tok) done();
  };
  // the tap that finished the round is not taken as a skip
  at(800, () => addEventListener('pointerdown', end, true));
  setTimeout(end, VICTORY_MS);
}

// a crying face pops up by the seat and sobs: tears stream down its cheeks and drip off, splashing where they land
function tears(x, y, ground) {
  if (reduceMotion()) return;
  const R = 30,
    T = 3400;
  let all = null,
    started = false;
  setTimeout(() => Sound.play('sob'), 300);
  const drop = (cx, px, py, a) => {
    cx.globalAlpha = a;
    cx.fillStyle = '#8fd0ff';
    cx.beginPath();
    cx.moveTo(px, py - 7);
    cx.bezierCurveTo(px + 5, py - 1, px + 4.5, py + 4, px, py + 4.5);
    cx.bezierCurveTo(px - 4.5, py + 4, px - 5, py - 1, px, py - 7);
    cx.fill();
    cx.globalAlpha = 1;
  };
  particles(
    (ps, age) => {
      all = ps;
      if (!started) {
        started = true;
        ps.push({ k: 'face' });
      }
      if (age > 350 && age < T - 600 && Math.random() < 0.45) {
        const side = Math.random() < 0.5 ? -1 : 1;
        ps.push({
          k: 'tear',
          x: x + side * R * 0.42,
          y: y + R * 0.75,
          vx: side * (0.5 + Math.random() * 1.1),
          vy: 0.5 + Math.random(),
        });
      }
    },
    (cx, p, age) => {
      if (p.k === 'face') {
        if (age > T) return false;
        // pops in, then shakes with sobs, and fades at the end
        const sc =
            age < 280
              ? (1.15 * Math.sin((age / 280) * Math.PI * 0.6)) / Math.sin(Math.PI * 0.6)
              : 1,
          a = Math.min(1, Math.max(0, (T - age) / 400));
        const fy = y + (age > 280 ? Math.sin(age / 85) * 1.6 : 0);
        cx.save();
        cx.globalAlpha = a;
        cx.translate(x, fy);
        cx.scale(sc, sc);
        const g = cx.createRadialGradient(-8, -10, 4, 0, 0, R);
        g.addColorStop(0, '#ffe27a');
        g.addColorStop(1, '#f0ac2e');
        cx.fillStyle = g;
        cx.beginPath();
        cx.arc(0, 0, R, 0, Math.PI * 2);
        cx.fill();
        cx.strokeStyle = '#8a5a00';
        cx.lineWidth = 2.6;
        cx.lineCap = 'round';
        // brows raised in the middle, eyes squeezed shut, mouth wide open and turned down
        for (const sd of [-1, 1]) {
          cx.beginPath();
          cx.moveTo(sd * R * 0.62, -R * 0.42);
          cx.lineTo(sd * R * 0.18, -R * 0.6);
          cx.stroke();
          cx.beginPath();
          cx.arc(sd * R * 0.4, -R * 0.08, R * 0.17, Math.PI * 1.1, Math.PI * 1.9);
          cx.stroke();
        }
        cx.fillStyle = '#6b3a12';
        cx.beginPath();
        cx.ellipse(0, R * 0.47, R * 0.36, R * 0.24, 0, Math.PI, 0);
        cx.closePath();
        cx.fill();
        // two streams of tears running from the eyes to the chin
        if (age > 200) {
          const run = Math.min(1, (age - 200) / 400) * R * 0.85;
          cx.fillStyle = 'rgba(120,195,255,.8)';
          for (const sd of [-1, 1]) {
            cx.beginPath();
            cx.roundRect
              ? cx.roundRect(sd * R * 0.4 - 3.5, 0, 7, run, 3.5)
              : cx.rect(sd * R * 0.4 - 3.5, 0, 7, run);
            cx.fill();
          }
        }
        cx.restore();
        return true;
      }
      if (p.k === 'tear') {
        p.vy += 0.28;
        p.x += p.vx;
        p.y += p.vy;
        drop(cx, p.x, p.y, 0.95);
        if (p.y < ground) return true;
        all.push({ k: 'splash', x: p.x, y: ground, r: 2, life: 1 });
        return false;
      }
      p.r += 1;
      p.life -= 0.08;
      cx.strokeStyle = `rgba(150,210,255,${Math.max(0, p.life) * 0.8})`;
      cx.lineWidth = 1.5;
      cx.beginPath();
      cx.ellipse(p.x, p.y, p.r, p.r * 0.35, 0, 0, Math.PI * 2);
      cx.stroke();
      return p.life > 0;
    },
    T,
  );
}

export function jieFeng(from, to) {
  Sound.play('whoosh');
  const a = seatPoint(from),
    b = seatPoint(to),
    plate = to === 0 ? $('.meinfo') : $('#seat' + to + ' .who');
  const land = () => {
    // the label rises as it fades, so it starts where there is room above it: below the plate of the player
    // across the table (at the top of the screen), above everyone else's
    const r = plate && plate.getBoundingClientRect();
    const side = !isPhone() && (to === 1 || to === 3);
    const q = !r
      ? actPoint(to)
      : to === 2
        ? { x: r.left + r.width / 2, y: r.bottom + 44 }
        : side
          ? { x: to === 3 ? r.right + 62 : r.left - 62, y: r.top + r.height / 2 }
          : { x: r.left + r.width / 2, y: r.top - 30 };
    fxEl('fx-tag first', '接风', q.x, q.y);
    Sound.play('ding');
    if (plate) {
      plate.classList.add('acting');
      setTimeout(() => plate.classList.remove('acting'), 2400);
    }
  };
  if (reduceMotion()) {
    land();
    return;
  }
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  const g = document.createElement('div');
  g.className = 'gust';
  g.style.transform = `translate(${a.x}px,${a.y}px) rotate(${ang}deg)`;
  document.body.appendChild(g);
  g.getBoundingClientRect();
  g.style.transform = `translate(${b.x}px,${b.y}px) rotate(${ang}deg)`;
  setTimeout(() => {
    g.style.opacity = '0';
    land();
  }, 850);
  setTimeout(() => g.remove(), 1200);
}

// the shuffling / cutting label stands on the side of the player's plate away from the deck: right of the
// player across the table, above the players at the sides (on a narrow screen there is no room beside them)
function actPoint(p) {
  const a = $(p === 0 ? '.meinfo' : '#seat' + p + ' .who').getBoundingClientRect();
  if (p === 2) return { x: a.right + 56, y: a.top + a.height / 2 };
  if (p === 0) return placePoint(0);
  return { x: a.left + a.width / 2, y: a.top - 30 };
}

// where a player's place label sits: on the table side of their plate (yours at the foot of the table)
function placePoint(p) {
  const R = (q) => $(q).getBoundingClientRect();
  if (p === 0) {
    const m = R('#msg');
    return { x: m.left + m.width / 2, y: m.top - 20 };
  }
  if (p === 2) {
    const a = R('#seat2 .who');
    return { x: a.left + a.width / 2, y: a.bottom + 28 };
  }
  if (p === 3) {
    const a = R('#seat3 .whorow');
    return { x: a.right + 48, y: a.top + a.height / 2 };
  }
  const a = R('#seat1 .whorow');
  return { x: a.left - 48, y: a.top + a.height / 2 };
}

// a crying face by a seat: above the plate, or beside it for the player across the table (no room above) - or, where
// that would cover cards on the table (the last cards laid out at the end of a round), beside, above or below the
// plate wherever it is clear of them
function cryAt(p) {
  const seat = p === 0 ? $('.meinfo') : $('#seat' + p + ' .who');
  const sr = seat && seat.getBoundingClientRect(),
    pt = sr ? { x: sr.left + sr.width / 2, y: sr.top + sr.height / 2 } : seatPoint(p);
  const cards = [...document.querySelectorAll('#pile .pc')]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width);
  const spots = [
    p === 2 && sr
      ? [sr.right + 52, pt.y, sr.bottom + 70]
      : [pt.x, Math.max(56, pt.y - 92), pt.y + 28],
  ];
  if (sr)
    spots.push(
      [sr.right + 52, pt.y, pt.y + 70],
      [sr.left - 52, pt.y, pt.y + 70],
      [pt.x, sr.top - 60, sr.top - 4],
      [pt.x, sr.bottom + 50, sr.bottom + 110],
    );
  const clear = ([x, y, gr]) =>
    x > 40 &&
    x < innerWidth - 40 &&
    y > 40 &&
    gr < innerHeight - 10 &&
    !cards.some((r) => r.left < x + 42 && r.right > x - 42 && r.top < gr && r.bottom > y - 42);
  const [x, y, gr] = spots.find(clear) || spots[0];
  tears(x, y, gr);
}

// the place label itself lands on the player's plate (see .place), so this adds only sound and effects
// dbl: the round ended in a double-down, so third place is rained on as well as last
export function celebrate(p, place, dbl) {
  const seat = p === 0 ? $('.meinfo') : $('#seat' + p + ' .who');
  if (place === 0) {
    Sound.play('fanfare');
    const q = placePoint(p);
    confetti(q.x, q.y);
  } else if (place < 3 && !(dbl && place === 2)) {
    Sound.play('ding');
  } else {
    // the sad trombone only when it hurts: your side was double-downed (the other side took first and second)
    if (place === 3 && dbl && p % 2 === 0 && runtime.game.out[0] % 2 === 1) Sound.play('sad');
    // a moment later, once the last cards on the table have settled, so the face can keep clear of them
    setTimeout(() => cryAt(p), 600);
    if (seat && !reduceMotion()) {
      seat.classList.add('gloom');
      setTimeout(() => seat.classList.remove('gloom'), 2600);
    }
  }
}

export function initialize() {
  // a throwaway full-screen canvas running one particle effect
  runtime.fxCut = 0;
  // the match is over (A passed): twelve seconds, three times as long as a round's. The winners celebrate - light rays
  // turning behind a large gold banner, fireworks all over the screen, confetti raining down and the victory call three
  // times; the losers mourn - the table greys out under rain, a grey banner sags, tears run and the sad trombone plays.
  // A tap anywhere skips to the result; done (showing the result) runs once either way, unless the game has moved on
  VICTORY_MS = 12000;
}

const TIE_MS = 8000;
export function tieGame(done) {
  if (runtime.reviewMode) {
    Sound.play('ding');
    done();
    return;
  }
  const m = $('#table').getBoundingClientRect(),
    tok = runtime.game.tok;
  const bg = document.createElement('div');
  bg.className = 'fx-tie';
  document.body.appendChild(bg);
  const b = document.createElement('div');
  b.className = 'fx fx-champ tie';
  b.innerHTML =
    '<b>平局</b><span class="hs">🤝</span><small>双方握手言和</small><i>点任意处看结果</i>';
  b.style.left = m.left + m.width / 2 + 'px';
  b.style.top = m.top + m.height * 0.42 + 'px';
  document.body.appendChild(b);
  let over = false;
  const at = (ms, fn) =>
    setTimeout(() => {
      if (!over) fn();
    }, ms);
  Sound.play('ding');
  at(1800, () => Sound.play('ding'));
  at(4200, () => Sound.play('fanfare'));
  const css = getComputedStyle(document.documentElement),
    red = css.getPropertyValue('--red-team').trim() || '#d64545',
    blue = css.getPropertyValue('--blue-team').trim() || '#3a78d8';
  particles(
    (ps, age) => {
      if (age > TIE_MS - 2500) return;
      for (const side of [-1, 1]) {
        for (let i = 0; i < 2; i++)
          ps.push({
            x: side < 0 ? -10 : innerWidth + 10,
            y: innerHeight * (0.55 + Math.random() * 0.3),
            vx: (-side * (5 + Math.random() * 6) * innerWidth) / 900,
            vy: -(7 + Math.random() * 7),
            r: Math.random() * 6,
            vr: (Math.random() - 0.5) * 0.4,
            w: 6 + Math.random() * 6,
            h: 4 + Math.random() * 5,
            c: side < 0 ? red : blue,
            life: 1,
          });
      }
    },
    (cx, p) => {
      p.vy += 0.22;
      p.vx *= 0.995;
      p.x += p.vx;
      p.y += p.vy;
      p.r += p.vr;
      p.life -= 0.004;
      cx.save();
      cx.globalAlpha = Math.max(0, p.life);
      cx.translate(p.x, p.y);
      cx.rotate(p.r);
      cx.fillStyle = p.c;
      cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)));
      cx.restore();
      return p.life > 0 && p.y < innerHeight + 20;
    },
    TIE_MS - 1500,
  );
  const end = () => {
    if (over) return;
    over = true;
    runtime.fxCut = performance.now();
    bg.remove();
    b.remove();
    removeEventListener('pointerdown', end, true);
    if (runtime.game.tok === tok) done();
  };
  at(800, () => addEventListener('pointerdown', end, true));
  setTimeout(end, TIE_MS);
}
