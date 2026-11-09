import { runtime } from '../app/runtime.js';
import { PLAY_MS, PREP_MS, RET_MS, TRIB_MS, HURRY_MS } from '../game/clock.js';
import { DEFAULT_BOT_MODEL, botModelName } from '../ai/model-catalog.mjs';
import { rulesPages, ruleCards } from './rules-book.mjs';
import { $ } from './cards.js';
let at = { section: 0, tab: 0 };
const operations = `<section><h3>选牌与出牌</h3><p>点按选牌；按住未选中的牌扫过，可以连选。双击牌可以提交出牌；想避免误触，可在“选项”打开“出牌需确认”。手牌上方会解释所选牌型与能否出牌。</p></section>
  <section><h3>把牌理顺</h3><p>从选中的牌开始拖动，可以一起换位置；拖到成组区，或点“成组”，可以把计划中的一手牌放在一起。</p><p>“理牌”菜单支持按大小、花色、智能牌型排序，以及拆开所有组、撤销和重做。排序保留手动成组；自己的牌改变后会清空理牌撤销。</p></section>
  <section><h3>提示、牌谱与布局</h3><p>“提示”循环查看合法出法，“同花顺”循环查找可用组合。手持、横式、竖式可切换，并可调整排数。选项中的“牌谱与战况”能切换局数、查看整场统计，按玩家筛选、复制或下载公开动作。</p></section>
  <section><h3>键盘也能打</h3><dl class="help-keys"><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>手牌获得焦点时，浏览相邻的牌；Home / End 到两端</dd><dt><kbd>Space</kbd> <kbd>Enter</kbd></dt><dd>手牌上选择牌；在牌桌其他位置，空格过牌、回车提交</dd><dt><kbd>P</kbd></dt><dd>提交选牌，或确认进还贡</dd><dt><kbd>H</kbd></dt><dd>下一条出牌提示</dd><dt><kbd>Esc</kbd></dt><dd>取消选牌或拖动；有弹窗时先关闭弹窗</dd><dt><kbd>Ctrl</kbd> / <kbd>⌘</kbd> <kbd>Z</kbd></dt><dd>撤销上次理牌，最多 30 步；Ctrl / ⌘ Shift Z 或 Ctrl Y 重做</dd></dl></section>
  <section><h3>和朋友一起玩</h3><p>邀请链接发给朋友，空位由电脑接管。原标签页刷新后可以尝试恢复座位，等待期间牌局会继续。房主刷新或关闭页面后，同一浏览器三小时内可以恢复原房间与牌桌；明确退出会清除恢复。</p></section>`;

function renderBook() {
  const timing = runtime.reviewMode
    ? '明牌练习按步骤推进，没有玩家倒计时。'
    : `进贡 ${TRIB_MS / 1000} 秒，理牌 ${PREP_MS / 1000} 秒，还贡 ${RET_MS / 1000} 秒，每手出牌 ${PLAY_MS / 1000} 秒；最后 ${HURRY_MS / 1000} 秒提醒。`;
  const models = [...new Set(runtime.botModels || [DEFAULT_BOT_MODEL])]
    .map(botModelName)
    .join('、');
  const pages = rulesPages(runtime.rules, models, timing);
  pages[3].tabs.push({
    label: '更多操作',
    items: [{ name: '本项目操作与恢复', text: '', html: operations }],
  });
  const section = pages[at.section],
    tab = section.tabs[at.tab] || section.tabs[0];
  $('#helpTabs').innerHTML = pages
    .map(
      (s, i) =>
        `<button type="button" data-section="${i}" aria-pressed="${i === at.section}" class="${i === at.section ? 'on' : ''}">${s.label}</button>`,
    )
    .join('');
  $('#helpSubtabs').innerHTML = section.tabs
    .map(
      (t, i) =>
        `<button type="button" role="tab" id="helpTab${i}" aria-controls="rulesPane" aria-selected="${t === tab}" tabindex="${t === tab ? 0 : -1}" data-tab="${i}" class="${t === tab ? 'on' : ''}">${t.label}</button>`,
    )
    .join('');
  $('#rulesPane').setAttribute('aria-labelledby', 'helpTab' + section.tabs.indexOf(tab));
  $('#rulesPane').innerHTML = tab.items
    .map(
      (it) =>
        `<section class="rule-item${it.text.length > 58 || (it.cards || '').split(' ').length > 9 || it.html ? ' wide' : ''}"><div class="ri-head"><b>${it.name}</b>${it.tag ? `<span class="ri-tag">${it.tag}</span>` : ''}</div>${it.text ? `<p>${it.text}</p>` : ''}${it.cards ? `<div class="ri-cards">${ruleCards(it.cards)}</div>` : ''}${it.html || ''}</section>`,
    )
    .join('');
  $('#rulesPane').scrollTop = 0;
}
export function showRules() {
  at = { section: 0, tab: 0 };
  renderBook();
  $('#helpTiming').textContent = runtime.reviewMode
    ? '明牌练习没有玩家计时。'
    : runtime.network.mode === 'solo'
      ? '查看帮助时，单人局暂缓计时与电脑落牌。'
      : '朋友房间继续计时。';
  if (!$('#rulesDialog').open) $('#rulesDialog').showModal();
}
export function initialize() {
  $('#helpClose').onclick = () => $('#rulesDialog').close();
  $('#lobbyHelpBtn').onclick = showRules;
  $('#rulesDialog').addEventListener('click', (e) => e.stopPropagation());
  $('#helpTabs').onclick = (e) => {
    const b = e.target.closest('[data-section]');
    if (b) {
      at = { section: +b.dataset.section, tab: 0 };
      renderBook();
      $('#helpTabs').querySelector(`[data-section="${at.section}"]`).focus();
    }
  };
  $('#helpSubtabs').onclick = (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) {
      at.tab = +b.dataset.tab;
      renderBook();
      $('#helpSubtabs').querySelector(`[data-tab="${at.tab}"]`).focus();
    }
  };
  $('#helpSubtabs').onkeydown = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const n = $('#helpSubtabs').children.length;
    at.tab =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? n - 1
          : (at.tab + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
    renderBook();
    $('#helpSubtabs').querySelector(`[data-tab="${at.tab}"]`).focus();
  };
}
