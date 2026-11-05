import { publicLog, publicLogText } from './public-log.js';
import { rankName } from '../core/cards.js';

export const MAX_PUBLIC_ROUNDS = 200;
const RESULT_FIELDS = [
  'team',
  'up',
  'before',
  'after',
  'win',
  'draw',
  'reset',
  'aTry',
  'aTeam',
  'playedLevel',
];

/** Keep only completed public actions and results; never copy a hand or a deck. */
export function rememberPublicRound(game, names, playerName) {
  if (!game.result || !game.round) return;
  const record = {
    round: game.round,
    L: game.L,
    levels: game.levels.slice(),
    names: names.map((name, seat) => (seat === 0 ? playerName || '你' : name)),
    log: (game.log || []).map(({ p, cards, type, value, n, lead }) => ({
      p,
      type,
      value,
      n,
      lead: !!lead,
      cards: cards?.map(({ id, s, r }) => ({ id, s, r })) || null,
    })),
    result: {
      ...Object.fromEntries(RESULT_FIELDS.map((key) => [key, game.result[key]])),
      order: game.result.order.slice(),
    },
  };
  game.roundHistory = [
    ...(game.roundHistory || []).filter((past) => past.round !== game.round),
    record,
  ]
    .sort((a, b) => a.round - b.round)
    .slice(-MAX_PUBLIC_ROUNDS);
}

export function matchStats(records) {
  const seats = Array.from({ length: 4 }, () => ({
    plays: 0,
    passes: 0,
    cards: 0,
    bombs: 0,
    firsts: 0,
  }));
  const wins = [0, 0];
  for (const record of records) {
    if (record.result) {
      wins[record.result.team]++;
      seats[record.result.order[0]].firsts++;
    }
    for (const entry of record.log || []) {
      const seat = seats[entry.p];
      if (entry.cards?.length) {
        seat.plays++;
        seat.cards += entry.cards.length;
        if (['bomb', 'sflush', 'jokers'].includes(entry.type)) seat.bombs++;
      } else seat.passes++;
    }
  }
  return { rounds: wins[0] + wins[1], wins, seats };
}

export function publicMatchText(records) {
  return [
    '掼蛋 · 整场公开牌谱',
    ...records.map((record) => {
      const text = publicLogText(publicLog(record, record.names, record.names[0]));
      const result = record.result;
      return result
        ? `${text}\n名次：${result.order.map((seat) => record.names[seat]).join(' → ')}\n${result.team ? '对方' : '我方'}本局获胜 · 级数 ${rankName(result.before)} → ${rankName(record.levels?.[result.team] ?? result.after)}${result.win ? ' · 打过 A' : result.draw ? ' · 本场平局' : ''}`
        : text;
    }),
  ].join('\n\n');
}
