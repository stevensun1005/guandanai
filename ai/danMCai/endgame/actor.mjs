/**
 * Endgame oracle-guiding actor (one process per slot).
 *
 * Plays complete single rounds from fresh deals. Before the endgame threshold every decision is the
 * frozen champion's greedy choice; at or below it the current endgame student decides with
 * softmax exploration and the decision is recorded. Each row stores the public 567-feature sample
 * (exactly the deployed input), the other three seats' private hands as 162 oracle features that
 * only the learner sees, and the label: the decider team's final signed round points (±1/±2/±3).
 * No trick, tempo or bomb proxy is used as a label.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { createRound, advanceRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { cardsArray } from '../../../web/src/ai/encoding.mjs';
import {
  FEATURES,
  argmax,
  createModelPool,
  encodeSample,
  explore,
  readJSON,
  writeJSON,
} from '../training/continuous/lib.mjs';
import { isMain } from './platform.mjs';

export const ORACLE = 162;

const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** Other seats' hands relative to `player` (next, partner, previous), 54 counts each. */
export function oracleFeatures(game, player) {
  const row = new Int8Array(ORACLE);
  for (let k = 1; k <= 3; k++) {
    const counts = cardsArray(game.hands[(player + k) % 4].map((card) => card.id));
    for (let i = 0; i < 54; i++) row[(k - 1) * 54 + i] = counts[i];
  }
  return row;
}

/**
 * Play one round. `decide(file, state)` returns values. Returns recorded rows and the result.
 * Exported for tests: with a fixed decide() the round is deterministic per seed.
 */
export async function playRound(
  seed,
  { decide, champion, student, threshold, temperature, random = seededRandom(seed ^ 0x2545f491) },
) {
  const game = createRound(seed);
  const rows = [];
  let endgameDecisions = 0;
  for (let ply = 0; ply < 1000; ply++) {
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const state = policyState(game, player, 0, plays);
      const endgame = remaining(game) <= threshold;
      const values = await decide(endgame ? student : champion, state);
      if (endgame) {
        index = explore(values, { type: 'softmax', temperature }, random).index;
        rows.push({
          x: encodeSample(state, state.actions[index]),
          o: oracleFeatures(game, player),
          team: player % 2,
          cards: remaining(game),
        });
        endgameDecisions++;
      } else index = argmax(values);
    }
    const result = advanceRound(game, plays[index]);
    if (result) {
      for (const row of rows) row.y = row.team === result.winner ? result.points : -result.points;
      return { rows, result, endgameDecisions, plies: ply + 1 };
    }
  }
  throw Error('Round did not terminate');
}

function writeShard(dir, name, rows, meta) {
  const x = new Int8Array(rows.length * FEATURES),
    o = new Int8Array(rows.length * ORACLE),
    y = new Float32Array(rows.length);
  rows.forEach((row, i) => {
    x.set(row.x, i * FEATURES);
    o.set(row.o, i * ORACLE);
    y[i] = row.y;
  });
  const tmp = join(dir, `.${name}`);
  writeFileSync(tmp + '.x.i8', x);
  writeFileSync(tmp + '.o.i8', o);
  writeFileSync(tmp + '.y.f32', y);
  for (const ext of ['x.i8', 'o.i8', 'y.f32'])
    renameSync(`${tmp}.${ext}`, join(dir, `${name}.${ext}`));
  writeJSON(join(dir, `${name}.json`), { ...meta, rows: rows.length });
}

async function main() {
  const option = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const run = option('run'),
    slot = Number(option('slot'));
  const config = readJSON(join(run, 'config.json'));
  if (!config || !Number.isInteger(slot)) throw Error('Usage: actor.mjs --run=<dir> --slot=<n>');
  const { threshold, temperature, shardRows } = config.actor;
  // A slot owns one [start, end) block or a list of audited blocks, consumed in order.
  const blocks = Array.isArray(config.actor.slotSeeds[slot][0])
    ? config.actor.slotSeeds[slot]
    : [config.actor.slotSeeds[slot]];
  const seedStart = blocks[0][0];
  const advance = (seed) => {
    const index = blocks.findIndex(([start, end]) => seed >= start && seed < end);
    if (index < 0) throw Error(`Seed ${seed} outside reserved blocks`);
    return seed + 1 < blocks[index][1] ? seed + 1 : (blocks[index + 1]?.[0] ?? Infinity);
  };
  const statePath = join(run, 'actors', `slot-${slot}.json`);
  mkdirSync(join(run, 'actors'), { recursive: true });
  mkdirSync(join(run, 'shards'), { recursive: true });
  const saved = readJSON(statePath, { nextSeed: seedStart, shards: 0, rounds: 0, rows: 0 });
  if (saved.nextSeed === null) saved.nextSeed = Infinity;
  const pool = await createModelPool(ort, { threads: 1, limit: 4 });
  const decide = (file, state) => pool.values(file, state);
  const deadline = Date.parse(config.deadline);
  let buffer = [],
    seeds = [];
  const flush = (student) => {
    if (!buffer.length) return;
    const name = `s${slot}-${String(saved.shards).padStart(6, '0')}`;
    writeShard(join(run, 'shards'), name, buffer, {
      slot,
      seeds: [seeds[0], seeds.at(-1)],
      student,
      threshold,
      temperature,
      createdAt: new Date().toISOString(),
    });
    saved.shards++;
    saved.rows += buffer.length;
    buffer = [];
    seeds = [];
  };
  while (Number.isFinite(saved.nextSeed)) {
    if (existsSync(join(run, 'STOP')) || Date.now() >= deadline) break;
    const latest = readJSON(join(run, 'models', 'latest.json'));
    const student = join(run, 'models', latest.file);
    const seed = saved.nextSeed;
    const round = await playRound(seed, {
      decide,
      champion: config.champion.file,
      student,
      threshold,
      temperature,
    });
    buffer.push(...round.rows);
    seeds.push(seed);
    saved.nextSeed = advance(seed);
    saved.rounds++;
    if (buffer.length >= shardRows) {
      flush(latest.version);
      saved.updatedAt = new Date().toISOString();
      writeJSON(statePath, saved);
    }
  }
  // Unflushed rows from the last partial shard are discarded; their seeds are re-played next start.
  if (buffer.length) saved.nextSeed = seeds[0];
  if (!Number.isFinite(saved.nextSeed)) saved.nextSeed = null;
  saved.updatedAt = new Date().toISOString();
  saved.stopped = true;
  writeJSON(statePath, saved);
  await pool.close();
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
