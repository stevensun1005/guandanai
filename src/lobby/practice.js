import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { enterPractice } from '../replay/session.js';
import { nickNow, setMode } from './lobby.js';
import { prepareBotStyles } from './bot-setup.js';
import { $ } from '../ui/cards.js';

export function initialize() {
  const dialog = $('#practiceDialog');
  $('#practiceBtn').onclick = () => {
    $('#practiceRoomNote').hidden = runtime.lobbyMode === 'solo';
    dialog.showModal();
  };
  $('#practiceStart').onclick = () => {
    const nickname = nickNow() || '练习者';
    if (runtime.lobbyMode !== 'solo') setMode('solo');
    runtime.nickname = nickname;
    runtime.direction = 'S';
    prepareBotStyles();
    Sound.unlock();
    dialog.close();
    enterPractice();
  };
}
