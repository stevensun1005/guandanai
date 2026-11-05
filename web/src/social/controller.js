/**
 * Table emotes: players pick a preset emoji or quick phrase, it pops up beside their seat for
 * everyone at the table. Only preset ids travel over the room connection; the host checks the id
 * and a per-seat rate limit, then relays it with the sender's seat, so nobody can post free text
 * or speak for another seat. Emotes are not game actions: they are not logged, replayed,
 * recovered or uploaded.
 */
import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { toAbs, toLocal } from '../game/session.js';
import { $ } from '../ui/cards.js';
import { EMOTES, EMOTE_COOLDOWN_MS, createEmoteLimiter, emoteById } from './emotes.mjs';

const SHOW_MS = 3500;
const MUTE_KEY = 'guandan-emote-muted-v1';
const SEAT_NAMES = ['你', '下家', '对家', '上家'];
const hostLimiter = createEmoteLimiter();
const timers = new Map();
let muted = false;
let coolingUntil = 0;

function seatName(local) {
  if (local === 0) return '你';
  const name = $(`#seat${local} .name`)?.textContent?.trim();
  return name || SEAT_NAMES[local];
}

/** The name plate a seat's bubble points at, in this page's own numbering (0 = you). */
const plateOf = (local) => (local === 0 ? $('#mebar .meinfo') : $(`#seat${local} .who`));

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

/** Pop the emote up beside a seat in this page's own numbering (0 = you). */
export function showEmote(local, id) {
  const entry = emoteById(id);
  if (!entry || !Number.isInteger(local) || local < 0 || local > 3) return false;
  if (muted && local !== 0) return false;
  if (!plateOf(local)) return false;
  document.querySelector(`.emote-bubble[data-seat="${local}"]`)?.remove();
  const bubble = document.createElement('div');
  bubble.className = `emote-bubble ${entry.kind}`;
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
  const live = $('#emoteLive');
  if (live) live.textContent = `${seatName(local)}：${entry.label}`;
  try {
    Sound.play('pop');
  } catch (_) {}
  return true;
}

function relay(message) {
  for (const value of runtime.network.conns?.values() || [])
    if (value.conn?.open) value.conn.send(message);
}

/** The host received an emote from a friend's seat (absolute numbering). */
export function hostEmote(seat, id) {
  if (!emoteById(id) || !Number.isInteger(seat) || !hostLimiter(seat)) return false;
  showEmote(toLocal(seat), id);
  relay({ t: 'emote', seat, id });
  return true;
}

/** A friend's page received the host's relay (absolute numbering). */
export function guestEmote(seat, id) {
  if (!emoteById(id) || !Number.isInteger(seat) || seat < 0 || seat > 3) return false;
  // Our own emote already popped up when we sent it.
  if (seat === toAbs(0)) return false;
  return showEmote(toLocal(seat), id);
}

/** Send one of the presets from this page's own seat. */
export function sendEmote(id) {
  if (!emoteById(id) || !runtime.game) return false;
  const now = Date.now();
  if (now < coolingUntil) return false;
  coolingUntil = now + EMOTE_COOLDOWN_MS;
  const mode = runtime.network.mode;
  if (mode === 'host') {
    hostLimiter(toAbs(0));
    showEmote(0, id);
    relay({ t: 'emote', seat: toAbs(0), id });
  } else if (mode === 'guest') {
    showEmote(0, id);
    if (runtime.network.hostConn?.open) runtime.network.hostConn.send({ t: 'emote', id });
  } else showEmote(0, id);
  paintCooldown();
  return true;
}

function paintCooldown() {
  const button = $('#emoteBtn');
  if (!button) return;
  const wait = coolingUntil - Date.now();
  button.disabled = wait > 0;
  if (wait > 0) setTimeout(paintCooldown, wait + 20);
}

function setPanel(open) {
  const panel = $('#emotePanel'),
    button = $('#emoteBtn');
  panel.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) panel.querySelector('button')?.focus();
}

function buildPanel() {
  const grid = $('#emoteGrid'),
    phrases = $('#emotePhrases');
  for (const entry of EMOTES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `emote-choice ${entry.kind}`;
    button.textContent = entry.text;
    button.title = entry.label;
    button.setAttribute('aria-label', entry.kind === 'emoji' ? entry.label : entry.text);
    button.onclick = () => {
      if (sendEmote(entry.id)) setPanel(false);
    };
    (entry.kind === 'emoji' ? grid : phrases).append(button);
  }
  const mute = $('#emoteMute');
  mute.checked = muted;
  mute.onchange = () => {
    muted = mute.checked;
    try {
      localStorage.setItem(MUTE_KEY, String(muted));
    } catch (_) {}
    if (muted)
      for (const bubble of document.querySelectorAll('.emote-bubble:not([data-seat="0"])'))
        bubble.remove();
  };
}

export function initialize() {
  try {
    muted = localStorage.getItem(MUTE_KEY) === 'true';
  } catch (_) {}
  buildPanel();
  $('#emoteBtn').onclick = (event) => {
    event.stopPropagation();
    setPanel($('#emotePanel').hidden);
  };
  $('#emotePanel').onclick = (event) => event.stopPropagation();
  document.addEventListener('click', () => {
    if (!$('#emotePanel').hidden) setPanel(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#emotePanel').hidden) {
      setPanel(false);
      $('#emoteBtn').focus();
    }
  });
}
