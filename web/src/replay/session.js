import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { PLACE, TYPE_NAME, cardText, isWild, rankName, sortHand, val } from '../core/cards.js';
import { analyze, isBomb, power } from '../core/combinations.js';
import { setHumans } from '../game/events.js';
import { newGame } from '../game/session.js';
import { armPlaysRaw, armScore, handPower, scorePower, unitScore } from '../hand/arrangement.js';
import { layoutHand, syncPhone } from '../hand/layout.js';
import { orderedHand, renderHand } from '../hand/view.js';
import { straightFlushes } from '../input/controls.js';
import { cardEl, handEl } from '../input/pointer.js';
import { practiceBack, practiceUndo } from './history.js';
import {
  practiceClear,
  practiceCopy,
  practiceFinish,
  practiceImport,
  practiceSave,
} from './import-export.js';
import {
  T_ORDER,
  curRec,
  handUnits,
  recName,
  rowsOf,
  practiceCounterNext,
  practiceList,
  practiceNoteEdit,
  practicePeeks,
  practicePlays,
} from './inspector.js';
import { practiceLoad, practiceStore, onRecordStorageStatus } from './storage.js';
import { practiceView, tvClick, tvDraw, tvNote, tvPlay, tvStop } from './viewer.js';
import { $, cardHTML, displayOrder } from '../ui/cards.js';
import { practiceStepGo } from '../ui/clocks.js';
import { kangHtml } from '../ui/table.js';
import { syncFullscreen } from '../ui/fullscreen.js';
import { leaveNet } from '../network/rooms.js';
import { forgetSeat } from '../network/rejoin-storage.js';

let practiceResize;
export let pcol;
export let powerText;
export let playName;
export let esc;
export let trickEnd;
export let roundName;
export let practiceGrouped;
let myCards;
export let uaOf;
export let rawPower;
let untouched;
let setLocks;
let sfIdxP;
let hotOff;

