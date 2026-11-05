import { runtime } from '../app/runtime.js';
import { BOT_CHOICES, DEFAULT_BOT_MODEL, botChoiceId, botModelName } from '../ai/model-catalog.mjs';
import { broadcastLobby } from '../network/rooms.js';
import { $ } from '../ui/cards.js';

const directions = ['S', 'E', 'N', 'W'];
const names = { S: '南', E: '东', N: '北', W: '西' };

export function normalizeBotPreferences(input) {
  return Object.fromEntries(
    directions.map((direction) => [direction, botChoiceId(input?.[direction])]),
  );
}

export function loadBotPreferences() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('guandan-bot-choices-v1') || '{}');
  } catch (_) {}
  runtime.botPreferences = normalizeBotPreferences(saved);
}

export function prepareBotModels() {
  const start = Math.max(0, directions.indexOf(runtime.direction));
  runtime.botModels = Array.from({ length: 4 }, (_, index) =>
    botChoiceId(runtime.botPreferences?.[directions[(start + index) % 4]]),
  );
}

function save() {
  try {
    localStorage.setItem('guandan-bot-choices-v1', JSON.stringify(runtime.botPreferences));
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
    select.value = botChoiceId(runtime.botPreferences?.[direction]);
    select.disabled = joining || !!human;
    select.closest('label').classList.toggle('human-seat', !!human);
    select.closest('label').querySelector('small').textContent = human ? '玩家座位' : '电脑空位';
  }
  $('#mixedBotsBtn').disabled = joining;
  $('#botSetupNote').textContent = joining
    ? '由房主设置；玩家离开后的空位沿用对应模型。'
    : `仅影响电脑空位。默认使用本地现任冠军 ${botModelName(DEFAULT_BOT_MODEL)}。Clint规则机器人不使用神经网络。`;
}

export function initialize() {
  loadBotPreferences();
  runtime.botModels = Array(4).fill(DEFAULT_BOT_MODEL);
  $('#botSetupRows').innerHTML = directions
    .map(
      (direction) =>
        `<label class="bot-setup-row"><span>${names[direction]}位 <small>电脑空位</small></span><select data-bot-seat="${direction}" aria-label="${names[direction]}位电脑模型">${BOT_CHOICES.map((model) => new window.Option(botModelName(model.id), model.id).outerHTML).join('')}</select></label>`,
    )
    .join('');
  $('#botSetupRows').addEventListener('change', (event) => {
    const select = event.target.closest('[data-bot-seat]');
    if (!select || select.disabled || runtime.lobbyMode === 'join') return;
    runtime.botPreferences[select.dataset.botSeat] = botChoiceId(select.value);
    save();
  });
  $('#mixedBotsBtn').onclick = () => {
    if (runtime.lobbyMode === 'join') return;
    runtime.botPreferences = normalizeBotPreferences();
    save();
  };
}
