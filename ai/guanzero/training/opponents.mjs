import { RULE_OPPONENT_VERSION } from '../../shared/simulation/rule-baseline.mjs';

export const LEGACY_FIVE_OPPONENTS = Object.freeze(['random', 'rule', 'p0', 'clint', 'champion']);
export const DEFAULT_OPPONENTS = Object.freeze(['random', 'p0', 'clint', 'champion']);
export const FOUR_OPPONENT_PANEL = 'random-p0-clint-champion-v1';
const definitions = {
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
