import { runtime } from '../app/runtime.js';
import { publicLog, publicLogText } from '../replay/public-log.js';
import { publicMatchText } from '../replay/match-record.js';
import { renderMatchSummary } from './match-summary.js';
import { $ } from './cards.js';

let dialog,
  list,
  filter,
  rounds,
  returnFocus,
  signature = '';
const source = () =>
  (runtime.game.roundHistory || []).find((record) => String(record.round) === rounds.value) ||
  runtime.game;
const record = () => {
  const game = source();
  return publicLog(game, game.names || runtime.names, game.names?.[0] || runtime.nickname);
};

function syncRounds() {
  const saved = rounds.value;
  const history = (runtime.game.roundHistory || []).filter(
    (record) => record.round !== runtime.game.round,
  );
  const key = `${runtime.game.tok}:${history.map((record) => record.round).join(',')}`;
  if (rounds.dataset.key === key) return;
  rounds.dataset.key = key;
  rounds.replaceChildren(new window.Option(`当前 · 第 ${runtime.game.round} 局`, ''));
  for (const record of history.slice().reverse())
    rounds.add(new window.Option(`第 ${record.round} 局`, String(record.round)));
  rounds.value = [...rounds.options].some((option) => option.value === saved) ? saved : '';
}

function download(text, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function renderPublicHistory(force = false) {
  if (!dialog?.open || !runtime.game) return;
  const game = runtime.game;
  syncRounds();
  const key = `${game.tok}:${game.round}:${game.phase}:${game.log?.length}:${game.roundHistory?.length}:${filter.value}:${rounds.value}:${runtime.names.join('|')}`;
  if (!force && key === signature) return;
  signature = key;
  const atEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const scroll = list.scrollTop;
  const data = record();
  const selected = source();
  const names = selected.names || runtime.names;
  [...filter.options].forEach((option, index) => {
    if (index)
      option.textContent =
        index === 1 ? selected.names?.[0] || runtime.nickname || '你' : names[index - 1];
  });
  renderMatchSummary(game, runtime.names, runtime.nickname);
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

export function showPublicHistory(showSummary = false, opener = $('#optBtn')) {
  if (!runtime.game || runtime.reviewMode) return;
  $('#optMenu').hidden = true;
  $('#optBtn').setAttribute('aria-expanded', 'false');
  $('#publicHistoryNotice').textContent =
    runtime.game.phase === 'over'
      ? '新的一场会清空记录，可以先下载整场牌谱。'
      : runtime.game.phase === 'roundEnd'
        ? '当前场次的记录已保留，可切换局数回看。'
        : '查看期间对局计时继续。';
  if (showSummary) $('#publicMatchSummary').open = true;
  returnFocus = opener;
  if (!dialog.open) dialog.showModal();
  renderPublicHistory(true);
}

export function initialize() {
  dialog = $('#publicHistory');
  list = $('#publicHistoryList');
  filter = $('#publicHistoryFilter');
  rounds = $('#publicHistoryRound');
  $('#historyBtn').onclick = () => showPublicHistory();
  $('#publicHistoryClose').onclick = () => dialog.close();
  dialog.addEventListener('close', () =>
    (returnFocus?.isConnected ? returnFocus : $('#optBtn')).focus({ preventScroll: true }),
  );
  filter.onchange = () => renderPublicHistory(true);
  rounds.onchange = () => {
    list.scrollTop = 0;
    renderPublicHistory(true);
  };
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
    download(publicLogText(data), `guandan-round-${data.round}.txt`);
    $('#publicHistoryNotice').textContent = '已下载本局公开牌谱。';
  };
  $('#publicMatchSave').onclick = () => {
    const game = runtime.game;
    const records = [...(game.roundHistory || [])];
    if (!records.some((record) => record.round === game.round))
      records.push({
        round: game.round,
        L: game.L,
        log: game.log,
        result: game.result,
        names: runtime.names.map((name, seat) => (seat === 0 ? runtime.nickname || '你' : name)),
      });
    download(publicMatchText(records), 'guandan-match.txt');
    $('#publicHistoryNotice').textContent = '已下载整场公开牌谱；未包含尚未打出的手牌。';
  };
}
