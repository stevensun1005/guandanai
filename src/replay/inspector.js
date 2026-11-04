import { runtime } from '../app/runtime.js';
import { TALLY_RANKS, tallyKey } from '../ai/rule-policy.js';
import {
  SUIT_CH,
  TYPE_NAME,
  cardText,
  isWild,
  makeDeck,
  rankName,
  sortHand,
  val,
} from '../core/cards.js';
import { isBomb, power } from '../core/combinations.js';
import { armPlays, handPower } from '../hand/arrangement.js';
import { miniMode } from '../input/actions.js';
import { syncUndo } from './history.js';
import {
  esc,
  pcol,
  playName,
  powerText,
  rawPower,
  readGroup,
  seatGroups,
  practiceMine,
  trickEnd,
  uaOf,
} from './session.js';
import { practiceStore } from './storage.js';
import { $, cardHTML, displayOrder } from '../ui/cards.js';
import { pileGeo, pileRefit } from '../ui/table-pile.js';
import { cardTag } from '../ui/table.js';

export let T_ORDER;
export let rowsHTML;
let handRowsHTML;
export let curRec;
let TCV;
let TC;
let rankLabel;
let KIND_ORDER;
export let practiceMidHalf;
let tcwNow;

export function handUnits(cards, L, grouped) {
  if (grouped)
    return armPlays(cards, L)
      .slice()
      .sort(
        (a, b) =>
          T_ORDER.indexOf(a.type) - T_ORDER.indexOf(b.type) ||
          (isBomb(a) ? power(b) - power(a) : b.value - a.value),
      )
      .map((u) => ({
        cards: displayOrder(u, L),
        name: u.type === 'bomb' ? u.n + '张炸弹' : TYPE_NAME[u.type],
      }));
  const out = [];
  for (const c of sortHand(cards.slice(), L)) {
    const g = out[out.length - 1];
    if (g && val(g.cards[0], L) === val(c, L) && isWild(g.cards[0], L) === isWild(c, L))
      g.cards.push(c);
    else out.push({ cards: [c], name: '' });
  }
  return out;
}

// a seat's cards as a record shows them: yours in the groups you had when play began, a computer's as you rearranged it
// (less what has been played since), or else the computer's own arrangement
export function recUnits(rec, p, cards) {
  const gs = p ? rec.userGroups && rec.userGroups[p] : rec.myGroups;
  if (!gs) return handUnits(cards, rec.L, true);
  const by = new Map(cards.map((c) => [c.id, c]));
  return gs
    .map((gr) => gr.filter((id) => by.has(id)).map((id) => by.get(id)))
    .filter((g) => g.length)
    .map((g) => ({ cards: g, name: '' }));
}

// the groups in at most three rows (or as many as asked), as even in length as the groups allow (lengths in card widths:
// each further card shows 0.42 of a card, a gap of 0.22 between groups)
export function rowsOf(units, k = 3) {
  const W = units.map((u) => 1.22 + 0.42 * (u.cards.length - 1)),
    n = units.length,
    pre = [0];
  for (const w of W) pre.push(pre[pre.length - 1] + w);
  // best[r][i]: the widest row when the first i groups go in r rows, and where its last row starts
  const best = [[{ m: 0, at: 0 }].concat(Array(n).fill({ m: Infinity, at: 0 }))];
  for (let r = 1; r <= k; r++) {
    const row = [{ m: 0, at: 0 }];
    for (let i = 1; i <= n; i++) {
      let b = { m: Infinity, at: 0 };
      for (let j = 0; j < i; j++) {
        const m = Math.max(best[r - 1][j].m, pre[i] - pre[j]);
        if (m < b.m - 1e-9) b = { m, at: j };
      }
      row.push(b.m < best[r - 1][i].m - 1e-9 ? b : { ...best[r - 1][i], same: true });
    }
    best.push(row);
  }
  const rows = [];
  for (let r = k, i = n; r > 0 && i > 0; r--) {
    const b = best[r][i];
    if (b.same) continue;
    rows.unshift(units.slice(b.at, i));
    i = b.at;
  }
  return rows;
}

export function practiceRender() {
  practicePeeks();
  practiceMine();
  practiceList();
  practicePlays();
  practiceCounter();
  syncUndo();
}

