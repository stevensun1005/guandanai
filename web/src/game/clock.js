import { runtime } from '../app/runtime.js';
import { TableBot } from '../ai/controller.js';
import { aiReturnCard, tributeCard } from '../ai/rule-policy.js';
import { Sound } from '../audio/sound.js';
import { cardText } from '../core/cards.js';
import { act } from './events.js';
import { isHost, toAbs } from './session.js';
import { owesReturn } from './tribute.js';
import { $ } from '../ui/cards.js';
import { renderClocks } from '../ui/clocks.js';
import { setMsg } from '../ui/table.js';

export let PLAY_MS;
export let TRIB_MS;
export let RET_MS;
export let PREP_MS;
export let HURRY_MS;
export let AI_THINK_MIN;
export let AI_THINK_MAX;

// a clock ran out (host only): the computer makes the move for whoever's turn it was
export function timeUp(c) {
  const who = c.who;
  if (who === 'prep') {
    act({ k: 'begin' });
    return;
  }
  if (who === 'deck') {
    act({ k: runtime.game.phase === 'shuffle' ? 'shuffle' : 'cut' });
    return;
  }
  if (who === 'tribute') {
    for (const s of c.seats)
      if (runtime.game.phase === 'tribPick' && runtime.game.tribPick[s] == null) {
        const card = tributeCard(runtime.game.hands[s], runtime.game.L);
        if (s === 0) {
          runtime.selection = new Set();
          setMsg(`时间到，已自动进贡 ${cardText(card)}`);
        }
        act({ k: 'tribute', p: toAbs(s), id: card.id });
      }
    return;
  }
  if (who === 'return') {
    for (const s of c.seats)
      if (owesReturn(s)) {
        const card = aiReturnCard(runtime.game.hands[s], runtime.game.L);
        if (s === 0) {
          runtime.selection = new Set();
          setMsg(`时间到，已自动还贡 ${cardText(card)}`);
        }
        act({ k: 'return', p: toAbs(s), id: card.id });
      }
    return;
  }
  if (typeof who === 'number' && runtime.game.phase === 'play' && runtime.game.turn === who) {
    void TableBot.playTurn(c);
  }
}

export function initialize() {
  /* ---------- clocks: one ticker drives turn limits, computer thinking and the pre-play countdown ---------- */
  PLAY_MS = 60000;
  TRIB_MS = 30000;
  RET_MS = 60000;
  PREP_MS = 90000;
  HURRY_MS = 10000;
  AI_THINK_MIN = 500;
  AI_THINK_MAX = 1000;
  runtime.lastTick = performance.now();
  setInterval(() => {
    const now = performance.now(),
      dt = Math.min(now - runtime.lastTick, 1000);
    runtime.lastTick = now;
    const c = runtime.game && runtime.game.clock;
    if (
      !c ||
      runtime.game.paused ||
      (runtime.network.mode === 'solo' && (!$('#overlay').hidden || $('#rulesDialog').open)) ||
      runtime.replayView.open ||
      runtime.replayView.edit
    )
      return; // paused, a solo game with a panel open, or looking back or writing a comment in the practice table
    if (runtime.reviewMode && c.think == null) return; // the practice table has no time limits: nobody is hurried, nothing runs out
    const before = c.left;
    c.left -= dt;
    if (
      c.think == null &&
      c.left > 0 &&
      c.left <= HURRY_MS &&
      Math.ceil(before / 1000) !== Math.ceil(c.left / 1000)
    )
      Sound.play('tick');
    if (c.think != null && c.total - c.left >= c.think) {
      runtime.game.clock = null;
      void TableBot.playTurn(c);
      return;
    }
    if (c.left <= 0) {
      if (isHost()) {
        runtime.game.clock = null;
        timeUp(c);
      } else c.left = 0;
      return;
    }
    renderClocks();
  }, 100);
}