export function enterPractice() {
  leaveNet();
  forgetSeat();
  runtime.reviewMode = true;
  document.body.classList.add('practice');
  syncPhone();
  runtime.TREC.started = new Date();
  runtime.TREC.rounds = practiceLoad();
  runtime.network.mode = 'solo';
  runtime.network.off = 0;
  setHumans([0]);
  practiceNames();
  $('#lobby').hidden = true;
  for (const p of [1, 2, 3]) {
    const e = document.createElement('div');
    e.className = 'peek';
    e.id = 'peek' + p;
    e.innerHTML = '<div class="pw"></div><div class="pbody"><div class="prows"></div></div>';
    e.onclick = (ev) => {
      const b = ev.target.closest('button[data-a]');
      if (b) {
        if (b.dataset.a === 'reset') practiceCompReset(p);
        else if (b.dataset.a === 'sf') practiceCompSF(p);
        else practiceCompGroup(p, b.dataset.a === 'split');
        return;
      }
    };
    practicePeekDrag(e, p);
    $('#seat' + p).appendChild(e);
  }
  $('#mebar .whorow').insertAdjacentHTML('beforeend', '<span class="mypw" id="myPw"></span>');
  $('.meinfo').appendChild($('#myPlace'));
  $('#fixBtn').insertAdjacentHTML(
    'afterend',
    '<button class="link" id="splitBtn" title="选中的牌拆成单张">拆开</button>',
  );
  $('#splitBtn').onclick = () => {
    const have = new Set(runtime.game.hands[0].map((c) => c.id));
    practiceRegroup(
      [...runtime.selection].filter((id) => have.has(id)),
      true,
    );
  };
  $('#sortBtn').insertAdjacentHTML(
    'afterend',
    '<button class="link" id="undoBtn" title="撤回当前练习的上一手，恢复当时牌局" disabled>撤回一步</button>',
  );
  $('#undoBtn').onclick = practiceUndo;
  $('#undoBtn').insertAdjacentHTML(
    'afterend',
    '<button class="link" id="goBtn" title="走下一步（空格，或点屏幕空白处）" hidden>继续</button>',
  );
  $('#goBtn').onclick = practiceStepGo;
  $('#fixBtn').title = '选中的牌组成一组';
  $('#sortBtn').title = '重新按建议牌型分组';
  const s = document.createElement('aside');
  s.className = 'tside';
  s.id = 'tside';
  s.innerHTML = `<div class="tsh"><b>出牌记录</b><span id="tsRound"></span></div>
    <div class="tsb"><button class="link" id="tsDone" title="导出这一局的出牌与评语">导出本局复盘</button><button class="link" id="tsClose">关闭</button></div>
    <div class="tsb"><button class="link" id="tsPrev" title="查看上一手的牌桌（键盘 ←）">看上一手</button><button class="link" id="tsReplay">回放</button><button class="link" id="tsSave">导出全部</button><button class="link" id="tsCopy">复制全部</button><button class="link" id="tsLoad">导入</button><button class="link" id="tsClear">清空</button></div>
    <div class="tshint">点桌上或这里的任意一手牌旁的“评”写评语；点一手牌看当时四家的牌、重打这一局</div>
    <p id="practiceStorageNotice" class="practice-storage-notice" role="status" hidden>本机空间不足，当前记录尚未保存。请先导出备份。</p>
    <ol class="tlist" id="tsList"></ol>`;
  document.body.appendChild(s);
  const v = document.createElement('div');
  v.className = 'tview';
  v.id = 'tview';
  v.hidden = true;
  document.body.appendChild(v);
  v.onclick = tvClick;
  v.onchange = (e) => {
    if (e.target.id === 'tvRound') {
      tvPlay(false);
      runtime.replayView.ri = +e.target.value;
      runtime.replayView.step = 0;
      tvDraw();
    }
  };
  v.oninput = (e) => {
    if (e.target.id === 'tvNote') tvNote(e.target.value);
  };
  v.addEventListener('focusin', (e) => {
    if (e.target.id === 'tvNote') tvStop();
  });
  $('#tsPrev').onclick = practiceBack;
  $('#tsReplay').onclick = () => {
    if (runtime.TREC.rounds.length) practiceView(runtime.TREC.rounds.length - 1, 0, true);
  };
  $('#tsSave').onclick = practiceSave;
  $('#tsCopy').onclick = practiceCopy;
  $('#tsLoad').onclick = practiceImport;
  $('#tsClear').onclick = practiceClear;
  $('#tsList').onclick = (e) => {
    const ed = e.target.closest('.tedit,.tnote,.tchg');
    if (ed) {
      practiceNoteEdit(+(ed.closest('li').dataset.k || 0));
      return;
    }
    const li = e.target.closest('li.tp');
    if (li) practiceView(runtime.TREC.rounds.length - 1, +li.dataset.k, false);
  };
  $('#tsDone').onclick = practiceFinish;
  $('#tsClose').onclick = () => {
    s.classList.remove('open');
    $('#tsBtn').classList.remove('on');
  };
  // a play in the middle of the table: tap it to write its comment
  // once the round is over: back to the table as it stood after that play, every hand as it was, to finish the comments
  $('#table').addEventListener('click', (e) => {
    const t = e.target.closest('#tplays .tq[data-k]');
    if (!t) return;
    if (['roundEnd', 'over'].includes(runtime.game.phase) && runtime.TREC.rounds.length)
      practiceView(runtime.TREC.rounds.length - 1, +t.dataset.k, false);
    else practiceNoteEdit(+t.dataset.k);
  });
  // a 记牌器 button beside each name
  for (let q = 0; q < 4; q++) {
    const at = q ? $('#seat' + q + ' .name') : $('#myName');
    at.insertAdjacentHTML(
      'afterend',
      `<button class="tcb" data-p="${q}" title="点一下看他出的每一手，再点看他出过的所有牌，再点看他眼里外面还剩的牌">记牌器</button>`,
    );
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.tcb[data-p]');
    if (b) {
      e.stopPropagation();
      practiceCounterNext(+b.dataset.p);
    }
  });
  $('#tsBtn').onclick = () => {
    s.classList.toggle('open');
    $('#tsBtn').classList.toggle('on', s.classList.contains('open'));
    $('#tsList').dataset.k = '';
    practiceList();
  };
  document.body.classList.toggle(
    'fsok',
    !!(document.fullscreenEnabled || document.webkitFullscreenEnabled),
  );
  syncFullscreen();
  practiceSize();
  // the boxes of plays follow the table when it changes size (the hand below it getting shorter, say)
  let t = 0;
  if (window.ResizeObserver)
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(practicePlays, 120);
    }).observe($('#table'));
  newGame();
}

