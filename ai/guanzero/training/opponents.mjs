import { RULE_OPPONENT_VERSION } from '../../shared/simulation/rule-baseline.mjs';

export const LEGACY_FIVE_OPPONENTS = Object.freeze(['random', 'rule', 'p0', 'clint', 'champion']);
export const LEGACY_THREE_OPPONENTS = Object.freeze(['random', 'clint', 'champion']);
export const DEFAULT_OPPONENTS = Object.freeze(['clint', 'champion', 'reason']);
export const LEGACY_TWO_OPPONENTS = Object.freeze(['clint', 'champion']);
/** Registered 2026-11-09 with the old 3 / 4 s desktop budget; kept for its frozen batches. */
export const REASON_V1_PANEL = 'clint-champion-reason-v1';
/** Owner 2026-11-09: computer moves up to 60 s, reasoning at most 50 s, fallback after. */
export const REASON_V2_PANEL = 'clint-champion-reason-v2';
/** Both reason panels evaluate the same three opponents; only the reason budget differs. */
export const REASON_PANELS = Object.freeze([REASON_V1_PANEL, REASON_V2_PANEL]);
/** Panel of newly registered batches (the frozen companion's freezeReason decides it). */
export const REASON_OPPONENT_PANEL = REASON_V2_PANEL;
export const THREE_OPPONENT_PANEL = 'random-clint-champion-v1';
export const TWO_OPPONENT_PANEL = 'clint-champion-v1';
export function suiteOpponents(plan) {
  if (plan.opponentPanel === undefined) return LEGACY_FIVE_OPPONENTS;
  if (plan.opponentPanel === THREE_OPPONENT_PANEL) return LEGACY_THREE_OPPONENTS;
  if (plan.opponentPanel === TWO_OPPONENT_PANEL) return LEGACY_TWO_OPPONENTS;
  if (REASON_PANELS.includes(plan.opponentPanel)) return DEFAULT_OPPONENTS;
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
