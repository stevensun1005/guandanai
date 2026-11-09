/**
 * The only data the search worker receives: the mover's own hand, hand counts and public table
 * information (log, open trick, passes, finished seats, levels, tribute / anti-tribute records).
 * `restoreGame` rebuilds a game whose other hands are placeholders of the right length; reading a
 * hidden card throws, exactly like maskHidden in ai/danMCai/belief/midgame-search.mjs.
 */
import { makeDeck } from '../../core/cards.js';
import { publicKnownCards } from './known-cards.mjs';

const deck = makeDeck();
const ids = (cards) => cards.map((card) => card.id);
const shapeOf = ({ type, value, n }) => ({ type, value, n });

/** Payload for the seat to move. `seed` is a per-round random number, never derived from cards. */
export function searchPayload(game, p, offset, seed) {
  if (game.turn !== p) throw Error('Search payload is only built for the seat to move');
  const card = (c) => (c && Number.isInteger(c.id) ? c.id : null);
  return {
    p,
    offset,
    seed: seed >>> 0,
    L: game.L,
    levels: game.levels.slice(),
    turn: game.turn,
    passes: game.passes || 0,
    out: game.out.slice(),
    hand: ids(game.hands[p]),
    counts: game.hands.map((hand) => hand.length),
    log: game.log.map((e) =>
      e.cards?.length
        ? { p: e.p, cards: ids(e.cards), ...shapeOf(e), lead: !!e.lead }
        : { p: e.p, cards: null },
    ),
    trick: game.trick
      ? {
          player: game.trick.player,
          ...shapeOf(game.trick.play),
          wu: game.trick.play.wu || 0,
          cards: ids(game.trick.play.cards),
        }
      : null,
    exchanges: {
      trib: (game.trib || []).map((t) => ({ g: t.g, r: t.r, tc: card(t.tc), rc: card(t.rc) })),
      kang: game.kang?.has ? { has: game.kang.has.map(({ g, n }) => ({ g, n })) } : null,
    },
  };
}

const hidden = Object.freeze({
  get id() {
    throw Error('Hidden card read during search');
  },
});

/** Masked game for the worker; throws on an inconsistent payload. */
export function restoreGame(payload) {
  const { p, hand, counts } = payload;
  if (
    !Number.isInteger(p) ||
    p < 0 ||
    p > 3 ||
    payload.turn !== p ||
    counts?.length !== 4 ||
    hand.length !== counts[p] ||
    new Set(hand).size !== hand.length ||
    hand.some((id) => !deck[id])
  )
    throw Error('Invalid search payload');
  const log = payload.log.map((e) =>
    e.cards
      ? {
          p: e.p,
          cards: e.cards.map((id) => deck[id]),
          type: e.type,
          value: e.value,
          n: e.n,
          lead: e.lead,
        }
      : { p: e.p, cards: null },
  );
  const game = {
    hands: counts.map((n, seat) =>
      seat === p ? hand.map((id) => deck[id]) : Array(n).fill(hidden),
    ),
    L: payload.L,
    levels: payload.levels.slice(),
    log,
    trick: payload.trick
      ? {
          player: payload.trick.player,
          play: {
            ...shapeOf(payload.trick),
            ...(payload.trick.wu ? { wu: payload.trick.wu } : {}),
            cards: payload.trick.cards.map((id) => deck[id]),
          },
        }
      : null,
    passes: payload.passes,
    out: payload.out.slice(),
    turn: payload.turn,
  };
  game.publicKnownCards = publicKnownCards(
    { p, hand, counts, log: payload.log },
    payload.exchanges,
  );
  return game;
}
