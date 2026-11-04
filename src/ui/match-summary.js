import { rankName } from '../core/cards.js';
import { matchStats } from '../replay/match-record.js';
import { $ } from './cards.js';

export function renderMatchSummary(game, names, playerName) {
  const finished = game.roundHistory || [];
  const ongoing = finished.some((record) => record.round === game.round)
    ? []
    : [{ log: game.log || [] }];
  const stats = matchStats([...finished, ...ongoing]);
  const recent = finished.length && finished[0].round > 1;
  $('#publicMatchLabel').textContent =
    `整场战况 · ${recent ? '最近' : '已完成'} ${stats.rounds} 局`;
  const body = document.createDocumentFragment();
  const score = document.createElement('p');
  score.textContent = `累计胜局：我方 ${stats.wins[0]} 局 · 对方 ${stats.wins[1]} 局`;
  body.append(score);
  const table = document.createElement('table');
  const caption = table.createCaption();
  caption.textContent = '累计公开动作，包含当前局；过牌次数不代表手里没有能压过的牌。';
  const header = table.createTHead().insertRow();
  for (const label of ['玩家', '头游', '出牌', '过牌', '炸弹']) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    header.append(cell);
  }
  const rows = table.createTBody();
  stats.seats.forEach((seat, index) => {
    const row = rows.insertRow();
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = index === 0 ? playerName || '你' : names[index];
    row.append(name);
    for (const key of ['firsts', 'plays', 'passes', 'bombs'])
      row.insertCell().textContent = seat[key];
  });
  body.append(table);
  for (const record of finished.slice().reverse()) {
    const item = document.createElement('p');
    item.className = 'match-round-result';
    const title = document.createElement('b');
    title.textContent = `第 ${record.round} 局 · 打 ${rankName(record.L)}`;
    const result = document.createElement('span');
    result.textContent = record.result.order.map((seat) => record.names[seat]).join(' → ');
    item.append(title, result);
    body.append(item);
  }
  $('#publicMatchBody').replaceChildren(body);
}
