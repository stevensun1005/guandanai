/**
 * Markdown and self-contained HTML reports for review.mjs output (Chinese labels).
 *
 * Exact hindsight values (perfect information, all four hands public after the round) and PIMC
 * estimates (own view, sampled worlds) are always shown in separate, labelled blocks; estimates are
 * never added into the exact lost-point totals. Reports are written locally only.
 *
 *   node ai/danMCai/review/report.mjs --in=<review.json> [--out=<dir>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { assertSafeOut, isEntry, playerSummary, seatSummary } from './review.mjs';

export const EXACT_LABEL = '明牌事后最优（结束后四家牌已公开）';
export const ESTIMATE_LABEL = '估计（只用该座位当时能看到的信息，抽样其他三家的牌）';

const EXACT_NOTE =
  '本局结束后四家手牌都已公开。求解器在四家牌全部可见的前提下，按整局最终签名升级分（本队 +1／+2／+3 或 −1／−2／−3，被双下为 −3）精确计算每手出法的价值。' +
  '这是事后上限：只看自己手牌的玩家不一定能做到；"丢分"表示这一手让本队在双方都按最优打的前提下少得的升级分。牌权、炸弹等中间信号不参与评分。';
const ESTIMATE_NOTE =
  '对丢分的决策，可选地从出牌者当时的视角重新估计：按公开信息（自己的牌、已出的牌、各家张数及自己经手的进还贡牌）均匀抽样其他三家的牌，在每个抽样世界里精确求解每个出法。' +
  '均匀抽样忽略对手出牌透露的信息，所以这只是估计，不计入精确丢分合计。';

export const seatName = (seat) => `座位${seat}`;
export const teamName = (team) => (team === 0 ? '0/2 队' : '1/3 队');

/** Signed round points with a short meaning. */
export function valueText(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (v === 0) return '0';
  if (!Number.isInteger(v)) return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
  const sign = v > 0 ? '+' : '−';
  const note = { 3: '（双上）', '-3': '（被双下）' }[v] || '';
  return `${sign}${Math.abs(v)}${note}`;
}
const pointsText = (v) => (v ? `${Number.isInteger(v) ? v : v.toFixed(2)} 分` : '0');

export function stopText(round, options) {
  const { stop } = round.tail;
  if (stop.reason === 'start-of-round') return '已到本局开头：整局都可精确求解。';
  if (stop.reason === 'card-cap')
    return `再往前一手（第 ${stop.index + 1} 手之前）全桌剩 ${stop.cards} 张，超过精确求解上限 ${options.maxCards} 张。`;
  return `再往前一手（第 ${stop.index + 1} 手之前，全桌剩 ${stop.cards} 张）超出求解预算（${options.maxNodes} 节点／${options.maxMs} 毫秒）。`;
}

const VERDICT = {
  'all-worlds': '每个抽样世界都丢分：按当时能看到的信息，你本可以看出这手不好',
  'most-worlds': '多数抽样世界也丢分：大概率本可以看出',
  'few-worlds': '不超过一半的抽样世界丢分：从公开信息较难判断',
  'hindsight-only': '抽样世界里都不丢分：只有看到全部手牌才能发现',
  unknown: '抽样世界均超出求解预算，无法估计',
};

const ACTOR = { bot: '电脑', timeout: '超时托管' };
const actorText = (actor) => ACTOR[actor] || actor;

const plyText = (ply) => `${ply.lead ? '｜' : ''}${seatName(ply.seat)} ${ply.play.text}`;
const lineText = (line, team) =>
  `${line.plies.map(plyText).join(' → ')} ⇒ 结束，${teamName(team)} ${valueText(line.value)}`;
const trickText = (d) =>
  d.trick
    ? `${seatName(d.trick.player)} 出了 ${d.trick.play.text}，需要压过或不要`
    : '首出（桌面为空）';
const countsText = (counts) => counts.map((n, s) => `${seatName(s)} ${n} 张`).join('，');

function roundPoints(round) {
  const bySeat = [0, 0, 0, 0];
  const flagged = [0, 0, 0, 0];
  for (const d of round.decisions)
    if (!d.unscored) {
      bySeat[d.seat] += d.loss;
      flagged[d.seat] += Number(d.flagged);
    }
  return { bySeat, flagged };
}

