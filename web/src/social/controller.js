/**
 * Table emotes. Players pick a preset: a gift thrown at another seat (cappuccino, flower, bomb),
 * an emoji with an effect beside their own seat (sunglasses, crying) or a quick phrase that pops
 * up and is read aloud. Only preset ids (plus the receiving seat for gifts) travel over the room
 * connection; the host checks the id, the receiver and a per-seat rate limit, then relays it with
 * the sender's seat, so nobody can post free text or speak for another seat. A computer seat that
 * receives a gift from a person answers with an emote of its own. Emotes are not game actions:
 * they are not logged, replayed, recovered or uploaded, and they never change how a bot plays.
 */
import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { isHumanSeat, toAbs, toLocal } from '../game/session.js';
import { $ } from '../ui/cards.js';
import {
  EMOTES,
  EMOTE_COOLDOWN_MS,
  botReply,
  createEmoteLimiter,
  emoteById,
  validTarget,
} from './emotes.mjs';

const SHOW_MS = 3500;
const FLIGHT_MS = 750;
const LAND_MS = 2600;
const BOT_COOLDOWN_MS = 6000;
const MUTE_KEY = 'guandan-emote-muted-v1';
const SEAT_NAMES = ['你', '下家', '对家', '上家'];
/** Each seat gets its own voice pitch so the phrases are told apart by ear. */
const SEAT_PITCH = [1, 1.35, 0.8, 1.15];
const hostLimiter = createEmoteLimiter();
const botLimiter = createEmoteLimiter(BOT_COOLDOWN_MS);
const timers = new Map();
let muted = false;
let coolingUntil = 0;
let pendingGift = null;

const reducedMotion = () => matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function seatName(local) {
  if (local === 0) return '你';
  const name = $(`#seat${local} .name`)?.textContent?.trim();
  return name || SEAT_NAMES[local];
}

/** The name plate a seat's emotes point at, in this page's own numbering (0 = you). */
const plateOf = (local) => (local === 0 ? $('#mebar .meinfo') : $(`#seat${local} .who`));

function centerOf(local) {
  const r = plateOf(local)?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

/** Fixed position beside the plate: below the far seat, inward for the sides, above your own. */
function place(bubble, local) {
  const plate = plateOf(local);
  if (!plate) return;
  const r = plate.getBoundingClientRect(),
    gap = 8;
  const [left, top, translate] =
    local === 2
      ? [r.left + r.width / 2, r.bottom + gap, '-50% 0']
      : local === 3
        ? [r.right + gap, r.top + r.height / 2, '0 -50%']
        : local === 1
          ? [r.left - gap, r.top + r.height / 2, '-100% -50%']
          : [r.left + r.width / 2, r.top - gap, '-50% -100%'];
  Object.assign(bubble.style, { left: `${left}px`, top: `${top}px`, translate });
  // Keep it inside the window on narrow screens.
  const box = bubble.getBoundingClientRect(),
    margin = 6;
  const shift =
    box.left < margin
      ? margin - box.left
      : box.right > innerWidth - margin
        ? innerWidth - margin - box.right
        : 0;
  if (shift) bubble.style.left = `${left + shift}px`;
}

function sound(name, arg) {
  try {
    Sound.play(name, arg);
  } catch (_) {}
}

/** Read a quick phrase aloud with the browser's own speech synthesis, if it has a voice. */
function speak(text, local) {
  try {
    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || !Sound.prefs.sfx || typeof Utterance !== 'function') return;
    const say = new Utterance(text);
    say.lang = 'zh-CN';
    say.rate = 1.05;
    say.pitch = SEAT_PITCH[local] ?? 1;
    const voice = synth.getVoices().find((v) => /^zh(-|_)?CN/i.test(v.lang) || /^zh/i.test(v.lang));
    if (voice) say.voice = voice;
    synth.cancel();
    synth.speak(say);
  } catch (_) {}
}

function announce(text) {
  const live = $('#emoteLive');
  if (live) live.textContent = text;
}

function later(element, ms) {
  setTimeout(() => element.remove(), ms);
}

