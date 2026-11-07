import { Sound } from '../audio/sound.js';
import { TYPE_NAME, isWild, makeDeck, rankName, shuffle, sortHand } from '../core/cards.js';
import { isBomb } from '../core/combinations.js';
import { armPlaysRaw, armScore, scorePower } from '../hand/arrangement.js';
import { readGroup, groupUnits, sortGroups } from '../replay/session.js';
import { rowsOf } from '../replay/inspector.js';
import { $, cardHTML, displayOrder } from '../ui/cards.js';
import { VERSION } from '../network/protocol.js';
import { editGroups, readArrangementRecord } from './groups.mjs';

let onHome;
const ARKEY = 'guandan-arrange-records';
const AR = {
  hands: null,
  L: 2,
  deal: 0,
  seat: 0,
  done: [false, false, false, false],
  comp: [null, null, null, null],
  mine: [null, null, null, null],
  recOf: [null, null, null, null],
  sel: new Set(),
  view: 'seat',
  recs: [],
  byId: null,
  lv: 'r',
  cache: new Map(),
  uk: new Map(),
};
export function openArrangement(home) {
  onHome = home;
  try {
    const saved = JSON.parse(localStorage.getItem(ARKEY) || '[]');
    AR.recs = Array.isArray(saved)
      ? saved.slice(-500).flatMap((r) => {
          try {
            return [readArrangementRecord(r)];
          } catch {
            return [];
          }
        })
      : [];
  } catch {
    AR.recs = [];
  }
  document.body.classList.add('arranging');
  $('#arr').hidden = false;
  if (!AR.hands) arrDeal();
  arrRender();
  $('#arr').focus();
}
function arrDeal() {
  AR.deal++;
  const L = AR.lv === 'r' ? 2 + Math.floor(Math.random() * 13) : +AR.lv;
  const deck = shuffle(makeDeck());
  AR.L = L;
  AR.byId = new Map(deck.map((c) => [c.id, c]));
  AR.hands = [0, 1, 2, 3].map((p) => sortHand(deck.slice(p * 27, p * 27 + 27), L));
  AR.seat = 0;
  AR.done = [false, false, false, false];
  AR.comp = [null, null, null, null];
  AR.mine = [null, null, null, null];
  AR.recOf = [null, null, null, null];
  AR.sel = new Set();
  AR.view = 'seat';
  AR.cache.clear();
  AR.uk = new Map();
}
const arrKey = (gr) =>
  gr
    .slice()
    .sort((a, b) => a - b)
    .join('.');
