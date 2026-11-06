import { encodeTributeBatch } from './encoding.mjs';

/** Same action ordering/ties in Node and browser; no tactics or hidden information. */
export async function selectTribute(state, head, predict, baseline) {
  if (![0, 1].includes(head)) throw Error('Invalid specialist head');
  const { actions, rows } = encodeTributeBatch(state);
  if (actions.length === 1) return actions[0];
  const values = await predict(rows, actions.length);
  if (values.length !== actions.length * 2 || !Array.from(values).every(Number.isFinite))
    throw Error('Invalid specialist output');
  let chosen = actions.findIndex((id) => id % 54 === baseline % 54);
  if (chosen < 0) throw Error('Illegal baseline choice');
  for (let i = 0; i < actions.length; i++)
    if (values[i * 2 + head] > values[chosen * 2 + head] + 1e-6) chosen = i;
  return actions[chosen];
}
