import { rankName } from '../core/cards.js';
/** Display only: keep the attempt just played until that side plays A again. */
export function levelDisplayLabel(game, team) {
  if (game.levels[team] !== 14) return rankName(game.levels[team]);
  if (game.aOut != null && game.aOut !== team) return 'A末';
  return `A${Math.max(1, Math.min(3, (game.aFails?.[team] || 0) + (game.lvlTeam === team ? 1 : 0)))}`;
}
