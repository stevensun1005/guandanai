import { runtime } from './runtime.js';
import { lobbyStatus, setMode, showStart } from '../lobby/lobby.js';
import { $ } from '../ui/cards.js';
import { savedSeat } from '../network/rejoin-storage.js';

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
  showStart();
  invitedRoom = new URLSearchParams(location.search).get('room');
  const previous = savedSeat(invitedRoom);
  if (!invitedRoom && previous) invitedRoom = previous.code;
  if (/^\d{4}$/.test(invitedRoom || '')) {
    setMode('join');
    $('#roomCode').value = invitedRoom;
    lobbyStatus('输入昵称，然后点「进入」加入朋友的牌桌');
    if (previous) {
      $('#nick').value = previous.name;
      $('#joinBtn').click();
      lobbyStatus('正在恢复原来的座位…');
    }
  }
}
