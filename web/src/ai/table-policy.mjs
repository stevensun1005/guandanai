import { candidates } from './candidates.js';
import { decisionContext, policyState } from './observation.js';
import { endgameRequest, solvePublicEndgame } from './endgame.js';
import { inferPolicy } from './policy-inference.mjs';
import { profileId, selectProfileAction, usesResponseModel } from './profiles.js';
import { responseCandidates, predictResponses } from './response.mjs';

/** Shared by the table controller and full-match evaluation; private opponents stay outside. */
export function prepareTableDecision(game, player, offset, config, profile = 'balanced') {
  const plays = candidates(game.hands[player], game.L, game.trick?.play);
  const finish = plays.findIndex((play) => play?.cards.length === game.hands[player].length);
  if (finish >= 0 && !config.learnFinishingDecisions) return { plays, index: finish };
  if (plays.length === 1) return { plays, index: 0 };
  const state = policyState(game, player, offset, plays);
  state.profile = profileId(profile);
  if (state.profile !== 'balanced') state.context = decisionContext(game, player);
  if (state.profile !== 'balanced' || config.extraFeatures)
    state.actionShapes = plays.map(
      (play) => play && { type: play.type, value: play.value, n: play.n, wu: play.wu },
    );
  if (config.extraFeatures) {
    const trick = game.trick;
    state.trick = trick && {
      player: trick.player,
      play: { type: trick.play.type, value: trick.play.value, n: trick.play.n },
    };
    if (config.extraFeatures === 61)
      state.match = {
        levels: game.levels.slice(),
        aFails: (game.aFails || [0, 0]).slice(),
        lvlTeam: game.lvlTeam,
        round: game.round,
        previousOrder: game.prevOut?.slice() || null,
      };
  }
  state.endgame = config.publicEndgame === false ? null : endgameRequest(game, player, plays);
  return { plays, state };
}

function shapedPlays(state) {
  const hand = new Map(state.context.hand.map((card) => [card.id, card]));
  if (state.actionShapes?.length !== state.actions.length) throw Error('Missing action shapes');
  return state.actions.map((ids, index) =>
    ids.length ? { ...state.actionShapes[index], cards: ids.map((id) => hand.get(id)) } : null,
  );
}

/** The actual Worker decision pipeline, also runnable without DOM or a Python bridge. */
export async function decideTablePolicy(ort, session, state, config) {
  const engine = await session();
  const started = performance.now();
  const inferred = await inferPolicy(ort, engine, state, config);
  let index = inferred.index;
  const style = profileId(state.profile);
  const scores = inferred.values;
  const endgame = state.endgame ? solvePublicEndgame(state, scores) : null;
  let responseRisks = null;
  if (endgame) index = endgame.index;
  else if (style !== 'balanced') {
    const plays = shapedPlays(state);
    index = selectProfileAction(plays, scores, style, state.context);
    if (usesResponseModel(style)) {
      const options = responseCandidates(plays, scores, state.context, index);
      if (options) {
        responseRisks = await predictResponses(
          ort,
          await session('response'),
          state.context,
          plays,
          options,
        );
        index = selectProfileAction(plays, scores, style, { ...state.context, responseRisks });
      }
    }
  }
  return {
    index,
    value: scores[index],
    candidates: state.actions.length,
    elapsedMs: Math.round(performance.now() - started),
    ...(state.includeValues ? { values: scores, ...(responseRisks ? { responseRisks } : {}) } : {}),
    ...(endgame ? { endgame } : {}),
  };
}