/** A few pieces flying out of (x, y) and fading: bomb fire, flower petals or coffee steam. */
function burst(x, y, kind) {
  if (reducedMotion()) return;
  const pieces = {
    g01: { text: ['', '', '', '', ''], spread: 30, rise: -70, ms: 1300, cls: 'steam' },
    g02: { text: ['🌸', '🌸', '🌹', '🌸', '💮', '🌸', '🌸', '🌸'], spread: 90, rise: 70, ms: 1500 },
    g03: { text: ['💥', '🔥', '✨', '🔥', '💥', '✨', '🔥', '💥'], spread: 110, rise: 0, ms: 900 },
    e01: { text: ['✨', '⭐', '✨', '✨'], spread: 45, rise: -10, ms: 1100 },
    e02: { text: ['💧', '💧', '💧', '💧', '💧', '💧'], spread: 28, rise: 60, ms: 1200 },
  }[kind];
  if (!pieces) return;
  pieces.text.forEach((text, i) => {
    const piece = document.createElement('div');
    piece.className = `emote-particle ${pieces.cls || ''}`;
    piece.textContent = text;
    piece.style.left = `${x}px`;
    piece.style.top = `${y}px`;
    document.body.append(piece);
    const angle = (i / pieces.text.length) * Math.PI * 2 + Math.random() * 0.6;
    const dx = Math.cos(angle) * pieces.spread * (0.6 + Math.random() * 0.4);
    const dy = Math.sin(angle) * pieces.spread * 0.5 + pieces.rise * (0.6 + Math.random() * 0.6);
    piece.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.15 },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.8) rotate(${dx}deg)`,
          opacity: 0,
        },
      ],
      { duration: pieces.ms, delay: i * 40, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'both' },
    );
    later(piece, pieces.ms + i * 40 + 60);
  });
}

function shake(local) {
  const seat = local === 0 ? $('#mebar') : $(`#seat${local}`);
  if (!seat || reducedMotion()) return;
  seat.classList.remove('emote-shake');
  void seat.offsetWidth;
  seat.classList.add('emote-shake');
  setTimeout(() => seat.classList.remove('emote-shake'), 600);
}

/** The gift lands on the receiver's plate with its own effect and sound. */
function land(from, to, entry) {
  const at = centerOf(to);
  if (!at) return;
  document.querySelector(`.emote-gift[data-to="${to}"]`)?.remove();
  const gift = document.createElement('div');
  gift.className = `emote-gift ${entry.id}`;
  gift.dataset.from = String(from);
  gift.dataset.to = String(to);
  gift.textContent = entry.text;
  gift.title = `${seatName(from)} → ${seatName(to)}：${entry.label}`;
  gift.style.left = `${at.x}px`;
  gift.style.top = `${at.y}px`;
  document.body.append(gift);
  later(gift, LAND_MS);
  if (entry.id === 'g03') {
    const blast = document.createElement('div');
    blast.className = 'emote-blast';
    blast.style.left = `${at.x}px`;
    blast.style.top = `${at.y}px`;
    document.body.append(blast);
    later(blast, 700);
    shake(to);
    sound('bomb', true);
  } else sound(entry.id === 'g02' ? 'ding' : 'pop');
  burst(at.x, at.y, entry.id);
}

