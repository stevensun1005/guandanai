import { readJSON, sha256, TRAIN_SEED_BASE, TRAIN_SEED_SPAN } from './lib.mjs';

/** Pre-audited sparse roots avoid historical deals without changing legacy sequences. */
export function actorSeedReader(config, slot) {
  const reservation = config.actorSeedList;
  if (!reservation) return (index) => TRAIN_SEED_BASE + slot * TRAIN_SEED_SPAN + index;
  if (sha256(reservation.file) !== reservation.sha256) throw Error('Actor seed list changed');
  const all = readJSON(reservation.file).seeds;
  const n = reservation.perSlot,
    seeds = all.slice(slot * n, (slot + 1) * n);
  if (
    !Number.isInteger(n) ||
    n < 1 ||
    seeds.length !== n ||
    new Set(seeds).size !== n ||
    !seeds.every((s) => Number.isInteger(s) && s >= 0 && s < 2 ** 32)
  )
    throw Error('Invalid reserved actor roots');
  return (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= n)
      throw Error('Reserved actor roots exhausted');
    return seeds[index];
  };
}
