import { runtime } from '../app/runtime.js';
import { PLAY_MS, PREP_MS, RET_MS, TRIB_MS } from '../game/clock.js';
import { $ } from './cards.js';

function rules() {
  const tribute = runtime.rules.trib
    ? '从第二局起，末游向头游进贡最大非百搭牌，双下则两人都进贡。收贡者还一张 10 或以下的非百搭牌；没有合适低牌时，还最小的非百搭牌。进贡方合计有两张大王时抗贡，不进不还，由头游先出。'
    : '本场不进贡，每局由上一局头游先出。';
  const fail =
    runtime.rules.aFail === 'keep'
      ? '打 A 不限次数，一直打到通过为止。'
      : `每方打 A 有三次机会，三次未过${runtime.rules.aFail === 'draw' ? '则本场平局。' : '则该方从 2 重新打。'}`;
  const timing = runtime.reviewMode
    ? '明牌练习按步骤推进，不限制玩家思考时间；空格或“继续”推进下一步。'
    : `理牌 ${PREP_MS / 1000} 秒，进贡选牌 ${TRIB_MS / 1000} 秒，还贡 ${RET_MS / 1000} 秒，每手出牌 ${PLAY_MS / 1000} 秒；到时会自动处理。`;
  return `<section><h3>四人，两队，两副牌</h3><p>共 108 张，每人 27 张。你和对家一队，按逆时针轮流出牌。头游一方升级：队友二游升 3 级、三游升 2 级、末游升 1 级。</p></section>
    <section><h3>级牌与百搭</h3><p>大王 ＞ 小王 ＞ 级牌 ＞ A ＞ K … ＞ 2。红心级牌是百搭，可以当除大小王以外的牌使用。顺子中的 A 可以作 1，不能带王。</p></section>
    <section><h3>牌型与炸弹</h3><p>单张、对子、三张、三带二、5 张顺子、3 个连续对子、2 个连续三张。通常只能用同牌型、更大的牌跟牌。</p><p>炸弹从小到大：4 张 ＜ 5 张 ＜ 同花顺 ＜ 6 张及以上 ＜ 四个王。炸弹可以压普通牌型。</p></section>
    <section><h3>过牌与接风</h3><p>先手不能过。其余人都不要时，最后出牌的人重新领出；若他已经走完，则由仍有牌的队友接风。</p></section>
    <section><h3>本桌进还贡规则</h3><p>${tribute}</p></section>
    <section><h3>打 A 与计时</h3><p>打过 A 且队友不是末游，赢下整场。${fail}</p><p>${timing}</p></section>`;
}

const operations = `<section><h3>选牌与出牌</h3><p>点按选牌；按住未选中的牌扫过，可以连选。双击牌可以提交出牌；想避免误触，可在“选项”打开“出牌需确认”。手牌上方会解释所选牌型与能否出牌。</p></section>
  <section><h3>把牌理顺</h3><p>从选中的牌开始拖动，可以一起换位置；拖到成组区，或点“成组”，可以把计划中的一手牌放在一起。</p><p>“理牌”菜单支持按大小、花色、智能牌型排序，以及拆开所有组、撤销。排序保留手动成组；自己的牌改变后会清空理牌撤销。</p></section>
  <section><h3>提示、牌谱与布局</h3><p>“提示”循环查看合法出法，“同花顺”循环查找可用组合。手持、横式、竖式可切换，并可调整排数。选项中的“牌谱与战况”能切换局数、查看整场统计，按玩家筛选、复制或下载公开动作。</p></section>
  <section><h3>键盘也能打</h3><dl class="help-keys"><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>手牌获得焦点时，浏览相邻的牌；Home / End 到两端</dd><dt><kbd>Space</kbd> <kbd>Enter</kbd></dt><dd>手牌上选择牌；在牌桌其他位置，空格过牌、回车提交</dd><dt><kbd>P</kbd></dt><dd>提交选牌，或确认进还贡</dd><dt><kbd>H</kbd></dt><dd>下一条出牌提示</dd><dt><kbd>Esc</kbd></dt><dd>取消选牌或拖动；有弹窗时先关闭弹窗</dd><dt><kbd>Ctrl</kbd> / <kbd>⌘</kbd> <kbd>Z</kbd></dt><dd>撤销上次理牌，最多 30 步</dd></dl></section>
  <section><h3>和朋友一起玩</h3><p>邀请链接发给朋友，空位由电脑接管。原标签页刷新后可以尝试恢复座位，等待期间牌局会继续。房主需要保持页面打开。</p></section>`;

function selectTab(id) {
  for (const tab of $('#helpTabs').querySelectorAll('[role=tab]')) {
    const selected = tab.dataset.helpTab === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  $('#rulesPane').hidden = id !== 'rules';
  $('#operationsPane').hidden = id !== 'operations';
  $('#rulesDialog .help-content').scrollTop = 0;
}

export function showRules() {
  $('#rulesPane').innerHTML = rules();
  $('#helpTiming').textContent = runtime.reviewMode
    ? '明牌练习没有玩家计时，关闭帮助后继续。'
    : runtime.network.mode === 'solo'
      ? '查看帮助时，单人局暂缓计时与电脑落牌。'
      : '朋友房间继续计时，关闭帮助后可继续操作。';
  selectTab('rules');
  if (!$('#rulesDialog').open) $('#rulesDialog').showModal();
}

export function initialize() {
  $('#operationsPane').innerHTML = operations;
  $('#helpClose').onclick = () => $('#rulesDialog').close();
  $('#lobbyHelpBtn').onclick = showRules;
  $('#rulesDialog').addEventListener('click', (event) => event.stopPropagation());
  $('#helpTabs').addEventListener('click', (event) => {
    const button = event.target.closest('[data-help-tab]');
    if (button) selectTab(button.dataset.helpTab);
  });
  $('#helpTabs').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...$('#helpTabs').querySelectorAll('button')];
    const index =
      event.key === 'Home' ? 0 : event.key === 'End' ? 1 : event.target === buttons[0] ? 1 : 0;
    selectTab(buttons[index].dataset.helpTab);
    buttons[index].focus();
  });
}
