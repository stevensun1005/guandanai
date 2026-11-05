import { runtime } from '../app/runtime.js';
import { rankName } from '../core/cards.js';
import { $ } from '../ui/cards.js';
import { Sound } from '../audio/sound.js';
import { broadcastLobby } from '../network/rooms.js';

export function renderLevelPicker() {
  const mine = runtime.lobbyMode !== 'join';
  const level = runtime.rules.startLevel || 2,
    side = runtime.rules.startSide || '';
  const chosen = level !== 2 || side;
  const button = $('#levelBtn');
  button.textContent = chosen
    ? `打${rankName(level)}${side ? '·' + { SN: '南北', EW: '东西' }[side] : ''}`
    : '选级';
  button.classList.toggle('on', !!chosen);
  button.setAttribute('aria-expanded', String(!$('#levelPick').hidden));
  if ($('#levelPick').hidden) return;
  const levels = Array.from({ length: 13 }, (_, i) => i + 2)
    .map(
      (n) =>
        `<button type="button" class="rule-btn${n === level ? ' on' : ''}" data-lv="${n}" aria-pressed="${n === level}"${mine ? '' : ' disabled'}>${rankName(n)}</button>`,
    )
    .join('');
  $('#levelPick').innerHTML =
    `<div class="level-row"><span class="level-k">打几</span>${levels}</div><div class="level-row"><span class="level-k">哪一方</span>${['SN', 'EW'].map((s) => `<button type="button" class="rule-btn lv-${s === 'SN' ? 'red' : 'blue'}${side === s ? ' on' : ''}" aria-pressed="${side === s}" data-side="${s}"${mine ? '' : ' disabled'}>${s === 'SN' ? '南北' : '东西'}</button>`).join('')}${mine ? '<button type="button" class="rule-btn" data-reset>还原</button>' : ''}<button type="button" class="rule-btn" data-done>好</button></div>${mine ? '' : '<p class="rule-note">由房主选定</p>'}`;
}

export function initialize() {
  $('#levelBtn').onclick = () => {
    Sound.unlock();
    Sound.play('select');
    $('#levelPick').hidden = !$('#levelPick').hidden;
    renderLevelPicker();
    if (!$('#levelPick').hidden) $('#levelPick').querySelector('button:not(:disabled)')?.focus();
  };
  $('#levelPick').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-done')) {
      $('#levelPick').hidden = true;
      renderLevelPicker();
      $('#levelBtn').focus();
      return;
    }
    if (runtime.lobbyMode === 'join') return;
    if (b.dataset.lv) runtime.rules.startLevel = Number(b.dataset.lv);
    else if (b.dataset.side)
      runtime.rules.startSide = runtime.rules.startSide === b.dataset.side ? '' : b.dataset.side;
    else if (b.hasAttribute('data-reset')) {
      runtime.rules.startLevel = 2;
      runtime.rules.startSide = '';
    } else return;
    Sound.play('select');
    renderLevelPicker();
    const focus = b.dataset.lv
      ? `[data-lv="${b.dataset.lv}"]`
      : b.dataset.side
        ? `[data-side="${b.dataset.side}"]`
        : '[data-reset]';
    $('#levelPick').querySelector(focus)?.focus();
    if (runtime.lobbyMode === 'host') broadcastLobby();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#levelPick').hidden && !$('#lobby').hidden) {
      $('#levelPick').hidden = true;
      renderLevelPicker();
      $('#levelBtn').focus();
    }
  });
}
