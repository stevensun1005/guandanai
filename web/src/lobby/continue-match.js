import { renderLevelPicker } from './level.js';
import { runtime } from '../app/runtime.js';
import { readMatch, sameMatchStart } from '../collection/match-link.mjs';
import { rankName } from '../core/cards.js';
import { renderLobby } from './lobby.js';
import { broadcastLobby } from '../network/rooms.js';
export function renderContinueMatch() {
  const button = document.querySelector('#continueMatch'),
    saved = readMatch(localStorage);
  button.hidden = runtime.lobbyMode === 'join' || !saved;
  if (!saved) return;
  const ready =
    runtime.pendingContinuation?.id === saved.id && sameMatchStart(saved, runtime.rules);
  button.textContent = `${ready ? '已准备继续' : '继续上一场'} · 南北${rankName(saved.state.levels.SN)}／东西${rankName(saved.state.levels.EW)} · 第${saved.nextRound}局`;
}
export function initialize() {
  document.querySelector('#continueMatch').onclick = () => {
    const saved = readMatch(localStorage);
    if (!saved || runtime.lobbyMode === 'join') return;
    runtime.pendingContinuation = saved;
    runtime.rules.startState = structuredClone(saved.state);
    runtime.rules.trib = saved.rules.trib;
    runtime.rules.aFail = saved.rules.aFail;
    renderLobby();
    renderLevelPicker();
    if (runtime.lobbyMode === 'host') broadcastLobby();
  };
}
