/** Match progression, shared by the table and training environment. */
export function roundOutcome({ levels, lvlTeam, L, aFails = [0, 0] }, order, aFail = 'draw') {
  const nextLevels = levels.slice(),
    fails = aFails.slice();
  const team = order[0] % 2,
    pos = order.indexOf((order[0] + 2) % 4);
  const up = pos === 1 ? 3 : pos === 2 ? 2 : 1,
    before = levels[team];
  const win = lvlTeam === team && before === 14 && pos <= 2;
  if (!win) nextLevels[team] = Math.min(14, before + up);
  const after = nextLevels[team];
  let aTry = 0,
    draw = false,
    reset = false;
  if (L === 14 && !win && aFail !== 'keep') {
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
  return {
    levels: nextLevels,
    aFails: fails,
    lvlTeam: team,
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
    },
  };
}
