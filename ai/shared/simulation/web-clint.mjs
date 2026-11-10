/** Public tribute reconstruction and the deployed, masked Clint seat; shared evaluation adapter. */
import { seededRandom } from './simulation.mjs';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { WEB_BRAIN, decideClintRule, ruleObservation } from '../../../web/src/rule-bot/runtime.mjs';
export function exchangeRecords(dealt, game, order) {
  if (!order) return {};
  const dbl = order[0] % 2 === order[1] % 2;
  const givers = dbl ? [order[2], order[3]] : [order[3]];
  const owner = new Map();
  dealt.forEach((hand, seat) => hand.forEach((card) => owner.set(card.id, seat)));
  const moves = [];
  game.hands.forEach((hand, seat) =>
    hand.forEach((card) => {
      if (owner.get(card.id) !== seat) moves.push({ from: owner.get(card.id), to: seat, card });
    }),
  );
  if (!moves.length) {
    const has = givers
      .map((g) => ({ g, n: game.hands[g].filter((c) => c.r === 17).length }))
      .filter((x) => x.n);
    if (has.reduce((sum, x) => sum + x.n, 0) < 2 || game.turn !== order[0])
      throw Error('Tribute round without card movement');
    return { trib: [], kang: { has, leader: order[0] } };
  }
  if (moves.length !== 2 * givers.length || !givers.includes(game.turn))
    throw Error('Unexpected tribute movement');
  const trib = [game.turn, ...givers.filter((g) => g !== game.turn)].map((g) => {
    const out = moves.filter((m) => m.from === g),
      back = moves.filter((m) => m.to === g);
    if (out.length !== 1 || back.length !== 1 || out[0].to !== back[0].from)
      throw Error('Unexpected tribute movement');
    return { g, r: out[0].to, tc: out[0].card, rc: back[0].card };
  });
  return { trib };
}

/**
 * The deployed web Clint seat in Node: the AI worker's decideClintRule on the controller's
 * ruleObservation (own hand, public counts / log / trick / passes / finished order / tribute
 * records), then the controller's checks mapping card ids back to this table. Math.random is the
 * same seeded stream the development suite gives Clint (roundSeed ^ 0x6a09e667); the brain's
 * world count still depends on wall-clock time (WEB_BRAIN.ms), so it is load-dependent.
 * `game.tok` must be unique per round: runtime.mjs keeps one view per seat keyed by tok:round.
 */
export function createWebClint(randomSeed, settings = WEB_BRAIN) {
  const random = seededRandom(randomSeed);
  return (game, p) => {
    if (game.tok === undefined) throw Error('Clint web view needs a per-round game.tok');
    const previous = Math.random;
    Math.random = random;
    let result;
    try {
      result = decideClintRule(ruleObservation(game, p), settings);
    } finally {
      Math.random = previous;
    }
    if (!result) {
      if (!game.trick) throw Error('invalid-rule-pass');
      return null;
    }
    const cards = result.cards.map((id) => game.hands[p].find((card) => card.id === id));
    if (
      cards.some((c) => !c) ||
      new Set(cards).size !== cards.length ||
      !analyze(cards, game.L).some(
        (shape) =>
          shape.type === result.type && shape.value === result.value && shape.n === result.n,
      ) ||
      !beats(result, game.trick?.play)
    )
      throw Error('invalid-rule-action');
    return { ...result, cards };
  };
}
