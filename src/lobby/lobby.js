import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { setHumans } from '../game/events.js';
import { newGame, resetGame } from '../game/session.js';
import { isPhone } from '../hand/layout.js';
import {
  broadcastLobby,
  joinRoom,
  leaveNet,
  openRoom,
  sendSit,
  startOnline,
} from '../network/rooms.js';
import { $ } from '../ui/cards.js';
import { render } from '../ui/table.js';
import { loadBotPreferences, prepareBotStyles, renderBotSetup } from './bot-setup.js';

export let DIRS;
export let absOf;
let seatBtns;
export let lobbyStatus;
let nickMax;
export let nickNow;
let ruleBtns;

function syncNickMax() {
  const n = $('#nick');
  n.maxLength = nickMax();
  if (n.value.length > n.maxLength) n.value = n.value.slice(0, n.maxLength);
}

export function showStart() {
  resetGame();
  render();
  $('#nick').value = runtime.nickname;
  syncNickMax();
  setMode('solo');
  $('#lobby').hidden = false;
  if (!runtime.nickname) $('#nick').focus();
}

// your own choice of rules (a room you join shows the host's instead)
function loadRules() {
  Object.assign(runtime.rules, { trib: true, aFail: 'draw' });
  try {
    Object.assign(runtime.rules, JSON.parse(localStorage.getItem('guandan-rules') || '{}'));
  } catch (_) {}
}

function renderRules() {
  const mine = runtime.lobbyMode !== 'join';
  for (const b of ruleBtns) {
    b.classList.toggle(
      'on',
      b.dataset.val ===
        (b.dataset.rule === 'trib' ? (runtime.rules.trib ? '1' : '0') : runtime.rules.aFail),
    );
    b.disabled = !mine;
  }
  $('#rulesNote').textContent = mine ? '' : '规则由房主选定';
}

export function setMode(m) {
  leaveNet();
  loadRules();
  loadBotPreferences();
  runtime.lobbyMode = m;
  runtime.direction = '';
  runtime.network.lastCode = null;
  runtime.network.rejoinDir = null;
  runtime.network.lobby = { S: null, E: null, N: null, W: null };
  document
    .querySelectorAll('.mode-btn')
    .forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  $('#joinRow').hidden = m !== 'join';
  $('#roomCode').classList.toggle('call', m === 'join');
  $('#joinBtn').disabled = false;
  $('#roomInfo').hidden = true;
  lobbyStatus('');
  if (m === 'host') openRoom();
  if (m === 'join') $('#roomCode').focus();
  renderLobby();
}

export function renderLobby() {
  $('#shareRoomBtn').hidden = runtime.lobbyMode !== 'host' || !runtime.network.peerOpen;
  const nick = nickNow(),
    solo = runtime.lobbyMode === 'solo';
  for (const b of seatBtns) {
    const d = b.dataset.seat,
      me = d === runtime.direction,
      who = runtime.network.lobby[d],
      taken = !solo && !!who && !me;
    b.classList.toggle('mine', me);
    b.classList.toggle('bot', solo && !!runtime.direction && !me);
    b.classList.toggle('taken', taken);
    b.disabled =
      taken ||
      (runtime.lobbyMode === 'join' &&
        !(runtime.network.hostConn && runtime.network.hostConn.open)) ||
      (runtime.lobbyMode === 'host' && !runtime.network.peerOpen);
    b.querySelector('span').textContent = me
      ? nick || '你'
      : taken
        ? who
        : solo && runtime.direction
          ? '电脑'
          : '空位';
  }
  renderRules();
  renderBotSetup();
  const go = $('#sitBtn');
  go.hidden = runtime.lobbyMode === 'join';
  go.textContent = runtime.lobbyMode === 'host' ? '开始' : '坐下开始';
  go.disabled =
    !nick || !runtime.direction || (runtime.lobbyMode === 'host' && !runtime.network.peerOpen);
}

