import { runtime } from '../app/runtime.js';
import { PLACE, cardText, isWild, makeDeck, rankName, sortHand } from '../core/cards.js';
import { removeDeck } from '../effects/deck.js';
import { startPrep } from '../game/turns.js';
import { recListHTML, recUnits, rowsHTML, testList, testPlays } from './inspector.js';
import { esc, playName, powerText, readGroup, roundName, trickEnd } from './session.js';
import { testStore } from './storage.js';
import { $, cardHTML, displayOrder } from '../ui/cards.js';
import { hideOverlay, setPaused } from '../ui/overlays.js';
import { pileRebuild } from '../ui/table-pile.js';

let tvRec;
let tvCount;

export function testView(ri, step, play) {
  runtime.replayView.open = true;
  runtime.replayView.ri = ri;
  runtime.replayView.step = step;
  runtime.replayView.sure = false;
  $('#tview').hidden = false;
  tvPlay(!!play);
}

function tvClose() {
  tvPlay(false);
  runtime.replayView.open = false;
  $('#tview').hidden = true;
}

export function tvPlay(on) {
  clearInterval(runtime.replayView.timer);
  runtime.replayView.play = on;
  if (on) {
    if (runtime.replayView.step >= tvCount()) runtime.replayView.step = 0;
    runtime.replayView.timer = setInterval(() => {
      if (runtime.replayView.step >= tvCount()) {
        tvPlay(false);
        return;
      }
      runtime.replayView.step++;
      tvDraw();
    }, runtime.replayView.speed);
  }
  tvDraw();
}

// starting to write a comment stops the replay where it is, without drawing the view again under the cursor
export function tvStop() {
  if (!runtime.replayView.play) return;
  clearInterval(runtime.replayView.timer);
  runtime.replayView.play = false;
  const b = $('#tvPlay');
  if (b) {
    b.textContent = '回放';
    b.classList.remove('on');
  }
}

export function tvNote(text) {
  const rec = tvRec(),
    t = text.trim();
  if (t) rec.notes[runtime.replayView.step] = t;
  else delete rec.notes[runtime.replayView.step];
  rec.nv++;
  const l = $('#tview .tvl .tlist');
  if (l) l.innerHTML = recListHTML(rec, runtime.replayView.step);
  testList();
  testStore();
  testPlays();
}

export function tvClick(e) {
  const b = e.target.closest('button,li[data-k]');
  if (!b) return;
  if (b.dataset.k) {
    tvPlay(false);
    runtime.replayView.step = +b.dataset.k;
    tvDraw();
    return;
  }
  if (b.dataset.ms) {
    runtime.replayView.speed = +b.dataset.ms;
    tvPlay(runtime.replayView.play);
    return;
  }
  if (b.id === 'tvClose') {
    tvClose();
    return;
  }
  if (b.id === 'tvPlay') {
    tvPlay(!runtime.replayView.play);
    return;
  }
  if (b.id === 'tvRe') {
    // a round still being played asks once more: the second press gives it up
    const busy = !['roundEnd', 'over', 'start'].includes(runtime.game.phase);
    if (busy && !runtime.replayView.sure) {
      runtime.replayView.sure = true;
      b.textContent = '放弃当前这局，确定重打？';
      return;
    }
    testReplay(tvRec());
    return;
  }
  const n = tvCount();
  runtime.replayView.step =
    {
      tvFirst: 0,
      tvLast: n,
      tvPrev: runtime.replayView.step - 1,
      tvNext: runtime.replayView.step + 1,
    }[b.id] ?? runtime.replayView.step;
  runtime.replayView.step = Math.max(0, Math.min(n, runtime.replayView.step));
  tvPlay(false);
}

// how the play being looked at was made: the hand as arranged just before it, the cards played raised, and whether a group
// was broken up (which one, what was taken out and what is left) or whole groups were played
function tvBreak(rec, plays, cur) {
  if (!cur || !cur.cards) return '';
  const L = rec.L,
    p = cur.p,
    ct = (c) => cardText(c) + (isWild(c, L) ? '*' : '');
  const before = new Set(plays.slice(0, -1).flatMap((e) => e.cards.map((c) => c.id)));
  const units = recUnits(
      rec,
      p,
      rec.hands[p].filter((c) => !before.has(c.id)),
    ),
    played = new Set(cur.cards.map((c) => c.id));
  const gd = (cs) => {
    const u = readGroup(cs, L);
    return `[${u ? playName(u) : '散牌'} ${cs.map(ct).join(' ')}]`;
  };
  const info = units
    .map((u) => ({ cs: u.cards, out: u.cards.filter((c) => played.has(c.id)) }))
    .filter((x) => x.out.length);
  const part = info.filter((x) => x.out.length < x.cs.length),
    whole = info.filter((x) => x.out.length === x.cs.length);
  const verdict = part.length
    ? `拆牌了：` +
      part
        .map(
          (x) =>
            `从 ${gd(x.cs)} 里拿出 ${x.out.map(ct).join(' ')}，剩 ${x.cs
              .filter((c) => !played.has(c.id))
              .map(ct)
              .join(' ')}`,
        )
        .join('；') +
      (whole.length ? `；另外整组出了 ${whole.map((x) => gd(x.cs)).join(' ')}` : '')
    : `没有拆牌：出的是整组 ${whole.map((x) => gd(x.cs)).join(' ')}`;
  return `<div class="tvbrk"><div class="tvbh">${runtime.names[p]}出牌前的配牌（出的牌抬起）</div><div class="peek"><div class="prows">${rowsHTML(units, L, played)}</div></div><div class="tvbv${part.length ? ' broke' : ''}">${verdict}</div></div>`;
}

