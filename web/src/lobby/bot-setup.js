import { runtime } from '../app/runtime.js';
import {
  BOT_CHOICES,
  DEFAULT_BOT_MODEL,
  botChoiceId,
  botModel,
  botModelName,
  searchBot,
} from '../ai/model-catalog.mjs';
import { broadcastLobby } from '../network/rooms.js';
import { $ } from '../ui/cards.js';

const directions = ['S', 'E', 'N', 'W'];
const names = { S: '南', E: '东', N: '北', W: '西' };
const STORE = 'guandan-bot-choices-v2';
/*
 * v1 saved all four seats on any change, so a v1 '017' (the champion default of that menu) cannot be
 * told from an untouched seat. It migrates to the current default; other v1 choices stay while they
 * are still in the menu. Any saved choice that is no longer offered (since 2026-11-09: P0 001,
 * the previous champion 012, older GuanZero generations) falls back to the menu default
 * (danMCai-reason) through botChoiceId, and the next save drops it from storage.
 */
const LEGACY_STORE = 'guandan-bot-choices-v1',
  LEGACY_DEFAULT = '017';

export function normalizeBotPreferences(input) {
  return Object.fromEntries(
    directions.map((direction) => [direction, botChoiceId(input?.[direction])]),
  );
}

/** v2 stores only seats that differ from the menu default, so untouched seats follow it. */
export function storedBotPreferences(current, legacy) {
  if (current) return current;
  return Object.fromEntries(
    Object.entries(legacy || {}).filter(([, value]) => value !== LEGACY_DEFAULT),
  );
}

export function loadBotPreferences() {
  let saved;
  try {
    const read = (key) => JSON.parse(localStorage.getItem(key) || 'null');
    saved = storedBotPreferences(read(STORE), read(LEGACY_STORE));
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
    const explicit = Object.entries(runtime.botPreferences).filter(
      ([, value]) => value !== DEFAULT_BOT_MODEL,
    );
    localStorage.setItem(STORE, JSON.stringify(Object.fromEntries(explicit)));
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
    : defaultNote();
}

function defaultNote() {
  const name = botModelName(DEFAULT_BOT_MODEL);
  if (!searchBot(DEFAULT_BOT_MODEL))
    return `仅影响电脑空位。默认使用danMCai 现任冠军 ${name}。Clint规则机器人不使用神经网络。`;
  const champion = botModelName(botModel(DEFAULT_BOT_MODEL).id);
  return `仅影响电脑空位。默认 ${name}：现任冠军 ${champion} 加手牌推断搜索（带推理），只在无进贡单局对冠军验证过；进还贡、超时托管和搜索超时仍由冠军出牌。Clint规则机器人不使用神经网络。`;
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