// the one card size for every hand: the side hands in five rows are about 5.5 cards wide (each further card shows 0.42 of
// one), with the table about 6 between them; upright, your partner's and your three rows (about 3 cards high each), the
// side hands' five (about 4.7) and the plates, buttons and margins (about 250px)
function practiceSize() {
  if (!runtime.reviewMode) return;
  const w = (innerWidth - 48) / 17,
    h = (innerHeight - 250) / 11;
  document.body.style.setProperty('--tcw', Math.round(Math.max(28, Math.min(w, h, 100))) + 'px');
}

function practiceNames() {
  for (let p = 0; p < 4; p++) runtime.names[p] = `${p + 1}号`;
  for (let q = 1; q < 4; q++) {
    const e = $('#seat' + q + ' .name');
    e.textContent = runtime.names[q];
    e.style.color = pcol(q);
  }
  $('#myName').textContent = runtime.names[0];
  $('#myName').style.color = pcol(0);
}

// a group read as the play it makes best (by its score), or null if its cards make no play
export function readGroup(cards, L) {
  return (
    analyze(cards, L)
      .map((a) => ({ ...a, n: cards.length, cards }))
      .sort((a, b) => unitScore(b) - unitScore(a))[0] || null
  );
}

// a group that makes no play counts as its cards rank by rank (singles, pairs, threes)
function groupUnits(cards, L) {
  const u = readGroup(cards, L);
  if (u) return [u];
  const by = new Map();
  for (const c of cards) {
    const k = isWild(c, L) ? 'w' : c.r >= 16 ? c.r : val(c, L);
    (by.get(k) || by.set(k, []).get(k)).push(c);
  }
  return [...by.values()].map(
    (g) => readGroup(g, L) || { type: 'single', n: 1, value: val(g[0], L), cards: [g[0]] },
  );
}

function myUnits() {
  const h = myCards();
  return runtime.game.fixed.flatMap((gr) => {
    const cards = gr.map((id) => h.get(id)).filter(Boolean);
    return cards.length ? groupUnits(cards, runtime.game.L) : [];
  });
}

