import { runtime } from '../app/runtime.js';
import { $ } from '../ui/cards.js';
import { VERSION, ROOM_PREFIX, peerReady } from './protocol.js';
import { readHost, writeHost, clearHost } from './host-storage.mjs';
import { leaveNet, listenHost, enterOnline } from './rooms.js';
import { snapshotReservations, restoreReservations } from './recovery.js';
import { snapshotRecord, restoreRecord } from '../collection/record.mjs';
import { snapshotMatch, restoreMatch } from '../collection/match-link.mjs';
import { privateWasUsed, restorePrivateUse } from '../private-table/state.mjs';
import { setHumans } from '../game/events.js';
import { startShuffle, startCut, finishDeal } from '../game/dealing.js';
import { runGives, tribWait, retWait } from '../game/tribute.js';
import { startTurn } from '../game/turns.js';
import { TableBot } from '../ai/controller.js';
import { pileRebuild } from '../ui/table-pile.js';
import { hideOverlay, showResult, setPaused } from '../ui/overlays.js';
import { render, setMsg } from '../ui/table.js';
import { lobbyStatus } from '../lobby/lobby.js';
let quitting = false;
export function forgetHost() {
  quitting = true;
  clearHost(localStorage);
}
export function saveHost() {
  const game = runtime.game,
    net = runtime.network;
  if (
    quitting ||
    net.mode !== 'host' ||
    !net.started ||
    !net.peerOpen ||
    !net.peer ||
    runtime.reviewMode ||
    !game ||
    game.phase === 'start'
  )
    return;
  if (game.phase === 'over') {
    clearHost(localStorage);
    return;
  }
  writeHost(localStorage, {
    version: VERSION,
    code: net.code,
    direction: runtime.direction,
    nickname: runtime.nickname,
    hostDir: net.hostDir,
    names: net.names,
    rules: runtime.rules,
    botModels: runtime.botModels,
    botPreferences: runtime.botPreferences,
    game,
    reservations: snapshotReservations(),
    record: snapshotRecord(game),
    match: snapshotMatch(game),
    privateUsed: privateWasUsed(game),
  });
}
function resume(saved) {
  const net = runtime.network;
  net.started = true;
  net.names = saved.names;
  net.hostDir = saved.hostDir;
  net.startSettingsUsed = true;
  runtime.game = {
    ...saved.game,
    tok: (saved.game.tok || 0) + 1,
    busy: false,
    queuedPlay: false,
    fresh: [],
    stepWait: null,
  };
  const game = runtime.game;
  runtime.botModels = saved.botModels;
  runtime.botPreferences = saved.botPreferences;
  enterOnline('host', saved.hostDir, saved.names);
  // Friends reclaim their original opaque token; bots handle their seats meanwhile.
  setHumans([0], saved.names);
  restoreReservations(saved.reservations);
  restoreMatch(game, saved.match);
  restoreRecord(game, saved.record, Date.now() - saved.savedAt);
  restorePrivateUse(game, saved.privateUsed);
  runtime.selection = new Set();
  runtime.confirmation = null;
  runtime.privateTable = false;
  hideOverlay();
  TableBot.init();
  pileRebuild();
  const clock = game.clock;
  game.clock = null;
  if (game.phase === 'shuffle') startShuffle();
  else if (game.phase === 'cut') startCut();
  else if (game.phase === 'deal') {
    // Complete the same rotating deal, including cards that were in flight when saved.
    for (let n = game.hands.reduce((s, h) => s + h.length, 0); n < 108 && game.deck.length; n++)
      game.hands[(game.dealIdx + n) % 4].push(game.deck.pop());
    finishDeal();
  } else if (game.phase === 'tribute') void runGives();
  else if (game.phase === 'tribPick') tribWait();
  else if (game.phase === 'return') retWait();
  else if (game.phase === 'prep') game.clock = clock;
  else if (game.phase === 'play') {
    if (game.turn === -1) {
      if (!game.tribHold) {
        game.heapN += (game.trickPlays || []).reduce((s, t) => s + t.play.cards.length, 0);
        game.trickPlays = [];
        game.trick = null;
        game.passes = 0;
        game.last = [null, null, null, null];
      }
      game.turn = game.nextLeader ?? game.leader ?? 0;
      game.tribHold = false;
    }
    startTurn();
    if (clock?.who === game.turn && game.turn === 0) game.clock = clock;
  } else if (game.phase === 'roundEnd') {
    game.reveal = 4;
    render();
    showResult();
  }
  render();
  if (game.paused) setPaused(true, game.pausedBy);
  saveHost();
  setMsg(`已恢复房间 ${saved.code}，朋友可回到原座位`);
}
export function restoreHost() {
  const saved = readHost(localStorage, VERSION);
  if (!saved || !peerReady()) return false;
  leaveNet();
  quitting = false;
  runtime.direction = saved.direction;
  runtime.nickname = saved.nickname;
  $('#nick').value = saved.nickname;
  runtime.rules = saved.rules;
  runtime.lobbyMode = 'host';
  runtime.network.mode = 'host';
  let tries = 0;
  const open = () => {
    const peer = new Peer(ROOM_PREFIX + saved.code);
    runtime.network.peer = peer;
    lobbyStatus(`正在恢复房间 ${saved.code}…`, true);
    peer.on('open', () => {
      if (runtime.network.peer !== peer) return;
      const latest = readHost(localStorage, VERSION);
      if (!latest || latest.code !== saved.code) {
        peer.destroy();
        lobbyStatus('原牌局已结束或已退出，不再恢复。');
        return;
      }
      runtime.network.peerOpen = true;
      runtime.network.code = saved.code;
      runtime.rules = latest.rules;
      resume(latest);
    });
    peer.on('error', (error) => {
      if (runtime.network.peer !== peer) return;
      if (error.type === 'unavailable-id' && ++tries <= 24) {
        peer.destroy();
        setTimeout(() => {
          if (runtime.network.peer === peer) open();
        }, 2500);
        return;
      }
      lobbyStatus('暂时无法恢复原房间，请稍后刷新重试；原存档保留。');
    });
    listenHost(peer);
  };
  open();
  return true;
}
export function initialize() {
  setInterval(saveHost, 3000);
  addEventListener('pagehide', saveHost);
}