export function practiceCounterNext(p) {
  let w = $('#tc' + p);
  if (!w) {
    w = document.createElement('div');
    w.id = 'tc' + p;
    w.className = 'tcount';
    w.hidden = true;
    w.style.left = 16 + p * 36 + 'px';
    w.style.top = 90 + p * 36 + 'px';
    document.body.appendChild(w);
    practiceDragBox(w, 'guandan-tc' + p);
    w.addEventListener('click', (e) => {
      if (e.target.closest('.tcClose')) {
        w.hidden = true;
        document.querySelector(`.tcb[data-p="${p}"]`).classList.remove('on');
        return;
      }
      const t = e.target.closest('.tcv [data-v]');
      if (t) {
        TC[p] = +t.dataset.v;
        w.dataset.k = '';
        practiceCounter();
      }
    });
  }
  TC[p] = w.hidden ? 0 : ((TC[p] || 0) + 1) % 3;
  w.hidden = false;
  document.querySelector(`.tcb[data-p="${p}"]`).classList.add('on');
  w.dataset.k = '';
  practiceCounter();
}

// cards in rank groups, largest first: each rank's label, its cards, how many
function rankRows(cards, L) {
  const by = {};
  for (const c of cards) (by[tallyKey(c, L)] || (by[tallyKey(c, L)] = [])).push(c);
  return TALLY_RANKS(L)
    .filter((k) => by[k])
    .map(
      (k) =>
        `<div class="tcr"><b>${rankLabel(k, L)}</b><div><span class="mcs">${sortHand(
          by[k].slice(),
          L,
        )
          .map(miniCard)
          .join('')}</span><span class="cn">${by[k].length} 张</span></div></div>`,
    )
    .join('');
}

function practiceCounter() {
  if (!runtime.reviewMode || !runtime.game) return;
  const L = runtime.game.L;
  for (let p = 0; p < 4; p++) {
    const w = $('#tc' + p);
    if (!w || w.hidden) continue;
    const v = TC[p] || 0,
      key = [runtime.game.round, L, runtime.game.log.length, v, runtime.game.hands[p].length].join(
        '|',
      );
    if (w.dataset.k === key) continue;
    w.dataset.k = key;
    const mine = runtime.game.log.map((e, i) => ({ e, k: i + 1 })).filter((x) => x.e.p === p),
      plays = mine.filter((x) => x.e.cards);
    let body = '';
    if (v === 0) {
      const kinds = KIND_ORDER.filter((t) => plays.some((x) => x.e.type === t));
      body =
        kinds
          .map(
            (t) =>
              `<div class="tcr"><b>${t === 'bomb' ? '炸弹' : TYPE_NAME[t]}</b><div>${plays
                .filter((x) => x.e.type === t)
                .map(
                  (x) =>
                    `<span class="tcp"><i>第 ${x.k} 手${x.e.lead ? ' 领出' : ''}</i><span class="mcs">${displayOrder(x.e, L).map(miniCard).join('')}</span></span>`,
                )
                .join('')}</div></div>`,
          )
          .join('') || '<div class="tcsum">还没出过牌</div>';
      body += `<div class="tcsum">出了 ${plays.length} 手，过了 ${mine.length - plays.length} 次，剩 ${runtime.game.hands[p].length} 张</div>`;
    } else if (v === 1) {
      const cs = plays.flatMap((x) => x.e.cards);
      body =
        (rankRows(cs, L) || '<div class="tcsum">还没出过牌</div>') +
        `<div class="tcsum">一共出了 ${cs.length} 张</div>`;
    } else {
      const gone = new Set(
        runtime.game.log
          .filter((e) => e.cards)
          .flatMap((e) => e.cards.map((c) => c.id))
          .concat(runtime.game.hands[p].map((c) => c.id)),
      );
      const out = makeDeck().filter((c) => !gone.has(c.id));
      body =
        rankRows(out, L) +
        `<div class="tcsum">外面一共 ${out.length} 张（另外三家手里合起来）</div>`;
    }
    w.innerHTML = `<h3 class="tnh"><span style="color:${pcol(p)}">${runtime.names[p]} 记牌器</span><button class="tcClose">关闭</button></h3>
      <div class="tcv">${TCV.map((t, i) => `<span data-v="${i}"${i === v ? ' class="on"' : ''}>${t}</span>`).join('')}</div>${body}`;
  }
}

