import { runtime } from '../app/runtime.js';
import { tributeCard } from '../ai/rule-policy.js';
import { tributeDecision } from '../ai/tribute-specialist.mjs';
import { Sound } from '../audio/sound.js';
import { sortHand, val } from '../core/cards.js';
import { tributeOptions } from '../core/tribute.js';
import { giveAnim, kangAnim } from '../effects/dealing.js';
import { RET_MS, TRIB_MS } from './clock.js';
import { isHumanSeat } from './session.js';
import { later, startPlay, startPrep } from './turns.js';
import { arrivals } from '../hand/view.js';
import { handEl } from '../input/pointer.js';
import { render } from '../ui/table.js';

let tribChoice;
const giving = new WeakMap();
const choosing = new WeakMap();
export let owesReturn;

function botPick(stage, player) {
  const game = runtime.game,
    tok = game.tok,
    key = stage + ':' + tok + ':' + player;
  let pending = choosing.get(game);
  if (!pending) {
    pending = new Set();
    choosing.set(game, pending);
  }
  if (pending.has(key)) return;
  const value = tributeDecision(game, player, stage);
  if (typeof value === 'number') return value;
  pending.add(key);
  void value.then((id) => {
    pending.delete(key);
    const phase = stage === 'tribute' ? 'tribPick' : 'return',
      picks = stage === 'tribute' ? 'tribPick' : 'retPick';
    if (
      runtime.game !== game ||
      game.tok !== tok ||
      game.phase !== phase ||
      isHumanSeat(player) ||
      game[picks]?.[player] != null
    )
      return;
    const obligated =
      stage === 'tribute'
        ? game.tribGivers?.includes(player)
        : game.returns?.some((x) => x.from === player);
    if (!obligated || !game.hands[player].some((c) => c.id === id)) return;
    game[picks][player] = id;
    (stage === 'tribute' ? tribWait : retWait)();
  });
}

export function doTribute() {
  runtime.game.trib = [];
  const o = runtime.game.prevOut,
    L = runtime.game.L;
  const dbl = o[1] % 2 === o[0] % 2;
  const givers = dbl ? [o[2], o[3]] : [o[3]];
  const bigJ = givers.reduce(
    (s, g) => s + runtime.game.hands[g].filter((c) => c.r === 17).length,
    0,
  );
  if (bigJ >= 2) {
    // who holds the big jokers, kept so the screen can spell out the resistance and what follows from it
    runtime.game.kang = {
      has: givers
        .map((g) => ({ g, n: runtime.game.hands[g].filter((c) => c.r === 17).length }))
        .filter((x) => x.n),
      leader: o[0],
    };
    runtime.game.notice = '';
    runtime.game.phase = 'tribute';
    render();
    const tok = runtime.game.tok,
      jokers = givers.flatMap((g) =>
        runtime.game.hands[g].filter((c) => c.r === 17).map((c) => ({ g, c })),
      );
    kangAnim(jokers).then(() => {
      if (runtime.game.tok === tok) startPrep(o[0]);
    });
    return;
  }
  runtime.game.tribGivers = givers;
  runtime.game.tribPick = {};
  runtime.game.clock = null;
  if (givers.includes(0)) runtime.selection = new Set();
  tribWait();
}

// the largest cards a payer may give (never a wild card); with several of that rank in different suits, they choose
export function tribOptions(p) {
  return tributeOptions(runtime.game.hands[p], runtime.game.L);
}

export function tribWait() {
  for (const g of runtime.game.tribGivers)
    if (runtime.game.tribPick[g] == null && (!isHumanSeat(g) || !tribChoice(g))) {
      const id = isHumanSeat(g)
        ? tributeCard(runtime.game.hands[g], runtime.game.L).id
        : botPick('tribute', g);
      if (id != null) runtime.game.tribPick[g] = id;
    }
  const left = runtime.game.tribGivers.filter((g) => runtime.game.tribPick[g] == null);
  if (!left.length) {
    runtime.game.clock = null;
    payTribute();
    return;
  }
  runtime.game.phase = 'tribPick';
  if (runtime.game.clock && runtime.game.clock.who === 'tribute') runtime.game.clock.seats = left;
  else runtime.game.clock = { who: 'tribute', seats: left, left: TRIB_MS, total: TRIB_MS };
  if (left.includes(0) && !runtime.selection.size) {
    const op = tribOptions(0);
    if (op.length === 1) runtime.selection = new Set([op[0].id]);
  }
  if (left.includes(0)) Sound.play('turn');
  render();
}

function payTribute() {
  const o = runtime.game.prevOut,
    L = runtime.game.L,
    dbl = o[1] % 2 === o[0] % 2;
  let tribs = runtime.game.tribGivers.map((g) => ({
    g,
    card: runtime.game.hands[g].find((c) => c.id === runtime.game.tribPick[g]),
  }));
  if (dbl) tribs.sort((a, b) => val(b.card, L) - val(a.card, L));
  const recv = dbl ? [o[0], o[1]] : [o[0]];
  runtime.game.gives = tribs.map((t, i) => ({
    from: t.g,
    to: recv[i],
    id: t.card.id,
    label: '进贡',
  }));
  runtime.game.trib = [];
  runtime.game.leader = tribs[0].g;
  runtime.game.returns = tribs.map((t, i) => ({ from: recv[i], to: t.g }));
  runtime.game.notice = '';
  runtime.game.afterTrib = true;
  runGives();
}

