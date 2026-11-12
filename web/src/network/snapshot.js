/** Rotate a host snapshot into a player's view without changing physical card ranks or IDs. */
export function rotateSnapshot(source, offset) {
  const game = structuredClone(source);
  const seat = (value) =>
    Number.isInteger(value) && value >= 0 ? (value - offset + 4) % 4 : value;
  const team = (value) => (Number.isInteger(value) ? (value + offset) % 2 : value);
  const seats = (values) => values?.map(seat);
  const records = (values, fields) =>
    values?.map((value) => ({
      ...value,
      ...Object.fromEntries(
        fields.filter((field) => value[field] != null).map((field) => [field, seat(value[field])]),
      ),
    }));
  for (const field of ['hands', 'last', 'pw', 'res'])
    if (game[field]?.length === 4)
      game[field] = Array.from({ length: 4 }, (_, local) => game[field][(local + offset) % 4]);
  for (const field of [
    'turn',
    'leader',
    'cutter',
    'shuffler',
    'dealIdx',
    'firstLeader',
    'nextLeader',
    'pausedBy',
    'stepWait',
  ])
    if (game[field] != null) game[field] = seat(game[field]);
  for (const field of ['out', 'prevOut', 'ready', 'nextReady', 'tribGivers'])
    if (game[field]) game[field] = seats(game[field]);
  for (const field of ['retPick', 'tribPick'])
    if (game[field])
      game[field] = Object.fromEntries(
        Object.entries(game[field]).map(([key, value]) => [seat(+key), value]),
      );
  for (const [field, keys] of [
    ['returns', ['from', 'to']],
    ['gives', ['from', 'to']],
    ['trib', ['g', 'r']],
    ['log', ['p']],
    ['trickPlays', ['p']],
    ['rest', ['p']],
  ])
    if (game[field]) game[field] = records(game[field], keys);
  if (game.trick) game.trick.player = seat(game.trick.player);
  if (game.kang) {
    game.kang.leader = seat(game.kang.leader);
    game.kang.has = records(game.kang.has, ['g']);
  }
  if (game.clock) {
    if (typeof game.clock.who === 'number') game.clock.who = seat(game.clock.who);
    if (game.clock.seat != null) game.clock.seat = seat(game.clock.seat);
    if (game.clock.seats) game.clock.seats = seats(game.clock.seats);
  }
  if (game.shown) {
    game.shown.lvlTeam = team(game.shown.lvlTeam);
    if (game.shown.aOut != null) game.shown.aOut = team(game.shown.aOut);
    if (offset % 2) {
      game.shown.levels.reverse();
      game.shown.aFails.reverse();
    }
  }
  game.lvlTeam = team(game.lvlTeam);
  if (game.aOut != null) game.aOut = team(game.aOut);
  if (offset % 2) {
    game.levels.reverse();
    game.aFails?.reverse();
  }
  if (game.result) {
    game.result.team = team(game.result.team);
    game.result.aTeam = team(game.result.aTeam);
    if (game.result.aOut != null) game.result.aOut = team(game.result.aOut);
    game.result.order = seats(game.result.order);
  }
  if (game.roundHistory)
    game.roundHistory = game.roundHistory.map((record) => ({
      ...record,
      names: Array.from({ length: 4 }, (_, local) => record.names[(local + offset) % 4]),
      levels: offset % 2 ? record.levels.slice().reverse() : record.levels,
      log: records(record.log, ['p']),
      result: {
        ...record.result,
        team: team(record.result.team),
        aTeam: team(record.result.aTeam),
        ...(record.result.aOut != null ? { aOut: team(record.result.aOut) } : {}),
        order: seats(record.result.order),
      },
    }));
  return game;
}

/** Await stable logical phases; do not revive callbacks in the middle of an animation. */
export function canResume(game) {
  if (!game || game.busy || game.gives?.length) return false;
  if (game.phase === 'play') return game.turn >= 0;
  if (game.phase === 'roundEnd' || game.phase === 'over') return game.reveal === 4;
  return ['prep', 'return', 'tribPick'].includes(game.phase);
}
