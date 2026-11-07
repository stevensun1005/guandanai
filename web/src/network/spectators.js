import { runtime } from '../app/runtime.js';
import { cardHTML, $ } from '../ui/cards.js';
import { setMsg } from '../ui/table.js';
import { rankName } from '../core/cards.js';
import { lobbyStatus, nickNow } from '../lobby/lobby.js';
import { VERSION, OLD_PAGE } from './protocol.js';
import { joinRoom, leaveNet, broadcast } from './rooms.js';
import { VC } from './voice.js';
import { publicTable, validPublicTable } from './public-table.mjs';

const viewers = () => runtime.network.spectators;
const mutedIds = () => [...viewers().values()].filter((v) => v.muted).map((v) => v.sid);

export function voicePeers() {
  const peers = { 0: runtime.network.peer?.id };
  const dirs = ['S', 'E', 'N', 'W'];
  const host = dirs.indexOf(runtime.network.hostDir || runtime.direction);
  for (const v of runtime.network.conns.values())
    if (v.dir && v.conn.open)
      peers[(dirs.indexOf(v.dir) - Math.max(0, host) + 4) % 4] = v.conn.peer;
  for (const v of viewers().values()) if (v.conn.open) peers[v.sid] = v.conn.peer;
  return peers;
}

export function updateSpectatorVoice() {
  if (!runtime.network.peer) return;
  const peers = voicePeers(),
    ids = mutedIds();
  broadcast({ t: 'vpeers', peers });
  broadcast({ t: 'vmuted', ids });
  broadcast({ t: 'mics', m: runtime.network.mics });
  VC.start(peers);
  VC.setMuted(ids);
}

export function relaySpectators(message) {
  if (!['bye', 'mics', 'vpeers', 'peers', 'vmuted'].includes(message.t)) return;
  for (const v of viewers().values())
    if (v.conn.open) v.conn.send(message.t === 'bye' ? { t: 'watch-ended' } : message);
}

