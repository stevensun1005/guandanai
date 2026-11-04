/** Public match progress, independent of private opponent cards. */
export function encodeMatchFeatures(state) {
  const match = state.match;
  if (!match || match.levels?.length !== 2 || match.aFails?.length !== 2)
    throw Error('Missing public match progress');
  const team = state.p % 2,
    other = 1 - team,
    order = match.previousOrder;
  const double = !!order && order[0] % 2 === order[1] % 2;
  const result = new Float32Array([
    match.levels[team] / 14,
    match.levels[other] / 14,
    match.aFails[team] / 3,
    match.aFails[other] / 3,
    Number(match.lvlTeam === team),
    Math.min(match.round, 100) / 100,
    Number(double && order[0] % 2 === team),
    Number(double && order[0] % 2 === other),
  ]);
  if (!result.every(Number.isFinite)) throw Error('Invalid public match progress');
  return result;
}
