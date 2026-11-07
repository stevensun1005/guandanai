import { runtime } from '../app/runtime.js';
import { act, setHumans } from '../game/events.js';
import { toLocal } from '../game/session.js';
import { startTurn } from '../game/turns.js';
import { absOf, lobbyStatus, renderLobby } from '../lobby/lobby.js';
import { botModelId } from '../ai/model-catalog.mjs';
import { $ } from '../ui/cards.js';
import { hideOverlay, setPaused, showPanel, showResult } from '../ui/overlays.js';
import { pileRebuild } from '../ui/table-pile.js';
import { render, setMsg } from '../ui/table.js';
import { broadcast, broadcastLobby, enterOnline, goSolo, joinRoom } from './rooms.js';
import { VERSION } from './protocol.js';
import { VC } from './voice.js';
import { forgetSeat, rememberSeat, savedSeat } from './rejoin-storage.js';
import { canResume, rotateSnapshot } from './snapshot.js';
import { voicePeers } from './spectators.js';

const reservations = new Map();
let retryTimer = 0;

export function resetReservations() {
  reservations.clear();
}

export function reserveSeat(info) {
  if (!info.token) info.token = crypto.randomUUID();
  for (const [token, reservation] of reservations)
    if (token !== info.token && reservation.dir === info.dir) reservations.delete(token);
  reservations.set(info.token, { dir: info.dir, name: info.name });
  info.conn.send({
    t: 'seat-session',
    code: runtime.network.code,
    token: info.token,
    dir: info.dir,
    name: info.name,
  });
}

export function releaseSeat(info) {
  if (info?.token) reservations.delete(info.token);
}

export function confirmReservations() {
  const seated = new Set(
    [...runtime.network.conns.values()]
      .filter((info) => info.dir && info.conn.open)
      .map((info) => info.token),
  );
  for (const token of reservations.keys()) if (!seated.has(token)) reservations.delete(token);
}

export function peerList() {
  return voicePeers();
}

function sendSnapshot(info, sync = false) {
  info.conn.send({
    t: 'resume',
    sync,
    game: structuredClone(runtime.game),
    humans: [...runtime.network.humans],
    names: runtime.network.names,
    hostDir: runtime.network.hostDir,
    you: info.dir,
    name: info.name,
    rules: runtime.rules,
    botModels: runtime.botModels,
    peers: peerList(),
  });
}

export function receiveSync(conn, message) {
  if (message.t !== 'sync') return false;
  const info = runtime.network.conns.get(conn.peer);
  if (
    !info?.dir ||
    !runtime.network.started ||
    info.syncing ||
    message.ver !== VERSION ||
    Date.now() - (info.lastSync || 0) < 8000
  )
    return true;
  info.syncing = true;
  info.lastSync = Date.now();
  const deadline = Date.now() + 20000;
  const send = () => {
    if (!conn.open || runtime.network.conns.get(conn.peer) !== info || Date.now() > deadline) {
      info.syncing = false;
      return;
    }
    if (!canResume(runtime.game)) {
      setTimeout(send, 100);
      return;
    }
    info.syncing = false;
    sendSnapshot(info, true);
  };
  send();
  return true;
}

/** Possession of an opaque tab-local credential restores only its original seat. */
export function receiveHello(conn, message) {
  if (message.t !== 'hello') return false;
  const info = runtime.network.conns.get(conn.peer);
  if (!info || info.resuming || info.dir) return true;
  const reservation = reservations.get(message.token);
  if (!runtime.network.started) {
    if (reservation && !runtime.network.lobby[reservation.dir]) {
      Object.assign(info, reservation, { token: message.token });
      runtime.network.lobby[info.dir] = info.name;
      reserveSeat(info);
      broadcastLobby();
      renderLobby();
    }
    return true;
  }
  const refuse = (reason) => {
    conn.send({ t: 'resume-refused', reason });
    setTimeout(() => conn.close(), 500);
  };
  if (!reservation) {
    refuse('seat');
    return true;
  }
  if (reservation.dir === runtime.network.hostDir) {
    refuse('seat');
    return true;
  }
  if (message.ver !== VERSION) {
    refuse('version');
    return true;
  }
  info.resuming = true;
  const deadline = Date.now() + 20000;
  const resume = () => {
    if (!conn.open || runtime.network.conns.get(conn.peer) !== info) return;
    if (!canResume(runtime.game)) {
      if (Date.now() < deadline) setTimeout(resume, 100);
      else refuse('busy');
      return;
    }
    // A refresh may open its new connection before the browser closes the old one.
    for (const old of [...runtime.network.conns.values()]) {
      if (old === info || old.token !== message.token) continue;
      runtime.network.conns.delete(old.conn.peer);
      old.conn.send({ t: 'seat-replaced' });
      old.conn.close();
    }
    Object.assign(info, reservation, { token: message.token, resuming: false });
    runtime.network.lobby[info.dir] = info.name;
    const seat = absOf(info.dir, runtime.network.hostDir);
    const humans = [...new Set([...runtime.network.humans, seat])];
    act({ k: 'humans', list: humans, names: runtime.network.names, joined: seat });
    reserveSeat(info);
    const peers = peerList();
    sendSnapshot(info);
    broadcast({ t: 'peers', peers });
    VC.start(peers);
    setMsg(`${info.name}已回到原座位`);
  };
  resume();
  return true;
}