// one card changes hands: it leaves the giver's hand as it sets off and joins the receiver's on arrival;
// false if a new round started meanwhile
async function handOver(x, tok) {
  const card = runtime.game.hands[x.from].find((c) => c.id === x.id);
  if (!card) return true;
  let start = null;
  if (x.from === 0) {
    const el = handEl.querySelector(`.card[data-id="${card.id}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      start = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  // Commit both hands before the cosmetic flight: readying during an animation must not lose a card.
  runtime.game.hands[x.from] = runtime.game.hands[x.from].filter((c) => c !== card);
  runtime.game.hands[x.to].push(card);
  sortHand(runtime.game.hands[x.to], runtime.game.L);
  if (x.label === '进贡') runtime.game.trib.push({ g: x.from, r: x.to, tc: card });
  else {
    const tribute = runtime.game.trib.find((tribute) => tribute.r === x.from && tribute.g === x.to);
    if (tribute) tribute.rc = card;
  }
  runtime.selection.delete(card.id);
  render();
  await giveAnim(x.from, x.to, card, x.label, start);
  if (runtime.game.tok !== tok) return false;
  if (x.to === 0 && runtime.game.hands[0].some((held) => held.id === card.id)) {
    runtime.game.fresh.push(card.id);
    arrivals.set(card.id, performance.now());
  }
  return true;
}

// hand over queued cards one at a time, face up across the table, then carry on with the returns
export async function runGives() {
  const game = runtime.game,
    tok = game.tok;
  if (giving.get(game) === tok) return;
  giving.set(game, tok);
  try {
    runtime.game.phase = 'tribute';
    render();
    while (runtime.game.gives.length) {
      if (!(await handOver(runtime.game.gives[0], tok))) return;
      runtime.game.gives.shift();
      render();
    }
    // the tribute is in: sort your cards first (whoever leads is known now), the returns follow
    if (runtime.game.afterTrib) {
      runtime.game.afterTrib = false;
      startPrep(runtime.game.leader);
      return;
    }
    processReturns();
  } finally {
    if (giving.get(game) === tok) giving.delete(game);
  }
}

export function processReturns() {
  if (!runtime.game.returns.length) {
    startPlay(runtime.game.leader);
    return;
  }
  runtime.game.retPick = runtime.game.retPick || {};
  if (runtime.game.returns.some((x) => x.from === 0)) runtime.selection = new Set();
  retWait();
}

// everyone who owes a return chooses at the same time (the computer at once, a player within 20 seconds);
// once all have chosen, the cards go back together
export function retWait() {
  for (const x of runtime.game.returns)
    if (runtime.game.retPick[x.from] == null && !isHumanSeat(x.from)) {
      const id = botPick('return', x.from);
      if (id != null) runtime.game.retPick[x.from] = id;
    }
  const left = runtime.game.returns
    .filter((x) => runtime.game.retPick[x.from] == null)
    .map((x) => x.from);
  if (!left.length) {
    // Enter the transfer phase before deferring its animation: duplicate ready messages must not start play.
    runtime.game.phase = 'tribute';
    runtime.game.clock = null;
    runtime.game.gives = runtime.game.returns.map((x) => ({
      from: x.from,
      to: x.to,
      id: runtime.game.retPick[x.from],
      label: '还贡',
    }));
    runtime.game.returns = [];
    later(runGives, 150);
    return;
  }
  runtime.game.phase = 'return';
  if (runtime.game.clock && runtime.game.clock.who === 'return') runtime.game.clock.seats = left;
  else {
    runtime.game.clock = { who: 'return', seats: left, left: RET_MS, total: RET_MS };
    if (left.includes(0)) Sound.play('turn');
  }
  render();
}

// a return made during the sorting minute goes across at once, while the others are still sorting
export function returnNow(p, id) {
  const x = runtime.game.returns.find((r) => r.from === p);
  if (!x) return;
  runtime.game.returns = runtime.game.returns.filter((r) => r !== x);
  handOver({ from: p, to: x.to, id, label: '还贡' }, runtime.game.tok).then((ok) => {
    if (ok) render();
  });
  render();
}

export function initialize() {
  // the largest card goes at once, for the computer and for a player who has only one kind of it; a player whose
  // largest card comes in several suits gets 30 seconds to choose, after which one goes for them
  tribChoice = (g) => new Set(tribOptions(g).map((c) => c.s)).size > 1;
  owesReturn = (p) =>
    (runtime.game.phase === 'return' || runtime.game.phase === 'prep') &&
    (runtime.game.returns || []).some((x) => x.from === p) &&
    (runtime.game.retPick || {})[p] == null;
}
