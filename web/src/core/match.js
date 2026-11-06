/** Match progression, shared by the table and training environment. */
export function roundOutcome(
  { levels, lvlTeam, L, aFails = [0, 0], aOut = null },
  order,
  aFail = 'draw',
) {
  const nextLevels = levels.slice(),
    fails = aFails.slice();
  const team = order[0] % 2,
    pos = order.indexOf((order[0] + 2) % 4);
  const up = pos === 1 ? 3 : pos === 2 ? 2 : 1,
    before = levels[team];
  const once = aFail === 'once';
  const win = lvlTeam === team && before === 14 && pos <= 2 && !(once && aOut === team);
  if (!win) nextLevels[team] = Math.min(14, before + up);
  const after = nextLevels[team];
  let aTry = 0,
    draw = false,
    reset = false,
    spent = false,
    lastTry = false;
  if (L === 14 && !win && aFail !== 'keep') {
    if (once) {
      if (aOut == null) {
        aTry = ++fails[lvlTeam];
        if (aTry >= 3) {
          aOut = lvlTeam;
          spent = true;
        }
      } else if (lvlTeam !== aOut) {
        draw = true;
        lastTry = true;
      }
    } else {
      aTry = ++fails[lvlTeam];
      if (aTry >= 3) {
        if (aFail === 'draw') draw = true;
        else {
          nextLevels[lvlTeam] = 2;
          fails[lvlTeam] = 0;
          reset = true;
        }
      }
    }
  }
  return {
    levels: nextLevels,
    aFails: fails,
    lvlTeam: team,
    ...(once ? { aOut } : {}),
    result: {
      order: order.slice(),
      team,
      up,
      before,
      after,
      win,
      draw,
      reset,
      aTry,
      aTeam: lvlTeam,
      playedLevel: L,
      ...(once ? { aOut, spent, lastTry } : {}),
    },
  };
}

export function initialMatchLevels(rules, ownDirection = 'S', hostTeam = 0) {
  const level =
    Number.isInteger(rules?.startLevel) && rules.startLevel >= 2 && rules.startLevel <= 14
      ? rules.startLevel
      : 2;
  const directions = ['S', 'E', 'N', 'W'];
  const side = rules?.startSide === 'SN' ? 0 : rules?.startSide === 'EW' ? 1 : null;
  const own = Math.max(0, directions.indexOf(ownDirection));
  const team = side == null ? hostTeam % 2 : (side - own + 4) % 2;
  const levels = [2, 2];
  levels[team] = level;
  return { levels, lvlTeam: team, L: level };
}

export function levelAttemptLabel(game, team) {
  if (game.levels[team] !== 14) return null;
  return game.aOut != null && game.aOut !== team
    ? 'A末'
    : `A${Math.min(3, (game.aFails?.[team] || 0) + 1)}`;
}

/**
 * Why the round's winners are still at A after a round they won while at A (null when they passed
 * A, were not at A, or moved). Each round is played at the level of the previous round's winners,
 * so a team at A only passes it in a round played at its own A, with its partner not last.
 *   spent       - the team used up its A attempts ("once" table rule)
 *   notOwnA     - the round was played at the other team's level
 *   partnerLast - the round was played at their A but the partner finished last
 */
export function aStayReason(result) {
  if (!result || result.win || result.draw || result.before !== 14 || result.after !== 14)
    return null;
  if (result.aOut != null && result.aOut === result.team) return 'spent';
  if (result.aTeam !== result.team || result.playedLevel !== 14) return 'notOwnA';
  return 'partnerLast';
}
