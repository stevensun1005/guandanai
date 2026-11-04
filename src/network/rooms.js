import { runtime } from '../app/runtime.js';
import { readPlay, canPass, isReturnCard } from '../core/validation.js';
import { aiReturnCard, tributeCard } from '../ai/rule-policy.js';
import { PREP_MS, timeUp } from '../game/clock.js';
import { startCut, startShuffle } from '../game/dealing.js';
import { act, setHumans } from '../game/events.js';
import { isHumanSeat, newGame, resetGame, toLocal } from '../game/session.js';
import { owesReturn, retWait, tribOptions, tribWait } from '../game/tribute.js';
import { beginPlay, startTurn } from '../game/turns.js';
import { DIRS, absOf, lobbyStatus, nickNow, renderLobby } from '../lobby/lobby.js';
import { OLD_PAGE, ROOM_PREFIX, VERSION, peerReady } from './protocol.js';
import { VC } from './voice.js';
import { $ } from '../ui/cards.js';
import { hideOverlay, showPanel, showResult } from '../ui/overlays.js';
import { render, setMsg } from '../ui/table.js';

let SILENT_MS;

export function leaveNet() {
  VC.stop();
  try {
    runtime.network.peer && runtime.network.peer.destroy();
  } catch (_) {}
  runtime.network.peer = null;
  runtime.network.peerOpen = false;
  runtime.network.hostConn = null;
  runtime.network.refused = false;
  runtime.network.conns = new Map();
  runtime.network.inbox = [];
}

// the host: claims a free room number and keeps the seat list
export function openRoom() {
  if (!peerReady()) return;
  const code = String(1000 + ((Math.random() * 9000) | 0));
  const peer = new Peer(ROOM_PREFIX + code);
  runtime.network.peer = peer;
  lobbyStatus('正在开房间…');
  peer.on('open', () => {
    if (runtime.network.peer !== peer) return;
    runtime.network.peerOpen = true;
    runtime.network.code = code;
    $('#roomCodeShow').textContent = code;
    $('#roomInfo').hidden = false;
    lobbyStatus('把房间号告诉朋友，再选你的座位');
    renderLobby();
  });
  peer.on('error', (err) => {
    if (runtime.network.peer !== peer) return;
    if (err.type === 'unavailable-id') {
      peer.destroy();
      openRoom();
      return;
    }
    lobbyStatus('开房间失败，请检查网络后重试');
  });
  peer.on('call', (c) => VC.incoming(c));
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      if (runtime.network.started) {
        conn.send({ t: 'full' });
        setTimeout(() => conn.close(), 500);
        return;
      }
      runtime.network.conns.set(conn.peer, { conn, dir: '', name: '', seen: Date.now() });
      conn.send({
        t: 'lobby',
        seats: runtime.network.lobby,
        you: '',
        rules: runtime.rules,
        ver: VERSION,
      });
    });
    conn.on('data', (d) => hostOnData(conn, d));
    conn.on('close', () => hostOnClose(conn));
  });
}

export function broadcast(msg) {
  for (const v of runtime.network.conns.values()) if (v.conn.open) v.conn.send(msg);
}

export function broadcastLobby() {
  for (const v of runtime.network.conns.values())
    if (v.conn.open)
      v.conn.send({
        t: 'lobby',
        seats: runtime.network.lobby,
        you: v.dir,
        rules: runtime.rules,
        ver: VERSION,
      });
}

