/** Room clock choices only; never imported by training or model rewards. */
export const PREP_CHOICES = [30, 60, 90];
export const PLAY_MODES = { '20+60': [20, 60], '30+60': [30, 60], 60: [60, 0] };
export const prepMs = (rules = {}) =>
  (PREP_CHOICES.includes(rules.prepSec) ? rules.prepSec : 90) * 1000;
export const playMode = (rules = {}) =>
  Object.hasOwn(PLAY_MODES, rules.playMode) ? rules.playMode : '60';
export const playMs = (rules = {}) => PLAY_MODES[playMode(rules)][0] * 1000;
export const reserveMs = (rules = {}) => PLAY_MODES[playMode(rules)][1] * 1000;
export const clockShown = (clock) => (clock.left > 0 ? clock.left : (clock.res || 0) + clock.left);
export function turnClock(game, player, human, rules, extra = {}) {
  const ms = playMs(rules);
  return {
    who: player,
    left: ms,
    total: ms,
    res: human ? (game.res?.[player] ?? reserveMs(rules)) : 0,
    ...extra,
  };
}
export function commitReserve(game, clock) {
  if (!clock || typeof clock.who !== 'number' || !(clock.res > 0) || clock.left >= 0) return;
  game.res ||= [null, null, null, null];
  game.res[clock.who] = Math.max(0, clock.res + clock.left);
}
export function playText(rules) {
  const [move, reserve] = PLAY_MODES[playMode(rules)];
  return reserve
    ? `每次出牌 ${move} 秒，每局每位真人另有 ${reserve} 秒超时余额（超过本手时间后扣余额，用尽后超时托管）`
    : `每次出牌 ${move} 秒`;
}