// your groups in the order the computer's are shown in: bombs first, then runs, then the rest, larger first; groups that
// make no play last
function sortGroups(groups, by, L) {
  const key = (gr) => {
    const u = readGroup(
      gr.map((id) => by.get(id)),
      L,
    );
    return u ? [T_ORDER.indexOf(u.type), isBomb(u) ? -power(u) : -u.value] : [99, 0];
  };
  return groups
    .filter((gr) => gr.length)
    .map((gr) => ({ gr, k: key(gr) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1])
    .map((x) => x.gr);
}

function practiceSortMine() {
  runtime.game.fixed = sortGroups(runtime.game.fixed, myCards(), runtime.game.L);
}

// several cards as one group, laid out the way their combination reads
function tidyIds(ids, hand) {
  const cards = ids.map((id) => hand.find((c) => c.id === id)).filter(Boolean),
    u = readGroup(cards, runtime.game.L);
  return (u ? displayOrder(u, runtime.game.L) : sortHand(cards.slice(), runtime.game.L)).map(
    (c) => c.id,
  );
}

export function practiceArm(hand, L) {
  if (!runtime.reviewMode || !runtime.game) return null;
  for (const p of [1, 2, 3]) {
    if (hand !== runtime.game.hands[p] || !uaOf(p)) continue;
    return seatGroups(p)
      .flatMap((gr) =>
        groupUnits(
          gr.map((id) => hand.find((c) => c.id === id)),
          L,
        ),
      )
      .map((u) => ({ ...u, wu: u.cards.filter((c) => isWild(c, L)).length }));
  }
  return null;
}

// the groups you set that are still whole, and the rest of the hand arranged the computer's way, in the order shown
function lockedAndRest(hand, locks, L) {
  const have = new Set(hand.map((c) => c.id));
  const kept = locks.filter((gr) => gr.every((id) => have.has(id)));
  const used = new Set(kept.flat()),
    free = hand.filter((c) => !used.has(c.id));
  const auto = free.length
    ? armPlaysRaw(free, L).map((u) => displayOrder(u, L).map((c) => c.id))
    : [];
  return { kept, groups: sortGroups(kept.concat(auto), new Map(hand.map((c) => [c.id, c])), L) };
}

// a computer's groups now: yours plus its own arrangement of the rest, or all its own
export function seatGroups(p) {
  const h = runtime.game.hands[p],
    locks = uaOf(p);
  if (!locks) return handUnits(h, runtime.game.L, true).map((u) => u.cards.map((c) => c.id));
  return lockedAndRest(h, locks, runtime.game.L).groups;
}

function lockGroup(locks, ids, hand) {
  return untouched(locks, ids).concat([tidyIds(ids, hand)]);
}

function lockSingles(locks, ids) {
  return untouched(locks, ids).concat(ids.map((id) => [id]));
}

function lockJoin(locks, groups, ids, target, hand) {
  const into = target != null ? groups.find((gr) => gr.includes(target)) : null;
  const join = into ? into.filter((id) => !ids.includes(id)).concat(ids) : ids;
  return untouched(locks, join).concat([tidyIds(join, hand)]);
}

function practiceCompSel(p, id) {
  if (runtime.game.phase !== 'prep') return;
  if (runtime.TSEL.p !== p) {
    runtime.TSEL.p = p;
    runtime.TSEL.ids = new Set();
  }
  if (runtime.TSEL.ids.has(id)) runtime.TSEL.ids.delete(id);
  else runtime.TSEL.ids.add(id);
  practicePeeks();
  Sound.play('select');
}

function practiceCompSF(p) {
  if (runtime.game.phase !== 'prep') return;
  const list = straightFlushes(runtime.game.hands[p]);
  if (!list.length) {
    runtime.TSFI = {
      p,
      k: runtime.TSEL.p === p ? [...runtime.TSEL.ids].join() : '',
      text: '这手牌组不成同花顺',
    };
    practicePeeks();
    return;
  }
  const k = (sfIdxP[p] || 0) % list.length,
    f = list[k];
  sfIdxP[p] = k + 1;
  runtime.TSEL.p = p;
  runtime.TSEL.ids = new Set(f.cards.map((c) => c.id));
  // the information stands in the computer's own heading, over its cards, never on them
  runtime.TSFI = {
    p,
    k: [...runtime.TSEL.ids].join(),
    text: `同花顺 ${k + 1}/${list.length}：${displayOrder({ type: 'sflush', value: f.s, cards: f.cards }, runtime.game.L).map(cardText).join(' ')}`,
  };
  practicePeeks();
  Sound.play('select');
}

function practiceCompGroup(p, split) {
  if (
    runtime.game.phase !== 'prep' ||
    runtime.TSEL.p !== p ||
    runtime.TSEL.ids.size < (split ? 1 : 2)
  )
    return;
  const ids = [...runtime.TSEL.ids],
    locks = uaOf(p) || [];
  setLocks(p, split ? lockSingles(locks, ids) : lockGroup(locks, ids, runtime.game.hands[p]));
  runtime.TSEL.ids = new Set();
  practicePeeks();
  Sound.play('play');
}

// your own cards follow the pointer; the group under it lights up
export function practiceDragMove(e) {
  if (!runtime.mv.active) {
    if (Math.hypot(e.clientX - runtime.mv.x0, e.clientY - runtime.mv.y0) < 6) return;
    runtime.mv.ids =
      runtime.selection.has(runtime.mv.id) && runtime.selection.size > 1
        ? orderedHand()
            .filter((c) => runtime.selection.has(c.id))
            .map((c) => c.id)
        : [runtime.mv.id];
    runtime.mv.grab = runtime.mv.ids.indexOf(runtime.mv.id);
    const L = handEl.getBoundingClientRect(),
      el = cardEl(runtime.mv.id);
    runtime.mv.dx = runtime.mv.x0 - L.left - parseFloat(el.style.left);
    runtime.mv.dy = runtime.mv.y0 - L.top - parseFloat(el.style.top);
    runtime.mv.ids.forEach((id, j) => {
      const c = cardEl(id);
      c.classList.add('drag');
      c.style.zIndex = 1000 + j;
      c.style.pointerEvents = 'none';
    });
    runtime.mv.active = true;
    runtime.mv.test = true;
    runtime.mv.tid = null;
    runtime.lastDown = null;
  }
  const L = handEl.getBoundingClientRect(),
    cw = cardEl(runtime.mv.id).offsetWidth;
  const x = e.clientX - L.left - runtime.mv.dx,
    y = e.clientY - L.top - runtime.mv.dy;
  runtime.mv.ids.forEach((id, j) => {
    const c = cardEl(id);
    c.style.left = x + (j - runtime.mv.grab) * cw * 0.36 + 'px';
    c.style.top = y + 'px';
  });
  const t = document.elementFromPoint(e.clientX, e.clientY),
    tc = t && t.closest('#hand .card');
  const tid = tc && !runtime.mv.ids.includes(+tc.dataset.id) ? +tc.dataset.id : null;
  runtime.mv.out = !t || !t.closest('.handwrap');
  if (tid === runtime.mv.tid) return;
  runtime.mv.tid = tid;
  hotOff(handEl);
  if (tid != null)
    for (const id of runtime.game.fixed.find((gr) => gr.includes(tid)))
      if (!runtime.mv.ids.includes(id)) cardEl(id).classList.add('hot');
}

// dropped on a group: they join it; on a gap in your hand: a group of their own; anywhere else: back where they were
export function practiceDropMine(m) {
  hotOff(handEl);
  for (const id of m.ids) {
    const c = cardEl(id);
    if (c) c.style.pointerEvents = '';
  }
  if (!m.cancel && !(m.out && m.tid == null)) {
    runtime.game.tgLock = lockJoin(
      runtime.game.tgLock,
      runtime.game.fixed,
      m.ids,
      m.tid,
      runtime.game.hands[0],
    );
    for (const id of m.ids) runtime.selection.delete(id);
    Sound.play('play');
  }
  renderHand();
}

// a computer's cards while sorting: a tap picks a card, a drag carries it (or the picked cards) the same way as yours
function practicePeekDrag(el, p) {
  let d = null;
  el.addEventListener('pointerdown', (e) => {
    if (runtime.game.phase !== 'prep') return;
    const c = e.target.closest('.card');
    if (!c) return;
    e.preventDefault();
    d = { id: +c.dataset.id, x0: e.clientX, y0: e.clientY, on: false, tid: null };
    try {
      el.setPointerCapture(e.pointerId);
    } catch (_) {}
  });
  el.addEventListener('pointermove', (e) => {
    if (!d) return;
    if (!d.on) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      d.on = true;
      d.ids =
        runtime.TSEL.p === p && runtime.TSEL.ids.has(d.id) && runtime.TSEL.ids.size > 1
          ? seatGroups(p)
              .flat()
              .filter((id) => runtime.TSEL.ids.has(id))
          : [d.id];
      const g = document.createElement('div');
      g.className = 'tghost';
      g.style.setProperty('--cw', el.querySelector('.card').offsetWidth + 'px');
      g.innerHTML = `<span class="grp">${d.ids
        .map((id) =>
          cardHTML(
            runtime.game.hands[p].find((c) => c.id === id),
            runtime.game.L,
          ),
        )
        .join('')}</span>`;
      document.body.appendChild(g);
      d.ghost = g;
      for (const id of d.ids) {
        const c = el.querySelector(`.card[data-id="${id}"]`);
        if (c) c.style.opacity = 0.3;
      }
    }
    d.ghost.style.left = e.clientX + 'px';
    d.ghost.style.top = e.clientY + 'px';
    const t = document.elementFromPoint(e.clientX, e.clientY),
      tc = t && el.contains(t) && t.closest('.card');
    const tid = tc && !d.ids.includes(+tc.dataset.id) ? +tc.dataset.id : null;
    d.out = !t || !el.contains(t);
    if (tid === d.tid) return;
    d.tid = tid;
    hotOff(el);
    if (tid != null)
      for (const id of seatGroups(p).find((gr) => gr.includes(tid)))
        if (!d.ids.includes(id)) {
          const c = el.querySelector(`.card[data-id="${id}"]`);
          if (c) c.classList.add('hot');
        }
  });
  const end = (cancel) => {
    if (!d) return;
    const m = d;
    d = null;
    if (m.ghost) m.ghost.remove();
    if (!m.on) {
      if (!cancel) practiceCompSel(p, m.id);
      return;
    }
    if (cancel || (m.out && m.tid == null)) {
      el.dataset.k = '';
      practicePeeks();
      return;
    }
    setLocks(p, lockJoin(uaOf(p) || [], seatGroups(p), m.ids, m.tid, runtime.game.hands[p]));
    runtime.TSEL.ids = new Set();
    practicePeeks();
    Sound.play('play');
  };
  el.addEventListener('pointerup', () => end(false));
  el.addEventListener('pointercancel', () => end(true));
}