export function initialize() {
  /* ---------- the lobby: a nickname, then play alone or with friends ---------- */
  // Solo: pick a seat and the computer takes the other three. Online: one player opens a room and gets a
  // four-digit number, friends type it in to join, everyone picks a seat, and the host starts; empty seats
  // are played by the computer. Sitting down is also the first click, which lets the browser play sound.
  runtime.nickname = '';
  /* ---------- the lobby: a nickname, then play alone or with friends ---------- */
  // Solo: pick a seat and the computer takes the other three. Online: one player opens a room and gets a
  // four-digit number, friends type it in to join, everyone picks a seat, and the host starts; empty seats
  // are played by the computer. Sitting down is also the first click, which lets the browser play sound.
  runtime.direction = '';
  /* ---------- the lobby: a nickname, then play alone or with friends ---------- */
  // Solo: pick a seat and the computer takes the other three. Online: one player opens a room and gets a
  // four-digit number, friends type it in to join, everyone picks a seat, and the host starts; empty seats
  // are played by the computer. Sitting down is also the first click, which lets the browser play sound.
  runtime.lobbyMode = 'solo';
  try {
    runtime.nickname = localStorage.getItem('guandan-nick') || '';
  } catch (_) {}
  // seats in turn order, each player's next being the one on their right
  DIRS = ['S', 'E', 'N', 'W'];
  absOf = (d, hostDir) => (DIRS.indexOf(d) - DIRS.indexOf(hostDir) + 4) % 4;
  seatBtns = [...document.querySelectorAll('.seat-btn')];
  lobbyStatus = (t, hot) => {
    const e = $('#lobbyStatus');
    e.textContent = t || '';
    e.classList.toggle('hot', !!hot);
  };
  nickMax = () => (isPhone() ? 3 : 8);
  nickNow = () =>
    $('#nick')
      .value.replace(/[<>&"']/g, '')
      .trim()
      .slice(0, nickMax());
  syncNickMax();
  addEventListener('resize', syncNickMax);
  // (typing Chinese, the length can only be checked once the characters are in)
  $('#nick').addEventListener('compositionend', syncNickMax);
  ruleBtns = [...document.querySelectorAll('.rule-btn')];
  ruleBtns.forEach((b) =>
    b.addEventListener('click', () => {
      if (runtime.lobbyMode === 'join') return;
      if (b.dataset.rule === 'trib') runtime.rules.trib = b.dataset.val === '1';
      else runtime.rules.aFail = b.dataset.val;
      try {
        localStorage.setItem('guandan-rules', JSON.stringify(runtime.rules));
      } catch (_) {}
      Sound.unlock();
      Sound.play('select');
      renderRules();
      if (runtime.lobbyMode === 'host') broadcastLobby();
    }),
  );
  document.querySelectorAll('.mode-btn').forEach((b) =>
    b.addEventListener('click', () => {
      if (runtime.lobbyMode !== b.dataset.mode) setMode(b.dataset.mode);
    }),
  );
  $('#nick').addEventListener('input', () => {
    // a nickname change while seated online is passed on so the others see it
    if (runtime.direction && runtime.lobbyMode === 'host') {
      runtime.network.lobby[runtime.direction] = nickNow() || '房主';
      broadcastLobby();
    }
    if (runtime.direction && runtime.lobbyMode === 'join') sendSit(runtime.direction);
    renderLobby();
  });
  $('#nick').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('#sitBtn').disabled && !$('#sitBtn').hidden) $('#sitBtn').click();
  });
  seatBtns.forEach((b) =>
    b.addEventListener('click', () => {
      if (!nickNow()) {
        lobbyStatus('先输入昵称');
        $('#nick').focus();
        return;
      }
      const d = b.dataset.seat;
      Sound.unlock();
      Sound.play('select');
      if (runtime.lobbyMode === 'host') {
        if (runtime.network.lobby[d] && d !== runtime.direction) return;
        if (runtime.direction) runtime.network.lobby[runtime.direction] = null;
        runtime.direction = d;
        runtime.network.lobby[d] = nickNow();
        broadcastLobby();
      } else if (runtime.lobbyMode === 'join') {
        sendSit(d);
        return;
      } else runtime.direction = d;
      renderLobby();
    }),
  );
  $('#sitBtn').onclick = () => {
    runtime.nickname = nickNow();
    if (!runtime.nickname || !runtime.direction) return;
    try {
      localStorage.setItem('guandan-nick', runtime.nickname);
    } catch (_) {}
    Sound.unlock();
    if (runtime.lobbyMode === 'host') startOnline();
    else {
      runtime.network.mode = 'solo';
      runtime.network.off = 0;
      prepareBotStyles();
      setHumans([0]);
      $('#myName').textContent = runtime.nickname;
      $('#lobby').hidden = true;
      newGame();
    }
  };
  $('#joinBtn').onclick = () => {
    const code = $('#roomCode').value.replace(/\D/g, '');
    if (!nickNow()) {
      lobbyStatus('先输入昵称');
      $('#nick').focus();
      return;
    }
    if (code.length !== 4) {
      lobbyStatus('房间号是 4 位数字');
      return;
    }
    Sound.unlock();
    // pressed once: the button dims and the box stops calling (both come back if the room cannot be reached)
    $('#joinBtn').disabled = true;
    $('#roomCode').classList.remove('call');
    runtime.network.lastCode = code;
    runtime.network.rejoinTries = 0;
    joinRoom(code);
  };
  $('#roomCode').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#joinBtn').click();
  });
  if (runtime.nickname) $('#myName').textContent = runtime.nickname;
}
