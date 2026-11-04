import { isWild, val } from '../core/cards.js';
import { isBomb } from '../core/combinations.js';
import { observeResponses } from './observation.js';

export const BOT_PROFILES = Object.freeze([
  {
    id: 'balanced',
    name: '均衡',
    summary: '综合判断',
    description: '综合判断局势，按学习到的策略出牌',
  },
  {
    id: 'aggressive',
    name: '激进',
    summary: '主动争先',
    description: '更主动争夺出牌权，倾向加快节奏',
  },
  {
    id: 'conservative',
    name: '稳健',
    summary: '留牌控场',
    description: '谨慎使用控制牌，倾向保留炸弹',
  },
  {
    id: 'observant',
    name: '观察',
    summary: '读牌应对',
    description: '结合公开出牌与过牌倾向调整选择',
  },
]);
export const profileId = (value) =>
  BOT_PROFILES.some((profile) => profile.id === value) ? value : 'balanced';

function preference(play, style, context, observed) {
  const { p, hand, counts, level, trick } = context;
  const mate = (p + 2) % 4;
  const opponents = [(p + 1) % 4, (p + 3) % 4].filter((seat) => counts[seat] > 0);
  const urgent = opponents.some((seat) => counts[seat] <= 2);
  const partnerLeading = trick?.player === mate;
  if (!play) {
    if (style === 'conservative') return partnerLeading ? 0.024 : urgent ? -0.012 : 0.006;
    if (style === 'aggressive') return partnerLeading ? 0.004 : -0.018;
    return partnerLeading ? 0.018 : urgent ? -0.018 : 0;
  }
  const bomb = isBomb(play);
  const wilds = play.cards.filter((card) => isWild(card, level)).length;
  const controls = play.cards.filter((card) => val(card, level) >= 15).length / play.cards.length;
  const tempo = play.cards.length / Math.max(1, hand.length);
  if (style === 'aggressive')
    return 0.012 + 0.026 * tempo + (bomb ? 0.012 : 0) - (partnerLeading ? 0.03 : 0);
  if (style === 'conservative')
    return (
      0.012 * tempo -
      (bomb && !urgent ? 0.028 : 0) -
      0.012 * controls -
      0.006 * wilds -
      (partnerLeading ? 0.018 : 0)
    );
  let score = 0.012 * tempo - (partnerLeading ? 0.02 : 0);
  if (urgent && !partnerLeading) score += 0.014;
  // Sample-weighted evidence stays weak when a seat has barely responded.
  if (!trick)
    for (const seat of opponents) {
      const bucket = observed[seat].bySize[play.cards.length];
      if (!bucket) continue;
      const total = bucket.passes + bucket.responds;
      score += (0.018 * (bucket.passes - bucket.responds)) / (total + 6);
    }
  if (partnerLeading && counts[mate] <= 3) score -= 0.012;
  return score;
}

/** Styles only choose among actions close to the learned policy's best value. */
export function selectProfileAction(plays, values, requestedStyle, context) {
  if (
    plays.length !== values.length ||
    !plays.length ||
    values.some((value) => !Number.isFinite(value))
  )
    throw Error('Invalid policy scores');
  let best = 0;
  for (let index = 1; index < values.length; index++)
    if (values[index] > values[best]) best = index;
  const style = profileId(requestedStyle);
  if (style === 'balanced') return best;
  const observed = style === 'observant' ? observeResponses(context.log) : null;
  const floor = values[best] - 0.055;
  let chosen = best,
    score = -Infinity;
  for (let index = 0; index < plays.length; index++) {
    if (values[index] < floor) continue;
    const candidate = values[index] + preference(plays[index], style, context, observed);
    if (candidate > score) {
      score = candidate;
      chosen = index;
    }
  }
  return chosen;
}