function practiceCompReset(p) {
  if (runtime.game.ua && runtime.game.ua.r === runtime.game.round) delete runtime.game.ua.lock[p];
  runtime.TSEL.ids = new Set();
  practicePeeks();
  Sound.play('shuffle');
}

// your hand: the groups you set (G.tgLock) stay, the rest is arranged again the computer's way whenever the hand or your
// groups change
export function practiceArrangeMine() {
  if (
    !runtime.game ||
    ['start', 'shuffle', 'cut', 'deal'].includes(runtime.game.phase) ||
    !runtime.game.hands[0].length
  )
    return;
  if (runtime.game.tgRound !== runtime.game.round) {
    runtime.game.tgRound = runtime.game.round;
    runtime.game.tgLock = [];
    runtime.game.tgKey = '';
  }
  const key =
    runtime.game.hands[0]
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join() +
    '|' +
    JSON.stringify(runtime.game.tgLock);
  if (runtime.game.tgKey === key) return;
  runtime.game.tgKey = key;
  const r = lockedAndRest(runtime.game.hands[0], runtime.game.tgLock, runtime.game.L);
  runtime.game.tgLock = r.kept;
  runtime.game.fixed = r.groups;
  runtime.game.myOrder = [];
}

// 成组 / 拆开 on your own cards
export function practiceRegroup(ids, split) {
  if (ids.length < (split ? 1 : 2)) return;
  runtime.game.tgLock = split
    ? lockSingles(runtime.game.tgLock, ids)
    : lockGroup(runtime.game.tgLock, ids, runtime.game.hands[0]);
  runtime.selection = new Set();
  renderHand();
  Sound.play('play');
}