/** Throw a gift from one seat to another (both in this page's numbering). */
function throwGift(from, to, entry) {
  const start = centerOf(from),
    end = centerOf(to);
  if (!start || !end) return false;
  announce(`${seatName(from)}送给${seatName(to)}：${entry.label}`);
  if (reducedMotion() || typeof document.body.animate !== 'function') {
    land(from, to, entry);
    return true;
  }
  const flight = document.createElement('div');
  flight.className = `emote-flight ${entry.id}`;
  flight.textContent = entry.text;
  flight.style.left = `${start.x}px`;
  flight.style.top = `${start.y}px`;
  document.body.append(flight);
  const dx = end.x - start.x,
    dy = end.y - start.y,
    lift = Math.min(140, 40 + Math.hypot(dx, dy) * 0.25);
  const spin = entry.id === 'g03' ? 540 : entry.id === 'g02' ? 200 : 0;
  flight.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.6) rotate(0deg)' },
      {
        transform: `translate(calc(-50% + ${dx / 2}px), calc(-50% + ${dy / 2 - lift}px)) scale(1.25) rotate(${spin / 2}deg)`,
      },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin}deg)`,
      },
    ],
    { duration: FLIGHT_MS, easing: 'ease-in-out', fill: 'forwards' },
  );
  sound('whoosh');
  setTimeout(() => {
    flight.remove();
    land(from, to, entry);
  }, FLIGHT_MS);
  return true;
}

/** A bubble beside the sender's plate: the emoji with its effect, or the phrase (read aloud). */
function popBubble(local, entry) {
  if (!plateOf(local)) return false;
  document.querySelector(`.emote-bubble[data-seat="${local}"]`)?.remove();
  const bubble = document.createElement('div');
  bubble.className = `emote-bubble kind-${entry.kind} ${entry.id}`;
  bubble.dataset.seat = String(local);
  bubble.textContent = entry.text;
  bubble.title = entry.label;
  document.body.append(bubble);
  place(bubble, local);
  clearTimeout(timers.get(local));
  timers.set(
    local,
    setTimeout(() => bubble.remove(), SHOW_MS),
  );
  announce(`${seatName(local)}：${entry.label}`);
  if (entry.kind === 'phrase') {
    sound('pop');
    speak(entry.text, local);
  } else {
    const r = bubble.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, entry.id);
    sound(entry.id === 'e02' ? 'sob' : 'whoosh');
  }
  return true;
}

/**
 * Show an emote from a seat in this page's own numbering (0 = you); gifts also name the receiving
 * seat in the same numbering.
 */
export function showEmote(local, id, to) {
  const entry = emoteById(id);
  if (!entry || !Number.isInteger(local) || local < 0 || local > 3) return false;
  if (!validTarget(entry, local, to)) return false;
  if (muted && local !== 0) return false;
  return entry.kind === 'gift' ? throwGift(local, to, entry) : popBubble(local, entry);
}

function relay(message) {
  for (const value of runtime.network.conns?.values() || [])
    if (value.conn?.open) value.conn.send(message);
}

/** On the host (or alone): show an emote from an absolute seat, tell the friends, let bots answer. */
function publish(seat, id, to) {
  const gift = Number.isInteger(to);
  showEmote(toLocal(seat), id, gift ? toLocal(to) : undefined);
  relay(gift ? { t: 'emote', seat, id, to } : { t: 'emote', seat, id });
  if (gift) answerGift(seat, id, to);
}

/**
 * A computer seat that gets a gift from a person answers after a short pause: it throws the gift
 * back, or puts on sunglasses (cappuccino, flower) or cries (bomb). Only the host decides this, and
 * each bot answers at most once per cooldown so two tables of bots never ping-pong.
 */
function answerGift(from, id, to) {
  if (runtime.network.mode === 'guest') return;
  if (isHumanSeat(toLocal(to)) || !isHumanSeat(toLocal(from))) return;
  if (!botLimiter(to)) return;
  const reply = botReply(id);
  if (!reply) return;
  setTimeout(
    () => {
      if (!runtime.game || isHumanSeat(toLocal(to))) return;
      const entry = emoteById(reply);
      publish(to, reply, entry.kind === 'gift' ? from : undefined);
    },
    1000 + Math.random() * 1000,
  );
}

/** The host received an emote from a friend's seat (absolute numbering). */
export function hostEmote(seat, id, to) {
  const entry = emoteById(id);
  if (!entry || !Number.isInteger(seat) || !validTarget(entry, seat, to)) return false;
  if (!hostLimiter(seat)) return false;
  publish(seat, id, entry.kind === 'gift' ? to : undefined);
  return true;
}

/** A friend's page received the host's relay (absolute numbering). */
export function guestEmote(seat, id, to) {
  const entry = emoteById(id);
  if (!entry || !Number.isInteger(seat) || seat < 0 || seat > 3) return false;
  if (!validTarget(entry, seat, to)) return false;
  // Our own emote already showed when we sent it.
  if (seat === toAbs(0)) return false;
  return showEmote(toLocal(seat), id, entry.kind === 'gift' ? toLocal(to) : undefined);
}

/** Send one of the presets from this page's own seat; gifts name a receiver in local numbering. */
export function sendEmote(id, toSeat) {
  const entry = emoteById(id);
  if (!entry || !runtime.game || !validTarget(entry, 0, toSeat)) return false;
  const now = Date.now();
  if (now < coolingUntil) return false;
  coolingUntil = now + EMOTE_COOLDOWN_MS;
  const to = entry.kind === 'gift' ? toAbs(toSeat) : undefined;
  if (runtime.network.mode === 'guest') {
    showEmote(0, id, toSeat);
    if (runtime.network.hostConn?.open)
      runtime.network.hostConn.send(
        entry.kind === 'gift' ? { t: 'emote', id, to } : { t: 'emote', id },
      );
  } else {
    hostLimiter(toAbs(0));
    publish(toAbs(0), id, to);
  }
  paintCooldown();
  return true;
}

/** The button stays disabled during the cooldown, with a ring that sweeps round until it is ready. */
function paintCooldown() {
  const button = $('#emoteBtn');
  if (!button) return;
  const wait = coolingUntil - Date.now();
  button.disabled = wait > 0;
  if (wait > 0 && !button.classList.contains('cooling')) {
    button.style.setProperty('--cool-ms', `${wait}ms`);
    button.classList.add('cooling');
  } else if (wait <= 0) button.classList.remove('cooling');
  if (wait > 0) setTimeout(paintCooldown, wait + 20);
}

function showTargets(entry) {
  const box = $('#emoteTargets');
  pendingGift = entry;
  box.replaceChildren();
  const title = document.createElement('div');
  title.className = 'emote-targets-title';
  title.textContent = `把${entry.label}送给`;
  box.append(title);
  for (const local of [3, 2, 1]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emote-target';
    button.dataset.to = String(local);
    const name = seatName(local);
    button.textContent = name === SEAT_NAMES[local] ? name : `${SEAT_NAMES[local]} · ${name}`;
    button.onclick = () => {
      if (sendEmote(pendingGift.id, local)) setPanel(false);
    };
    box.append(button);
  }
  box.hidden = false;
  for (const choice of document.querySelectorAll('#emoteGrid .emote-choice'))
    choice.setAttribute('aria-pressed', String(choice.dataset.id === entry.id));
  box.querySelector('.emote-target')?.focus();
}

function hideTargets() {
  pendingGift = null;
  const box = $('#emoteTargets');
  if (box) box.hidden = true;
  for (const choice of document.querySelectorAll('#emoteGrid .emote-choice'))
    choice.removeAttribute('aria-pressed');
}

/** Open the panel just above the emote button under your own seat, kept inside the window. */
function placePanel() {
  const panel = $('#emotePanel'),
    button = $('#emoteBtn');
  if (panel.hidden) return;
  const r = button.getBoundingClientRect(),
    margin = 10,
    width = panel.offsetWidth;
  const center = r.left + r.width / 2;
  const left = Math.max(margin, Math.min(innerWidth - margin - width, center - width / 2));
  panel.style.left = `${left}px`;
  panel.style.bottom = `${Math.max(margin, innerHeight - r.top + 10)}px`;
  panel.style.setProperty('--arrow-x', `${Math.max(18, Math.min(width - 18, center - left))}px`);
}

function setTab(name) {
  for (const tab of document.querySelectorAll('#emoteTabs [role=tab]')) {
    const on = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(`#${tab.getAttribute('aria-controls')}`).hidden = !on;
  }
  hideTargets();
}