export function receiveRecovery(message) {
  if (message.t === 'seat-session') {
    rememberSeat(message);
    return true;
  }
  if (message.t === 'hello') {
    runtime.network.hostConn?.send({
      t: 'hello',
      token: savedSeat(runtime.network.lastCode)?.token,
      ver: VERSION,
    });
    return true;
  }
  if (message.t === 'peers') {
    VC.start(message.peers);
    return true;
  }
  if (message.t === 'seat-replaced') {
    VC.stop();
    forgetSeat();
    runtime.network.gone = true;
    connectionFailed('这个座位已在另一个页面恢复。');
    return true;
  }
  if (message.t === 'resume-refused') {
    if (message.reason === 'seat') forgetSeat();
    runtime.network.refused = true;
    connectionFailed(
      message.reason === 'version'
        ? '页面版本与牌桌不同。请让所有人使用相同版本后重试。'
        : message.reason === 'busy'
          ? '牌桌暂时无法恢复，请稍后重试。'
          : '原座位无法恢复，房主可能已重新开局。',
    );
    return true;
  }
  if (message.t !== 'resume') return false;
  clearTimeout(retryTimer);
  const order = message.sync
    ? { myOrder: runtime.game.myOrder || [], fixed: runtime.game.fixed || [] }
    : { myOrder: [], fixed: [] };
  const selected = message.sync ? [...runtime.selection] : [];
  const tok = (runtime.game?.tok || 0) + 1;
  runtime.direction = message.you;
  runtime.nickname = message.name;
  Object.assign(runtime.rules, message.rules);
  runtime.botModels = Array.from({ length: 4 }, (_, index) =>
    botModelId(message.botModels?.[index]),
  );
  enterOnline('guest', message.hostDir, message.names);
  runtime.game = rotateSnapshot(message.game, runtime.network.off);
  runtime.network.startSettingsUsed = true;
  Object.assign(runtime.game, {
    tok,
    ...order,
    fresh: [],
    queuedPlay: false,
    notice: '',
  });
  if (runtime.game.clock) delete runtime.game.clock.think;
  runtime.network.inbox = [];
  runtime.network.pending = false;
  runtime.network.gone = false;
  runtime.network.refused = false;
  const held = new Set(runtime.game.hands[0].map((card) => card.id));
  runtime.selection = new Set(selected.filter((id) => held.has(id)));
  runtime.confirmation = null;
  setHumans(message.humans.map(toLocal), message.names);
  hideOverlay();
  pileRebuild();
  if (runtime.game.phase === 'play') {
    const clock = runtime.game.clock;
    startTurn();
    if (clock) runtime.game.clock = clock;
  }
  render();
  if (runtime.game.paused) setPaused(true, runtime.game.pausedBy);
  else if (['roundEnd', 'over'].includes(runtime.game.phase)) showResult();
  VC.start(message.peers);
  if (message.sync) runtime.network.syncCount = (runtime.network.syncCount || 0) + 1;
  setMsg(message.sync ? '牌桌已重新同步，继续打牌' : '已恢复原座位，继续打牌');
  return true;
}

export function reconnect() {
  clearTimeout(retryTimer);
  const code = runtime.network.lastCode || savedSeat()?.code;
  if (!code) {
    connectionFailed('没有可恢复的座位。');
    return;
  }
  showReconnectPanel('正在连接房主，等待同步当前牌局…');
  $('#reconnectBtn').disabled = true;
  joinRoom(code);
  retryTimer = setTimeout(
    () => connectionFailed('连接暂未恢复。请检查网络后重试，或由电脑继续。'),
    25000,
  );
}

export function connectionFailed(message) {
  clearTimeout(retryTimer);
  if (runtime.network.mode === 'guest') showReconnectPanel(message);
  else {
    lobbyStatus(message);
    $('#joinBtn').disabled = false;
  }
}

export function showReconnectPanel(message = '正在尝试恢复原座位；等待期间由电脑接管。') {
  showPanel(
    `<h2>连接中断</h2><p class="muted" id="reconnectMessage"></p><div class="btns"><button class="btn primary" id="reconnectBtn">重新连接</button><button class="btn" id="soloOnBtn">和电脑继续打</button><button class="btn" id="backBtn">退出游戏</button></div>`,
  );
  $('#reconnectMessage').textContent = message;
  $('#reconnectBtn').disabled = !savedSeat(runtime.network.lastCode);
  $('#reconnectBtn').onclick = reconnect;
  $('#soloOnBtn').onclick = () => {
    clearTimeout(retryTimer);
    forgetSeat();
    goSolo();
  };
  $('#backBtn').onclick = () => {
    forgetSeat();
    location.reload();
  };
}

export function initialize() {
  let head = null,
    since = 0,
    requested = 0;
  setInterval(() => {
    const network = runtime.network;
    const first =
      network.mode === 'guest' && !network.gone && network.hostConn?.open ? network.inbox[0] : null;
    if (first !== head) {
      head = first;
      since = Date.now();
    }
    if (head && Date.now() - since > 8000 && Date.now() - requested > 12000) {
      requested = Date.now();
      network.hostConn.send({ t: 'sync', ver: VERSION });
    }
  }, 500);
}
