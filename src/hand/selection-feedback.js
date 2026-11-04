import { TYPE_NAME } from '../core/cards.js';
import { analyze, beats, strength } from '../core/combinations.js';
import { isReturnCard } from '../core/validation.js';
import { returnInstruction } from '../core/tribute.js';

export function selectionFeedback(
  cards,
  level,
  { mode = 'wait', current = null, tributeIds = [], confirm = false, hand = null } = {},
) {
  const count = cards.length;
  const result = (message, tone = 'neutral') => ({ message, tone, count });
  if (!count && mode === 'return' && hand) return result(returnInstruction(hand, level));
  if (!count)
    return result(
      {
        play: '轮到你：选牌或点提示',
        prep: '点牌选择，拖动理牌',
        return: '请选择一张合法的还贡牌',
        tribute: '请选择最大的非百搭牌',
        wait: '可以提前选牌',
      }[mode],
    );
  const prefix = `已选 ${count} 张`;
  if (mode === 'return')
    return count === 1 && isReturnCard(cards[0], level, hand)
      ? result(`${prefix} · 可以还贡`, 'ready')
      : result(
          `${prefix} · ${hand ? returnInstruction(hand, level) : '还贡需一张 10 或以下的非百搭牌'}`,
          'invalid',
        );
  if (mode === 'tribute')
    return count === 1 && tributeIds.includes(cards[0].id)
      ? result(`${prefix} · 可以进贡`, 'ready')
      : result(`${prefix} · 请选择最大的非百搭牌`, 'invalid');
  const readings = analyze(cards, level);
  if (!readings.length) return result(`${prefix} · 不成牌型`, 'invalid');
  const legal = readings.filter((shape) => beats(shape, current));
  const shape = (legal.length ? legal : readings)
    .slice()
    .sort((a, b) => strength(b) - strength(a))[0];
  const label = `${prefix} · ${TYPE_NAME[shape.type]}`;
  if (mode === 'prep') return result(`${label} · 可成组`);
  if (current && !legal.length)
    return result(`${label} · 当前压不过${TYPE_NAME[current.type]}`, 'invalid');
  return mode === 'play'
    ? result(`${label} · ${confirm ? '再次出牌确认' : '可以出牌'}`, 'ready')
    : result(`${label} · 已预选`);
}