export function acceptSpectator(conn, info, message) {
  if (info.dir || message.ver !== VERSION || viewers().size >= 6) {
    conn.send({
      t: 'watch-error',
      message:
        message.ver !== VERSION
          ? OLD_PAGE
          : info.dir
            ? '已入座的玩家不能同时作为观众'
            : '观战人数已满，请稍后再试',
    });
    if (!info.dir) {
      runtime.network.conns.delete(conn.peer);
      setTimeout(() => conn.close(), 100);
    }
    return;
  }
  runtime.network.conns.delete(conn.peer);
  const name =
    String(message.name || '观众')
      .replace(/[<>&"']/g, '')
      .slice(0, 8) || '观众';
  const sid = (runtime.network.spectatorSequence = (runtime.network.spectatorSequence || 9) + 1);
  viewers().set(conn.peer, { conn, name, sid, seen: Date.now(), muted: false });
  const notice = `${name} 来观战（现在 ${viewers().size} 人观战）`;
  if (runtime.network.started) setMsg(notice);
  else lobbyStatus(notice);
  conn.send({
    t: 'watch-open',
    sid,
    code: runtime.network.code,
    peers: voicePeers(),
    mics: runtime.network.mics,
    muted: mutedIds(),
  });
  sendPublicTables();
  updateSpectatorVoice();
  syncRoomOptions();
}

export function spectatorData(conn, message) {
  const viewer = viewers().get(conn.peer);
  if (!viewer || viewer.conn !== conn) return false;
  viewer.seen = Date.now();
  // Spectators cannot sit, recover credentials, play, emote as a player, or send coach actions.
  if (message?.t === 'mic') {
    runtime.network.mics[viewer.sid] = !!message.on && !viewer.muted;
    broadcast({ t: 'mics', m: runtime.network.mics });
  }
  if (message?.t === 'bye') {
    closeSpectator(conn);
    conn.close();
  }
  return true;
}

export function closeSpectator(conn) {
  const viewer = viewers().get(conn.peer);
  if (!viewer || viewer.conn !== conn) return false;
  viewers().delete(conn.peer);
  if (runtime.network.started) setMsg(`${viewer.name} 离开了观战`);
  delete runtime.network.mics[viewer.sid];
  updateSpectatorVoice();
  syncRoomOptions();
  return true;
}

export function resetSpectators() {
  for (const viewer of viewers()?.values() || [])
    if (viewer.conn.open) viewer.conn.send({ t: 'watch-ended' });
  runtime.network.spectators = new Map();
  runtime.network.watching = false;
  runtime.network.spectatorId = null;
  document.body.classList.remove('spectating');
  $('#spectatorView').hidden = true;
}

function sendPublicTables() {
  if (runtime.network.mode !== 'host' || !runtime.network.started || !viewers().size) return;
  const table = publicTable(runtime.game, runtime.network.names, runtime.network.humans);
  for (const viewer of viewers().values())
    if (viewer.conn.open) viewer.conn.send({ t: 'public-table', table });
}

export function syncRoomOptions() {
  const code =
    runtime.network.mode === 'host'
      ? runtime.network.code
      : runtime.network.mode === 'guest'
        ? runtime.network.lastCode
        : '';
  $('#roomOpt').hidden = !code;
  $('#roomOptNum').textContent = code || '';
  const box = $('#spectatorVoices');
  box.replaceChildren();
  box.hidden = runtime.network.mode !== 'host' || !viewers().size;
  if (box.hidden) return;
  for (const viewer of viewers().values()) {
    const button = document.createElement('button');
    button.className = 'link';
    button.type = 'button';
    button.textContent = `${viewer.name} · 语音${viewer.muted ? '已关闭' : '允许'}`;
    button.setAttribute('aria-pressed', String(!viewer.muted));
    button.onclick = (event) => {
      event.stopPropagation();
      viewer.muted = !viewer.muted;
      if (viewer.muted) runtime.network.mics[viewer.sid] = false;
      if (viewer.conn.open) viewer.conn.send({ t: 'vmute', off: viewer.muted });
      updateSpectatorVoice();
      syncRoomOptions();
    };
    box.append(button);
  }
}

export function spectatorGone(message = '和房间的连接断开，观战已结束。') {
  VC.stop();
  if (runtime.network.mode === 'spectator') {
    $('#spectatorStatus').textContent = message;
    $('#spectatorStatus').classList.add('ended');
  } else {
    leaveNet();
    lobbyStatus(message);
    $('#spectatorGo').disabled = false;
  }
}

export function spectatorMessage(message) {
  if (!message) return;
  runtime.network.hostSeen = Date.now();
  if (message.t === 'ping') {
    runtime.network.hostConn?.send({ t: 'pong' });
    return;
  }
  if (message.t === 'watch-error') {
    spectatorGone(message.message);
    return;
  }
  if (message.t === 'watch-ended' || message.t === 'bye') {
    spectatorGone('房主已退出，观战结束。');
    return;
  }
  if (message.t === 'watch-open') {
    runtime.network.mode = 'spectator';
    runtime.network.spectatorId = message.sid;
    runtime.network.off = 0;
    runtime.network.mics = message.mics || {};
    document.body.classList.add('spectating');
    $('#lobby').hidden = true;
    $('#spectatorView').hidden = false;
    $('#spectatorRoom').textContent = message.code;
    $('#spectatorStatus').textContent = '已连接，等待房主开始牌局…';
    VC.start(message.peers);
    VC.setMuted(message.muted || []);
  }
  if (message.t === 'vpeers' || message.t === 'peers') VC.start(message.peers);
  if (message.t === 'vmuted') VC.setMuted(message.ids || []);
  if (message.t === 'vmute') VC.lock(!!message.off);
  if (message.t === 'mics') {
    runtime.network.mics = message.m || {};
    VC.paint();
  }
  if (message.t === 'public-table' && runtime.network.mode === 'spectator')
    renderPublicTable(message.table);
}

function renderPublicTable(table) {
  if (!validPublicTable(table)) {
    spectatorGone('观战牌面格式无效，请重新进入。');
    return;
  }
  runtime.network.humans = new Set(table.players.filter((p) => p.human).map((p) => p.seat));
  VC.prune();
  const phase = {
    start: '等待开始',
    shuffle: '洗牌',
    cut: '切牌',
    deal: '发牌',
    prep: '理牌',
    play: '出牌',
    return: '还贡',
    tribPick: '进贡',
    roundEnd: '本局结束',
    over: '整场结束',
  };
  $('#spectatorStatus').textContent = table.paused
    ? '牌局暂停'
    : `第 ${table.round} 局 · ${phase[table.phase] || table.phase} · 打 ${rankName(table.level)}`;
  $('#spectatorScore').textContent =
    `1／3号 ${rankName(table.levels[0])} 级　2／4号 ${rankName(table.levels[1])} 级`;
  const seats = $('#spectatorSeats');
  for (const player of table.players) {
    let panel = seats.querySelector(`[data-watch-seat="${player.seat}"]`);
    if (!panel) {
      panel = document.createElement('section');
      panel.dataset.watchSeat = player.seat;
      panel.innerHTML =
        '<header><strong></strong><span></span></header><div class="watch-last"></div>';
      seats.append(panel);
    }
    panel.classList.toggle('turn', table.phase === 'play' && table.turn === player.seat);
    panel.querySelector('strong').textContent = `${player.seat + 1}号 ${player.name}`;
    panel.querySelector('strong').title = `${player.seat + 1}号 ${player.name}`;
    const place = table.out.indexOf(player.seat);
    panel.querySelector('header span').textContent =
      place >= 0 ? `第 ${place + 1} 名` : `剩 ${player.count} 张`;
    panel.querySelector('.watch-last').innerHTML =
      player.last === 'pass'
        ? '<span class="watch-pass">过</span>'
        : player.last?.cards.map((c) => cardHTML(c, table.level)).join('') || '';
  }
  const log = $('#spectatorLog'),
    signature = `${table.round}:${table.log.length}`;
  if (log.dataset.signature !== signature) {
    log.dataset.signature = signature;
    log.replaceChildren();
    table.log.forEach((entry, index) => {
      const row = document.createElement('li');
      row.innerHTML = `<b>${index + 1} · ${entry.seat + 1}号</b><span>${entry.cards ? entry.cards.map((c) => cardHTML(c, table.level)).join('') : '<i class="watch-pass">过</i>'}</span>`;
      log.append(row);
    });
    log.scrollTop = log.scrollHeight;
  }
}

export function initialize() {
  $('#spectatorBtn').onclick = () => {
    $('#spectatorRow').hidden = !$('#spectatorRow').hidden;
    if (!$('#spectatorRow').hidden) $('#spectatorCode').focus();
  };
  $('#spectatorGo').onclick = () => {
    const code = $('#spectatorCode').value.replace(/\D/g, '');
    if (!/^\d{4}$/.test(code)) {
      lobbyStatus('输入 4 位房间号');
      return;
    }
    runtime.nickname = nickNow() || '观众';
    $('#spectatorGo').disabled = true;
    joinRoom(code, true);
  };
  $('#spectatorCode').onkeydown = (event) => {
    if (event.key === 'Enter') $('#spectatorGo').click();
  };
  $('#spectatorBack').onclick = () => location.reload();
  $('#spectatorMic').onclick = () => VC.toggle();
  setInterval(sendPublicTables, 1000);
}
