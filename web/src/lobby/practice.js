import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { enterPractice } from '../replay/session.js';
import { nickNow, setMode } from './lobby.js';
import { prepareBotModels } from './bot-setup.js';
import { $ } from '../ui/cards.js';
import { openArrangement, initialize as initializeArrangement } from '../practice/arrangement.js';
import { leaveNet } from '../network/rooms.js';
import { forgetSeat } from '../network/rejoin-storage.js';
import { openEndgame, initialize as initializeEndgame } from '../practice/endgame.js';

export function initialize() {
  const dialog = $('#practiceDialog');
  initializeArrangement();
  initializeEndgame();
  $('#practiceBtn').onclick = () => {
    $('#practiceRoomNote').hidden = runtime.lobbyMode === 'solo';
    dialog.showModal();
  };
  $('#practiceStart').onclick = () => {
    const nickname = nickNow() || '练习者';
    if (runtime.lobbyMode !== 'solo') setMode('solo');
    runtime.nickname = nickname;
    runtime.direction = 'S';
    prepareBotModels();
    Sound.unlock();
    dialog.close();
    enterPractice();
  };
  $('#practiceArrange').onclick = () => {
    leaveNet();
    forgetSeat();
    if (runtime.lobbyMode !== 'solo') setMode('solo');
    Sound.unlock();
    dialog.close();
    $('#lobby').hidden = true;
    openArrangement(() => {
      $('#lobby').hidden = false;
      dialog.showModal();
    });
  };
  $('#practiceEndgame').onclick = () => {
    leaveNet();
    forgetSeat();
    if (runtime.lobbyMode !== 'solo') setMode('solo');
    Sound.unlock();
    dialog.close();
    $('#lobby').hidden = true;
    openEndgame(() => {
      $('#lobby').hidden = false;
      dialog.showModal();
    });
  };
}
