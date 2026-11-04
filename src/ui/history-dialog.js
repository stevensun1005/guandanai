import { runtime } from '../app/runtime.js';
import { publicLog, publicLogText } from '../replay/public-log.js';
import { $ } from './cards.js';

let dialog,
  list,
  filter,
  signature = '';
const record = () => publicLog(runtime.game, runtime.names, runtime.nickname);

export function renderPublicHistory(force = false) {
  if (!dialog?.open || !runtime.game) return;
  const game = runtime.game;
  const key = `${game.tok}:${game.round}:${game.log?.length}:${filter.value}`;
  if (!force && key === signature) return;
  signature = key;
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const scroll = list.scrollTop;
  const data = record();
  $('#publicHistoryTitle').textContent = `第 ${data.round} 局 · 打 ${data.level}`;
  $('#publicHistorySummary').textContent = `${data.rows.length} 手记录 · 仅含公开出牌和过牌`;
  const rows = data.rows.filter((row) => filter.value === 'all' || row.seat === +filter.value);
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const item = document.createElement('li');
    item.value = row.number;
    const header = document.createElement('div');
    header.className = 'public-history-row';
    const who = document.createElement('b');
    who.textContent = row.name;
    const action = document.createElement('span');
    action.className = 'muted';
    action.textContent = row.cards.length ? `${row.lead ? '领出 · ' : ''}${row.type}` : '过';
    header.append(who, action);
    item.append(header);
    if (row.cards.length) {
      const cards = document.createElement('div');
      cards.className = 'public-history-cards';
      for (const card of row.cards) {
        const tag = document.createElement('span');
        tag.textContent = card.text;
        if (card.red) tag.className = 'red';
        cards.append(tag);
      }
      item.append(cards);
    }
    fragment.append(item);
  }
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = data.rows.length
      ? '这个座位还没有出牌记录。'
      : '开始出牌后，记录会显示在这里。';
    fragment.append(empty);
  }
  list.replaceChildren(fragment);
  list.scrollTop = atEnd ? list.scrollHeight : scroll;
}

export function initialize() {
  dialog = $('#publicHistory');
  list = $('#publicHistoryList');
  filter = $('#publicHistoryFilter');
  $('#historyBtn').onclick = () => {
    if (!runtime.game || runtime.reviewMode) return;
    $('#optMenu').hidden = true;
    $('#optBtn').setAttribute('aria-expanded', 'false');
    [...filter.options].forEach((option, index) => {
      if (index)
        option.textContent = index === 1 ? runtime.nickname || '你' : runtime.names[index - 1];
    });
    $('#publicHistoryNotice').textContent = '查看期间对局计时继续。';
    dialog.showModal();
    renderPublicHistory(true);
  };
  $('#publicHistoryClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () => $('#optBtn').focus({ preventScroll: true }));
  filter.onchange = () => renderPublicHistory(true);
  $('#publicHistoryCopy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(publicLogText(record()));
      $('#publicHistoryNotice').textContent = '本局公开牌谱已复制。';
    } catch (_) {
      $('#publicHistoryNotice').textContent = '未能复制，请使用“下载牌谱”保存。';
    }
  };
  $('#publicHistorySave').onclick = () => {
    const data = record();
    const url = URL.createObjectURL(
      new Blob([publicLogText(data)], { type: 'text/plain;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `guandan-round-${data.round}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#publicHistoryNotice').textContent = '已下载本局公开牌谱。';
  };
}
