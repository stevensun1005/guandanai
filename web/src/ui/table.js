import { alignNamePlates } from './viewport.js';
import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { cardText, rankName } from '../core/cards.js';
import { levelAttemptLabel } from '../core/match.js';
import { returnInstruction } from '../core/tribute.js';
import { analyze, beats } from '../core/combinations.js';
import { showCount } from '../effects/dealing.js';
import { isHumanSeat } from '../game/session.js';
import { owesReturn, tribOptions } from '../game/tribute.js';
import { active } from '../game/turns.js';
import { isPhone, placeActionBtns, sideBtns } from '../hand/layout.js';
import { renderHand } from '../hand/view.js';
import { selKey, selectedCards, syncCfmShow, syncMini } from '../input/actions.js';
import { DIRS } from '../lobby/lobby.js';
import { practiceMidHalf, practicePlays, practiceRender } from '../replay/inspector.js';
import { practiceGrouped } from '../replay/session.js';
import { $ } from './cards.js';
import { renderClocks } from './clocks.js';
import { renderSelectionStatus } from './selection-status.js';
import { renderPublicHistory } from './history-dialog.js';
import { renderCoach } from '../coach/controller.js';
import { renderPrivateTable } from '../private-table/controller.js';
import { syncPauseBtn } from './overlays.js';
import {
  PASS_Y,
  centerRank,
  nearBottom,
  phoneRefit,
  pileGeo,
  pileRefit,
  showPlace,
} from './table-pile.js';

export let isRedSeat;
export let cardTag;
export let phoneSignTop;

