import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { makeDeck, sortHand } from '../core/cards.js';
import { dealView, fly, reduceMotion } from '../effects/dealing.js';
import { animCut, animShuffle, removeDeck, showDeck } from '../effects/deck.js';
import { act } from './events.js';
import { isHost, isHumanSeat, resetGame, toLocal } from './session.js';
import { doTribute } from './tribute.js';
import { later, startPrep } from './turns.js';
import { $ } from '../ui/cards.js';
import { hideOverlay, setPaused } from '../ui/overlays.js';
import { pileGeo, pileRebuild } from '../ui/table-pile.js';
import { render } from '../ui/table.js';

let DECK_MS;

export function startRound(e) {
  if (e.reset) resetGame();
  if (runtime.game.paused) setPaused(false);
  runtime.game.tok++;
  runtime.game.round++;
  runtime.game.L = runtime.game.levels[runtime.game.lvlTeam];
  const byId = new Map(makeDeck().map((c) => [c.id, c]));
  runtime.game.deck = e.deck.map((id) => byId.get(id));
  runtime.game.hands = [[], [], [], []];
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
  pileRebuild();
  runtime.game.dealCount = 0;
  // as at a real table: the last round's first-out cuts and the player before them shuffles
  // (the very first round picks the cutter at random)
  runtime.game.cutter = toLocal(e.cutter);
  runtime.game.firstLeader = toLocal(e.first);
  runtime.game.shuffler = (runtime.game.cutter + 3) % 4;
  runtime.game.dealIdx = runtime.game.cutter;
  runtime.game.ready = [];
  runtime.game.nextReady = [];
  runtime.network.pending = false;
  runtime.game.queuedPlay = false;
  runtime.selection = new Set();
  hideOverlay();
  removeDeck();
  startShuffle();
}

// the deck travels to whoever is handling it: it is shuffled right in front of the shuffler, slid across to
// the cutter and cut in front of them, then comes back to the middle to be dealt; their plate glows meanwhile
export function startShuffle() {
  runtime.game.phase = 'shuffle';
  showDeck();
  markActor(runtime.game.shuffler, '洗牌');
  slideDeck(actorSpot(runtime.game.shuffler));
  if (isHumanSeat(runtime.game.shuffler)) {
    runtime.game.clock = {
      who: 'deck',
      seat: runtime.game.shuffler,
      left: DECK_MS,
      total: DECK_MS,
    };
    render();
    return;
  }
  render();
  if (isHost()) later(() => act({ k: 'shuffle' }), 1000);
}

export function doShuffle() {
  if (runtime.game.phase !== 'shuffle' || runtime.game.busy) return;
  runtime.game.busy = true;
  runtime.game.clock = null;
  render();
  animShuffle(() => {
    runtime.game.busy = false;
    startCut();
  }, actorSpot(runtime.game.shuffler));
}

export function startCut() {
  runtime.game.phase = 'cut';
  markActor(runtime.game.cutter, '切牌');
  slideDeck(actorSpot(runtime.game.cutter));
  if (isHumanSeat(runtime.game.cutter)) {
    runtime.game.clock = { who: 'deck', seat: runtime.game.cutter, left: DECK_MS, total: DECK_MS };
    render();
    return;
  }
  render();
  if (isHost()) later(() => act({ k: 'cut' }), 1000);
}

export function doCut() {
  if (runtime.game.phase !== 'cut' || runtime.game.busy) return;
  runtime.game.busy = true;
  runtime.game.clock = null;
  render();
  animCut(() => {
    markActor(-1);
    slideDeck(null);
    later(() => {
      runtime.game.busy = false;
      beginDeal();
    }, 520);
  }, actorSpot(runtime.game.cutter));
}

// where the deck sits when a player handles it: on the table right in front of them
function actorSpot(p) {
  const g = pileGeo();
  if (p === 0) return { x: g.cx, y: g.bottom - g.ch * 0.8 };
  if (p === 2) return { x: g.cx, y: g.top + g.ch * 0.8 };
  if (p === 3) return { x: g.left + g.cw * 1.9, y: g.sideY[3] };
  return { x: g.right - g.cw * 1.9, y: g.sideY[1] };
}

function slideDeck(spot) {
  const d = $('#deck');
  if (!d) return;
  const g = pileGeo(),
    at = spot || { x: g.cx, y: g.hy };
  d.style.transition = 'transform .5s cubic-bezier(.3,.7,.3,1)';
  d.style.transform = `translate(${at.x}px,${at.y}px)`;
}

// the player handling the deck: their plate glows and a large label beside it says what they are doing
export function markActor(p, text) {
  document.querySelectorAll('.acting').forEach((e) => e.classList.remove('acting'));
  document.querySelectorAll('.fx-act').forEach((e) => e.remove());
  if (p < 0) return;
  (p === 0 ? $('.meinfo') : $('#seat' + p + ' .who')).classList.add('acting');
  // on your own turn the button is the only thing to look at, so no label competes with it
  if (p === 0) return;
  // the label belongs to the plate's row, so it moves with the plate: over it for the side players (above their tags),
  // to the right of the row for the player across the table
  const e = document.createElement('div');
  e.className = 'fx-act actlbl';
  e.textContent = text;
  $('#seat' + p + ' .whorow').appendChild(e);
}

export function beginDeal() {
  runtime.game.phase = 'deal';
  runtime.game.busy = false;
  runtime.game.clock = null;
  render();
  later(dealNext, 300);
}

// time you get to shuffle or cut before it is done for you
// one card leaves the centre every 20ms and lands in a hand 240ms later
function dealNext() {
  if (runtime.game.phase !== 'deal') return;
  if (runtime.game.dealCount >= 108) {
    later(finishDeal, 450);
    return;
  }
  const p = (runtime.game.dealIdx + runtime.game.dealCount++) % 4;
  fly(p);
  Sound.play('flick');
  later(() => {
    const c = runtime.game.deck.pop();
    if (!c) return;
    runtime.game.hands[p].push(c);
    dealView(p, c);
  }, 240);
  later(dealNext, reduceMotion() ? 0 : 20);
}

export function finishDeal() {
  // also fills hands at once if the page was reloaded mid-deal
  for (let p = 0; p < 4; p++)
    while (runtime.game.hands[p].length < 27 && runtime.game.deck.length)
      runtime.game.hands[p].push(runtime.game.deck.pop());
  runtime.game.deck = [];
  for (const h of runtime.game.hands) sortHand(h, runtime.game.L);
  removeDeck();
  if (!runtime.game.prevOut) {
    runtime.game.turn = runtime.game.firstLeader;
    runtime.game.notice = '';
    startPrep(runtime.game.turn);
  } else if (!runtime.rules.trib) {
    runtime.game.notice = '';
    startPrep(runtime.game.prevOut[0]);
  } else {
    // the tribute is paid straight after the deal; the returns come after the sorting minute
    runtime.game.notice = '';
    doTribute();
  }
}

export function initialize() {
  DECK_MS = 15000;
}