// the three computer hands, face up beside their plates; arranged once the cards are all dealt
export function practicePeeks() {
  if (!runtime.reviewMode || !runtime.game) return;
  const grouped = !['start', 'shuffle', 'cut', 'deal'].includes(runtime.game.phase),
    rec = curRec(),
    live = rec && rec.live && rec.g === runtime.game.round;
  // while sorting, a computer's cards can be picked and grouped (成组 / 拆开), or put back as it had them (复原)
  const edit = runtime.game.phase === 'prep';
  let moved = false;
  for (const p of [1, 2, 3]) {
    const el = $('#peek' + p);
    if (!el) continue;
    const h = runtime.game.hands[p],
      ua = uaOf(p),
      picked = runtime.TSEL.p === p ? runtime.TSEL.ids : new Set();
    const key = [
      runtime.game.round,
      runtime.game.L,
      grouped,
      edit,
      h.map((c) => c.id).join(),
      JSON.stringify(ua),
      [...picked].join(),
      runtime.TSFI && runtime.TSFI.p === p ? runtime.TSFI.text : '',
    ].join('|');
    if (el.dataset.k === key) continue;
    el.dataset.k = key;
    moved = true;
    let pw = '';
    if (live)
      pw =
        powerText(rec.power[p]) +
        (rec.userPower[p] != null ? `　你改后 ${powerText(rec.userPower[p])}` : '');
    else if (grouped && h.length)
      pw =
        powerText(rawPower(h, runtime.game.L)) +
        (ua ? `　你改后 ${powerText(handPower(h, runtime.game.L))}` : '');
    // the sorting buttons: a column beside the rows (never on a card), level with the first row for your partner, a
    // little lower for the sides
    const btns =
      edit && h.length
        ? `<span class="tgrp${p === 2 ? '' : ' low'}"><button class="tgbtn" data-a="sf" title="依次选出这手牌里能组成的同花顺（包括用百搭），再点成组">同花顺</button><button class="tgbtn" data-a="grp"${picked.size >= 2 ? '' : ' disabled'} title="选中的牌组成一组">成组</button><button class="tgbtn" data-a="split"${picked.size ? '' : ' disabled'} title="选中的牌拆成单张">拆开</button><button class="tgbtn" data-a="reset"${ua ? '' : ' disabled'} title="改回电脑自己的配法">复原</button></span>`
        : '';
    el.classList.toggle('edit', edit);
    const pwEl = el.querySelector('.pw');
    pwEl.hidden = !edit;
    pwEl.textContent = pw;
    // what 同花顺 found: in this heading, over the cards, while the cards it picked are still the ones picked
    if (runtime.TSFI && runtime.TSFI.p === p && runtime.TSFI.k === [...picked].join()) {
      const d = document.createElement('div');
      d.className = 'sfi';
      d.textContent = runtime.TSFI.text;
      pwEl.appendChild(d);
    }
    const units = ua
      ? seatGroups(p).map((gr) => ({ cards: gr.map((id) => h.find((c) => c.id === id)), name: '' }))
      : handUnits(h, runtime.game.L, grouped);
    el.querySelector('.prows').innerHTML = h.length
      ? rowsHTML(units, runtime.game.L, picked, p === 2 ? 3 : 5)
      : '';
    const old = el.querySelector('.tgrp');
    if (old) old.remove();
    if (btns) el.querySelector('.pbody').insertAdjacentHTML('beforeend', btns);
  }
  const partner = $('#seat2');
  if (['play', 'roundEnd', 'over'].includes(runtime.game.phase)) {
    const key = [runtime.game.round, innerWidth, innerHeight].join('|');
    if (runtime.practicePartnerSize?.key !== key) {
      partner.style.minHeight = '';
      runtime.practicePartnerSize = { key, height: partner.offsetHeight };
    }
    partner.style.minHeight = runtime.practicePartnerSize.height + 'px';
  } else {
    partner.style.minHeight = '';
    runtime.practicePartnerSize = null;
  }
  if (moved && runtime.pileGroups.length) pileRefit();
}

