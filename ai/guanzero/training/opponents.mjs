import { RULE_OPPONENT_VERSION } from '../../shared/simulation/rule-baseline.mjs';

export const LEGACY_FIVE_OPPONENTS = Object.freeze(['random', 'rule', 'p0', 'clint', 'champion']);
export const LEGACY_THREE_OPPONENTS = Object.freeze(['random', 'clint', 'champion']);
export const DEFAULT_OPPONENTS = Object.freeze(['clint', 'champion', 'reason']);
export const LEGACY_TWO_OPPONENTS = Object.freeze(['clint', 'champion']);
export const REASON_OPPONENT_PANEL = 'clint-champion-reason-v1';
export const THREE_OPPONENT_PANEL = 'random-clint-champion-v1';
export const TWO_OPPONENT_PANEL = 'clint-champion-v1';
export function suiteOpponents(plan) {
  if (plan.opponentPanel === undefined) return LEGACY_FIVE_OPPONENTS;
  if (plan.opponentPanel === THREE_OPPONENT_PANEL) return LEGACY_THREE_OPPONENTS;
  if (plan.opponentPanel === TWO_OPPONENT_PANEL) return LEGACY_TWO_OPPONENTS;
  if (plan.opponentPanel === REASON_OPPONENT_PANEL) return DEFAULT_OPPONENTS;
  throw Error('Unknown GuanZero opponent panel');
}
const definitions = {
  reason: { name: 'danMCai-reason', mode: 'self', version: 'resolved-at-freeze' },
  random: { name: '随机出牌', version: 'uniform-candidates-v1', mode: 'snapshot' },
  rule: { name: '原版规则机器人', version: 'original', mode: 'rule', ruleVersion: 'original' },
  p0: { name: 'P0初始模型', version: 'p0', mode: 'snapshot' },
  champion: { name: 'danMCai门控冠军', mode: 'snapshot', version: 'resolved-at-freeze' },
  clint: {
    name: 'Clint规则机器人',
    version: RULE_OPPONENT_VERSION,
    mode: 'rule',
    ruleVersion: RULE_OPPONENT_VERSION,
  },
};
export function opponentDefinition(id) {
  if (!Object.hasOwn(definitions, id)) throw Error(`Unknown GuanZero evaluation opponent: ${id}`);
  return { id, ...definitions[id] };
}
