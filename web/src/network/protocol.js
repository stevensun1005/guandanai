import { runtime } from '../app/runtime.js';
import { lobbyStatus } from '../lobby/lobby.js';
import { $ } from '../ui/cards.js';

export let ROOM_PREFIX;
export let VERSION;
export let OLD_PAGE;
export let peerReady;

export function versionsMatch(clients, version) {
  return [...clients].every((info) => !info.dir || info.version === version);
}

export function initialize() {
  /* ---------- connections (PeerJS: browsers talk to each other directly, matched by the room number) ---------- */
  ROOM_PREFIX = 'guandanai-room-';
  VERSION = __BUILD_VERSION__;
  $('#verTag').textContent = VERSION === 'dev' ? '' : '版本 ' + VERSION;
  OLD_PAGE = '页面版本和房主不同，请刷新页面（电脑按 Ctrl+F5）后重新加入';
  peerReady = () => {
    if (window.Peer && /^https?:$/.test(location.protocol)) return true;
    lobbyStatus('联机请通过发布后的网页网址打开');
    return false;
  };
}

export function signalBack(peer = runtime.network.peer) {
  if (!peer || peer !== runtime.network.peer || peer.destroyed || !peer.disconnected) return;
  try {
    peer.reconnect();
  } catch {}
}
export function keepSignal(peer) {
  let tries = 0,
    timer;
  peer.on('open', () => {
    tries = 0;
  });
  peer.on('disconnected', () => {
    clearTimeout(timer);
    timer = setTimeout(() => signalBack(peer), Math.min(30000, 1000 * 2 ** tries++));
  });
}
