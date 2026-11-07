import { runtime } from '../app/runtime.js';
import { cardText, sortHand } from '../core/cards.js';
import { $ } from '../ui/cards.js';
import { render } from '../ui/table.js';
import { renderLobby } from '../lobby/lobby.js';
import { TableBot } from '../ai/controller.js';
import { privateEligible, privateActive, markPrivateTable, privateWasUsed } from './state.mjs';
import { excludeMatch } from '../collection/match-link.mjs';

function markUsed() {
  markPrivateTable(runtime);
  if (privateWasUsed(runtime.game))
    excludeMatch(runtime.game, localStorage, runtime.pendingContinuation, runtime.rules);
}

export function setPrivateTable(value) {
  const mode = $('#lobby').hidden ? runtime.network.mode : runtime.lobbyMode;
  const nickname = $('#lobby').hidden ? runtime.nickname : $('#nick').value.trim();
  runtime.privateTable = value === true && privateEligible(mode, nickname);
  runtime.privateEpoch = (runtime.privateEpoch || 0) + 1;
  if (runtime.privateTable && innerWidth >= 1400) $('#privateHands').open = true;
  markUsed();
  if (privateWasUsed(runtime.game)) {
    $('#collectionStatus').hidden = false;
    $('#collectionStatus').textContent = '本场牌谱未参与采集';
  }
  TableBot.cancelTurn();
  if (!$('#lobby').hidden) renderLobby();
  render();
  const clock = runtime.game?.clock;
  if (
    runtime.game?.phase === 'play' &&
    Number.isInteger(clock?.who) &&
    !runtime.network.humans.has(clock.who) &&
    runtime.network.mode === 'host'
  )
    void TableBot.playTurn(clock);
}

export function renderPrivateTable() {
  const eligible = privateEligible(runtime.network.mode, runtime.nickname);
  const toggle = $('#privateTableToggle');
  toggle.hidden = !eligible;
  toggle.textContent = runtime.privateTable ? '明牌工具：开' : '明牌工具：关';
  toggle.setAttribute('aria-pressed', String(privateActive(runtime)));
  const panel = $('#privateHands'),
    game = runtime.game;
  panel.hidden = !(
    privateActive(runtime) &&
    game &&
    ['prep', 'return', 'tribPick', 'play', 'roundEnd', 'over'].includes(game.phase)
  );
  document.body.classList.toggle('has-private', !panel.hidden);
  if (panel.hidden) {
    $('#privateHandRows').replaceChildren();
    delete panel.dataset.position;
    return;
  }
  markUsed();
  $('#collectionStatus').hidden = false;
  $('#collectionStatus').textContent = '本场牌谱未参与采集';
  const top = Math.max(65, Math.ceil($('.score').getBoundingClientRect().bottom + 12));
  panel.style.top = `${top}px`;
  const height = Math.min(
    innerHeight - top - 16,
    innerWidth >= 1400 ? innerHeight : innerHeight * 0.45,
  );
  panel.style.maxHeight = `${Math.max(60, height)}px`;
  const signature = `${game.tok}|${game.L}|${runtime.names.join('|')}|${game.hands.map((hand) => hand.map((c) => c.id).join(',')).join('|')}`;
  if (panel.dataset.position === signature) return;
  panel.dataset.position = signature;
  const rows = [];
  for (const seat of [2, 3, 1]) {
    const row = document.createElement('section'),
      title = document.createElement('strong');
    title.textContent = `${runtime.names[seat]} · ${game.hands[seat].length} 张`;
    row.append(title);
    const cards = document.createElement('div');
    cards.className = 'private-cards';
    for (const card of sortHand(game.hands[seat].slice(), game.L)) {
      const span = document.createElement('span');
      span.className = 'coach-card';
      span.classList.toggle('red', card.s === 'H' || card.s === 'D' || card.r === 17);
      span.textContent = cardText(card);
      cards.append(span);
    }
    if (!cards.childElementCount) cards.textContent = '已走完';
    row.append(cards);
    rows.push(row);
  }
  $('#privateHandRows').replaceChildren(...rows);
}

export function initialize() {
  runtime.privateTable = false;
  runtime.privateEpoch = 0;
  $('#privateTableAllowed').onchange = () => setPrivateTable($('#privateTableAllowed').checked);
  $('#privateTableToggle').onclick = () => setPrivateTable(!runtime.privateTable);
  $('#privateHandsClose').onclick = () => {
    $('#privateHands').open = false;
  };
  $('#privateHands').addEventListener('toggle', () => {
    if ($('#privateHands').open && innerWidth < 1400)
      document.dispatchEvent(new CustomEvent('coach-collapse-suggestions'));
  });
  addEventListener('resize', () => {
    if (innerWidth < 1400) $('#privateHands').open = false;
  });
}