export function practicePlays() {
  if (!(runtime.reviewMode || miniMode()) || !runtime.game) return;
  let box = $('#tplays');
  if (!box) {
    box = document.createElement('div');
    box.id = 'tplays';
    $('#table').appendChild(box);
  }
  // (in 极简出牌区 the box holds only the trick on the table now, and clears the moment the trick is taken in: with nothing
  // to show there is no box, and the tribute notice and the like keep the middle to themselves)
  if (
    !['play', 'roundEnd', 'over'].includes(runtime.game.phase) ||
    (!runtime.reviewMode &&
      !(runtime.game.trickPlays || []).length &&
      !(runtime.game.rest || []).length)
  ) {
    if (box.innerHTML) box.innerHTML = '';
    box.dataset.k = '';
    return;
  }
  const g = pileGeo();
  // in 极简出牌区 the box keeps one place and size (see miniBoxRect); the practice table's follows the table's middle
  const R = runtime.reviewMode
    ? {
        left: g.left + 6,
        top: g.top + 6,
        w: Math.max(60, g.right - g.left - 12),
        h: Math.max(40, g.near - g.top - 12),
      }
    : miniBoxRect(g);
  const key = [
    runtime.game.round,
    runtime.game.log.length,
    (runtime.game.trickPlays || []).length,
    (runtime.game.rest || []).length,
    runtime.game.out.length,
    R.left,
    R.top,
    R.w,
    R.h,
    runtime.reviewMode && curRec() ? curRec().nv : 0,
  ]
    .map(Math.round)
    .join('|');
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  const progress = `${runtime.game.round}|${runtime.game.log.length}`,
    follow = box.dataset.progress !== progress,
    scrollTop = box.firstElementChild?.scrollTop || 0;
  box.dataset.progress = progress;
  // the trick on the table now: from its lead on (none once it has been taken in)
  let from = Infinity;
  if ((runtime.game.trickPlays || []).length)
    for (let i = runtime.game.log.length - 1; i >= 0; i--)
      if (runtime.game.log[i].cards && runtime.game.log[i].lead) {
        from = i;
        break;
      }
  // the latest cards played (a pass after them does not take the frame away)
  let last = -1;
  for (let i = runtime.game.log.length - 1; i >= 0; i--)
    if (runtime.game.log[i].cards) {
      last = i;
      break;
    }
  const rec =
    runtime.reviewMode && curRec() && curRec().live && curRec().g === runtime.game.round
      ? curRec()
      : null;
  const item = (x, i) => {
    const k = i + 1,
      sep = x.cards && x.lead && i ? '<span class="tsep"></span>' : '';
    return `${sep}<span class="tq${x.cards ? '' : ' pass'}${i >= from ? ' cur' : ''}${i === last ? ' last' : ''}${rec && rec.notes[k] ? ' noted' : ''}" data-k="${k}" style="--pc:${pcol(x.p)}"${runtime.reviewMode ? ' title="点一下写评语"' : ''}><b><span>${k}</span><em>${runtime.names[x.p]}</em></b>${
      x.cards
        ? `<span class="mcs">${displayOrder(x, runtime.game.L).map(miniCard).join('')}</span>`
        : '<span class="pchip">过</span>'
    }</span>`;
  };
  const rest = (runtime.game.rest || [])
    .map(
      (r) =>
        `<span class="tq rest" style="--pc:${pcol(r.p)}"><b><span>剩牌</span><em>${runtime.names[r.p]}</em></b><span class="mcs">${r.cards.map(miniCard).join('')}</span></span>`,
    )
    .join('');
  // the whole middle of the table, between the four hands
  box.innerHTML = `<div class="tpb" style="left:${R.left}px;top:${R.top}px;width:${R.w}px;height:${R.h}px">${runtime.game.log.map((x, i) => (runtime.reviewMode || i >= from ? item(x, i) : '')).join('')}${rest}</div>`;
  // the cards as large as will still fit (in 极简出牌区 never smaller than 24 wide: past that the box scrolls, to the
  // newest play)
  const b = box.firstElementChild;
  if (runtime.reviewMode) {
    b.style.setProperty('--mcw', Math.max(24, Math.min(40, tcwNow())) + 'px');
  } else {
    for (let w = 72; w >= 24; w -= 2) {
      b.style.setProperty('--mcw', w + 'px');
      if (b.scrollHeight <= b.clientHeight + 1 && b.scrollWidth <= b.clientWidth + 1) break;
    }
  }
  b.scrollTop = follow ? b.scrollHeight : scrollTop;
}

