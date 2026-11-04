import { runtime } from '../app/runtime.js';
import { BOT_PROFILES, profileId } from '../ai/profiles.js';
import { broadcastLobby } from '../network/rooms.js';
import { $ } from '../ui/cards.js';

const directions = ['S', 'E', 'N', 'W'];
const names = { S: '南', E: '东', N: '北', W: '西' };

export function normalizeBotPreferences(input) {
  return Object.fromEntries(
    directions.map((direction) => [direction, profileId(input?.[direction])]),
  );
}

export function loadBotPreferences() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem('guandan-bot-styles') || '{}');
  } catch (_) {}
  runtime.botPreferences = normalizeBotPreferences(saved);
}

export function prepareBotStyles() {
  const start = Math.max(0, directions.indexOf(runtime.direction));
  runtime.botStyles = Array.from({ length: 4 }, (_, index) =>
    profileId(runtime.botPreferences?.[directions[(start + index) % 4]]),
  );
}

function save() {
  try {
    localStorage.setItem('guandan-bot-styles', JSON.stringify(runtime.botPreferences));
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
    select.value = profileId(runtime.botPreferences?.[direction]);
    select.disabled = joining || !!human;
    select.closest('label').classList.toggle('human-seat', !!human);
    select.closest('label').querySelector('small').textContent = human ? '玩家座位' : '电脑空位';
  }
  $('#mixedBotsBtn').disabled = joining;
  $('#botSetupNote').textContent = joining
    ? '由房主设置；玩家离开后的空位也沿用对应风格。'
    : '仅影响电脑空位。均衡保持默认策略，其余风格各有所长。';
}

export function initialize() {
  loadBotPreferences();
  runtime.botStyles = Array(4).fill('balanced');
  $('#botSetupRows').innerHTML = directions
    .map(
      (direction) =>
        `<label class="bot-setup-row"><span>${names[direction]}位 <small>电脑空位</small></span><select data-bot-seat="${direction}" aria-label="${names[direction]}位电脑出牌风格">${BOT_PROFILES.map((profile) => `<option value="${profile.id}">${profile.name} · ${profile.summary}</option>`).join('')}</select></label>`,
    )
    .join('');
  $('#botSetupRows').addEventListener('change', (event) => {
    const select = event.target.closest('[data-bot-seat]');
    if (!select || select.disabled || runtime.lobbyMode === 'join') return;
    runtime.botPreferences[select.dataset.botSeat] = profileId(select.value);
    save();
  });
  $('#mixedBotsBtn').onclick = () => {
    if (runtime.lobbyMode === 'join') return;
    const start = Math.max(0, directions.indexOf(runtime.direction));
    ['balanced', 'aggressive', 'observant', 'conservative'].forEach((style, index) => {
      runtime.botPreferences[directions[(start + index) % 4]] = style;
    });
    save();
  };
}