// the table after the k-th play of the round (0: as play began): every hand, the trick so far, the comment on this play,
// the record beside it
export function tvDraw() {
  const rec = tvRec(),
    L = rec.L,
    n = tvCount(),
    k = (runtime.replayView.step = Math.min(runtime.replayView.step, n));
  const end = k,
    done = rec.log.slice(0, end),
    plays = done.filter((e) => e.cards),
    cur = done[k - 1];
  const gone = new Set(plays.flatMap((e) => e.cards.map((c) => c.id)));
  const hands = rec.hands.map((h) => h.filter((c) => !gone.has(c.id)));
  // who has gone out so far, in order
  const left = rec.hands.map((h) => h.length),
    outs = [];
  for (const e of plays) {
    left[e.p] -= e.cards.length;
    if (!left[e.p]) outs.push(e.p);
  }
  // this trick, from its lead
  let s = -1;
  for (let i = end - 1; i >= 0; i--)
    if (done[i].cards && done[i].lead) {
      s = i;
      break;
    }
  const trick = s < 0 ? [] : done.slice(s);
  let note = '';
  if (s > 0)
    for (let i = s - 1; i >= 0; i--)
      if (done[i].cards) {
        note = '上一圈：' + trickEnd(done[i].p, done[s].p);
        break;
      }
  const pw = (p) =>
    p === 0 && rec.myGroups && rec.myPower !== rec.power[0]
      ? `${powerText(rec.myPower)}，电脑配牌 ${rec.power[0]}`
      : p && rec.userPower[p] != null
        ? `${powerText(rec.power[p])}，你改后 ${rec.userPower[p]}`
        : powerText(rec.power[p]);
  const seat = (p) => `<div class="tvs" data-p="${p}"><div class="tvn">${runtime.names[p]}<small>${
    hands[p].length ? `剩 ${hands[p].length} 张` : PLACE[outs.indexOf(p)] || ''
  } · ${pw(p)}</small></div>
    <div class="peek"><div class="prows">${hands[p].length ? rowsHTML(recUnits(rec, p, hands[p]), L) : ''}</div></div></div>`;
  const mid = `<div class="tvmid">${note ? `<div class="tvnote">${note}</div>` : ''}${trick
    .map((e) =>
      e.cards
        ? `<div class="tvp${e === cur ? ' cur' : ''}"><span class="no">${done.indexOf(e) + 1}</span><span class="tw">${runtime.names[e.p]} ${e.lead ? '领出' : '跟'}</span><span class="grp">${displayOrder(
            e,
            L,
          )
            .map((c) => cardHTML(c, L))
            .join('')}</span><small>${playName(e)}</small></div>`
        : `<div class="tvp pass${e === cur ? ' cur' : ''}"><span class="no">${done.indexOf(e) + 1}</span><span class="tw">${runtime.names[e.p]}</span>过</div>`,
    )
    .join('')}${
    k ? '' : `<div class="tvnote">${runtime.names[rec.leader]}先出</div>`
  }${k === n && rec.result ? `<div class="tvnote">${rec.result}</div>` : ''}${tvBreak(rec, plays, cur)}</div>`;
  const cm = `<div class="tvcm"><label for="tvNote">${k ? `对第 ${k} 手的评语` : '对这一局开局（配牌）的评语'}</label>
      <textarea id="tvNote" rows="2" placeholder="${!k ? '比如：这手牌应该配成…' : cur.cards ? '比如：这里应该出…，因为…' : '比如：这里不该过，应该出…，因为…'}">${esc(rec.notes[k] || '')}</textarea></div>`;
  const v = $('#tview');
  v.innerHTML = `<div class="tvh">
      <div class="tvi">${roundName(rec)} · 打 ${rankName(L)}<small>${k ? `第 ${k} / ${n} 手：${cur.cards ? `${runtime.names[cur.p]}${cur.lead ? '领出' : '跟'} ${playName(cur)}` : `${runtime.names[cur.p]} 过`}` : `开局（共 ${n} 手）`}</small></div>
      <select id="tvRound" title="看哪一局">${runtime.TREC.rounds.map((r, i) => `<option value="${i}"${i === runtime.replayView.ri ? ' selected' : ''}>${roundName(r)}</option>`).join('')}</select>
      <button class="link" id="tvFirst">开头</button><button class="link" id="tvPrev">上一步</button><button class="link" id="tvNext">下一步</button><button class="link" id="tvLast">最后</button>
      <button class="link${runtime.replayView.play ? ' on' : ''}" id="tvPlay">${runtime.replayView.play ? '暂停' : '回放'}</button>
      <span class="muted">速度</span>${[
        ['慢', 2500],
        ['中', 1500],
        ['快', 700],
      ]
        .map(
          ([t, ms]) =>
            `<button class="link${runtime.replayView.speed === ms ? ' on' : ''}" data-ms="${ms}">${t}</button>`,
        )
        .join('')}
      <button class="link" id="tvRe" title="同样的四手牌再打一次">${runtime.replayView.sure ? '放弃当前这局，确定重打？' : '重打这一局'}</button>
      <button class="btn primary" id="tvClose">回到牌局</button></div>
    ${cm}
    <div class="tvb"><div class="tvt">${[2, 3, 1, 0].map(seat).join('')}${mid}</div>
      <div class="tvl"><ol class="tlist">${recListHTML(rec, k)}</ol></div></div>`;
  const on = v.querySelector('.tlist li.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}

// 重打这一局: the same four hands (as play began, after the tribute), the same level and the same first player; you sort
// and play again, the computer plays with the rules it has now
function testReplay(rec) {
  tvClose();
  hideOverlay();
  if (runtime.game.paused) setPaused(false);
  runtime.game.tok++;
  runtime.game.round++;
  const byId = new Map(makeDeck().map((c) => [c.id, c]));
  runtime.game.levels = rec.levels ? rec.levels.slice() : runtime.game.levels.slice();
  runtime.game.levels[rec.lvlTeam] = rec.L;
  runtime.game.lvlTeam = rec.lvlTeam;
  runtime.game.L = rec.L;
  runtime.game.hands = rec.hands.map((h) =>
    sortHand(
      h.map((c) => byId.get(c.id)),
      runtime.game.L,
    ),
  );
  runtime.game.deck = [];
  runtime.game.trick = null;
  runtime.game.passes = 0;
  runtime.game.last = [null, null, null, null];
  runtime.game.out = [];
  runtime.game.fresh = [];
  runtime.game.result = null;
  runtime.game.turn = -1;
  runtime.game.notice = '';
  runtime.game.trib = [];
  runtime.game.kang = null;
  runtime.game.returns = [];
  runtime.game.gives = [];
  runtime.game.afterTrib = false;
  runtime.game.clock = null;
  runtime.game.stepWait = null;
  runtime.game.busy = false;
  runtime.game.reveal = 0;
  runtime.game.trickPlays = [];
  runtime.game.heapN = 0;
  runtime.game.seen = [];
  runtime.game.log = [];
  runtime.game.pw = [];
  runtime.game.rest = [];
  runtime.game.myOrder = [];
  runtime.game.fixed = [];
  runtime.game.ready = [];
  runtime.game.nextReady = [];
  runtime.game.queuedPlay = false;
  runtime.game.tgRound = null;
  runtime.game.ua = null;
  runtime.network.pending = false;
  runtime.selection = new Set();
  removeDeck();
  pileRebuild();
  runtime.game.replay = { of: rec.replayOf || rec.no, trib: rec.trib, kang: rec.kang };
  startPrep(rec.leader);
}

export function initialize() {
  /* the look-back view, over the whole screen; the game waits while it is open */
  runtime.replayView.speed = 1500;
  tvRec = () => runtime.TREC.rounds[runtime.replayView.ri];
  tvCount = () => tvRec().log.length;
  document.addEventListener('keydown', (e) => {
    if (!runtime.replayView.open || e.target.closest('textarea,input,select')) return;
    if (e.key === 'Escape') tvClose();
    else if (e.key === ' ') {
      e.preventDefault();
      tvPlay(!runtime.replayView.play);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      runtime.replayView.step = Math.max(
        0,
        Math.min(tvCount(), runtime.replayView.step + (e.key === 'ArrowLeft' ? -1 : 1)),
      );
      tvPlay(false);
    }
  });
}