// groups of card numbers for an arrangement, in the order the computer's are shown in
// (a group the computer's arranging made keeps its own reading, by its cards, so it is scored as the computer scored it)
function arrIds(units, L) {
  for (const u of units) AR.uk.set(arrKey(u.cards.map((c) => c.id)), u);
  return units.map((u) => displayOrder(u, L).map((c) => c.id));
}
function arrOrder(groups, L) {
  return sortGroups(groups, AR.byId, L);
}
// the computer's arrangement of a seat's hand, and its 牌力
function arrComp(p) {
  if (!AR.comp[p]) {
    const h = AR.hands[p],
      L = AR.L,
      units = armPlaysRaw(h, L);
    AR.comp[p] = { groups: arrOrder(arrIds(units, L), L), power: arrPow(units) };
  }
  return AR.comp[p];
}
// the player's arrangement of the seat's hand now (the computer's until changed) and its 牌力
function arrMine(p) {
  if (!AR.mine[p]) AR.mine[p] = arrComp(p).groups.map((g) => g.slice());
  const L = AR.L,
    by = AR.byId,
    groups = AR.mine[p];
  const units = groups.flatMap((gr) => {
    const u = AR.uk.get(arrKey(gr));
    return u
      ? [u]
      : groupUnits(
          gr.map((id) => by.get(id)),
          L,
        );
  });
  return { groups, power: arrPow(units) };
}
// (the sum of the scores is rounded first: the same groups added up in another order can differ by 1e-16, enough to tip a 牌力)
const arrPow = (units) => scorePower(+armScore(units).toFixed(9));
// cards that are left without their group are arranged again the computer's way
function arrAuto(ids) {
  if (!ids.length) return [];
  const L = AR.L,
    key =
      L +
      ':' +
      ids
        .slice()
        .sort((a, b) => a - b)
        .join();
  let a = AR.cache.get(key);
  if (!a)
    AR.cache.set(
      key,
      (a = arrIds(
        armPlaysRaw(
          ids.map((id) => AR.byId.get(id)),
          L,
        ),
        L,
      )),
    );
  return a;
}
// several cards as one group, laid out the way their combination reads
function arrTidy(ids) {
  const L = AR.L,
    cards = ids.map((id) => AR.byId.get(id)),
    u = readGroup(cards, L);
  return (u ? displayOrder(u, L) : sortHand(cards.slice(), L)).map((c) => c.id);
}
// 成组: the picked cards become one group; 拆开: each becomes a single; 并入: they join the group at index `to`
function arrEdit(mode, to) {
  const p = AR.seat,
    L = AR.L,
    ids = [...AR.sel];
  if (!ids.length || (mode === 'group' && ids.length < 2)) return;
  AR.mine[p] = editGroups(AR.mine[p], ids, {
    mode,
    to,
    auto: arrAuto,
    tidy: arrTidy,
    order: (groups) => arrOrder(groups, L),
  });
  AR.sel = new Set();
  Sound.play('play');
  arrRender();
}
// how a group reads: its kind and its cards
function arrName(cards, L) {
  const u = readGroup(cards, L);
  return u
    ? u.type === 'jokers'
      ? '天王炸'
      : isBomb(u) && u.type === 'bomb'
        ? u.n + '张炸弹'
        : TYPE_NAME[u.type]
    : '不成牌型';
}
const arrLabel = (c, L) =>
  c.r === 17
    ? '大王'
    : c.r === 16
      ? '小王'
      : isWild(c, L)
        ? '百搭'
        : rankName(c.r) + (c.r === L ? '(级)' : '');