// your groups laid out like the computer's: in three rows, a small gap between groups
export function practiceGeo() {
  const el = $('#hand'),
    probe = el.firstElementChild,
    W = Math.max(probe.offsetWidth * 4, el.clientWidth - 246),
    cw = probe.offsetWidth,
    ch = probe.offsetHeight;
  const rows = rowsOf(runtime.game.fixed.map((gr) => ({ cards: gr })));
  const off = cw * 0.42,
    gap = cw * 0.22,
    lift = Math.round(ch * 0.22),
    rowGap = Math.round(ch * runtime.ROW_STEP),
    fix = new Map();
  let right = 0;
  rows.forEach((r, i) => {
    const w = r.reduce((s, u) => s + cw + off * (u.cards.length - 1), 0) + gap * (r.length - 1);
    let x = Math.max(0, (W - w) / 2);
    for (const u of r) {
      u.cards.forEach((id, j) => fix.set(id, { x: x + j * off, y: lift + i * rowGap, rot: 0 }));
      x += cw + off * (u.cards.length - 1) + gap;
    }
    right = Math.max(right, x - gap);
  });
  return {
    test: true,
    slots: [],
    fix,
    fixTags: [],
    fixW: 0,
    fixH: 0,
    cw,
    ch,
    counts: [0],
    fixEmpty: true,
    fixEdge: -1,
    right,
    lift,
    height: lift + ch + Math.max(0, rows.length - 1) * rowGap + 4,
  };
}