function miniBoxRect(g) {
  const k = [runtime.game.round, innerWidth, innerHeight, runtime.handView].join('|');
  if (
    !runtime.miniRect ||
    runtime.miniRect.k !== k ||
    (runtime.game.phase === 'play' && !runtime.miniRect.play)
  ) {
    const w = Math.round(g.L.width * 0.58),
      top = Math.round(g.top) + 6;
    runtime.miniRect = {
      k,
      play: runtime.game.phase === 'play',
      left: Math.round((g.L.width - w) / 2),
      top,
      w,
      h: Math.max(80, Math.round(g.L.height - 52 - top)),
    };
  }
  return runtime.miniRect;
}

// a played card as its rank over its suit, nothing more (wild cards gold, level cards marked, jokers 大王 / 小王)
function miniCard(c) {
  if (c.r >= 16)
    return `<span class="mc jk${c.r === 17 ? ' red' : ''}"><i>${c.r === 17 ? '大' : '小'}</i><i>王</i></span>`;
  const red = c.s === 'H' || c.s === 'D',
    wild = isWild(c, runtime.game.L);
  return `<span class="mc${red ? ' red' : ''}${wild ? ' wild' : c.r === runtime.game.L ? ' lvl' : ''}"><i${c.r === 10 ? ' class="ten"' : ''}>${rankName(c.r)}</i><i>${SUIT_CH[c.s]}</i></span>`;
}

// a comment on the k-th play of the round being played (or just finished): written in a small box over the table, kept
// with the record at once; the game waits meanwhile
export function practiceNoteEdit(k) {
  const rec = curRec();
  if (!rec) return;
  const e = k ? rec.log[k - 1] : null;
  if (k && !e) return;
  let b = $('#tnbox');
  if (!b) {
    b = document.createElement('div');
    b.id = 'tnbox';
    b.className = 'tnbox';
    document.body.appendChild(b);
    practiceNoteMove(b);
  }
  b.innerHTML = `<h3 class="tnh" title="拖这里可以移动">${k ? `第 ${k} 手：${turnHTML(rec, k)}` : '开局（理牌）的评语'}</h3>
    <textarea id="tnText" placeholder="${!k ? '比如：这手牌应该这样理，因为…' : e.cards ? '比如：这里应该出…，因为…' : '比如：这里不该过，应该出…，因为…'}">${esc(rec.notes[k] || '')}</textarea>
    <div class="btns">${rec.notes[k] ? '<button class="btn" id="tnDel">删掉评语</button>' : ''}<button class="btn" id="tnNo">取消</button><button class="btn primary" id="tnOk">保存</button></div>`;
  b.hidden = false;
  runtime.replayView.edit = true;
  const close = () => {
    b.hidden = true;
    runtime.replayView.edit = false;
  };
  const put = (t) => {
    if (t) rec.notes[k] = t;
    else delete rec.notes[k];
    rec.nv++;
    practiceStore();
    practiceList();
    practicePlays();
    close();
  };
  $('#tnOk').onclick = () => put($('#tnText').value.trim());
  $('#tnNo').onclick = close;
  if ($('#tnDel')) $('#tnDel').onclick = () => put('');
  $('#tnText').onkeydown = (ev) => {
    if (ev.key === 'Escape') close();
    else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) $('#tnOk').click();
  };
  $('#tnText').focus();
}

// The box starts in the lower-left corner and remembers a dragged position.
// dragging its title bar moves it
function practiceNoteMove(b) {
  practiceDragBox(b, 'guandan-practice-note-position-v2');
}

function practiceDragBox(b, store) {
  let at = null;
  try {
    at = JSON.parse(localStorage.getItem(store) || 'null');
  } catch (_) {}
  const place = (x, y) => {
    x = Math.max(0, Math.min(innerWidth - b.offsetWidth, x));
    y = Math.max(0, Math.min(innerHeight - b.offsetHeight, y));
    b.style.left = x + 'px';
    b.style.top = y + 'px';
    b.style.right = b.style.bottom = 'auto';
  };
  if (at) requestAnimationFrame(() => place(at.x, at.y));
  let d = null;
  b.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.tnh') || e.target.closest('button')) return;
    e.preventDefault();
    const r = b.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try {
      b.setPointerCapture(e.pointerId);
    } catch (_) {}
  });
  b.addEventListener('pointermove', (e) => {
    if (d) place(e.clientX - d.dx, e.clientY - d.dy);
  });
  const end = () => {
    if (!d) return;
    d = null;
    const r = b.getBoundingClientRect();
    try {
      localStorage.setItem(store, JSON.stringify({ x: r.left, y: r.top }));
    } catch (_) {}
  };
  b.addEventListener('pointerup', end);
  b.addEventListener('pointercancel', end);
}

