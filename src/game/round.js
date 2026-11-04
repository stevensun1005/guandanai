import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { isBomb } from '../core/combinations.js';
import { celebrate, jieFeng, victory } from '../effects/celebrations.js';
import { active, later, nextActive, startTurn } from './turns.js';
import { miniMode } from '../input/actions.js';
import { handEl } from '../input/pointer.js';
import { practicePlays } from '../replay/inspector.js';
import { practiceRoundEnd } from '../replay/session.js';
import { $ } from '../ui/cards.js';
import { renderClocks } from '../ui/clocks.js';
import { showResult } from '../ui/overlays.js';
import { pileSweep, pileThrow, showPlace, showRest, trickHold } from '../ui/table-pile.js';
import { render } from '../ui/table.js';

let END_SHOW_MS;

export function doPlay(p, play) {
  if (runtime.game.phase !== 'play' || runtime.game.turn !== p) return;
  // the clock goes at once, before the cards are laid out, so the plate is back to its own size for them
  runtime.game.clock = null;
  renderClocks();
  if (runtime.game.notice && (play || runtime.game.trick)) runtime.game.notice = '';
  if (play) Sound.play(isBomb(play) ? 'bomb' : 'play', play.type === 'jokers' || play.n >= 6);
  else Sound.play('pass');
  if (play) {
    let origins = null;
    if (p === 0) {
      origins = {};
      for (const c of play.cards) {
        const el = handEl.querySelector(`.card[data-id="${c.id}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          origins[c.id] = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
    }
    const goesOut = runtime.game.hands[p].every((c) => play.cards.includes(c));
    if (goesOut) {
      runtime.game.out.push(p);
      runtime.game.reveal = runtime.game.out.length;
      showPlace(p === 0 ? $('#myPlace') : $('#seat' + p + ' .place'), runtime.game.out.length - 1);
    }
    pileThrow(p, play, origins, true);
    runtime.game.trickPlays.push({
      p,
      play: { type: play.type, value: play.value, n: play.n, cards: play.cards },
    });
    runtime.game.seen.push(...play.cards); // every card played this round, for the computer's card memory
    runtime.game.log.push({
      p,
      cards: play.cards,
      lead: !runtime.game.trick,
      type: play.type,
      value: play.value,
      n: play.n,
    }); // and who played what, in order, leading or following
    const ids = new Set(play.cards.map((c) => c.id));
    runtime.game.hands[p] = runtime.game.hands[p].filter((c) => !ids.has(c.id));
    runtime.game.trick = { player: p, play };
    runtime.game.passes = 0;
    runtime.game.last[p] = { play };
    if (p === 0) {
      runtime.selection = new Set();
      runtime.game.fresh = [];
    }
    if (goesOut) {
      celebrate(p, runtime.game.out.length - 1);
      if (roundOver()) {
        finishRound();
        return;
      }
    }
  } else {
    runtime.game.passes++;
    runtime.game.last[p] = 'pass';
    runtime.game.log.push({ p, cards: null });
  }
  advance();
}

function roundOver() {
  return (!active(0) && !active(2)) || (!active(1) && !active(3));
}

function advance() {
  const winner = runtime.game.trick.player;
  const others = [0, 1, 2, 3].filter((i) => i !== winner && active(i)).length;
  if (runtime.game.passes >= others) {
    let leader = winner,
      jf = null;
    if (!active(winner)) {
      const mate = (winner + 2) % 4;
      leader = active(mate) ? mate : nextActive(winner);
      runtime.game.notice = `${runtime.names[leader]}接风，获得出牌权。`;
      jf = { from: winner, to: leader };
    }
    runtime.game.turn = -1;
    runtime.game.nextLeader = leader;
    render();
    later(() => {
      pileSweep();
      runtime.game.heapN += runtime.game.trickPlays.reduce((s, t) => s + t.play.cards.length, 0);
      runtime.game.trickPlays = [];
      runtime.game.trick = null;
      runtime.game.passes = 0;
      runtime.game.last = [null, null, null, null];
      runtime.game.turn = leader;
      startTurn();
      if (jf) jieFeng(jf.from, jf.to);
    }, trickHold());
    return;
  }
  runtime.game.turn = nextActive(runtime.game.turn);
  startTurn();
}

function finishRound() {
  // the losing side's remaining players fill in the last places, in turn order
  let i = runtime.game.out[runtime.game.out.length - 1];
  const k0 = runtime.game.out.length;
  for (let k = 1; k <= 4; k++) {
    const j = (i + k) % 4;
    if (!runtime.game.out.includes(j)) runtime.game.out.push(j);
  }
  const first = runtime.game.out[0],
    team = first % 2,
    mate = (first + 2) % 4;
  const pos = runtime.game.out.indexOf(mate);
  const up = pos === 1 ? 3 : pos === 2 ? 2 : 1;
  const before = runtime.game.levels[team];
  let win = false;
  const aTeam = runtime.game.lvlTeam,
    atA = runtime.game.L === 14;
  if (runtime.game.lvlTeam === team && before === 14 && pos <= 2) win = true;
  else runtime.game.levels[team] = Math.min(14, before + up);
  const after = runtime.game.levels[team];
  // each side gets three tries at A: after the third miss the match is drawn, or that side starts again from 2
  let aTry = 0,
    draw = false,
    reset = false;
  if (atA && !win && runtime.rules.aFail !== 'keep') {
    const f = runtime.game.aFails || (runtime.game.aFails = [0, 0]);
    aTry = ++f[aTeam];
    if (aTry >= 3) {
      if (runtime.rules.aFail === 'draw') draw = true;
      else {
        runtime.game.levels[aTeam] = 2;
        f[aTeam] = 0;
        reset = true;
      }
    }
  }
  runtime.game.result = {
    order: runtime.game.out.slice(),
    team,
    up,
    before,
    after,
    win,
    draw,
    reset,
    aTry,
    aTeam,
    playedLevel: runtime.game.L,
  };
  if (runtime.reviewMode) practiceRoundEnd();
  runtime.game.prevOut = runtime.game.out.slice();
  runtime.game.lvlTeam = team;
  runtime.game.phase = win || draw ? 'over' : 'roundEnd';
  runtime.game.turn = -1;
  runtime.game.reveal = k0;
  render();
  // the end of a round plays out like a real table: the last trick stays face up for a moment,
  // then gets turned over onto the pile, then the places are called out one by one, then the result
  later(() => {
    pileSweep();
    Sound.play('shuffle');
    runtime.game.heapN += runtime.game.trickPlays.reduce((s, t) => s + t.play.cards.length, 0);
    runtime.game.trickPlays = [];
    runtime.game.last = [null, null, null, null];
    if (miniMode()) practicePlays();
  }, END_SHOW_MS);
  // places already earned during play are on the plates; the rest (always including last place) are called out now
  const dbl = runtime.game.out[0] % 2 === runtime.game.out[1] % 2;
  // and whoever is caught with cards left lays them face up on the table for everyone to see
  for (let k = k0; k < 4; k++)
    later(
      () => {
        runtime.game.reveal = k + 1;
        render();
        showRest(runtime.game.out[k]);
        celebrate(runtime.game.out[k], k, dbl);
      },
      END_SHOW_MS + 700 + (k - k0) * 500,
    );
  later(
    () => {
      if (win) victory(team, showResult);
      else if (draw) {
        Sound.play('ding');
        showResult();
      } else {
        Sound.play(team === 0 ? 'win' : 'lose');
        showResult();
      }
    },
    END_SHOW_MS + 700 + (4 - k0) * 500 + 1400,
  );
}

export function initialize() {
  END_SHOW_MS = 2600;
}