function setPanel(open) {
  const panel = $('#emotePanel'),
    button = $('#emoteBtn');
  hideTargets();
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (!open) return;
  placePanel();
  panel.querySelector('.emote-page:not([hidden]) button')?.focus();
}

function buildPanel() {
  const grid = $('#emoteGrid'),
    phrases = $('#emotePhrases');
  for (const entry of EMOTES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `emote-choice kind-${entry.kind}`;
    button.dataset.id = entry.id;
    button.title = entry.kind === 'gift' ? `送${entry.label}` : entry.label;
    button.setAttribute('aria-label', entry.kind === 'phrase' ? entry.text : button.title);
    if (entry.kind === 'phrase') button.textContent = entry.text;
    else {
      const icon = document.createElement('span');
      icon.className = 'emote-icon';
      icon.textContent = entry.text;
      const label = document.createElement('span');
      label.className = 'emote-label';
      label.textContent = entry.label;
      button.append(icon, label);
    }
    button.onclick = () => {
      if (entry.kind === 'gift') showTargets(entry);
      else if (sendEmote(entry.id)) setPanel(false);
    };
    (entry.kind === 'phrase' ? phrases : grid).append(button);
  }
  const mute = $('#emoteMute');
  mute.checked = muted;
  mute.onchange = () => {
    muted = mute.checked;
    try {
      localStorage.setItem(MUTE_KEY, String(muted));
    } catch (_) {}
    if (muted) {
      for (const node of document.querySelectorAll(
        '.emote-bubble:not([data-seat="0"]), .emote-gift:not([data-from="0"])',
      ))
        node.remove();
      try {
        window.speechSynthesis?.cancel();
      } catch (_) {}
    }
  };
}

export function initialize() {
  try {
    muted = localStorage.getItem(MUTE_KEY) === 'true';
  } catch (_) {}
  buildPanel();
  for (const tab of document.querySelectorAll('#emoteTabs [role=tab]'))
    tab.onclick = () => setTab(tab.dataset.tab);
  $('#emoteTabs').addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const tabs = [...document.querySelectorAll('#emoteTabs [role=tab]')];
    const next = tabs[(tabs.indexOf(document.activeElement) + 1) % tabs.length] || tabs[0];
    setTab(next.dataset.tab);
    next.focus();
  });
  setTab('emotes');
  addEventListener('resize', placePanel);
  $('#emoteBtn').onclick = (event) => {
    event.stopPropagation();
    setPanel($('#emotePanel').hidden);
  };
  $('#emotePanel').onclick = (event) => event.stopPropagation();
  document.addEventListener('click', () => {
    if (!$('#emotePanel').hidden) setPanel(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || $('#emotePanel').hidden) return;
    if (pendingGift) {
      const id = pendingGift.id;
      hideTargets();
      $(`#emoteGrid .emote-choice[data-id="${id}"]`)?.focus();
      return;
    }
    setPanel(false);
    $('#emoteBtn').focus();
  });
}
