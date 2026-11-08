// This nickname reveals a local feature. It is not authentication or a secret in a public build.
export const privateEligible = (mode, nickname) => mode === 'host' && nickname === 'stezer0';
export const privateActive = (context) =>
  context.privateTable === true && privateEligible(context.network.mode, context.nickname);
export const privateSeat = (context, seat) =>
  privateActive(context) && (seat === 0 || (seat === 2 && !context.network.humans.has(2)));

const touched = new WeakSet();
export function markPrivateTable(context) {
  if (privateActive(context) && context.game && context.game.phase !== 'start')
    touched.add(context.game);
}
export const privateWasUsed = (game) => !!game && touched.has(game);

/** Separate privileged input; ordinary policyState never receives these hands. */
export function oracleObservation(game, player = 0) {
  return {
    hands: game.hands.map((hand) => hand.map((card) => card.id)),
    player,
    level: game.L,
    levels: game.levels.slice(),
    log: game.log.map((entry) => ({
      p: entry.p,
      cards: entry.cards?.map((card) => card.id) || null,
    })),
    trick: game.trick && {
      player: game.trick.player,
      play: {
        type: game.trick.play.type,
        value: game.trick.play.value,
        n: game.trick.play.n,
      },
    },
    passes: game.passes || 0,
    out: game.out.slice(),
  };
}

// A restored game keeps its permanent collection exclusion; this never enables the tool.
export function restorePrivateUse(game, used) {
  if (used && game) touched.add(game);
}