function resultText(round) {
  return `${teamName(round.result.team)} 获胜，升 ${round.result.up} 级（出完顺序 ${round.result.order.map(seatName).join(' → ')}）`;
}

function tailStartText(round) {
  const t = round.tail;
  if (!t.actions) return '本局没有可精确求解的尾段。';
  return `从第 ${t.startIndex + 1} 手（共 ${round.actions} 手）开始可精确求解：全桌剩 ${t.startCards} 张，轮到${seatName(t.startTurn)}；尾段 ${t.actions} 手。`;
}

/* ---------- Markdown ---------- */

export function renderMarkdown(review) {
  const options = review.options;
  const summary = review.summary || seatSummary(review.rounds);
  const out = [];
  const push = (...lines) => out.push(...lines);
  push('# 掼蛋牌局复盘', '');
  push(`> **${EXACT_LABEL}**：${EXACT_NOTE}`, '');
  if (options.pimc > 0) push(`> **${ESTIMATE_LABEL}**：${ESTIMATE_NOTE}`, '');
  push(
    `- 记录：${review.rounds.length} 局（来源 \`${review.raw}\`，可信度 ${review.trust}：浏览器上传，未做身份验证）`,
    `- 复盘座位：${(review.options.seats || [0, 1, 2, 3]).map(seatName).join('、')}`,
    `- 精确求解：全桌 ≤ ${options.maxCards} 张；每次求解预算 ${options.maxNodes} 节点／${options.maxMs} 毫秒`,
    `- 估计：${options.pimc > 0 ? `丢分决策且全桌 ≤ ${options.pimcCards} 张时，抽样 ${options.pimc} 个世界` : '未启用（--pimc=8 可启用）'}`,
    `- 生成时间：${review.finishedAt || ''}`,
    '',
  );
  push(`## 汇总：各座位丢分 · ${EXACT_LABEL} · 精确值`, '');
  push(
    '| 座位 | 局数 | 复盘决策 | 其中有选择 | 丢分决策 | 合计丢分 | 未求解 | 非本人操作 | 出牌前看过预评 |',
    '| --- | --: | --: | --: | --: | --: | --: | --: | --: |',
  );
  for (const r of summary)
    push(
      `| ${seatName(r.seat)} | ${r.rounds} | ${r.decisions} | ${r.choices} | ${r.flagged} | ${pointsText(r.lostPoints)} | ${r.decisions - r.scored} | ${r.nonHuman} | ${r.assisted} |`,
    );
  push(
    '',
    '座位号按每局记录；不同比赛的同一座位可能是不同的人，请按各局标题里的玩家标识认领自己的座位。合计丢分是各手丢分之和，只覆盖可精确求解的尾段。',
    '',
  );
  const players = review.players || playerSummary(review.rounds);
  push(`### 按玩家标识（匿名 ID 前 8 位）· 精确值`, '');
  push(
    '| 玩家标识 | 座位 | 局数 | 复盘决策 | 丢分决策 | 合计丢分 | 未求解 | 出牌前看过预评 |',
    '| --- | --- | --: | --: | --: | --: | --: | --: |',
  );
  for (const r of players)
    push(
      `| ${r.player} | ${r.seats.map(seatName).join('、')} | ${r.rounds} | ${r.decisions} | ${r.flagged} | ${pointsText(r.lostPoints)} | ${r.decisions - r.scored} | ${r.assisted} |`,
    );
  push('');
  if (options.pimc > 0) {
    push(`### 估计（不计入上表）`, '', `${ESTIMATE_LABEL}。`, '');
    push(
      '| 座位 | 已估计的丢分决策 | 多数世界也丢分 | 只有明牌才发现 |',
      '| --- | --: | --: | --: |',
    );
    for (const r of summary)
      push(
        `| ${seatName(r.seat)} | ${r.pimcChecked} | ${r.pimcMostWorlds} | ${r.pimcHindsightOnly} |`,
      );
    push('');
  }
  push('## 每局概览', '');
  push(
    '| 局 | 结果 | 尾段起点（全桌张数） | 尾段开始时精确值（0/2 队） | 座位0 丢分 | 座位1 丢分 | 座位2 丢分 | 座位3 丢分 |',
    '| --- | --- | --: | --: | --: | --: | --: | --: |',
  );
  for (const round of review.rounds) {
    const { bySeat } = roundPoints(round);
    const reviewed = new Set(round.seats);
    push(
      `| ${round.label} | ${teamName(round.result.team)} +${round.result.up} | ${round.tail.startCards ?? '—'} | ${valueText(round.tail.exactTeam0)}（实际 ${valueText(round.result.team0)}） | ${bySeat.map((v, s) => (reviewed.has(s) ? pointsText(v) : '—')).join(' | ')} |`,
    );
  }
  push('');
  for (const round of review.rounds) {
    push(`## 第 ${round.label} 局（${round.file || round.id}）`, '');
    push(`- 级牌：打 ${round.level}；${resultText(round)}`);
    push(
      `- 玩家标识（前 8 位）：${round.players.map((p, s) => `${seatName(s)} ${p.id || '—'}`).join('，')}`,
    );
    push(`- 尾段：${tailStartText(round)}`);
    push(`- 尾段为什么从这里开始：${stopText(round, options)}`);
    if (round.tail.actions) {
      push(
        `- 尾段开始时 ${EXACT_LABEL}：${teamName(0)} ${valueText(round.tail.exactTeam0)}；实际结果 ${teamName(0)} ${valueText(round.result.team0)}`,
      );
      push(
        `- 尾段开始时四家手牌：${round.tail.startHands.map((h, s) => `${seatName(s)}［${h.text || '已出完'}］`).join('；')}`,
      );
    }
    push('');
    for (const d of round.decisions) push(...decisionMarkdown(d, round), '');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

function decisionMarkdown(d, round) {
  const team = d.seat % 2;
  const head = `### 第 ${d.index + 1} 手 · ${seatName(d.seat)} · 全桌剩 ${d.tableCards} 张`;
  const tags = [];
  if (d.unscored) tags.push('超出预算，未求解');
  else if (d.flagged) tags.push(`**丢 ${d.loss} 分**`);
  else tags.push(d.forced ? '只有一种出法' : '最优');
  if (d.actor !== 'human') tags.push(`非本人操作（${actorText(d.actor)}）`);
  if (d.assisted) tags.push('出牌前看过预评');
  const lines = [`${head} · ${tags.join(' · ')}`, ''];
  lines.push(`- 桌面：${trickText(d)}；${countsText(d.counts)}`);
  lines.push(`- 手牌：${d.hand.text}`);
  if (d.unscored) {
    lines.push(`- 实际出牌：${d.played.text}`);
    return lines;
  }
  lines.push(
    `- 实际出牌：${d.played.text}${d.played.inCandidates ? '' : '（不在候选生成器的列表中）'} → 精确值 ${valueText(d.playedValue)}；局面值 ${valueText(d.best)}；丢分 ${d.loss}`,
  );
  lines.push(
    `- 最优出法（${d.optimalCount}／${d.candidates} 个候选保持局面值）：${d.optimal.map((p) => p.text).join('；')}`,
  );
  if (d.flagged) {
    lines.push(
      `- 其他三家手牌（事后公开）：${d.hands
        .map((h, s) => (s === d.seat ? null : `${seatName(s)}［${h.text || '已出完'}］`))
        .filter(Boolean)
        .join('；')}`,
    );
    lines.push(`- 最优续打（明牌）：${lineText(d.line, team)}`);
    if (d.afterPlayed) lines.push(`- 实际这手之后双方最优续打：${lineText(d.afterPlayed, team)}`);
    else lines.push('- 实际这手直接结束本局。');
    if (d.pimc) lines.push(...pimcMarkdown(d.pimc));
  } else {
    lines.push(
      '',
      '<details><summary>最优续打（明牌）</summary>',
      '',
      lineText(d.line, team),
      '',
      '</details>',
    );
  }
  return lines;
}

/** The PIMC-best move, or a note that the played move already ties for the best estimate. */
function pimcBestText(p, cards, plain = (t) => t) {
  if (p.playedIsPimcBest || p.pimcBestIndex === undefined)
    return plain('按估计平均值，实际这手已是（并列）最佳');
  return `${plain('估计最佳出法')} ${cards(p.pimcBest.text)} ${plain(valueText(p.meanBest))}`;
}

function pimcMarkdown(p) {
  if (!p.used) return [`- *${ESTIMATE_LABEL}*：${VERDICT.unknown}`];
  return [
    `- *${ESTIMATE_LABEL}*：${p.used} 个可求解的抽样世界中 ${p.losingWorlds} 个这手也丢分——${VERDICT[p.verdict]}。` +
      `平均值：实际这手 ${valueText(p.meanPlayed)}，${pimcBestText(p, (t) => t)}（估计值，非精确）。`,
  ];
}

/* ---------- HTML ---------- */

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const CSS = `
:root{--bg:#fbfaf7;--fg:#1f2328;--muted:#5d6670;--card:#ffffff;--line:#d9d6cf;--accent:#1f6f5c;--bad:#b42318;--bad-bg:#fdecea;--est:#6941c6;--est-bg:#f3effc;--chip:#eef1f3;--red:#c0392b}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15181c;--fg:#e6e8eb;--muted:#9aa4ae;--card:#1d2126;--line:#353b42;--accent:#4fc3a1;--bad:#ff8a80;--bad-bg:#3a1f1d;--est:#b69df8;--est-bg:#29223d;--chip:#262b31;--red:#ff8a80}}
:root[data-theme="dark"]{--bg:#15181c;--fg:#e6e8eb;--muted:#9aa4ae;--card:#1d2126;--line:#353b42;--accent:#4fc3a1;--bad:#ff8a80;--bad-bg:#3a1f1d;--est:#b69df8;--est-bg:#29223d;--chip:#262b31;--red:#ff8a80}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 12px}h2{font-size:20px;margin:36px 0 10px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:16px;margin:20px 0 8px}
.note{border-left:4px solid var(--accent);background:var(--card);padding:10px 14px;margin:10px 0;border-radius:6px}
.note.est{border-left-color:var(--est);background:var(--est-bg)}
.meta{color:var(--muted);font-size:13px}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:8px 0;background:var(--card);font-variant-numeric:tabular-nums}
th,td{border:1px solid var(--line);padding:6px 8px;text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{background:var(--chip);font-weight:600}
.decision{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.decision.flagged{border-color:var(--bad);box-shadow:inset 4px 0 0 var(--bad)}
.decision h3{margin:0 0 6px;font-size:15px}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:10px;background:var(--chip);margin-left:6px;font-weight:500}
.tag.bad{background:var(--bad-bg);color:var(--bad);font-weight:700}.tag.est{background:var(--est-bg);color:var(--est)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:4px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.line{font-size:13.5px;overflow-wrap:anywhere}.line .lead{color:var(--accent);font-weight:700}
.estimate{border:1px dashed var(--est);background:var(--est-bg);border-radius:6px;padding:8px 12px;margin-top:8px}
.estimate b{color:var(--est)}
.r{color:var(--red)}
details summary{cursor:pointer;color:var(--muted)}
@media (max-width:600px){dl{grid-template-columns:1fr}dt{margin-top:4px}}
`;

/** Card text with red suits colored (♥♦ and 大王). */
const cardsHTML = (text) =>
  esc(text).replace(/(♥|♦)([0-9JQKA]+(?:\(配\))?)|大王/g, (m) => `<span class="r">${m}</span>`);

const lineHTML = (line, team) =>
  `<div class="line">${line.plies
    .map(
      (ply) =>
        `${ply.lead ? '<span class="lead">｜</span>' : ''}${seatName(ply.seat)} ${cardsHTML(ply.play.text)}`,
    )
    .join(' → ')} ⇒ 结束，${teamName(team)} <b>${esc(valueText(line.value))}</b></div>`;

function decisionHTML(d) {
  const team = d.seat % 2;
  const tags = [];
  if (d.unscored) tags.push('<span class="tag">超出预算，未求解</span>');
  else if (d.flagged) tags.push(`<span class="tag bad">丢 ${d.loss} 分</span>`);
  else tags.push(`<span class="tag">${d.forced ? '只有一种出法' : '最优'}</span>`);
  if (d.actor !== 'human')
    tags.push(`<span class="tag">非本人操作（${esc(actorText(d.actor))}）</span>`);
  if (d.assisted) tags.push('<span class="tag">出牌前看过预评</span>');
  const rows = [
    [
      '桌面',
      `${cardsHTML(trickText(d))}<br><span class="meta">${esc(countsText(d.counts))}</span>`,
    ],
    ['手牌', cardsHTML(d.hand.text)],
  ];
  let extra = '';
  if (d.unscored) rows.push(['实际出牌', cardsHTML(d.played.text)]);
  else {
    rows.push([
      '实际出牌',
      `${cardsHTML(d.played.text)}${d.played.inCandidates ? '' : '（不在候选列表中）'} → 精确值 <b>${esc(valueText(d.playedValue))}</b>`,
    ]);
    rows.push(['局面值', `<b>${esc(valueText(d.best))}</b>　丢分 <b>${d.loss}</b>`]);
    rows.push([
      `最优出法（${d.optimalCount}／${d.candidates}）`,
      d.optimal.map((p) => cardsHTML(p.text)).join('；'),
    ]);
    if (d.flagged) {
      rows.push([
        '其他三家（事后公开）',
        d.hands
          .map((h, s) =>
            s === d.seat ? null : `${seatName(s)}［${cardsHTML(h.text || '已出完')}］`,
          )
          .filter(Boolean)
          .join('<br>'),
      ]);
      rows.push(['最优续打（明牌）', lineHTML(d.line, team)]);
      rows.push([
        '实际这手之后最优续打',
        d.afterPlayed ? lineHTML(d.afterPlayed, team) : '这手直接结束本局',
      ]);
      if (d.pimc) extra = pimcHTML(d.pimc);
    } else
      extra = `<details><summary>最优续打（明牌）</summary>${lineHTML(d.line, team)}</details>`;
  }
  return `<section class="decision${d.flagged ? ' flagged' : ''}"><h3>第 ${d.index + 1} 手 · ${seatName(d.seat)} · 全桌剩 ${d.tableCards} 张${tags.join('')}</h3><dl>${rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join('')}</dl>${extra}</section>`;
}

function pimcHTML(p) {
  const body = p.used
    ? `${p.used} 个可求解的抽样世界中 <b>${p.losingWorlds}</b> 个这手也丢分——${esc(VERDICT[p.verdict])}。<br>平均值（估计）：实际这手 ${esc(valueText(p.meanPlayed))}，${pimcBestText(p, cardsHTML, esc)}。`
    : esc(VERDICT.unknown);
  return `<div class="estimate"><span class="tag est">估计</span> <b>${esc(ESTIMATE_LABEL)}</b><br>${body}</div>`;
}

const tableHTML = (head, rows) =>
  `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;

export function renderHTML(review) {
  const options = review.options;
  const summary = review.summary || seatSummary(review.rounds);
  const parts = [];
  parts.push(`<h1>掼蛋牌局复盘</h1>`);
  parts.push(`<div class="note"><b>${esc(EXACT_LABEL)}</b>：${esc(EXACT_NOTE)}</div>`);
  if (options.pimc > 0)
    parts.push(`<div class="note est"><b>${esc(ESTIMATE_LABEL)}</b>：${esc(ESTIMATE_NOTE)}</div>`);
  parts.push(
    `<p class="meta">记录 ${review.rounds.length} 局（可信度 ${esc(review.trust)}：浏览器上传，未做身份验证）；复盘座位 ${esc((options.seats || [0, 1, 2, 3]).map(seatName).join('、'))}；精确求解全桌 ≤ ${options.maxCards} 张，预算 ${options.maxNodes} 节点／${options.maxMs} 毫秒；${options.pimc > 0 ? `估计：丢分决策且 ≤ ${options.pimcCards} 张时抽样 ${options.pimc} 个世界` : '估计未启用'}；生成 ${esc(review.finishedAt || '')}</p>`,
  );
  parts.push(`<h2>汇总：各座位丢分 · ${esc(EXACT_LABEL)} · 精确值</h2>`);
  parts.push(
    tableHTML(
      [
        '座位',
        '局数',
        '复盘决策',
        '其中有选择',
        '丢分决策',
        '合计丢分',
        '未求解',
        '非本人操作',
        '看过预评',
      ],
      summary.map((r) => [
        seatName(r.seat),
        r.rounds,
        r.decisions,
        r.choices,
        r.flagged,
        `<b>${esc(pointsText(r.lostPoints))}</b>`,
        r.decisions - r.scored,
        r.nonHuman,
        r.assisted,
      ]),
    ),
  );
  parts.push(
    '<p class="meta">座位号按每局记录；不同比赛的同一座位可能是不同的人，请按各局的玩家标识认领自己的座位。合计丢分是各手丢分之和，只覆盖可精确求解的尾段。</p>',
  );
  const players = review.players || playerSummary(review.rounds);
  parts.push('<h3>按玩家标识（匿名 ID 前 8 位）· 精确值</h3>');
  parts.push(
    tableHTML(
      ['玩家标识', '座位', '局数', '复盘决策', '丢分决策', '合计丢分', '未求解', '看过预评'],
      players.map((r) => [
        esc(r.player),
        esc(r.seats.map(seatName).join('、')),
        r.rounds,
        r.decisions,
        r.flagged,
        `<b>${esc(pointsText(r.lostPoints))}</b>`,
        r.decisions - r.scored,
        r.assisted,
      ]),
    ),
  );
  if (options.pimc > 0) {
    parts.push(`<h3>估计（不计入上表）</h3><p class="meta">${esc(ESTIMATE_LABEL)}。</p>`);
    parts.push(
      tableHTML(
        ['座位', '已估计的丢分决策', '多数世界也丢分', '只有明牌才发现'],
        summary.map((r) => [
          seatName(r.seat),
          r.pimcChecked,
          r.pimcMostWorlds,
          r.pimcHindsightOnly,
        ]),
      ),
    );
  }
  parts.push('<h2>每局概览</h2>');
  parts.push(
    tableHTML(
      [
        '局',
        '结果',
        '尾段起点（张）',
        '尾段开始精确值（0/2 队）',
        '座位0',
        '座位1',
        '座位2',
        '座位3',
      ],
      review.rounds.map((round) => {
        const { bySeat } = roundPoints(round);
        const reviewed = new Set(round.seats);
        return [
          `<a href="#r-${esc(round.label)}">${esc(round.label)}</a>`,
          esc(`${teamName(round.result.team)} +${round.result.up}`),
          round.tail.startCards ?? '—',
          esc(`${valueText(round.tail.exactTeam0)}（实际 ${valueText(round.result.team0)}）`),
          ...bySeat.map((v, s) => (reviewed.has(s) ? esc(pointsText(v)) : '—')),
        ];
      }),
    ),
  );
  for (const round of review.rounds) {
    parts.push(`<h2 id="r-${esc(round.label)}">第 ${esc(round.label)} 局</h2>`);
    const rows = [
      ['结果', esc(`打 ${round.level}；${resultText(round)}`)],
      [
        '玩家标识（前 8 位）',
        esc(round.players.map((p, s) => `${seatName(s)} ${p.id || '—'}`).join('，')),
      ],
      ['尾段', esc(tailStartText(round))],
      ['为什么从这里开始', esc(stopText(round, options))],
    ];
    if (round.tail.actions) {
      rows.push([
        `尾段开始时精确值`,
        esc(
          `${teamName(0)} ${valueText(round.tail.exactTeam0)}（实际 ${valueText(round.result.team0)}）`,
        ),
      ]);
      rows.push([
        '尾段开始时四家手牌',
        round.tail.startHands
          .map((h, s) => `${seatName(s)}［${cardsHTML(h.text || '已出完')}］`)
          .join('<br>'),
      ]);
    }
    parts.push(`<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`);
    for (const d of round.decisions) parts.push(decisionHTML(d));
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>掼蛋牌局复盘</title><style>${CSS}</style></head>
<body><main>${parts.join('\n')}</main></body></html>
`;
}

/** Write review.md and review.html into `dir`; returns the written paths. */
export function writeReports(review, dir) {
  const md = join(dir, 'review.md'),
    html = join(dir, 'review.html');
  writeFileSync(md, renderMarkdown(review));
  writeFileSync(html, renderHTML(review));
  return [md, html];
}

if (isEntry(import.meta.url)) {
  const option = (name) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const input = option('in');
  if (!input) {
    console.error('Usage: report.mjs --in=<review.json> [--out=<dir>]');
    process.exit(1);
  }
  const review = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const out = resolve(option('out') || dirname(resolve(input)));
  assertSafeOut(out, review.raw || null);
  console.log(writeReports(review, out).join('\n'));
}
