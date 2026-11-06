import { runtime } from '../app/runtime.js';
import { BASE_NAMES, makeDeck, shuffle } from '../core/cards.js';
import { TableBot } from '../ai/controller.js';
import { act } from './events.js';
import { render } from '../ui/table.js';
import { initialTableState } from '../lobby/start-state.mjs';

export let isHost;
export let isHumanSeat;
export let toAbs;
export let toLocal;

export function resetGame() {
  // levels start at 2 for both sides; lvlTeam counts from the host's side, so a seat across a gap of one sees it flipped
  runtime.game = {
    levels: [2, 2],
    lvlTeam: runtime.network.off % 2,
    L: 2,
    round: 0,
    hands: [[], [], [], []],
    trick: null,
    passes: 0,
    last: [null, null, null, null],
    out: [],
    prevOut: null,
    turn: -1,
    phase: 'start',
    notice: '',
    fresh: [],
    returns: [],
    leader: 0,
    result: null,
    tok: ((runtime.game && runtime.game.tok) || 0) + 1,
    trickPlays: [],
    heapN: 0,
    ready: [],
    aFails: [0, 0],
    nextReady: [],
    roundHistory: [],
    aOut: null,
    ...initialTableState(
      runtime.rules,
      runtime.direction,
      runtime.network.off % 2,
      runtime.network.startSettingsUsed,
    ),
  };
}

export function newGame() {
  resetGame();
  render();
  if (isHost()) {
    if (runtime.network.humans.size < 4) TableBot.init();
    act(roundEvt(true));
  }
}

// The host sends one uniformly shuffled deck. Large bombs and four jokers remain valid random deals.
export function roundEvt(reset) {
  const cutter = runtime.game?.prevOut ? toAbs(runtime.game.prevOut[0]) : (Math.random() * 4) | 0;
  const deck = shuffle(makeDeck());
  return { k: 'round', reset, deck: deck.map((c) => c.id), cutter, first: (Math.random() * 4) | 0 };
}

export function initialize() {
  runtime.names = BASE_NAMES.slice();
  /* ---------- game state ---------- */
  runtime.game = null;
  runtime.selection = new Set();
  // the practice table (entered explicitly from the lobby): every hand face up, every play numbered; TV is its look-back view
  runtime.reviewMode = false;
  runtime.replayView = { open: false };
  // Who sits where. Seat 0 is always you: every player's view is turned so they sit at the bottom.
  // Online, the host decides everything (deals, computer moves, timeouts) and sends each step as an event;
  // events name seats in the host's numbering, and NET.off turns those into your own.
  runtime.network = {
    mode: 'solo',
    off: 0,
    humans: new Set([0]),
    inbox: [],
    pending: false,
    conns: new Map(),
    lobby: { S: null, E: null, N: null, W: null },
    mics: {},
  };
  isHost = () => runtime.network.mode !== 'guest';
  runtime.rules = { trib: true, aFail: 'draw', startLevel: 2, startSide: '', coachAllowed: false };
  isHumanSeat = (p) => runtime.network.humans.has(p);
  toAbs = (p) => (p + runtime.network.off) % 4;
  toLocal = (a) => (a - runtime.network.off + 4) % 4;
  runtime.hints = [];
  runtime.hintIdx = 0;
  runtime.msgTimer = 0;
}
