import { runtime } from '../app/runtime.js';
import { BOT_MODELS, DEFAULT_BOT_MODEL, botModelId } from '../ai/model-catalog.mjs';
import { broadcastLobby } from '../network/rooms.js';
import { $ } from '../ui/cards.js';

const directions = ['S', 'E', 'N', 'W'];
const names = { S: '南', E: '东', N: '北', W: '西' };

export function normalizeBotPreferences(input) {
  return Object.fromEntries(
    directions.map((direction) => [direction, botModelId(input?.[direction])]),
  );
}

export function loadBotPreferences() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('guandan-bot-models') || '{}');
  } catch (_) {}
  runtime.botPreferences = normalizeBotPreferences(saved);
}

export function prepareBotModels() {
  const start = Math.max(0, directions.indexOf(runtime.direction));
  runtime.botModels = Array.from({ length: 4 }, (_, index) =>
    botModelId(runtime.botPreferences?.[directions[(start + index) % 4]]),
  );
}

function save() {
  try {
    localStorage.setItem('guandan-bot-models', JSON.stringify(runtime.botPreferences));
  } catch (_) {}
  if (runtime.lobbyMode === 'host') broadcastLobby();
  renderBotSetup();
}

export function renderBotSetup() {
  const joining = runtime.lobbyMode === 'join';
  for (const select of document.querySelectorAll('[data-bot-seat]')) {
    const direction = select.dataset.botSeat;
    const human =
      direction === runtime.direction ||
      (runtime.lobbyMode !== 'solo' && runtime.network.lobby[direction]);
    select.value = botModelId(runtime.botPreferences?.[direction]);
    select.disabled = joining || !!human;
    select.closest('label').classList.toggle('human-seat', !!human);
    select.closest('label').querySelector('small').textContent = human ? '玩家座位' : '电脑空位';
  }
  $('#mixedBotsBtn').disabled = joining;
  $('#botSetupNote').textContent = joining
    ? '由房主设置；玩家离开后的空位沿用对应模型。'
    : `仅影响电脑空位。新玩家默认使用 ${DEFAULT_BOT_MODEL}，可按编号选择已发布模型。`;
}

export function initialize() {
  loadBotPreferences();
  runtime.botModels = Array(4).fill(DEFAULT_BOT_MODEL);
  $('#botSetupRows').innerHTML = directions
    .map(
      (direction) =>
        `<label class="bot-setup-row"><span>${names[direction]}位 <small>电脑空位</small></span><select data-bot-seat="${direction}" aria-label="${names[direction]}位电脑模型">${BOT_MODELS.map((model) => `<option value="${model.id}">${model.id}</option>`).join('')}</select></label>`,
    )
    .join('');
  $('#botSetupRows').addEventListener('change', (event) => {
    const select = event.target.closest('[data-bot-seat]');
    if (!select || select.disabled || runtime.lobbyMode === 'join') return;
    runtime.botPreferences[select.dataset.botSeat] = botModelId(select.value);
    save();
  });
  $('#mixedBotsBtn').onclick = () => {
    if (runtime.lobbyMode === 'join') return;
    runtime.botPreferences = normalizeBotPreferences();
    save();
  };
}
