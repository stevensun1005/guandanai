/** Runtime seats/levels are already rotated together. Other private hands never cross the worker boundary. */
export function tributeObservation(game, player, stage) {
  const order = game.prevOut;
  if (!Array.isArray(order) || order.length !== 4) throw Error('No previous finish');
  const dbl = order[0] % 2 === order[1] % 2;
  const recipient =
    stage === 'tribute' ? (dbl ? null : order[0]) : game.returns.find((x) => x.from === player)?.to;
  if (stage === 'return' && recipient == null) throw Error('No return obligation');
  return {
    stage,
    player,
    hand: game.hands[player].map((c) => c.id),
    level: game.L,
    levels: game.levels.slice(),
    previousOrder: order.slice(),
    recipient,
    leader: stage === 'tribute' ? null : game.leader,
    publicOffers:
      stage === 'tribute'
        ? []
        : (game.trib || []).map((t) => ({ from: t.g, to: t.r, id: t.tc.id })),
  };
}

export function specialistHead(manifest, model) {
  if (!manifest?.enabled) return null;
  const cohort = model?.config?.history === 'guanzero-v1' ? 1 : 0;
  return manifest.approvedBaseSHA256?.[cohort]?.includes(model?.sha256) ? cohort : null;
}
