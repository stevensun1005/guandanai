import { runtime } from '../app/runtime.js';
import { Sound, syncAudioBtns } from '../audio/sound.js';
import { SUITS, SUIT_ORDER, cardText, isWild } from '../core/cards.js';
import { analyze } from '../core/combinations.js';
import { act } from '../game/events.js';
import { isHost, newGame, roundEvt, toAbs } from '../game/session.js';
import { owesReturn } from '../game/tribute.js';
import { layoutHand } from '../hand/layout.js';
import { fanMode, renderHand, vertMode } from '../hand/view.js';
import { miniMode, onHint, onPass, onPlay, onReturn, syncMini } from './actions.js';
import { fixCards, handEl, reflowHand, unfixCards } from './pointer.js';
import { VERSION } from '../network/protocol.js';
import { VC } from '../network/voice.js';
import { testBack } from '../replay/history.js';
import { testPlays } from '../replay/inspector.js';
import { testGrouped, testRegroup } from '../replay/session.js';
import { $, displayOrder } from '../ui/cards.js';
import { testStepGo } from '../ui/clocks.js';
import { askQuit, showRules } from '../ui/overlays.js';
import { centerRank, pileRebuild, pileRefit } from '../ui/table-pile.js';
import { placeLastPlay, renderControls, setMsg } from '../ui/table.js';

let ROW_NAME;
let nextRows;
let VIEW_NAME;
let VIEW_NEXT;
let setHandView;
let BACKS;

// if anything goes wrong, quietly keep the last error (with the page version) on this device for checking later
export function showError(m) {
  try {
    localStorage.setItem('guandan-lastError', `${new Date().toLocaleString()} 版本${VERSION} ${m}`);
  } catch (_) {}
}

export function syncHandBtns() {
  // one button for the three layouts: it names the one in use, and a click moves on to the next
  const v = fanMode() ? 'fan' : vertMode() ? 'vert' : 'flat';
  $('#fanBtn').textContent = VIEW_NAME[v];
  $('#fanBtn').title = `理牌方式，点一下换成${VIEW_NAME[VIEW_NEXT[v]]}`;
  // the button names what a click switches to (竖式 has no rows to choose: the button keeps its place, unseen, so
  // 手持 and 竖式 never move under the pointer)
  $('#rowsBtn').style.visibility = vertMode() ? 'hidden' : '';
  $('#rowsBtn').textContent = ROW_NAME[nextRows()];
  $('#rowsBtn').title = `改成${ROW_NAME[nextRows()]}`;
}

// every straight flush the hand can make, wild cards filling the gaps: those needing fewer wild cards first, then low to
// high; each press of 同花顺 picks the next one, so the player can look them over and set one aside while sorting
export function straightFlushes(hand = runtime.game.hands[0]) {
  const L = runtime.game.L,
    w = hand.filter((c) => isWild(c, L)),
    out = [];
  for (const su of SUITS)
    for (let s = 1; s <= 10; s++) {
      const nat = [];
      let wu = 0;
      for (let q = s; q < s + 5; q++) {
        const r = q === 1 ? 14 : q,
          c = hand.find((x) => !isWild(x, L) && x.s === su && x.r === r);
        if (c) nat.push(c);
        else wu++;
      }
      if (wu <= w.length && wu < 5) {
        const cards = nat.concat(w.slice(0, wu));
        if (analyze(cards, L).some((a) => a.type === 'sflush')) out.push({ cards, wu, s, su });
      }
    }
  return out.sort((a, b) => a.wu - b.wu || a.s - b.s || SUIT_ORDER[a.su] - SUIT_ORDER[b.su]);
}

function syncBack() {
  for (const [k] of BACKS)
    document.documentElement.classList.toggle(
      'back-' + k,
      k === runtime.cardBack && k !== 'stripes',
    );
  $('#backName').textContent = BACKS.find((b) => b[0] === runtime.cardBack)[1];
}

// next round / another match: each player at the table presses the button, and once all have, the host deals
export function askNext() {
  act({ k: 'next', p: toAbs(0) });
}

export function startNextIfReady() {
  if (
    !isHost() ||
    !runtime.game ||
    ![...runtime.network.humans].every((h) => (runtime.game.nextReady || []).includes(h))
  )
    return;
  if (runtime.game.phase === 'roundEnd') act(roundEvt(false));
  else if (runtime.game.phase === 'over') newGame();
}

export function clearPicked() {
  if (runtime.selection.size) {
    runtime.selection = new Set();
    runtime.hintIdx = 0;
    runtime.sfIdx = 0;
    renderHand();
  }
}

