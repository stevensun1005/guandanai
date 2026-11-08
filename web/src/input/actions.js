import { runtime } from '../app/runtime.js';
import { TYPE_NAME } from '../core/cards.js';
import { isReturnCard } from '../core/validation.js';
import { returnInstruction } from '../core/tribute.js';
import { analyze, beats, strength } from '../core/combinations.js';
import { act, playEvt } from '../game/events.js';
import { toAbs } from '../game/session.js';
import { owesReturn, tribOptions } from '../game/tribute.js';
import { isPhone } from '../hand/layout.js';
import { renderHand } from '../hand/view.js';
import { $, cardHTML, displayOrder } from '../ui/cards.js';
import { renderControls, setMsg } from '../ui/table.js';

let waitingHost;
export let selKey;

/* ---------- human actions ---------- */
export function selectedCards() {
  return runtime.game.hands[0].filter((c) => runtime.selection.has(c.id));
}

export function onPlay() {
  // A selection may be prepared during the sweep, but submission waits for the real turn.
  if (runtime.game.phase === 'play' && runtime.game.turn === -1 && runtime.game.nextLeader === 0) {
    setMsg('这一轮的牌还在收，收完再出', true);
    return;
  }
  if (runtime.game.phase !== 'play') return;
  if (runtime.game.turn !== 0) {
    setMsg('还没轮到你出牌', true);
    return;
  }
  const cards = selectedCards();
  if (!cards.length) {
    setMsg('先选几张牌', true);
    return;
  }
  const cur = runtime.game.trick ? runtime.game.trick.play : null;
  const reads = analyze(cards, runtime.game.L);
  if (!reads.length) {
    setMsg('这几张牌不成牌型', true);
    return;
  }
  const ok = reads.filter((r) => beats(r, cur)).sort((a, b) => strength(b) - strength(a));
  if (!ok.length) {
    setMsg(`管不上${cur ? TYPE_NAME[cur.type] : ''}`, true);
    return;
  }
  if (waitingHost()) return;
  if (askConfirm()) return;
  act(playEvt(0, { ...ok[0], cards }));
}

export function miniMode() {
  return runtime.miniPlays && !runtime.reviewMode && !isPhone();
}

export function syncMini() {
  const on = miniMode(),
    b = document.body;
  if (b.classList.contains('mini') !== on) {
    b.classList.toggle('mini', on);
    if (!on) {
      const t = $('#tplays');
      if (t) {
        t.innerHTML = '';
        t.dataset.k = '';
      }
    }
  }
}

function askConfirm() {
  if (!runtime.confirmPlay || runtime.confirmation === selKey()) return false;
  runtime.confirmation = selKey();
  renderControls();
  return true;
}

// the cards waiting for 确认, in the order the play reads, 1.8 times the size of the hand's cards and side by side in the
// middle of the table; a long play keeps every card's corner in view by overlapping, and shrinks only if it must
export function syncCfmShow() {
  let box = $('#cfmShow');
  if (!runtime.confirmation) {
    if (box) box.hidden = true;
    return;
  }
  if (!box) {
    box = document.createElement('div');
    box.id = 'cfmShow';
    document.body.appendChild(box);
  }
  const cards = selectedCards(),
    current =
      runtime.game.turn === -1 && runtime.game.nextLeader === 0 ? null : runtime.game.trick?.play,
    r = analyze(cards, runtime.game.L)
      .filter((shape) => beats(shape, current))
      .sort((a, b) => strength(b) - strength(a))[0],
    shown = r ? displayOrder({ ...r, cards }, runtime.game.L) : cards,
    n = shown.length;
  const t = $('#table').getBoundingClientRect(),
    hc = $('#hand .card'),
    maxW = t.width * 0.9;
  const cw = Math.min(
    (hc ? hc.offsetWidth : 60) * 1.8,
    (t.height * 0.5) / 1.4,
    maxW / (1 + 0.45 * (n - 1)),
  );
  const step = n > 1 ? Math.min(cw * 1.08, (maxW - cw) / (n - 1)) : cw;
  box.style.setProperty('--cw', cw + 'px');
  box.style.setProperty('--step', step - cw + 'px');
  box.innerHTML = shown.map((c) => cardHTML(c, runtime.game.L)).join('');
  box.style.left = t.left + t.width / 2 + 'px';
  box.style.top = t.top + t.height / 2 + 'px';
  box.hidden = false;
}

export function onPass() {
  if (
    runtime.game.phase !== 'play' ||
    runtime.game.turn !== 0 ||
    !runtime.game.trick ||
    waitingHost()
  )
    return;
  runtime.selection = new Set();
  act(playEvt(0, null));
}

export function onHint() {
  if (runtime.game.phase !== 'play' || runtime.game.turn !== 0) return;
  if (!runtime.hints.length) {
    setMsg('没有能管上的牌，可以点“过”');
    return;
  }
  const h = runtime.hints[runtime.hintIdx % runtime.hints.length];
  runtime.hintIdx++;
  runtime.selection = new Set(h.cards.map((c) => c.id));
  renderHand();
}

export function onReturn() {
  if (waitingHost()) return;
  if (runtime.game.phase === 'tribPick') {
    if (!runtime.game.tribGivers.includes(0) || runtime.game.tribPick[0] != null) return;
    const cards = selectedCards(),
      ok = tribOptions(0);
    if (cards.length !== 1 || !ok.includes(cards[0])) {
      setMsg('要进贡手里最大的一张牌（百搭除外）', true);
      return;
    }
    act({ k: 'tribute', p: toAbs(0), id: cards[0].id });
    return;
  }
  if (!owesReturn(0)) return;
  const cards = selectedCards();
  if (cards.length !== 1) {
    setMsg(returnInstruction(runtime.game.hands[0], runtime.game.L), true);
    return;
  }
  const c = cards[0];
  if (!isReturnCard(c, runtime.game.L, runtime.game.hands[0])) {
    setMsg(returnInstruction(runtime.game.hands[0], runtime.game.L), true);
    return;
  }
  act({ k: 'return', p: toAbs(0), id: c.id });
}

export function initialize() {
  // waiting for the host to confirm your last move; never for more than four seconds
  waitingHost = () =>
    runtime.network.pending && Date.now() - (runtime.network.pendingAt || 0) < 4000;
  runtime.confirmPlay = false;
  runtime.confirmation = null;
  try {
    runtime.confirmPlay = localStorage.getItem('guandan-confirm') === '1';
  } catch (_) {}
  runtime.miniPlays = false;

  selKey = () => [...runtime.selection].sort((a, b) => a - b).join(',');
  addEventListener('resize', () => {
    if (runtime.confirmation) syncCfmShow();
  });
}