function hostOnData(conn, d) {
  const info = runtime.network.conns.get(conn.peer);
  if (!info || !d) return;
  info.seen = Date.now();
  if (d.t === 'bye') {
    hostOnClose(conn, 'quit');
    try {
      conn.close();
    } catch (_) {}
    return;
  }
  if (d.t === 'mic') {
    if (runtime.network.started && info.dir) {
      runtime.network.mics[absOf(info.dir, runtime.network.hostDir)] = !!d.on;
      broadcast({ t: 'mics', m: runtime.network.mics });
      VC.paint();
    }
    return;
  }
  if (d.t === 'sit' && !runtime.network.started) {
    if (!DIRS.includes(d.dir) || (runtime.network.lobby[d.dir] && info.dir !== d.dir)) return;
    if (info.dir) runtime.network.lobby[info.dir] = null;
    info.dir = d.dir;
    info.name =
      String(d.name || '')
        .replace(/[<>&"']/g, '')
        .slice(0, 8) || '玩家';
    runtime.network.lobby[d.dir] = info.name;
    broadcastLobby();
    renderLobby();
    if (d.ver && d.ver !== VERSION)
      lobbyStatus(`${info.name}的页面版本不同（${d.ver}），请他刷新页面`);
  }
  if (
    d.t === 'act' &&
    runtime.network.started &&
    info.dir &&
    !hostGuestAct(absOf(info.dir, runtime.network.hostDir), d.e || {}) &&
    conn.open
  )
    conn.send({ t: 'nope', k: (d.e || {}).k });
}

// a friend's move: only for their own seat, and a play must be legal, exactly what their own buttons check
// false when the move is refused (the friend's page is then told, so it does not keep waiting)
function hostGuestAct(seat, e) {
  if (!isHumanSeat(seat)) return false;
  switch (e.k) {
    case 'next':
      if (e.p !== seat) return false;
      break;
    case 'shuffle':
      if (runtime.game.shuffler !== seat) return false;
      break;
    case 'cut':
      if (runtime.game.cutter !== seat) return false;
      break;
    case 'pass':
      if (
        e.p !== seat ||
        runtime.game.phase !== 'play' ||
        runtime.game.turn !== seat ||
        !canPass(runtime.game.trick)
      )
        return false;
      break;
    case 'return':
      if (
        e.p !== seat ||
        !owesReturn(seat) ||
        !isReturnCard(
          runtime.game.hands[seat].find((card) => card.id === e.id),
          runtime.game.L,
        )
      )
        return false;
      break;
    case 'ready':
      if (e.p !== seat) return false;
      break;
    case 'pause':
      if (e.p !== seat || (runtime.game.paused && runtime.game.pausedBy !== seat)) return false;
      break;
    case 'tribute':
      if (
        e.p !== seat ||
        runtime.game.phase !== 'tribPick' ||
        !tribOptions(seat).some((c) => c.id === e.id)
      )
        return false;
      break;
    case 'play': {
      if (e.p !== seat || runtime.game.phase !== 'play' || runtime.game.turn !== seat) return false;
      const play = readPlay(runtime.game.hands[seat], e, runtime.game.trick?.play, runtime.game.L);
      if (!play) return false;
      e = { ...e, type: play.type, value: play.value, n: play.n };
      break;
    }
    default:
      return false;
  }
  act(e);
  return true;
}

function hostOnClose(conn, how = 'drop') {
  const info = runtime.network.conns.get(conn.peer);
  if (!info) return;
  runtime.network.conns.delete(conn.peer);
  if (!runtime.network.started) {
    if (info.dir) runtime.network.lobby[info.dir] = null;
    broadcastLobby();
    renderLobby();
    return;
  }
  if (!info.dir) return;
  // a friend who drops out mid-game: the computer takes over their seat from here on
  const seat = absOf(info.dir, runtime.network.hostDir);
  const list = [...runtime.network.humans].filter((h) => h !== seat);
  act({ k: 'humans', list, names: runtime.network.names, left: info.name, how });
  const c = runtime.game.clock;
  if (c && (c.who === seat || c.seat === seat)) {
    runtime.game.clock = null;
    timeUp(c);
  }
  if (owesReturn(seat))
    act({ k: 'return', p: seat, id: aiReturnCard(runtime.game.hands[seat], runtime.game.L).id });
  if (
    runtime.game.phase === 'tribPick' &&
    runtime.game.tribGivers.includes(seat) &&
    runtime.game.tribPick[seat] == null
  )
    act({ k: 'tribute', p: seat, id: tributeCard(runtime.game.hands[seat], runtime.game.L).id });
  if (
    runtime.game.phase === 'prep' &&
    [...runtime.network.humans].every((h) => runtime.game.ready.includes(h))
  )
    act({ k: 'begin' });
}

// the host starts: everyone learns where everyone sits, then the first deal goes out
export function startOnline() {
  runtime.network.started = true;
  runtime.network.hostDir = runtime.direction;
  const names = {};
  for (const d of DIRS)
    if (runtime.network.lobby[d]) names[absOf(d, runtime.direction)] = runtime.network.lobby[d];
  runtime.network.names = names;
  // each person's connection name, so the people at the table can call each other for voice
  const peers = { 0: runtime.network.peer.id };
  for (const v of runtime.network.conns.values())
    if (v.dir && runtime.network.lobby[v.dir]) peers[absOf(v.dir, runtime.direction)] = v.conn.peer;
  broadcast({ t: 'start', hostDir: runtime.direction, names, rules: runtime.rules, peers });
  enterOnline('host', runtime.direction, names);
  newGame();
  VC.start(peers);
}

function enterOnline(mode, hostDir, names) {
  runtime.network.mode = mode;
  runtime.network.off = absOf(runtime.direction, hostDir);
  setHumans(
    Object.keys(names).map((a) => toLocal(+a)),
    names,
  );
  $('#myName').textContent = runtime.nickname;
  $('#lobby').hidden = true;
}

// a friend: connects to the room number and follows the host
export function joinRoom(code) {
  if (!peerReady()) return;
  leaveNet();
  lobbyStatus('正在连接…');
  const peer = new Peer();
  runtime.network.peer = peer;
  peer.on('call', (c) => VC.incoming(c));
  peer.on('open', () => {
    if (runtime.network.peer !== peer) return;
    const conn = peer.connect(ROOM_PREFIX + code, { reliable: true });
    runtime.network.hostConn = conn;
    conn.on('open', () => {
      runtime.network.hostSeen = Date.now();
      lobbyStatus('选一个空座位');
      $('#roomCodeShow').textContent = code;
      $('#roomInfo').hidden = false;
      renderLobby();
    });
    conn.on('data', guestOnData);
    // (only the current line's closing counts: an old one closed on the way back in must not start another round)
    conn.on('close', () => {
      if (runtime.network.hostConn === conn) hostGone();
    });
  });
  peer.on('error', (err) => {
    if (runtime.network.peer !== peer) return;
    lobbyStatus(
      err.type === 'peer-unavailable' ? '没有这个房间，请核对房间号' : '连接失败，请检查网络后重试',
    );
    $('#joinBtn').disabled = false;
    $('#roomCode').classList.add('call');
  });
}

export function sendSit(d) {
  if (runtime.network.hostConn && runtime.network.hostConn.open)
    runtime.network.hostConn.send({ t: 'sit', dir: d, name: nickNow(), ver: VERSION });
}

function guestOnData(d) {
  if (!d) return;
  runtime.network.hostSeen = Date.now();
  if (d.t === 'ping') {
    runtime.network.hostConn &&
      runtime.network.hostConn.open &&
      runtime.network.hostConn.send({ t: 'pong' });
    return;
  }
  if (d.t === 'bye') {
    hostGone();
    return;
  }
  if (d.t === 'mics') {
    runtime.network.mics = d.m || {};
    VC.paint();
    return;
  }
  // the host turned a move down: stop waiting for it and let the player try again
  if (d.t === 'nope') {
    runtime.network.pending = false;
    if (['play', 'pass', 'return', 'tribute'].includes(d.k))
      setMsg('这一步没有成功，请再试一次', true);
    render();
    return;
  }
  if (d.t === 'lobby') {
    runtime.network.lobby = d.seats;
    runtime.direction = d.you || '';
    if (runtime.direction) {
      runtime.network.rejoinDir = null;
      runtime.network.rejoinTries = 0;
    }
    // back in after a broken line: the seat held before is taken again if it is still free
    else if (runtime.network.rejoinDir && !d.seats[runtime.network.rejoinDir]) {
      const r = runtime.network.rejoinDir;
      runtime.network.rejoinDir = null;
      sendSit(r);
    }
    if (d.rules) Object.assign(runtime.rules, d.rules);
    if (d.ver && d.ver !== VERSION) lobbyStatus(OLD_PAGE);
    else
      lobbyStatus(runtime.direction ? '已坐下，等待房主开始' : '选一个空座位', !!runtime.direction);
    renderLobby();
  } else if (d.t === 'full') {
    runtime.network.refused = true;
    lobbyStatus('这个房间已经开始打了');
  } else if (d.t === 'start') {
    if (!runtime.direction) return;
    runtime.nickname = nickNow();
    try {
      localStorage.setItem('guandan-nick', runtime.nickname);
    } catch (_) {}
    if (d.rules) Object.assign(runtime.rules, d.rules);
    enterOnline('guest', d.hostDir, d.names);
    resetGame();
    render();
    VC.start(d.peers);
  } else if (d.t === 'evt') {
    runtime.network.inbox.push(d.e);
  }
}

function hostGone() {
  if (runtime.network.gone) return;
  VC.stop();
  if (runtime.network.mode === 'guest') {
    runtime.network.gone = true;
    showPanel(`<h2>房主退出了游戏</h2><p class="muted">可以和电脑继续打完这一场，也可以退出。</p>
      <div class="btns"><button class="btn primary" id="soloOnBtn">和电脑继续打</button><button class="btn" id="backBtn">退出游戏</button></div>`);
    $('#soloOnBtn').onclick = goSolo;
    $('#backBtn').onclick = () => location.reload();
  } else if (runtime.lobbyMode === 'join') {
    if (runtime.network.refused) return;
    // the line to the room broke while waiting (the phone switched to another app, say): the page goes straight back
    // in and takes the same seat again, a few times at most, before asking the player to enter again
    if (runtime.network.lastCode && (runtime.network.rejoinTries || 0) < 3) {
      runtime.network.rejoinTries = (runtime.network.rejoinTries || 0) + 1;
      runtime.network.rejoinDir = runtime.direction || runtime.network.rejoinDir;
      runtime.direction = '';
      lobbyStatus('和房间断开了，正在重新连接…');
      renderLobby();
      joinRoom(runtime.network.lastCode);
      return;
    }
    runtime.network.hostConn = null;
    runtime.direction = '';
    lobbyStatus('和房间断开了，请重新进入');
    renderLobby();
    $('#joinBtn').disabled = false;
    $('#roomCode').classList.add('call');
  }
}

// the host left: this table carries on alone from wherever the game stood, the computer taking every other seat
function goSolo() {
  VC.stop();
  try {
    runtime.network.peer && runtime.network.peer.destroy();
  } catch (_) {}
  runtime.network.peer = null;
  runtime.network.hostConn = null;
  runtime.network.inbox = [];
  runtime.network.pending = false;
  runtime.network.mode = 'solo';
  runtime.network.off = 0;
  setHumans([0]);
  hideOverlay();
  const c = runtime.game.clock;
  runtime.game.clock = null;
  if (runtime.game.phase === 'shuffle' && !runtime.game.busy) startShuffle();
  else if (runtime.game.phase === 'cut' && !runtime.game.busy) startCut();
  else if (runtime.game.phase === 'return') retWait();
  else if (runtime.game.phase === 'tribPick') tribWait();
  else if (runtime.game.phase === 'prep') {
    if (runtime.game.ready.includes(0)) beginPlay();
    else {
      runtime.game.clock =
        c && c.who === 'prep' ? c : { who: 'prep', left: PREP_MS, total: PREP_MS };
      render();
    }
  } else if (runtime.game.phase === 'play' && runtime.game.turn >= 0) startTurn();
  else if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  render();
}

export function initialize() {
  // a closed tab or a lost phone signal is not always reported by the connection itself, so both ends say hello
  // every two seconds, and 20 seconds of silence counts as leaving
  SILENT_MS = 20000;
  setInterval(() => {
    const now = Date.now();
    for (const v of [...runtime.network.conns.values()]) {
      if (now - v.seen > SILENT_MS) {
        try {
          v.conn.close();
        } catch (_) {}
        hostOnClose(v.conn);
        continue;
      }
      if (v.conn.open) v.conn.send({ t: 'ping' });
    }
    if (
      runtime.network.hostConn &&
      runtime.network.hostSeen &&
      now - runtime.network.hostSeen > SILENT_MS
    ) {
      const c = runtime.network.hostConn;
      runtime.network.hostSeen = 0;
      try {
        c.close();
      } catch (_) {}
      hostGone();
    }
  }, 2000);
}
