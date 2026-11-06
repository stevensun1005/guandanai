import { runtime } from '../app/runtime.js';
import { rankName } from '../core/cards.js';
import { $ } from '../ui/cards.js';
import { Sound } from '../audio/sound.js';
import { broadcastLobby } from '../network/rooms.js';
import { startOptions, startConfigured, START_DIRS } from './start-state.mjs';
const names = { S: '南', N: '北', E: '东', W: '西' },
  sides = { SN: '南北', EW: '东西' };
function close() {
  $('#levelPick').hidden = true;
  $('#levelBtn').setAttribute('aria-expanded', 'false');
  $('#levelBtn').focus();
}
export function renderLevelPicker() {
  const mine = runtime.lobbyMode !== 'join',
    s = startOptions(runtime.rules, runtime.direction || 'S'),
    chosen = startConfigured(s),
    dis = mine ? '' : ' disabled';
  const b = $('#levelBtn');
  b.innerHTML = chosen ? `南北${rankName(s.levels.SN)}<br>东西${rankName(s.levels.EW)}` : '选级';
  b.classList.toggle('on', !!chosen);
  b.setAttribute('aria-expanded', String(!$('#levelPick').hidden));
  if ($('#levelPick').hidden) return;
  const btn = (text, attrs, on, cls = '') =>
    `<button type="button" class="rule-btn ${cls}${on ? ' on' : ''}" aria-pressed="${on}" ${attrs}${dis}>${text}</button>`;
  const lv = (side) =>
    `<div class="level-row"><span class="level-k">${sides[side]}打</span>${Array.from(
      { length: 13 },
      (_, i) => i + 2,
    )
      .map((n) =>
        btn(
          rankName(n),
          `data-level-team="${side}" data-lv="${n}"`,
          n === s.levels[side],
          'lv-' + (side === 'SN' ? 'red' : 'blue'),
        ),
      )
      .join('')}</div>`;
  const ranks = ['头游', '二游', '三游', '末游']
    .map(
      (name, i) =>
        `<div class="level-row"><span class="level-k">${name}</span>${START_DIRS.map((d) => btn(names[d], `data-rank="${i}" data-direction="${d}"`, s.order[i] === d, 'lv-' + ('SN'.includes(d) ? 'red' : 'blue'))).join('')}</div>`,
    )
    .join('');
  const full = s.order.every(Boolean),
    double = full && 'SN'.includes(s.order[0]) === 'SN'.includes(s.order[1]);
  const pay = full
    ? double
      ? `${names[s.order[2]]}、${names[s.order[3]]}双进贡，${names[s.order[0]]}、${names[s.order[1]]}收贡`
      : `${names[s.order[3]]}进贡给${names[s.order[0]]}`
    : s.order.some(Boolean)
      ? '名次未选全，暂不进贡'
      : '不选名次则从第一局开始，不进贡';
  const attempts = (side) =>
    `<div class="level-row"><span class="level-k">${sides[side]}打A不过</span>${[0, 1, 2].map((n) => btn(n + ' 次', `data-attempt-team="${side}" data-attempt="${n}"`, s.aFails[side] === n)).join('')}</div>`;
  $('#levelPick').innerHTML =
    `<div class="level-card"><h3 id="startStateTitle">选级（接着之前的牌局）</h3>${lv('SN')}${lv('EW')}<div class="level-row"><span class="level-k">本局打谁的级</span>${['SN', 'EW', ''].map((side) => btn(sides[side] || '自动', `data-side="${side}"`, s.playSide === side)).join('')}</div><p class="hint">上一局名次（决定进贡关系）</p>${ranks}<p class="hint" id="startTributeHint">${pay}</p>${attempts('SN')}${attempts('EW')}<div class="level-row">${mine ? '<button type="button" class="rule-btn" data-reset>还原</button>' : '<span class="rule-note">由房主选定</span>'}<button type="button" class="rule-btn" data-done>好</button></div></div>`;
}
export function initialize() {
  const picker = $('#levelPick');
  document.body.append(picker);
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-modal', 'true');
  picker.setAttribute('aria-labelledby', 'startStateTitle');
  $('#levelBtn').onclick = () => {
    Sound.unlock();
    Sound.play('select');
    picker.hidden = !picker.hidden;
    renderLevelPicker();
    if (!picker.hidden) picker.querySelector('button')?.focus();
  };
  picker.onclick = (e) => {
    if (e.target === picker) {
      close();
      return;
    }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-done')) {
      close();
      return;
    }
    if (runtime.lobbyMode === 'join') return;
    let s = startOptions(runtime.rules, runtime.direction || 'S');
    const d = b.dataset;
    if (d.levelTeam) s.levels[d.levelTeam] = Number(d.lv);
    else if (d.side !== undefined) s.playSide = d.side;
    else if (d.attemptTeam) s.aFails[d.attemptTeam] = Number(d.attempt);
    else if (d.rank !== undefined) {
      const i = Number(d.rank),
        off = s.order[i] === d.direction;
      s.order = s.order.map((x) => (x === d.direction ? '' : x));
      s.order[i] = off ? '' : d.direction;
      if (!off && s.order.filter(Boolean).length === 3)
        s.order[s.order.indexOf('')] = START_DIRS.find((x) => !s.order.includes(x));
    } else if (b.hasAttribute('data-reset'))
      s = {
        levels: { SN: 2, EW: 2 },
        playSide: '',
        order: ['', '', '', ''],
        aFails: { SN: 0, EW: 0 },
      };
    else return;
    runtime.rules.startState = s;
    runtime.rules.startSide = s.playSide;
    runtime.rules.startLevel =
      s.levels[s.playSide || ('SN'.includes(runtime.direction || 'S') ? 'SN' : 'EW')];
    Sound.play('select');
    renderLevelPicker();
    if (runtime.lobbyMode === 'host') broadcastLobby();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !picker.hidden) {
      e.preventDefault();
      close();
    }
  });
}