// beside your name: the 牌力 of your groups (and of the computer's arrangement, when it differs); during play, as play began
export function practiceMine() {
  const el = $('#myPw');
  if (!el) return;
  el.hidden = runtime.game.phase !== 'prep';
  let t = '';
  const rec = curRec();
  if (runtime.game.phase === 'play' && rec && rec.live && rec.g === runtime.game.round)
    t =
      `开局${powerText(rec.myPower)}` +
      (rec.myPower !== rec.power[0] ? `　电脑配牌 ${rec.power[0]}` : '');
  else if (practiceGrouped() && runtime.game.hands[0].length) {
    const mine = scorePower(armScore(myUnits())),
      pc = handPower(runtime.game.hands[0], runtime.game.L);
    t =
      powerText(mine) +
      (mine !== pc ? `　电脑配牌 ${pc}` : '') +
      (runtime.game.phase === 'prep' ? '　（拖动牌重新分组，电脑的牌也可以）' : '');
  }
  if (el.textContent !== t) el.textContent = t;
}

/* the record of each round */
// a round's record starts when play starts (the tribute and returns done): the four hands, each one's 牌力 (yours also as
// you grouped it), the log, the comments; numbered on from the rounds already kept in this browser
export function practiceRoundStart() {
  runtime.TSNAP.length = 0;
  const L = runtime.game.L,
    rp = runtime.game.replay;
  runtime.game.replay = null;
  const mine = practiceGrouped() ? runtime.game.fixed.map((gr) => gr.slice()) : null;
  const power = runtime.game.hands.map((h) => rawPower(h, L)),
    ug = {},
    up = {};
  for (const p of [1, 2, 3])
    if (uaOf(p)) {
      ug[p] = seatGroups(p);
      up[p] = handPower(runtime.game.hands[p], L);
    }
  // the computer's own arrangement of each hand you changed (and of yours), to compare with
  const raw = {};
  for (const p of [0, 1, 2, 3])
    if (p ? ug[p] : mine)
      raw[p] = armPlaysRaw(runtime.game.hands[p], L).map((u) =>
        displayOrder(u, L).map((c) => c.id),
      );
  runtime.TSEL.ids = new Set();
  runtime.TREC.rounds.push({
    uid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    no: runtime.TREC.rounds.reduce((m, r) => Math.max(m, r.no), 0) + 1,
    at: new Date().toLocaleString(),
    live: true,
    g: runtime.game.round,
    L,
    lvlTeam: runtime.game.lvlTeam,
    levels: runtime.game.levels.slice(),
    leader: runtime.game.turn,
    hands: runtime.game.hands.map((h) => h.slice()),
    power,
    myGroups: mine,
    myPower: mine ? scorePower(armScore(myUnits())) : power[0],
    userGroups: ug,
    userPower: up,
    rawGroups: raw,
    trib: rp
      ? rp.trib
      : (runtime.game.trib || []).map(
          (t) =>
            `${runtime.names[t.g]}进贡 ${cardText(t.tc)} 给${runtime.names[t.r]}` +
            (t.rc ? `，${runtime.names[t.r]}还 ${cardText(t.rc)}` : ''),
        ),
    kang: rp ? rp.kang : runtime.game.kang ? kangHtml(true).replace(/<[^>]+>/g, '') : '',
    log: runtime.game.log,
    result: '',
    notes: {},
    nk: 'all',
    nv: 0,
    replayOf: rp ? rp.of : null,
  });
  recName(curRec());
  practiceStore();
}