// a round's record has a short name, the same for its file and in the page's store: 掼蛋记录-1028-第3局
export function recName(r) {
  if (!r.name) {
    const d = new Date(),
      z = (x) => String(x).padStart(2, '0');
    r.name = `掼蛋记录-${z(d.getMonth() + 1)}${z(d.getDate())}-第${r.no}局`;
  }
  return r.name;
}

// a name to the clipboard, with a word to say so
export function practiceCopy1(t) {
  const ok = () => practiceToast(`已复制：${t}`),
    no = () => practiceToast('没能复制，请手动选中');
  try {
    navigator.clipboard.writeText(t).then(ok, no);
  } catch (_) {
    no();
  }
}

function practiceToast(t) {
  let e = $('#ttoast');
  if (!e) {
    e = document.createElement('div');
    e.id = 'ttoast';
    e.className = 'ttoast';
    document.body.appendChild(e);
  }
  e.textContent = t;
  e.hidden = false;
  clearTimeout(e._t);
  e._t = setTimeout(() => {
    e.hidden = true;
  }, 1800);
}

// what was changed in the sorting, seat by seat: the groups of the computer's own arrangement taken apart, the groups
// made instead, and the 牌力 before and after
export function practiceChanges(rec) {
  const out = [];
  for (const p of [0, 1, 2, 3]) {
    const after = p ? rec.userGroups && rec.userGroups[p] : rec.myGroups,
      before = rec.rawGroups && rec.rawGroups[p];
    if (!after || !before) continue;
    const by = new Map(rec.hands[p].map((c) => [c.id, c])),
      key = (g) =>
        g
          .slice()
          .sort((a, b) => a - b)
          .join();
    const A = new Set(after.map(key)),
      B = new Set(before.map(key));
    const gone = before.filter((g) => !A.has(key(g))),
      made = after.filter((g) => !B.has(key(g)));
    if (!gone.length && !made.length) continue;
    const desc = (g) => {
      const cs = g.map((id) => by.get(id)).filter(Boolean),
        u = readGroup(cs, rec.L);
      return `[${u ? playName(u) : '散牌'} ${cs.map((c) => cardText(c) + (isWild(c, rec.L) ? '*' : '')).join(' ')}]`;
    };
    out.push(
      `${runtime.names[p]}${p ? '（你改了电脑的理牌）' : '（你理的牌和电脑的配法不同）'}：拆掉 ${gone.map(desc).join('、') || '没有'}；新组成 ${made.map(desc).join('、') || '没有'}；牌力 ${p ? `${rec.power[p]} → ${rec.userPower[p]}` : `电脑配法 ${rec.power[0]} → 你理的 ${rec.myPower}`}`,
    );
  }
  return out;
}

// the k-th turn in words: who played what, or who passed on what
function turnHTML(rec, k) {
  const e = rec.log[k - 1];
  if (e.cards)
    return `${runtime.names[e.p]}${e.lead ? '领出' : '跟'} ${playName(e)} ${displayOrder(e, rec.L).map(cardTag).join('')}`;
  const t = passedOn(rec, k);
  return `${runtime.names[e.p]} 过${t ? `（桌上是${runtime.names[t.p]}的${playName(t)} ${displayOrder(t, rec.L).map(cardTag).join('')}）` : ''}`;
}

// the play on the table when the k-th turn passed
export function passedOn(rec, k) {
  for (let i = k - 2; i >= 0; i--) if (rec.log[i].cards) return rec.log[i];
  return null;
}

