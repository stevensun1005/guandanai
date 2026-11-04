import { runtime } from './runtime.js';
import { TableBot } from '../ai/controller.js';
import { boot } from './restore.js';
import { lobbyStatus, setMode } from '../lobby/lobby.js';
import { $ } from '../ui/cards.js';

let invitedRoom;

export function initialize() {
  $('#shareRoomBtn').onclick = async () => {
    if (!runtime.network.code) return;
    const url = new URL(location.href);
    url.searchParams.set('room', runtime.network.code);
    url.hash = '';
    try {
      await navigator.clipboard.writeText(url.href);
      lobbyStatus('邀请链接已复制，发给朋友即可');
    } catch (_) {
      lobbyStatus('邀请链接：' + url.href);
    }
  };
  TableBot.init();
  boot();
  invitedRoom = new URLSearchParams(location.search).get('room');
  if (/^\d{4}$/.test(invitedRoom || '')) {
    setMode('join');
    $('#roomCode').value = invitedRoom;
    lobbyStatus('输入昵称，然后点「进入」加入朋友的牌桌');
  }
}
