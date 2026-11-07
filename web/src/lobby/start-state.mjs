import { initialMatchLevels } from '../core/match.js';
export const START_DIRS = ['S', 'E', 'N', 'W'];
const integer = (v, min, max, fallback) =>
  Number.isInteger(v) && v >= min && v <= max ? v : fallback;
export function startOptions(rules, direction = 'S') {
  const raw = rules.startState || {},
    levels = { SN: 2, EW: 2 };
  if (!rules.startState) {
    const side = rules.startSide || ('SN'.includes(direction) ? 'SN' : 'EW');
    levels[side] = integer(rules.startLevel, 2, 14, 2);
  } else for (const side of ['SN', 'EW']) levels[side] = integer(raw.levels?.[side], 2, 14, 2);
  const used = new Set();
  const order = Array.from({ length: 4 }, (_, i) => {
    const d = raw.order?.[i];
    if (!START_DIRS.includes(d) || used.has(d)) return '';
    used.add(d);
    return d;
  });
  return {
    levels,
    playSide: ['SN', 'EW'].includes(raw.playSide ?? rules.startSide)
      ? (raw.playSide ?? rules.startSide)
      : '',
    order,
    aFails: { SN: integer(raw.aFails?.SN, 0, 2, 0), EW: integer(raw.aFails?.EW, 0, 2, 0) },
    aOut: ['SN', 'EW'].includes(raw.aOut) ? raw.aOut : '',
  };
}
export function startConfigured(s) {
  return (
    Object.values(s.levels).some((l) => l !== 2) ||
    !!s.playSide ||
    s.order.some(Boolean) ||
    Object.values(s.aFails).some(Boolean) ||
    !!s.aOut
  );
}
/** Initial tabletop setup only; training and core settlement rules stay unchanged. */
export function initialTableState(rules, direction = 'S', hostTeam = 0, used = false) {
  if (!rules.startState) return initialMatchLevels(rules, direction, hostTeam);
  if (used) return initialMatchLevels({}, direction, hostTeam);
  const s = startOptions(rules, direction),
    own = Math.max(0, START_DIRS.indexOf(direction));
  const local = (d) => (START_DIRS.indexOf(d) - own + 4) % 4,
    team = (d) => local(d) % 2;
  const complete = s.order.every(Boolean),
    active = s.playSide || (complete ? ('SN'.includes(s.order[0]) ? 'SN' : 'EW') : null);
  const lvlTeam = active ? team(active[0]) : hostTeam % 2,
    levels = [2, 2],
    aFails = [0, 0];
  for (const side of ['SN', 'EW']) {
    levels[team(side[0])] = s.levels[side];
    aFails[team(side[0])] = s.aFails[side];
  }
  return {
    levels,
    lvlTeam,
    L: levels[lvlTeam],
    aFails,
    prevOut: complete ? s.order.map(local) : null,
    aOut: s.aOut ? team(s.aOut[0]) : null,
  };
}