export function practiceRoundEnd() {
  const rec = curRec();
  if (!rec || !rec.live || rec.g !== runtime.game.round) return;
  const r = runtime.game.result,
    side = (t) => (t === 0 ? '我方' : '对方');
  rec.result =
    r.order.map((p, i) => PLACE[i] + ' ' + runtime.names[p]).join('，') +
    '；' +
    (r.draw
      ? r.lastTry
        ? '冲 A 没有成功，平局'
        : '三次打 A 未过，平局'
      : r.win
        ? `${side(r.team)}打过 A，赢下整场`
        : r.before === r.after
          ? `${side(r.team)}在 A 级，没能打过`
          : `${side(r.team)}升 ${r.up} 级（${rankName(r.before)} → ${rankName(r.after)}）`);
  practiceStore();
}

export function initialize() {
  runtime.TREC = { started: null, rounds: [] };
  onRecordStorageStatus(({ saved }) => {
    const notice = $('#practiceStorageNotice');
    if (notice) notice.hidden = saved;
  });
  /* ---------- the practice table: a solo game for checking how the computer plays ---------- */
  // Every hand is face up. Grouping and its reference score help inspect combinations;
  // the learned policy still evaluates its own hand independently.
  // Every play gets a number and goes into the record down the right-hand side; 上一步 (or the ← key) opens a view of the
  // table as it stood after any earlier play, where each play can be given a comment, 回放 plays a round through again,
  // and 重打这一局 deals the same hands again to see whether the computer now plays it better. The records stay in this
  // browser, and save as a text file (which can be brought back in with 导入).
  runtime.practiceWH = '';
  practiceResize = () => {
    const k = innerWidth + 'x' + innerHeight;
    if (runtime.reviewMode && k !== runtime.practiceWH) {
      runtime.practiceWH = k;
      practiceSize();
      layoutHand();
      setTimeout(practicePlays, 200);
    }
  };
  addEventListener('resize', practiceResize);
  if (window.ResizeObserver) new ResizeObserver(practiceResize).observe(document.documentElement);
  pcol = (p) => (p % 2 ? 'var(--blue-team)' : 'var(--red-team)');
  powerText = (pw) => `理牌参考 ${pw}`;
  playName = (e) => (e.type === 'bomb' ? e.n + '张炸弹' : TYPE_NAME[e.type]);
  esc = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
    );
  trickEnd = (w, lead) =>
    w === lead
      ? `${runtime.names[w]}收回出牌权`
      : `${runtime.names[w]}出完，${runtime.names[lead]}接风`;
  roundName = (r) => `第 ${r.no} 局${r.replayOf ? `（重打第 ${r.replayOf} 局）` : ''}`;
  practiceGrouped = () =>
    runtime.reviewMode &&
    !!runtime.game &&
    runtime.game.tgRound === runtime.game.round &&
    !['start', 'shuffle', 'cut', 'deal'].includes(runtime.game.phase);
  myCards = () => new Map(runtime.game.hands[0].map((c) => [c.id, c]));
  uaOf = (p) =>
    runtime.game &&
    runtime.game.ua &&
    runtime.game.ua.r === runtime.game.round &&
    runtime.game.ua.lock[p] &&
    runtime.game.ua.lock[p].length
      ? runtime.game.ua.lock[p]
      : null;
  rawPower = (h, L) => scorePower(armScore(armPlaysRaw(h, L)));
  untouched = (locks, ids) => locks.filter((gr) => !gr.some((id) => ids.includes(id)));
  setLocks = (p, locks) => {
    if (!runtime.game.ua || runtime.game.ua.r !== runtime.game.round)
      runtime.game.ua = { r: runtime.game.round, lock: {} };
    runtime.game.ua.lock[p] = locks;
  };
  runtime.TSEL = { p: 0, ids: new Set() };
  sfIdxP = {};
  runtime.TSFI = null;
  hotOff = (root) => root.querySelectorAll('.card.hot').forEach((c) => c.classList.remove('hot'));
}