export function initialize() {
  $('#playBtn').onclick = onPlay;
  addEventListener('error', (e) => showError(e.message || '未知错误'));
  addEventListener('unhandledrejection', (e) =>
    showError((e.reason && e.reason.message) || '未知错误'),
  );
  $('#passBtn').onclick = onPass;
  $('#hintBtn').onclick = onHint;
  $('#returnBtn').onclick = onReturn;
  ROW_NAME = { 1: '一排', 2: '两排', 3: '三排' };
  nextRows = () =>
    fanMode()
      ? runtime.handRows === 3
        ? 2
        : 3
      : runtime.flatShown === 3
        ? runtime.flatOneFits
          ? 1
          : 2
        : runtime.flatShown + 1;
  VIEW_NAME = { flat: '横式', vert: '竖式', fan: '手持' };
  VIEW_NEXT = { flat: 'vert', vert: 'fan', fan: 'flat' };
  setHandView = (v) => {
    runtime.handView = v;
    try {
      localStorage.setItem('guandan-view', runtime.handView);
    } catch (_) {}
    syncHandBtns();
    // the cards slide to their new places (竖式 puts them in another order)
    if (runtime.game && runtime.game.hands) reflowHand();
    else layoutHand();
  };
  $('#fanBtn').onclick = () =>
    setHandView(VIEW_NEXT[fanMode() ? 'fan' : vertMode() ? 'vert' : 'flat']);
  $('#rowsBtn').onclick = () => {
    if (fanMode()) runtime.handRows = nextRows();
    else runtime.flatRows = nextRows();
    try {
      localStorage.setItem('guandan-rows', runtime.handRows);
      localStorage.setItem('guandan-flatrows', runtime.flatRows);
    } catch (_) {}
    syncHandBtns();
    layoutHand();
  };
  syncHandBtns();
  // 复原 sorts the active cards back by rank; the fixed groups stay as they are
  $('#sortBtn').onclick = () => {
    runtime.game.myOrder = [];
    if (runtime.reviewMode) {
      runtime.game.tgLock = [];
      runtime.game.tgKey = '';
    }
    renderHand();
    Sound.play('shuffle');
  };
  // 固定: the picked cards go to the fixed zone as one group; when every picked card is already there, 放回 puts them back
  $('#fixBtn').onclick = () => {
    const have = new Set(runtime.game.hands[0].map((c) => c.id)),
      ids = [...runtime.selection].filter((id) => have.has(id));
    if (!ids.length) return;
    if (testGrouped()) {
      testRegroup(ids, false);
      return;
    }
    const fixed = new Set((runtime.game.fixed || []).flat());
    if (ids.every((id) => fixed.has(id))) unfixCards(ids);
    else fixCards(ids, -1);
    runtime.selection = new Set();
    reflowHand();
    Sound.play('play');
  };
  // 重选 puts the picked cards down and starts the hints (and the straight flushes) over from the first
  $('#clearBtn').onclick = () => {
    runtime.selection = new Set();
    runtime.hintIdx = 0;
    runtime.sfIdx = 0;
    renderHand();
  };
  runtime.sfIdx = 0;
  $('#sfBtn').onclick = () => {
    const list = straightFlushes();
    if (!list.length) {
      setMsg('手里的牌组不成同花顺');
      return;
    }
    const k = runtime.sfIdx % list.length,
      f = list[k];
    runtime.sfIdx++;
    runtime.selection = new Set(f.cards.map((c) => c.id));
    renderHand();
    Sound.play('select');
    setMsg(
      `同花顺 ${k + 1}/${list.length}：${displayOrder({ type: 'sflush', value: f.s, cards: f.cards }, runtime.game.L).map(cardText).join(' ')}`,
    );
  };
  $('#rulesBtn').onclick = showRules;
  BACKS = [
    ['goose', '大雁'],
    ['maple', '枫叶'],
    ['stripes', '花纹'],
  ];
  runtime.cardBack = 'goose';
  try {
    const v = localStorage.getItem('guandan-back');
    if (BACKS.some((b) => b[0] === v)) runtime.cardBack = v;
  } catch (_) {}
  $('#cardBackBtn').onclick = () => {
    runtime.cardBack =
      BACKS[(BACKS.findIndex((b) => b[0] === runtime.cardBack) + 1) % BACKS.length][0];
    try {
      localStorage.setItem('guandan-back', runtime.cardBack);
    } catch (_) {}
    syncBack();
  };
  syncBack();
  $('#readyBtn').onclick = () => act({ k: 'ready', p: toAbs(0) });
  $('#deckBtn').onclick = () => act({ k: runtime.game.phase === 'cut' ? 'cut' : 'shuffle' });
  $('#sfxBtn').onclick = () => {
    Sound.toggle('sfx');
    syncAudioBtns();
  };
  $('#miniBtn').onclick = () => {
    runtime.miniPlays = !runtime.miniPlays;
    try {
      localStorage.setItem('guandan-mini', runtime.miniPlays ? '1' : '0');
    } catch (_) {}
    syncMini();
    if (runtime.game) {
      testPlays();
      pileRefit();
    }
  };
  if (window.ResizeObserver)
    new ResizeObserver(() => {
      if (runtime.game && miniMode()) testPlays();
    }).observe($('#table'));
  $('#confirmBtn').setAttribute('aria-pressed', runtime.confirmPlay);
  $('#confirmBtn').onclick = () => {
    runtime.confirmPlay = !runtime.confirmPlay;
    try {
      localStorage.setItem('guandan-confirm', runtime.confirmPlay ? '1' : '0');
    } catch (_) {}
    $('#confirmBtn').setAttribute('aria-pressed', runtime.confirmPlay);
    if (runtime.confirmation) {
      runtime.confirmation = null;
      if (runtime.game) renderControls();
    }
  };
  // the options drop down on a tap of 选项 and fold away on a tap anywhere outside them
  // it hangs from the button's right edge; where the button sits near the left of the screen (a phone held upright) it
  // hangs from the left edge instead, so it never runs off the screen
  $('#optBtn').onclick = () => {
    const m = $('#optMenu');
    m.hidden = !m.hidden;
    $('#optBtn').setAttribute('aria-expanded', !m.hidden);
    if (m.hidden) return;
    m.style.left = m.style.right = '';
    if (m.getBoundingClientRect().left < 8) {
      m.style.right = 'auto';
      m.style.left = '0';
    }
  };
  document.addEventListener('click', (e) => {
    if (!$('#optMenu').hidden && !e.target.closest('.optwrap')) {
      $('#optMenu').hidden = true;
      $('#optBtn').setAttribute('aria-expanded', 'false');
    }
  });
  syncAudioBtns();
  // browsers only allow audio after the first tap or key press; Safari on an iPad counts only the end of a tap (not
  // the touch going down), so every kind of tap event tries, and each later tap tries again until the sound is on
  for (const ev of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown'])
    document.addEventListener(
      ev,
      () => {
        Sound.unlock();
        VC.wake();
      },
      { capture: true, passive: true },
    );
  // coming back to the page (after switching apps or unlocking the iPad) wakes the sound up again where allowed
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    Sound.wake();
    // a page that was out of sight may not have heard the others' hellos meanwhile: it gives them a fresh 20 seconds
    // rather than taking the silence for their leaving
    if (runtime.network.hostSeen) runtime.network.hostSeen = Date.now();
    for (const v of runtime.network.conns.values()) v.seen = Date.now();
  });
  $('#quitBtn').onclick = askQuit;
  $('#micBtn').onclick = () => VC.toggle();
  $('#pauseBtn').onclick = () => {
    if (
      runtime.game &&
      runtime.game.phase !== 'start' &&
      !(runtime.game.paused && runtime.game.pausedBy !== 0)
    )
      act({ k: 'pause', on: !runtime.game.paused, p: toAbs(0) });
  };
  $('#table').addEventListener('click', (e) => {
    if (e.target.closest('.who,.btn')) return;
    clearPicked();
  });
  // so does a tap on the empty space around your name and under the hand (the hand itself is handled on pointerdown,
  // since a drag or a sweep of the cards also ends in a click there)
  for (const z of ['#mebar', '.handwrap'])
    $(z).addEventListener('click', (e) => {
      if (e.target.closest('#hand,button,input,textarea,.meinfo')) return;
      clearPicked();
    });
  document.addEventListener('keydown', (e) => {
    if (
      runtime.replayView.open ||
      runtime.replayView.edit ||
      !$('#overlay').hidden ||
      !$('#lobby').hidden ||
      e.target.closest('input,textarea')
    )
      return;
    if (runtime.reviewMode && e.key === 'ArrowLeft') {
      e.preventDefault();
      testBack();
      return;
    }
    // the test version's steps: the space bar lets the game go on to the next turn
    if (runtime.reviewMode && e.key === ' ' && runtime.game && runtime.game.stepWait != null) {
      e.preventDefault();
      if (document.activeElement) document.activeElement.blur();
      testStepGo();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runtime.game.phase === 'return' || runtime.game.phase === 'tribPick' || owesReturn(0)
        ? onReturn()
        : runtime.selection.size
          ? onPlay()
          : onHint();
    } else if (e.key === ' ') {
      e.preventDefault();
      onPass();
    } else if (e.key === 'h' || e.key === 'H') onHint();
  });
  // the test version's steps: a tap on the empty table lets the game go on too (not on a button, a card, a plate, the hands'
  // area or any panel that is open)
  document.addEventListener('click', (e) => {
    if (
      !runtime.reviewMode ||
      !runtime.game ||
      runtime.game.stepWait == null ||
      runtime.replayView.open ||
      runtime.replayView.edit
    )
      return;
    if (
      e.target.closest(
        'button,a,input,textarea,select,label,.card,.peek,.who,.meinfo,#mebar,.handwrap,#tside,#tview,#overlay,.tnbox,.tcount,.optmenu,.tpb,.tq,#fixZone,#fixTags,#tribInfo',
      )
    )
      return;
    testStepGo();
  });
  runtime.resizeT = 0;
  window.addEventListener('resize', () => {
    layoutHand();
    clearTimeout(runtime.resizeT);
    runtime.resizeT = setTimeout(() => {
      centerRank();
      placeLastPlay();
      pileRebuild();
    }, 150);
  });
  runtime.handW = 0;
  if (window.ResizeObserver)
    new ResizeObserver(() => {
      const w = handEl.clientWidth;
      if (w && w !== runtime.handW) {
        runtime.handW = w;
        layoutHand();
      }
    }).observe(handEl);
}