// the record: each play numbered, who played it, leading or following, its comment; the passes and how each trick ended
// in between; a replayed round starts with how it went the first time
export function recListHTML(rec, on) {
  const out = [];
  let last = null;
  const note = (k) =>
    rec.notes[k]
      ? `<li class="tnote" data-k="${k}">${k ? '评语' : '开局评语'}：${esc(rec.notes[k])}</li>`
      : '';
  if (rec.replayOf) {
    const o = runtime.TREC.rounds.find((r) => r.no === rec.replayOf);
    out.push(
      `<li class="thead">重打第 ${rec.replayOf} 局${o && o.result ? `；原来：${o.result}` : ''}</li>`,
    );
  }
  for (const t of practiceChanges(rec))
    out.push(`<li class="tchg" data-k="0">理牌改动：${esc(t)}</li>`);
  out.push(note(0));
  rec.log.forEach((e, i) => {
    const k = i + 1;
    if (!e.cards) {
      out.push(
        `<li class="tp pass${k === on ? ' on' : ''}" data-k="${k}"><span class="no">${k}</span><span class="tw" style="color:${pcol(e.p)}">${runtime.names[e.p]}</span><span class="lt">过</span><button class="tedit" title="写评语">评</button></li>`,
        note(k),
      );
      return;
    }
    if (e.lead && last != null) out.push(`<li class="tend">—— ${trickEnd(last, e.p)}</li>`);
    last = e.p;
    out.push(
      `<li class="tp${k === on ? ' on' : ''}" data-k="${k}"><span class="no">${k}</span><span class="tw" style="color:${pcol(e.p)}">${runtime.names[e.p]}</span><span class="lt">${e.lead ? '领出' : '跟'} ${playName(e)}</span><span class="tc">${displayOrder(e, rec.L).map(cardTag).join('')}</span><button class="tedit" title="写评语">评</button></li>`,
      note(k),
    );
  });
  if (rec.result) out.push(`<li class="thead">${rec.result}</li>`);
  return out.join('');
}

export function practiceList() {
  const el = $('#tsList');
  if (!el) return;
  const rec = curRec(),
    key = rec ? rec.uid + '|' + rec.log.length + '|' + rec.result + '|' + rec.nv : '';
  // a new play is kept at once, so a closed page loses nothing
  if (rec && rec.live && runtime.TREC.kept !== key) {
    if (runtime.TREC.kept) practiceStore();
    runtime.TREC.kept = key;
  }
  // the list itself is built only while it is open
  if (!$('#tside').classList.contains('open')) {
    el.dataset.k = '';
    return;
  }
  if (el.dataset.k === key) return;
  el.dataset.k = key;
  $('#tsRound').textContent = rec ? `${recName(rec)} · 打 ${rankName(rec.L)}` : '';
  el.innerHTML = rec
    ? recListHTML(rec, -1)
    : '<li class="tend">开始出牌后，每一手牌都记在这里</li>';
  el.scrollTop = el.scrollHeight;
}

export function initialize() {
  T_ORDER = [
    'jokers',
    'sflush',
    'bomb',
    'trip2',
    'pairs3',
    'straight',
    'full',
    'triple',
    'pair',
    'single',
  ];
  rowsHTML = (units, L, picked, k) =>
    rowsOf(units, k)
      .map(
        (r) =>
          `<div class="prow">${r
            .map(
              (u) =>
                `<span class="grp"${u.name ? ` title="${u.name}"` : ''}>${u.cards.map((c) => cardHTML(c, L, picked && picked.has(c.id) ? 'sel' : '')).join('')}</span>`,
            )
            .join('')}</div>`,
      )
      .join('');
  handRowsHTML = (cards, L, grouped) => rowsHTML(handUnits(cards, L, grouped), L);
  curRec = () => runtime.TREC.rounds[runtime.TREC.rounds.length - 1];
  TCV = ['出过的每一手', '出过的所有牌', '他看到的外面剩余'];
  TC = {};
  rankLabel = (k, L) =>
    k === 17 ? '大王' : k === 16 ? '小王' : k === 15 ? `级牌${rankName(L)}` : rankName(k);
  KIND_ORDER = [
    'single',
    'pair',
    'triple',
    'full',
    'straight',
    'pairs3',
    'trip2',
    'bomb',
    'sflush',
    'jokers',
  ];
  practiceMidHalf = 0.17;
  tcwNow = () => parseFloat(getComputedStyle(document.body).getPropertyValue('--tcw')) || 50;
  runtime.miniRect = null;
}
