import { observeOpponentHabits } from './habits.js';

/** Only this seat's private cards and information visible at the table. */
export function policyState(game, player, offset, plays) {
  return {
    p: player,
    hand: game.hands[player].map((card) => card.id),
    counts: game.hands.map((hand) => hand.length),
    log: game.log.map((entry) => ({
      p: entry.p,
      cards: entry.cards?.map((card) => card.id) || null,
    })),
    level: game.L,
    selfLevel: game.levels[(player + offset) % 2],
    opponentLevel: game.levels[(player + offset + 1) % 2],
    canPass: !!game.trick,
    actions: plays.map((play) => play?.cards.map((card) => card.id) || []),
  };
}

export function decisionContext(game, player) {
  return {
    p: player,
    hand: game.hands[player],
    counts: game.hands.map((hand) => hand.length),
    log: game.log.map(({ p, cards, type, value, n, lead }) => ({ p, cards, type, value, n, lead })),
    ...(game.roundHistory?.length
      ? { habits: observeOpponentHabits(game.roundHistory, game.log) }
      : {}),
    level: game.L,
    trick: game.trick && {
      player: game.trick.player,
      play: { type: game.trick.play.type, value: game.trick.play.value, n: game.trick.play.n },
    },
  };
}

/** A pass is an observation of a choice, never proof that a player cannot follow. */
export function observeResponses(log) {
  const seats = Array.from({ length: 4 }, () => ({
    responses: 0,
    passes: 0,
    bySize: {},
    plays: 0,
    bombs: 0,
  }));
  let lastSize = 0;
  for (const entry of log) {
    if (!Number.isInteger(entry.p) || entry.p < 0 || entry.p > 3) continue;
    const seat = seats[entry.p];
    const responseSize = lastSize;
    if (entry.cards?.length) {
      lastSize = entry.cards.length;
      seat.plays++;
      if (['bomb', 'sflush', 'jokers'].includes(entry.type)) seat.bombs++;
    } else if (lastSize) {
      seat.responses++;
      seat.passes++;
      const bucket = (seat.bySize[lastSize] ||= { passes: 0, responds: 0 });
      bucket.passes++;
    }
    if (entry.cards?.length && !entry.lead && responseSize) {
      seat.responses++;
      const bucket = (seat.bySize[responseSize] ||= { passes: 0, responds: 0 });
      bucket.responds++;
    }
  }
  return seats;
}
