const sessions = new WeakMap();
const eligible = (context) =>
  context.mode === 'host' && !context.practice && context.humans.length >= 2;
export const humanMask = (humans) => humans.reduce((mask, seat) => mask | (1 << seat), 0);
const ids = (hands) => hands.map((hand) => hand.map((card) => card.id));

export function captureDeal(game, context) {
  if (!eligible(context)) return;
  let session = sessions.get(game);
  if (!session) {
    session = {
      id: crypto.randomUUID(),
      players: Array.from({ length: 4 }, () => crypto.randomUUID()),
    };
    sessions.set(game, session);
  }
  session.pending = {
    schema: 1,
    kind: context.kind || 'game',
    encoding: 'physical-108-v1',
    id: `${session.id}:${game.round}`,
    matchId: session.id,
    round: game.round,
    appVersion: context.version,
    startedAt: new Date().toISOString(),
    level: game.L,
    match: {
      levels: game.levels.slice(),
      lvlTeam: game.lvlTeam,
      L: game.L,
      aFails: game.aFails.slice(),
      aOut: game.aOut ?? null,
    },
    rules: { trib: !!context.rules.trib, aFail: context.rules.aFail },
    dealtHands: ids(game.hands),
    actions: [],
  };
  session.monotonicStart = performance.now();
}

export function captureStart(game, context) {
  const session = sessions.get(game),
    record = session?.pending;
  if (!record || record.round !== game.round || record.hands || !eligible(context)) return;
  record.leader = game.turn;
  record.hands = ids(game.hands);
  record.humanMask = humanMask(context.humans);
  record.seats = session.players.map((id, p) => ({
    id,
    human: context.humans.includes(p),
    bot: context.models[p],
  }));
  record.tribute = (game.trib || []).map((t) => ({
    from: t.g,
    to: t.r,
    card: t.tc.id,
    returnCard: t.rc?.id ?? null,
  }));
}

export function captureAction(game, player, play, context) {
  const session = sessions.get(game),
    record = session?.pending;
  if (!record?.hands || record.round !== game.round || record.endedAt || context.mode !== 'host')
    return;
  const human = context.humans.includes(player);
  const actor = human ? (context.automatic ? 'timeout' : 'human') : 'bot';
  const clock = game.clock;
  record.actions.push({
    seat: player,
    cards: play ? play.cards.map((c) => c.id) : null,
    ...(play ? { type: play.type, value: play.value, n: play.n } : {}),
    actor,
    humanMask: humanMask(context.humans),
    model: actor === 'human' ? null : context.models[player],
    decisionMs:
      actor === 'human' && clock?.who === player
        ? Math.max(0, Math.round(clock.total - clock.left))
        : null,
    elapsedMs: Math.max(0, Math.round(performance.now() - session.monotonicStart)),
  });
}

export function completedRecord(game, context) {
  const record = sessions.get(game)?.pending;
  if (
    !record?.hands ||
    record.round !== game.round ||
    !game.result ||
    context.mode !== 'host' ||
    context.practice
  )
    return null;
  if (!record.endedAt) {
    record.endedAt = new Date().toISOString();
    record.order = game.result.order.slice();
  }
  return structuredClone(record);
}
