import { TYPE_NAME, cardText, rankName } from '../core/cards.js';

/** A shareable scorecard contains public actions only, never held cards. */
export function publicLog(game, names, playerName) {
  const name = (seat) => (seat === 0 ? playerName || '你' : names[seat] || `座位${seat}`);
  return {
    round: game.round,
    level: rankName(game.L),
    rows: (game.log || []).map((entry, index) => ({
      number: index + 1,
      seat: entry.p,
      name: name(entry.p),
      lead: !!entry.lead,
      type: entry.cards?.length ? TYPE_NAME[entry.type] || '出牌' : '过',
      cards:
        entry.cards?.map((card) => ({
          text: cardText(card),
          red: card.s === 'H' || card.s === 'D' || card.r === 17,
        })) || [],
    })),
  };
}

export function publicLogText(record) {
  return [
    `掼蛋 · 第 ${record.round} 局 · 打 ${record.level}`,
    ...record.rows.map(
      (row) =>
        `${row.number}. ${row.name} ${row.lead ? '领出 ' : ''}${row.type}${row.cards.length ? ' · ' + row.cards.map((card) => card.text).join(' ') : ''}`,
    ),
  ].join('\n');
}
