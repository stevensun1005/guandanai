import { renderLevelPicker } from './level.js';
import { runtime } from '../app/runtime.js';
import { readGuestProgress, readMatch, sameMatchStart } from '../collection/match-link.mjs';
import { rankName } from '../core/cards.js';
import { renderLobby } from './lobby.js';
import { broadcastLobby } from '../network/rooms.js';

const choices = [
  ['continueMatch', readMatch, '继续上一场'],
  ['continueGuestMatch', readGuestProgress, '继续好友牌局'],
];

export function renderContinueMatch() {
  for (const [id, read, label] of choices) {
    const button = document.getElementById(id);
    const saved = read(localStorage);
    button.hidden = runtime.lobbyMode === 'join' || !saved;
    if (!saved) continue;
    const ready =
      runtime.pendingContinuation?.id === saved.id && sameMatchStart(saved, runtime.rules);
    button.textContent = `${ready ? '已准备继续' : label} · 南北${rankName(saved.state.levels.SN)}／东西${rankName(saved.state.levels.EW)} · 第${saved.nextRound}局`;
  }
}

export function initialize() {
  for (const [id, read] of choices) {
    document.getElementById(id).onclick = () => {
      const saved = read(localStorage);
      if (!saved || runtime.lobbyMode === 'join') return;
      // Guest progress restores the public rules without adopting another room's collection identity.
      runtime.pendingContinuation = saved.id ? saved : null;
      runtime.rules.startState = structuredClone(saved.state);
      runtime.rules.trib = saved.rules.trib;
      runtime.rules.aFail = saved.rules.aFail;
      renderLobby();
      renderLevelPicker();
      if (runtime.lobbyMode === 'host') broadcastLobby();
    };
  }
}