export function render() {
  renderPublicHistory();
  phoneRefit();
  syncPauseBtn();
  for (let p = 0; p < 4; p++) {
    const el = p === 0 ? $('#mebar') : $('#seat' + p);
    el.classList.toggle('t-red', isRedSeat(p));
    el.classList.toggle('t-blue', !isRedSeat(p));
  }
  for (const t of [0, 1]) {
    $('#lv' + t).textContent =
      levelAttemptLabel(runtime.game, t) || rankName(runtime.game.levels[t]);
    $('#lvx' + t).textContent = '';
  }
  for (const t of [0, 1]) {
    const el = $('#team' + t);
    el.classList.toggle('playing', runtime.game.lvlTeam === t);
    el.classList.toggle('t-red', isRedSeat(t));
    el.classList.toggle('t-blue', !isRedSeat(t));
    el.title = runtime.game.lvlTeam === t ? '本局打这一方的级' : '';
    $('#tn' + t).textContent =
      (t === 0 ? '我方' : '对方') + (runtime.game.lvlTeam === t ? '打' : '');
  }
  const lv = $('#curLv');
  if (lv.dataset.v !== rankName(runtime.game.L)) {
    lv.dataset.v = lv.textContent = rankName(runtime.game.L);
    centerRank();
  }
  // the disc takes the colour of the side whose level is played; once a round is over it keeps that side's colour
  // (lvlTeam already names the side for the next round) until the next round starts
  const lt =
      (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') && runtime.game.result
        ? runtime.game.result.aTeam
        : runtime.game.lvlTeam,
    em = $('.emblem');
  em.classList.toggle('t-red', isRedSeat(lt));
  em.classList.toggle('t-blue', !isRedSeat(lt));
  em.title = `本局打${lt === 0 ? '我方' : '对方'}的级`;
  for (let p = 0; p < 4; p++) {
    const seat = $('#seat' + p);
    seat.classList.toggle(
      'turn',
      runtime.game.phase === 'play' && runtime.game.turn === p && p !== 0,
    );
    const place = runtime.game.out.indexOf(p);
    if (p !== 0) {
      showCount(seat.querySelector('.cnt'), place >= 0 ? 0 : runtime.game.hands[p].length);
      showPlace(seat.querySelector('.place'), place);
    }
  }
  showCount($('#myCnt'), runtime.game.out.includes(0) ? 0 : runtime.game.hands[0].length);
  const myPlace = runtime.game.out.indexOf(0);
  showPlace($('#myPlace'), myPlace);
  for (let p = 0; p < 4; p++) {
    const [k, t] = statusOf(p),
      el = p === 0 ? $('.meinfo .stat') : $('#seat' + p + ' .stat');
    if (el.dataset.s !== k) {
      el.dataset.s = k;
      el.textContent = t;
    }
  }
  $('#mebar').classList.toggle('turn', runtime.game.phase === 'play' && runtime.game.turn === 0);
  renderLastPlay();
  renderControls();
  renderHand();
  renderMsg();
  renderClocks();
  if (runtime.reviewMode) practiceRender();
  else {
    syncMini();
    practicePlays();
  }
  alignNamePlates();
}

// the line under the disc: the play now on the table and who made it, or who leads when the table is clear
function renderLastPlay() {
  let t = '';
  if (runtime.game.phase === 'play' && !runtime.game.trick && runtime.game.turn >= 0)
    t = `${runtime.game.turn === 0 ? '你' : runtime.names[runtime.game.turn]} 先出`;
  const el = $('#lastPlay');
  if (el.dataset.t !== t) {
    el.dataset.t = t;
    el.innerHTML = t;
  }
  placeLastPlay();
}

// the line hangs just under the disc, no wider than the middle of the table
export function placeLastPlay() {
  const el = $('#lastPlay');
  if (!el.textContent) return;
  const T = $('#table').getBoundingClientRect(),
    e = $('.emblem').getBoundingClientRect();
  // no wider than the middle of the table; on a phone, whose middle is very narrow, as wide as the room between the
  // side players' plates, so it stays on one or two lines
  const g = sideBtns() ? null : pileGeo();
  el.style.maxWidth =
    (runtime.reviewMode && runtime.game && ['play', 'roundEnd', 'over'].includes(runtime.game.phase)
      ? Math.max(
          120,
          (() => {
            const q = pileGeo();
            return Math.round((q.right - q.left) * practiceMidHalf * 2) - 8;
          })(),
        )
      : Math.max(120, g ? g.right - g.left - 8 : $('.mid').offsetWidth)) + 'px';
  // just under the disc; when that leaves the near player too little room for a row of cards, it rides up over the
  // disc's lower edge (below the figure) to give some back
  const cw = $('#pile .probe').offsetWidth || 48;
  let y = e.bottom + 16 - T.top;
  const short =
    cw * runtime.CR * 0.75 - (nearBottom() - T.top - (y + el.offsetHeight) - 2 * PASS_Y);
  if (short > 0) y = Math.max(e.top + e.height * 0.74 - T.top, y - short);
  const top = y + 'px';
  el.style.left = e.left + e.width / 2 - T.left + 'px';
  // the disc moved (the table grew as the hand got shorter): the line follows and the cards make way for it again
  el.style.top = top;
  const k = Math.round(y) + '|' + el.offsetHeight;
  if (el.dataset.k !== k) {
    el.dataset.k = k;
    if (runtime.pileGroups.length) pileRefit();
  }
}

// a player's status tag: sorting or done sorting (the computer is done at once), then on the table whose turn it is
// and what each player did in the trick so far; nothing once they are out or between rounds
function statusOf(p) {
  if (runtime.game.phase === 'prep')
    return isHumanSeat(p) && !(runtime.game.ready || []).includes(p)
      ? ['sort', '理牌中']
      : ['sorted', '理牌结束'];
  if (runtime.game.phase === 'play' && active(p)) {
    if (runtime.game.turn === p) return ['turn', '准备出牌'];
    if (runtime.game.last[p] === 'pass') return ['pass', '过'];
    if (runtime.game.last[p]) return ['played', '已出牌'];
  }
  return ['', ''];
}

export function renderControls() {
  $('.handtools').classList.toggle('empty', !runtime.game.hands[0].length);
  const my = runtime.game.phase === 'play' && runtime.game.turn === 0;
  // leading next while the finished trick is still on show: 出牌 can already be pressed
  const soon =
    runtime.game.phase === 'play' &&
    runtime.game.turn === -1 &&
    runtime.game.nextLeader === 0 &&
    runtime.game.hands[0].length > 0;
  const pay =
    runtime.game.phase === 'tribPick' &&
    runtime.game.tribGivers.includes(0) &&
    runtime.game.tribPick[0] == null;
  const ret = owesReturn(0) || pay;
  $('#playBtn').hidden = ret;
  $('#passBtn').hidden = ret;
  $('#hintBtn').hidden = ret;
  $('#returnBtn').hidden = !ret;
  $('#returnBtn').textContent = pay ? '进贡' : '还贡';
  // once your hand is empty (out, or the round is over) the play buttons have nothing left to do
  // while you are sorting, the "done sorting" button takes the play buttons' place
  $('#btns').hidden =
    (!runtime.reviewMode && ['roundEnd', 'over'].includes(runtime.game.phase)) ||
    (!runtime.reviewMode &&
      !ret &&
      runtime.game.phase !== 'deal' &&
      !runtime.game.hands[0].length) ||
    (sideBtns() &&
      runtime.game.phase === 'prep' &&
      !ret &&
      !(runtime.game.ready || []).includes(0));
  // every button that does something right now is lit, the others are dimmed and cannot be pressed:
  // 出牌 once the picked cards make a play that may go out now (beats the table, or any combination when you are
  // about to lead), 提示 on your turn, 过 when there is something on the table to pass on, 重选 while any cards are picked
  const picked = runtime.selection.size > 0,
    cur = my && runtime.game.trick ? runtime.game.trick.play : null;
  const playable =
    (my || soon) && picked && analyze(selectedCards(), runtime.game.L).some((r) => beats(r, cur));
  const can = {
    playBtn: playable,
    hintBtn: my,
    passBtn: my && !!runtime.game.trick,
    clearBtn: picked,
  };
  if (runtime.confirmation && (!playable || runtime.confirmation !== selKey()))
    runtime.confirmation = null;
  $('#playBtn').textContent = runtime.confirmation ? '确认' : '出牌';
  $('#playBtn').classList.toggle('cfm', !!runtime.confirmation);
  syncCfmShow();
  for (const id in can) {
    const b = $('#' + id);
    b.disabled = !can[id];
    b.classList.toggle('primary', can[id]);
  }
  // 同花顺 beside your name while you sort your cards and while you play them
  $('#sfBtn').hidden =
    !['prep', 'play'].includes(runtime.game.phase) || !runtime.game.hands[0].length;
  const fb = $('#fixBtn'),
    fixedNow = new Set((runtime.game.fixed || []).flat());
  $('#sortBtn').textContent = runtime.reviewMode ? '复原' : '理牌';
  $('#sortBtn').disabled = !runtime.game.hands[0].length;
  $('#restoreHandBtn').disabled = !runtime.game.hands[0].length;
  fb.disabled = !picked || !runtime.game.hands[0].length;
  if (!runtime.reviewMode)
    fb.hidden = !runtime.game.hands[0].length || ['roundEnd', 'over'].includes(runtime.game.phase);
  fb.textContent = practiceGrouped()
    ? '成组'
    : picked && [...runtime.selection].every((id) => fixedNow.has(id))
      ? '放回'
      : '成组';
  if (practiceGrouped()) {
    fb.disabled = runtime.selection.size < 2;
    const sp = $('#splitBtn');
    if (sp) {
      sp.disabled = !picked;
      sp.hidden = false;
    }
    const rb = $('#sortBtn');
    rb.disabled = !(runtime.game.tgLock && runtime.game.tgLock.length);
  }
  const deckTurn =
    (runtime.game.phase === 'shuffle' && runtime.game.shuffler === 0) ||
    (runtime.game.phase === 'cut' && runtime.game.cutter === 0);
  $('#deckBtn').hidden = !deckTurn || !!runtime.game.busy;
  $('#deckBtn').textContent = runtime.game.phase === 'cut' ? '切牌' : '洗牌';
  placeActionBtns();
  renderSelectionStatus({
    mode: pay
      ? 'tribute'
      : ret
        ? 'return'
        : runtime.game.phase === 'prep'
          ? 'prep'
          : my || soon
            ? 'play'
            : 'wait',
    current: soon ? null : runtime.game.trick?.play,
    tributeIds: pay ? tribOptions(0).map((card) => card.id) : [],
    confirm: !!runtime.confirmation,
  });
  renderCoach();
  renderPrivateTable();
}

// the table speaks for itself: only things you could not otherwise see get a line here
// (what changed hands in the tribute, a lead passing to a partner, which card you still owe)
function renderMsg() {
  if (runtime.msgTimer) return;
  const m = $('#msg');
  m.classList.remove('err');
  let t = '';
  if (runtime.game.phase === 'return') {
    const mine = runtime.game.returns.find((x) => x.from === 0);
    t = tribHtml();
    if (owesReturn(0))
      t += `<div>${returnInstruction(runtime.game.hands[0], runtime.game.L)}给${runtime.names[mine.to]}</div>`;
    const wait = runtime.game.returns.filter(
      (x) => x.from !== 0 && runtime.game.retPick[x.from] == null,
    );
    if (wait.length) t += `<div>等待${wait.map((x) => runtime.names[x.from]).join('、')}还贡</div>`;
  } else if (runtime.game.phase === 'tribPick') {
    const opts = [...new Map(tribOptions(0).map((c) => [cardText(c), c])).values()];
    if (runtime.game.tribGivers.includes(0) && runtime.game.tribPick[0] == null)
      t = `<div class="trib">进贡最大的牌：${opts.map(cardTag).join(' ')}${opts.length > 1 ? '，选一张' : ''}</div>`;
    const wait = runtime.game.tribGivers.filter((g) => g !== 0 && runtime.game.tribPick[g] == null);
    if (wait.length) t += `<div>等待${wait.map((g) => runtime.names[g]).join('、')}进贡</div>`;
  } else if (runtime.game.phase === 'tribute' || runtime.game.phase === 'prep') {
    t = runtime.game.notice ? `<div>${runtime.game.notice}</div>` : '';
    // done sorting and owing a return: it can go now, without waiting for the others to finish sorting
    if (owesReturn(0))
      t += `<div class="trib">${returnInstruction(runtime.game.hands[0], runtime.game.L)}给${runtime.names[runtime.game.returns.find((x) => x.from === 0).to]}</div>`;
  } else if (runtime.game.phase === 'play') {
    t = runtime.game.notice ? `<div>${runtime.game.notice}</div>` : '';
  }
  m.innerHTML = t;
  syncTribBox();
  syncTribInfo();
}

function syncTribInfo() {
  const ti = $('#tribInfo'),
    showTi =
      !!runtime.game &&
      ['play', 'roundEnd', 'over'].includes(runtime.game.phase) &&
      !runtime.game.tribHold;
  if (runtime.reviewMode) {
    ti.innerHTML = showTi ? tribHtml('tl') + kangHtml(true) : '';
    return;
  }
  if (!showTi || !((runtime.game.trib && runtime.game.trib.length) || runtime.game.kang)) {
    ti.innerHTML = '';
    runtime.TRIBUI.open = false;
    return;
  }
  if (runtime.TRIBUI.round !== runtime.game.round) {
    runtime.TRIBUI.round = runtime.game.round;
    runtime.TRIBUI.open = false;
  }
  ti.innerHTML =
    `<button class="link tribbtn${runtime.TRIBUI.open ? ' on' : ''}" title="看进贡还贡">贡</button>` +
    (runtime.TRIBUI.open ? `<div class="tribpop">${tribHtml('tl') + kangHtml(true)}</div>` : '');
}

// 抗贡: just whose big jokers they are (short: the line kept in the corner while the round is played)
export function kangHtml(short) {
  const k = runtime.game.kang;
  if (!k) return '';
  const who =
    k.has.length === 1
      ? `${runtime.names[k.has[0].g]}两张大王`
      : `${k.has.map((x) => runtime.names[x.g]).join('、')}各一张大王`;
  return `<div class="${short ? 'tl' : 'trib'}">抗贡：${who}</div>`;
}

// who paid whom (or whose big jokers refused it), in a box in the middle of the table, just under the sorting sign:
// while the tribute is given and the hands are sorted, and for the three seconds before the first play
export function syncTribBox() {
  let b = $('#tribBox');
  if (!b) {
    b = document.createElement('div');
    b.id = 'tribBox';
    document.body.appendChild(b);
  }
  const on =
    !!runtime.game &&
    (runtime.game.phase === 'tribute' ||
      runtime.game.phase === 'prep' ||
      (runtime.game.phase === 'play' && runtime.game.tribHold)) &&
    ((runtime.game.trib && runtime.game.trib.length) || !!runtime.game.kang);
  b.hidden = !on;
  if (!on) return;
  const html = tribHtml() + kangHtml();
  if (b.dataset.h !== html) {
    b.dataset.h = html;
    b.innerHTML = html;
  }
  const T = $('#table').getBoundingClientRect(),
    e = $('.emblem').getBoundingClientRect(),
    pb = $('#prepBig');
  const signs = pb.hidden
    ? []
    : [...pb.children].map((k) => k.getBoundingClientRect()).filter((r) => r.height);
  let y;
  // a phone has the side plates level with the space under the sign, so its box stands between your partner's plate
  // and the sign, as low as it can without reaching the sign (or the middle of the table, once the sign has gone)
  if (isPhone()) {
    const top = phoneSignTop(),
      sign = signs.length ? Math.min(...signs.map((r) => r.top)) : Infinity;
    y = Math.max(top, Math.min(sign - 8, e.top + e.height / 2) - b.offsetHeight);
  } else y = Math.max(e.top + e.height / 2, ...signs.map((r) => r.bottom)) + 12;
  b.style.left = T.left + T.width / 2 + 'px';
  b.style.top = y + 'px';
}

function tribHtml(cls = 'trib') {
  const tr = runtime.game.trib || [],
    back = tr.length && tr.every((t) => t.rc);
  return tr
    .map(
      (t) =>
        `<div class="${cls}">${runtime.names[t.g]}进贡 ${cardTag(t.tc)} 给${runtime.names[t.r]}${back ? `，${runtime.names[t.r]}还 ${cardTag(t.rc)}` : ''}</div>`,
    )
    .join('');
}

export function setMsg(t, err) {
  const m = $('#msg');
  m.textContent = t;
  m.classList.toggle('err', !!err);
  if (err) Sound.play('error');
  clearTimeout(runtime.msgTimer);
  runtime.msgTimer = setTimeout(() => {
    runtime.msgTimer = 0;
    renderMsg();
  }, 1600);
}

export function initialize() {
  isRedSeat = (p) => (DIRS.indexOf(runtime.direction || 'S') + p) % 2 === 0;
  runtime.TRIBUI = { round: null, open: false };
  $('#tribInfo').addEventListener('click', (e) => {
    if (runtime.reviewMode || !e.target.closest('.tribbtn,.tribpop')) return;
    e.stopPropagation();
    runtime.TRIBUI.open = !runtime.TRIBUI.open;
    syncTribInfo();
  });
  cardTag = (c) =>
    `<b class="ct${c.r === 17 || c.s === 'H' || c.s === 'D' ? ' red' : ''}">${cardText(c)}</b>`;
  phoneSignTop = () => {
    const r = $('#seat2 .whorow').getBoundingClientRect();
    return r.bottom + 8;
  };
  addEventListener('resize', () => {
    if (runtime.game) syncTribBox();
  });
}