function arrText(ids, L, by) {
  const cards = ids.map((id) => by.get(id)),
    u = readGroup(cards, L),
    ord = u ? displayOrder(u, L) : cards;
  return arrName(cards, L) + ' ' + ord.map((c) => arrLabel(c, L)).join(' ');
}
// the widest fit: how many card widths a row of groups takes (a group is 1 card, 0.42 more for each further card, and a gap)
function arrLayout(groups, rowsMax, W, hAvail, cwMax, cwMin) {
  const us = groups.map((g, i) => ({ cards: g, gi: i }));
  let best = null;
  for (let k = 1; k <= rowsMax; k++) {
    const rows = rowsOf(us, k);
    const wide = Math.max(
      ...rows.map(
        (r) => r.reduce((t, u) => t + 1.22 + 0.42 * (u.cards.length - 1), 0) + 0.06 * r.length,
      ),
    );
    const most = Math.max(...rows.map((r) => r.length));
    const cw = Math.max(
      cwMin,
      Math.min(
        cwMax,
        Math.floor((W - most * 16) / wide),
        Math.floor((hAvail / rows.length - 34) / 1.4),
      ),
    );
    if (!best || cw > best.cw) best = { cw, rows };
  }
  return best;
}
function arrRowsHTML(lay, groups, mine, otherKeys) {
  const L = AR.L,
    by = AR.byId;
  return (
    `<div class="ar-rows" style="--cw:${lay.cw}px">` +
    lay.rows
      .map(
        (r) =>
          `<div class="ar-row">` +
          r
            .map((u) => {
              const gr = groups[u.gi],
                cards = gr.map((id) => by.get(id)),
                rd = readGroup(cards, L);
              const diff = !otherKeys.has(arrKey(gr));
              const nm = arrName(cards, L),
                cls = rd ? (isBomb(rd) ? ' bomb' : '') : ' bad';
              const join = mine && AR.sel.size && [...AR.sel].some((id) => !gr.includes(id));
              return (
                `<div class="ag${diff ? ' diff' : ''}" data-gi="${u.gi}"><div class="agc">${cards.map((c) => cardHTML(c, L, AR.sel.has(c.id) ? 'sel' : '')).join('')}</div>` +
                `<span class="agl${cls}">${nm}</span>${join ? '<button class="agj" data-act="join">并入这组</button>' : ''}</div>`
              );
            })
            .join('') +
          `</div>`,
      )
      .join('') +
    `</div>`
  );
}
function arrRender() {
  const el = $('#arr');
  if (!AR.hands) return;
  const keep = el.scrollTop;
  const focused = el.contains(document.activeElement)
    ? document.activeElement.closest('.card')?.dataset.id
    : null;
  el.innerHTML = AR.view === 'sum' ? arrSumHTML() : arrSeatHTML();
  el.scrollTop = keep;
  for (const card of el.querySelectorAll('.mine .card')) {
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-label', '选择' + arrLabel(AR.byId.get(+card.dataset.id), AR.L));
    card.setAttribute('aria-pressed', String(AR.sel.has(+card.dataset.id)));
  }
  if (focused != null)
    el.querySelector('.mine .card[data-id="' + focused + '"]')?.focus({ preventScroll: true });
}
function arrTop() {
  const L = AR.L;
  const seats = [0, 1, 2, 3]
    .map((p) => {
      const now = AR.view === 'seat' && p === AR.seat,
        ok = AR.done[p] || now;
      return `<button class="ar-seat${AR.done[p] ? ' done' : ''}${now ? ' now' : ''}" data-act="seat" data-n="${p}"${ok ? '' : ' disabled'}>${p + 1}号</button>`;
    })
    .join('');
  const opts = ['<option value="r">随机</option>']
    .concat(
      Array.from({ length: 13 }, (_, i) => `<option value="${i + 2}">${rankName(i + 2)}</option>`),
    )
    .map((o) => o.replace(`value="${AR.lv}"`, `value="${AR.lv}" selected`))
    .join('');
  return `<div class="ar-top"><span class="ar-title">配牌</span><span class="ar-seats">${seats}</span>
    <span class="ar-info">第 <b>${AR.deal}</b> 副　本副打 <b>${rankName(L)}</b>　下一副打<select id="arrL">${opts}</select>${AR.view === 'seat' && AR.recs.length ? '<button class="ar-link" data-act="save">导出记录</button>' : ''}<button class="ar-link" data-act="home">训练首页</button></span></div>`;
}
function arrSeatHTML() {
  const p = AR.seat,
    L = AR.L,
    c = arrComp(p),
    m = arrMine(p),
    el = $('#arr');
  const W = Math.max(300, el.clientWidth - 40 - 30),
    avail = Math.max(300, el.clientHeight - 400);
  const compH = Math.max(120, Math.round(avail * 0.36)),
    mineH = Math.max(200, avail - compH);
  const ck = new Set(c.groups.map(arrKey)),
    mk = new Set(m.groups.map(arrKey));
  const lc = arrLayout(c.groups, 2, W, compH, 40, 24),
    lm = arrLayout(m.groups, 3, W, mineH, 66, 32);
  const d = m.power - c.power,
    cls = d > 0 ? 'up' : d < 0 ? 'down' : 'same',
    txt = d > 0 ? `牌力比电脑高 ${d}` : d < 0 ? `牌力比电脑低 ${-d}` : '牌力和电脑一样';
  const compOnly = c.groups.filter((g) => !mk.has(arrKey(g))),
    mineOnly = m.groups.filter((g) => !ck.has(arrKey(g)));
  const by = AR.byId;
  const diff =
    compOnly.length || mineOnly.length
      ? `<div class="l"><span class="k">电脑有、你没有</span>${compOnly.map((g) => `<span class="g">${arrText(g, L, by)}</span>`).join('') || '<span class="ok">（没有）</span>'}</div>
       <div class="l"><span class="k">你有、电脑没有</span>${mineOnly.map((g) => `<span class="g mine">${arrText(g, L, by)}</span>`).join('') || '<span class="ok">（没有）</span>'}</div>`
      : '<div class="l"><span class="ok">和电脑的配法完全一样。点牌可以改：选几张牌，再点“成组”“拆开”，或点某一组上的“并入这组”。</span></div>';
  // the next seat still to arrange (after this one), for the button
  const nxt = [1, 2, 3].map((k) => (p + k) % 4).find((q) => !AR.done[q]);
  const doneText = AR.done[p]
    ? `重新记录 ${p + 1}号`
    : nxt == null
      ? `完成 ${p + 1}号，看总结`
      : `完成 ${p + 1}号，配 ${nxt + 1}号 ▶`;
  const n = AR.recs.length,
    ch = AR.recs.filter((r) => !r.same).length;
  return (
    arrTop() +
    `<p class="ar-score-note">分组参考分不是冠军网络评分或胜率；记录仅保存在本浏览器，可导出，不自动用于训练。</p>${AR.storageFailed ? '<p class="ar-storage-warning" role="status">记录暂未写入浏览器，请先导出保存。</p>' : ''}
    <div class="ar-pnl"><div class="ar-head"><h2>电脑的配牌（分组参考）</h2><span class="sub">${p + 1}号 · ${AR.hands[p].length} 张 · 只能看</span>
      <span class="ar-pw"><span class="n">${c.power}</span><span class="t">分组参考分 · 第 ${Math.min(5, 1 + Math.floor(c.power / 20))} 档</span></span></div>${arrRowsHTML(lc, c.groups, false, mk)}</div>
    <div class="ar-pnl mine"><div class="ar-head"><h2>你的配牌</h2><span class="sub">点牌选中（可以选好几张），再点下面的按钮</span>
      <span class="ar-pw"><span class="n">${m.power}</span><span class="t">分组参考分 · 第 ${Math.min(5, 1 + Math.floor(m.power / 20))} 档</span><span class="d ${cls}">${txt}</span></span></div>${arrRowsHTML(lm, m.groups, true, ck)}</div>
    <div class="ar-diff">${diff}</div>
    <div class="ar-bar"><button class="ar-btn alt" data-act="group"${AR.sel.size >= 2 ? '' : ' disabled'}>成组</button><button class="ar-btn alt" data-act="split"${AR.sel.size ? '' : ' disabled'}>拆开</button>
      <button class="ar-btn alt" data-act="restore"${compOnly.length || mineOnly.length ? '' : ' disabled'}>改回电脑的配法</button>
      <span class="sp"></span>${AR.done[p] ? '' : '<button class="ar-link" data-act="skip">这家不记了</button>'}<button class="ar-btn big" data-act="done">${doneText}</button></div>
    <div class="ar-tip">每家配好点“完成”，电脑就把你和它的不同记下来（现在已记 ${n} 手，其中你改过 ${ch} 手）。屏幕上一次只有一家的牌。</div>`
  );
}
function arrSumHTML() {
  const rows = [0, 1, 2, 3]
    .map((p) => {
      const c = arrComp(p),
        m = arrMine(p),
        r = AR.recs.find((r) => r.uid === AR.recOf[p]),
        d = m.power - c.power;
      const k = new Set(c.groups.map(arrKey)),
        n = m.groups.filter((g) => !k.has(arrKey(g))).length;
      return `<tr><td>${p + 1}号</td><td>${r ? c.power : '—'}</td><td>${r ? m.power : '—'}</td><td class="${r ? (d > 0 ? 'up' : d < 0 ? 'down' : '') : ''}">${r ? (d > 0 ? '+' : '') + d : '—'}</td><td>${r ? (n ? n + ' 组不同' : '一样') : '没记'}</td></tr>`;
    })
    .join('');
  const n = AR.recs.length,
    ch = AR.recs.filter((r) => !r.same).length,
    hi = AR.recs.filter((r) => r.minePower > r.compPower).length,
    lo = AR.recs.filter((r) => r.minePower < r.compPower).length;
  return (
    arrTop() +
    `<p class="ar-score-note">分组参考分不是冠军网络评分或胜率；记录仅保存在本浏览器，可导出，不自动用于训练。</p>${AR.storageFailed ? '<p class="ar-storage-warning" role="status">记录暂未写入浏览器，请先导出保存。</p>' : ''}
    <div class="ar-pnl mine"><div class="ar-head"><h2>这副牌四家都配完了</h2><span class="sub">第 ${AR.deal} 副 · 打 ${rankName(AR.L)}</span></div>
      <table class="ar-sum"><tr><th></th><th>电脑牌力</th><th>你的牌力</th><th>差</th><th>配法</th></tr>${rows}</table></div>
    <div class="ar-diff"><div class="l"><span class="k">累计记录</span>共 ${n} 手，你改过 ${ch} 手；牌力比电脑高 ${hi} 手、低 ${lo} 手。</div></div>
    <div class="ar-bar"><button class="ar-btn alt" data-act="save">保存记录（txt）</button><button class="ar-btn alt" data-act="copy">复制记录</button><span class="sp"></span>
      <button class="ar-btn big" data-act="newdeal">再发一副 ▶</button></div>
    <div class="ar-tip">点上面的 1号～4号 可以回去看那一家的配牌，改了再点“重新记录”。</div>`
  );
}
function arrToast(t) {
  const e = document.createElement('div');
  e.className = 'ar-toast';
  e.textContent = t;
  document.body.appendChild(e);
  setTimeout(() => e.remove(), 2200);
}
// 完成: the two arrangements of this seat go into the records
function arrDone() {
  const p = AR.seat,
    L = AR.L,
    c = arrComp(p),
    m = arrMine(p);
  const ck = new Set(c.groups.map(arrKey)),
    mk = new Set(m.groups.map(arrKey));
  const only = {
    comp: c.groups.filter((g) => !mk.has(arrKey(g))),
    mine: m.groups.filter((g) => !ck.has(arrKey(g))),
  };
  const rec = {
    schema: 1,
    kind: 'arrangement-practice',
    source: 'unverified_browser',
    assisted: true,
    scoreKind: 'grouping-reference-not-network-probability',
    appVersion: VERSION,
    uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    at: new Date().toISOString(),
    deal: AR.deal,
    L,
    seat: p + 1,
    hand: AR.hands[p].map((x) => x.id),
    comp: c.groups,
    mine: m.groups,
    compPower: c.power,
    minePower: m.power,
    same: !only.comp.length && !only.mine.length,
    only,
  };
  const previous = AR.recs.findIndex((r) => r.uid === AR.recOf[p]);
  if (previous >= 0) AR.recs[previous] = rec;
  else AR.recs.push(rec);
  AR.recOf[p] = rec.uid;
  AR.recs = AR.recs.slice(-500);
  let saved = true;
  try {
    localStorage.setItem(ARKEY, JSON.stringify(AR.recs));
  } catch {
    saved = false;
  }
  AR.storageFailed = !saved;
  AR.done[p] = true;
  arrToast(
    rec.same
      ? `已记录：${p + 1}号和电脑配得一样`
      : `已记录：${p + 1}号有 ${only.mine.length} 组和电脑不同，牌力 ${c.power} → ${m.power}`,
  );
  const nxt = [1, 2, 3].map((k) => (p + k) % 4).find((q) => !AR.done[q]);
  AR.sel = new Set();
  if (nxt == null) AR.view = 'sum';
  else {
    AR.seat = nxt;
    AR.view = 'seat';
  }
  arrRender();
  $('#arr').scrollTop = 0;
}
const ARDECK = new Map(makeDeck().map((c) => [c.id, c]));
function arrRecText(r) {
  const by = ARDECK,
    L = r.L,
    line = (gs) => gs.map((g) => arrText(g, L, by)).join('　｜　');
  const d = r.minePower - r.compPower;
  return (
    `第 ${r.deal} 副 · 打 ${rankName(L)} · ${r.seat}号　牌力 电脑 ${r.compPower} → 你 ${r.minePower}（${d > 0 ? '+' : ''}${d}）${r.same ? '　配法一样' : ''}\n` +
    `  电脑的配牌：${line(r.comp)}\n  你的配牌：${line(r.mine)}\n` +
    (r.same
      ? ''
      : `  电脑有、你没有：${line(r.only.comp) || '（没有）'}\n  你有、电脑没有：${line(r.only.mine) || '（没有）'}\n`)
  );
}
function arrAllText() {
  const head = `掼蛋配牌训练记录\n保存时间：${new Date().toLocaleString()}　页面版本：${VERSION}\n共 ${AR.recs.length} 手；每手是一家的牌：电脑怎么配、你怎么配、牌力、有哪些组不同\n\n`;
  return (
    head +
    AR.recs.map(arrRecText).join('\n') +
    '\n#DATA ' +
    JSON.stringify(AR.recs.map((r) => ({ ...r, only: undefined }))) +
    '\n'
  );
}
function arrSave() {
  const t = arrAllText();
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([t], { type: 'text/plain;charset=utf-8' }));
    const d = new Date();
    a.download = `掼蛋配牌记录-${d.getMonth() + 1}月${d.getDate()}日.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    arrToast('记录已保存成 txt 文件');
  } catch (_) {
    arrCopy();
  }
}
function arrCopy() {
  const t = arrAllText();
  const ok = () => arrToast('记录已复制，可以保存或分析');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(t)
      .then(ok)
      .catch(() => arrToast('复制没有成功，请用“保存记录”'));
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = t;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    ok();
  } catch (_) {
    arrToast('复制没有成功，请用“保存记录”');
  }
  ta.remove();
}
export function initialize() {
  $('#arr').addEventListener('click', (e) => {
    const card = e.target.closest('.ar-pnl.mine .card');
    if (card && AR.view === 'seat') {
      const id = +card.dataset.id;
      if (AR.sel.has(id)) AR.sel.delete(id);
      else AR.sel.add(id);
      Sound.play('select');
      arrRender();
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'group':
        arrEdit('group');
        break;
      case 'split':
        arrEdit('split');
        break;
      case 'join':
        arrEdit('join', +b.closest('.ag').dataset.gi);
        break;
      case 'restore':
        AR.mine[AR.seat] = null;
        AR.sel = new Set();
        arrRender();
        break;
      case 'done':
        arrDone();
        break;
      case 'skip': {
        AR.done[AR.seat] = true;
        const nxt = [1, 2, 3].map((k) => (AR.seat + k) % 4).find((q) => !AR.done[q]);
        AR.sel = new Set();
        if (nxt == null) AR.view = 'sum';
        else AR.seat = nxt;
        arrRender();
        $('#arr').scrollTop = 0;
        break;
      }
      case 'seat':
        AR.seat = +b.dataset.n;
        AR.view = 'seat';
        AR.sel = new Set();
        arrRender();
        break;
      case 'newdeal':
        arrDeal();
        arrRender();
        $('#arr').scrollTop = 0;
        break;
      case 'save':
        arrSave();
        break;
      case 'copy':
        arrCopy();
        break;
      case 'home':
        closeArrangement();
        break;
    }
  });
  $('#arr').addEventListener('change', (e) => {
    if (e.target.id === 'arrL') AR.lv = e.target.value;
  });
  addEventListener('resize', () => {
    if (!$('#arr').hidden) arrRender();
  });

  document.addEventListener(
    'keydown',
    (e) => {
      if ($('#arr').hidden) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        closeArrangement();
      } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.mine .card')) {
        e.preventDefault();
        e.target.click();
      }
    },
    true,
  );
}
function closeArrangement() {
  $('#arr').hidden = true;
  document.body.classList.remove('arranging');
  onHome?.();
}
