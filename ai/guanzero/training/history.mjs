// Replay copied verbatim from encoding.mjs; parity is checked against encode().
import { cardsArray } from '../../../web/src/ai/encoding.mjs';
export function replay(log) {
  const histories = [[], [], [], []],
    sequence = [],
    out = [],
    remaining = [27, 27, 27, 27];
  let flag = 1;
  const append = (p, cards) => {
    histories[p].push(cards);
    sequence.push(cards);
  };
  for (const e of log) {
    const p = e.p,
      cards = e.cards || [];
    append(p, cards);
    if (out.length === 1) {
      if (cards.length && flag === 1) {
        flag = 2;
        if (p === (out[0] + 3) % 4) append(out[0], [-1]);
      } else if (flag === 1 && (p + 1) % 4 === out[0]) {
        flag = 2;
        append(out[0], [-1]);
        append((p + 2) % 4, []);
      } else if (p === (out[0] + 3) % 4 && flag === 2) append(out[0], [-1]);
    } else if (out.length === 2) {
      if (cards.length && flag <= 2) {
        flag = 3;
        if (out.includes((p + 1) % 4)) {
          append((p + 1) % 4, [-1]);
          append((p + 2) % 4, [-1]);
        }
      } else if (flag <= 2 && out.includes((p + 1) % 4)) {
        flag = 3;
        append((p + 1) % 4, [-1]);
        append((p + 2) % 4, [-1]);
        if (p === (out.at(-1) + 2) % 4) append((p + 3) % 4, []);
      } else if (out.includes((p + 1) % 4) && flag === 3) {
        append((p + 1) % 4, [-1]);
        append((p + 2) % 4, [-1]);
      }
    }
    remaining[p] -= cards.length;
    if (remaining[p] === 0 && !out.includes(p)) out.push(p);
  }
  return { histories, sequence, out };
}

export function history(state) {
  const sequence = replay(state.log).sequence.slice(-20);
  const padded = [...Array.from({ length: 20 - sequence.length }, () => []), ...sequence];
  const result = new Int8Array(1080);
  padded.forEach((cards, i) => result.set(cardsArray(cards), i * 54));
  return result;
}
