import { runtime } from '../app/runtime.js';
import { aiReturnCard } from '../ai/rule-policy.js';
import { Sound } from '../audio/sound.js';
import { beats } from '../core/combinations.js';
import { genPlays } from '../core/moves.js';
import { AI_THINK_MAX, AI_THINK_MIN, PLAY_MS, PREP_MS } from './clock.js';
import { isHost, isHumanSeat } from './session.js';
import { processReturns, returnNow } from './tribute.js';
import { sortHints } from '../hand/follow-hints.js';
import { onPlay } from '../input/actions.js';
import { testSnap } from '../replay/history.js';
import { testRoundStart } from '../replay/session.js';
import { renderClocks } from '../ui/clocks.js';
import { render } from '../ui/table.js';

let TRIB_SHOW_MS;
export let active;

export function startPrep(leader) {
  runtime.game.phase = 'prep';
  runtime.game.turn = leader;
  runtime.game.ready = [];
  runtime.game.retPick = {};
  // the test version gives ten minutes, to sort the computer's hands too
  runtime.game.clock = {
    who: 'prep',
    left: runtime.reviewMode ? 600000 : PREP_MS,
    total: runtime.reviewMode ? 600000 : PREP_MS,
  };
  render();
  // the computer players return their card early in the sorting minute, one after the other
  (runtime.game.returns || [])
    .filter((x) => !isHumanSeat(x.from))
    .forEach((x, i) =>
      later(
        () => {
          if (runtime.game.phase === 'prep' && runtime.game.returns.includes(x))
            returnNow(x.from, aiReturnCard(runtime.game.hands[x.from], runtime.game.L).id);
        },
        1500 + i * 1200,
      ),
    );
}

export function beginPlay() {
  if (runtime.game.phase !== 'prep') return;
  runtime.game.clock = null;
  if (runtime.game.returns && runtime.game.returns.length) {
    processReturns();
    return;
  }
  startPlay(runtime.game.turn);
}

export function startPlay(leader) {
  runtime.game.phase = 'play';
  runtime.game.turn = leader;
  runtime.game.clock = null;
  if (runtime.reviewMode) testRoundStart();
  if ((runtime.game.trib && runtime.game.trib.length) || runtime.game.kang) {
    runtime.game.turn = -1;
    runtime.game.nextLeader = leader;
    runtime.game.tribHold = true;
    render();
    later(() => {
      runtime.game.tribHold = false;
      runtime.game.turn = leader;
      startTurn();
    }, TRIB_SHOW_MS);
    return;
  }
  startTurn();
}

export function nextActive(i) {
  for (let k = 1; k <= 4; k++) {
    const j = (i + k) % 4;
    if (active(j)) return j;
  }
  return i;
}

export function later(fn, ms) {
  const t = runtime.game.tok;
  setTimeout(() => {
    if (runtime.game.tok === t) fn();
  }, ms);
}

export function startTurn() {
  runtime.hints = [];
  runtime.hintIdx = 0;
  // the test version stops before every turn, yours as much as a computer's, until the space bar (or 继续) is pressed,
  // so each step can be looked at and commented on before the next one is made
  // (your own turn needs no stop: after 4号 the game goes straight to you; a copy of the game is kept at its start all the same)
  if (runtime.reviewMode && runtime.game.phase === 'play' && runtime.game.turn >= 0) {
    if (runtime.game.turn !== 0 && !runtime.game.stepGo) {
      runtime.game.stepWait = runtime.game.turn;
      runtime.game.turn = -1;
      runtime.game.nextLeader = -1;
      runtime.game.clock = null;
      testSnap();
      render();
      return;
    }
    if (runtime.game.turn === 0) testSnap();
  }
  runtime.game.stepGo = false;
  render();
  if (runtime.game.phase !== 'play') return;
  const p = runtime.game.turn;
  runtime.network.pending = false;
  if (p === 0 && isHumanSeat(0)) {
    const cur = runtime.game.trick ? runtime.game.trick.play : null;
    runtime.hints = sortHints(
      genPlays(runtime.game.hands[0], runtime.game.L).filter((pl) => beats(pl, cur)),
    );
    Sound.play('turn');
    runtime.game.clock = { who: 0, left: PLAY_MS, total: PLAY_MS };
    render();
    // 出牌 was pressed while the last trick was still on show
    if (runtime.game.queuedPlay) {
      runtime.game.queuedPlay = false;
      if (runtime.selection.size) onPlay();
    }
    return;
  }
  // a friend's turn: their clock runs here too, and their move arrives as an event
  if (isHumanSeat(p)) {
    runtime.game.clock = { who: p, left: PLAY_MS, total: PLAY_MS };
    renderClocks();
    return;
  }
  // once you are out the computers stop pretending to think so long; only the host's computers actually move
  // the test version gives the computer more time, so each play can be followed
  const think = runtime.reviewMode
    ? 0
    : active(0)
      ? AI_THINK_MIN + Math.random() * (AI_THINK_MAX - AI_THINK_MIN)
      : 400 + Math.random() * 300;
  runtime.game.clock = {
    who: p,
    left: PLAY_MS,
    total: PLAY_MS,
    think: isHost() ? think : undefined,
  };
  renderClocks();
}

export function initialize() {
  // after a tribute (or a refused one) the play waits three seconds while who paid whom stays where it was shown during
  // the sorting, over your name; the leader may already press 出牌 meanwhile, as between two tricks
  TRIB_SHOW_MS = 3000;
  active = (i) => runtime.game.hands[i].length > 0;
}
