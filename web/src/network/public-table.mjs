import { makeDeck } from '../core/cards.js';

/** Public projection only: spectators never receive the deck, private hands or game seeds. */
export function publicTable(game, names = {}, humans = new Set()) {
  if (!game) return null;
  const shown = game.shown || game;
  const cards = (list) => (list || []).map(({ id, r, s }) => ({ id, r, s }));
  const play = (entry) =>
    entry && { cards: cards(entry.cards), type: entry.type, value: entry.value, n: entry.n };
  return {
    round: game.round,
    phase: game.phase,
    level: game.L,
    levels: shown.levels.slice(),
    aFails: shown.aFails?.slice() || [0, 0],
    levelTeam: shown.lvlTeam,
    turn: game.turn,
    out: game.out.slice(),
    paused: !!game.paused,
    players: game.hands.map((hand, seat) => ({
      seat,
      name: humans.has(seat) ? String(names[seat] || '玩家').slice(0, 8) : '电脑',
      human: humans.has(seat),
      count: hand.length,
      last: game.last?.[seat] === 'pass' ? 'pass' : play(game.last?.[seat]?.play),
    })),
    log: (game.log || []).map((entry) => ({
      seat: entry.p,
      cards: entry.cards ? cards(entry.cards) : null,
      lead: !!entry.lead,
    })),
  };
}

const deck = makeDeck();
export function validPublicTable(table) {
  const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
  const seat = (n) => integer(n, 0, 3);
  const cards = (list) =>
    Array.isArray(list) &&
    list.length <= 27 &&
    list.every((c) => c && integer(c.id, 0, 107) && deck[c.id].r === c.r && deck[c.id].s === c.s);
  return (
    !!table &&
    integer(table.round, 0, 200) &&
    integer(table.level, 2, 14) &&
    Array.isArray(table.levels) &&
    table.levels.length === 2 &&
    table.levels.every((n) => integer(n, 2, 15)) &&
    integer(table.turn, -1, 3) &&
    typeof table.phase === 'string' &&
    Array.isArray(table.out) &&
    table.out.length <= 4 &&
    table.out.every(seat) &&
    Array.isArray(table.players) &&
    table.players.length === 4 &&
    table.players.every(
      (p, i) =>
        p &&
        p.seat === i &&
        typeof p.name === 'string' &&
        p.name.length <= 8 &&
        integer(p.count, 0, 27) &&
        (p.last == null || p.last === 'pass' || cards(p.last.cards)),
    ) &&
    Array.isArray(table.log) &&
    table.log.length <= 2000 &&
    table.log.every((e) => e && seat(e.seat) && (e.cards === null || cards(e.cards)))
  );
}
