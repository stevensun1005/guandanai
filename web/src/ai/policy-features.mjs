/** Public supplementary features for the learned action-value residual. */
export const POLICY_EXTRA_FEATURES = 53;
export const POLICY_EXTRA_VERSION = 1;
export const POLICY_ACTION_TYPES = Object.freeze([
  'single',
  'pair',
  'triple',
  'full',
  'straight',
  'pairs3',
  'trip2',
  'bomb',
  'sflush',
  'jokers',
]);

// 0: trick present; 1..4: owner relative to actor; 5..14: trick type;
// 15..17: trick value, size, consecutive passes; 18..20: first-out team;
// 21..31: action type (pass first); 32..36: action value, size, wilds,
// controls and cards left; 37..40: next active relative seat; 41..44:
// partner leading, active seats, finishing action, shortest opposing hand;
// 45..52: remaining singles, pairs, triples, bombs, wilds, jokers,
// level cards and distinct ranks. All observations are public or own-hand.
export const POLICY_EXTRA_SCHEMA = Object.freeze({
  trickPresent: 0,
  trickOwner: 1,
  trickType: 5,
  trickValue: 15,
  trickSize: 16,
  passes: 17,
  firstOutTeam: 18,
  actionType: 21,
  actionValue: 32,
  actionSize: 33,
  actionWilds: 34,
  actionControls: 35,
  remainingCount: 36,
  nextActive: 37,
  partnerLeading: 41,
  activeCount: 42,
  finishes: 43,
  opponentMinimum: 44,
  remainingStructure: 45,
});

function rank(id) {
  const face = id % 54;
  return face >= 52 ? face - 36 : (face % 13) + 2;
}

const wild = (id, level) => Math.floor((id % 54) / 13) === 1 && rank(id) === level;
const value = (shape) => (shape.type === 'jokers' ? 1 : shape.value / 17);

function typeIndex(shape) {
  const index = POLICY_ACTION_TYPES.indexOf(shape?.type);
  if (index < 0) throw Error('Unknown policy action shape');
  return index;
}

function preparePolicyExtras(state) {
  if (state.actionShapes?.length !== state.actions.length)
    throw Error('Invalid residual action inputs');
  const { p, counts, log } = state;
  const result = new Float32Array(POLICY_EXTRA_FEATURES);
  const trick = state.canPass ? state.trick : null;
  if (state.canPass && !trick) throw Error('Missing public trick');
  result[0] = Number(!!trick);
  if (trick) {
    result[1 + ((trick.player - p + 4) % 4)] = 1;
    result[5 + typeIndex(trick.play)] = 1;
    result[15] = value(trick.play);
    result[16] = trick.play.n / 10;
    let passes = 0;
    for (let i = log.length - 1; i >= 0 && !log[i].cards?.length; i--) passes++;
    result[17] = Math.min(3, passes) / 3;
  }
  const played = [0, 0, 0, 0];
  let first = -1;
  for (const entry of log) {
    played[entry.p] += entry.cards?.length || 0;
    if (played[entry.p] === 27) {
      first = entry.p;
      break;
    }
  }
  result[18 + (first < 0 ? 0 : first % 2 === p % 2 ? 1 : 2)] = 1;
  result[41] = Number(trick?.player === (p + 2) % 4);
  result[42] = counts.filter((count) => count > 0).length / 4;
  const opponents = [counts[(p + 1) % 4], counts[(p + 3) % 4]].filter((count) => count > 0);
  result[44] = opponents.length ? Math.min(...opponents) / 27 : 0;
  return result;
}

/** state is policyState plus public trick and one actionShapes entry per action. */
export function encodePolicyExtras(state, actionIndex, prepared = preparePolicyExtras(state)) {
  if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex >= state.actions.length)
    throw Error('Invalid residual action inputs');
  const { p, hand, counts, level } = state;
  const action = state.actions[actionIndex];
  const shape = state.actionShapes[actionIndex];
  const result = new Float32Array(prepared);
  if (action.length) {
    result[22 + typeIndex(shape)] = 1;
    result[32] = value(shape);
    result[33] = action.length / 10;
    result[34] = action.filter((id) => wild(id, level)).length / 2;
    result[35] = action.filter((id) => rank(id) === level || rank(id) >= 16).length / 10;
  } else result[21] = 1;
  const used = new Set(action);
  const remaining = hand.filter((id) => !used.has(id));
  result[36] = remaining.length / 27;
  for (let step = 1; step <= 4; step++) {
    const seat = (p + step) % 4;
    if ((seat === p ? remaining.length : counts[seat]) > 0) {
      result[37 + (step % 4)] = 1;
      break;
    }
  }
  result[43] = Number(action.length > 0 && remaining.length === 0);
  const ranks = new Map();
  let wilds = 0,
    jokers = 0,
    levels = 0;
  for (const id of remaining) {
    const r = rank(id);
    if (r === level) levels++;
    if (r >= 16) jokers++;
    if (wild(id, level)) wilds++;
    else ranks.set(r, (ranks.get(r) || 0) + 1);
  }
  for (const count of ranks.values()) {
    if (count <= 3) result[44 + count] += 1;
    else result[48] += 1;
  }
  for (let index = 45; index <= 48; index++) result[index] /= 13;
  result[49] = wilds / 2;
  result[50] = jokers / 4;
  result[51] = levels / 8;
  result[52] = ranks.size / 15;
  return result;
}

/** Row-major [actions, 53], with public history processed once per decision. */
export function encodePolicyExtrasBatch(state) {
  const prepared = preparePolicyExtras(state);
  const result = new Float32Array(state.actions.length * POLICY_EXTRA_FEATURES);
  for (let index = 0; index < state.actions.length; index++)
    result.set(encodePolicyExtras(state, index, prepared), index * POLICY_EXTRA_FEATURES);
  return result;
}
