/**
 * Solver-labelled endgame actor (one process per slot).
 *
 * Plays single rounds from fresh deals. Above the endgame threshold every decision is the frozen
 * champion's greedy choice. At or below it, each real decision (not a finishing move, more than one
 * candidate) is labelled for EVERY candidate with the average exact value over sampled worlds:
 *
 *   Q(s, a) = mean over K worlds w ~ uniform deals of the unseen cards consistent with the mover's
 *             public information (own hand, cards played, hand counts) of the exact perfect-
 *             information team-minimax value of a in w, in the mover team's signed round points.
 *
 * This is perfect-information Monte Carlo (PIMC): the target is still the final round result under
 * best play (no trick, tempo or bomb proxy), averaged over what the mover cannot see, so the
 * network is not taught moves that only work with all hands visible. It is an approximation: the
 * uniform belief ignores what the opponents' earlier plays reveal, and averaging perfect-information
 * values still overrates information the mover will only learn later (strategy fusion).
 * The actual hidden hands are used only for a descriptive diagnostic, never for a label.
 *
 * The next move is the PIMC-best candidate with probability `followLabel`, otherwise a softmax over
 * the champion's values, so the recorded positions cover both well-played and champion-like
 * endgames. Each row is (567 public features of state+candidate, 162 zero oracle features, Q).
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { createRound, advanceRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { sampleWorlds } from '../../shared/search/belief.mjs';
import { searchObservation } from '../../shared/search/pimc.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { makeDeck } from '../../../web/src/core/cards.js';
import {
  FEATURES,
  argmax,
  createModelPool,
  encodeSample,
  explore,
  readJSON,
  writeJSON,
} from '../training/continuous/lib.mjs';
import { ORACLE } from './actor.mjs';
import { createSolver, SolverBudget } from './solver.mjs';
import { isMain } from './platform.mjs';

const deck = makeDeck();
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);
const forMover = (team0Value, seat) => (seat % 2 === 0 ? team0Value : -team0Value);

const positionOf = (game, hands) => ({
  hands,
  L: game.L,
  turn: game.turn,
  trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
  passes: game.passes,
  out: game.out.slice(),
});

/** Exact mover-team value of every candidate in one world, or null when over budget. */
function worldValues(solver, position, plays) {
  try {
    return plays.map((play) => forMover(solver.actionValue(position, play), position.turn));
  } catch (error) {
    if (!(error instanceof SolverBudget)) throw error;
    return null;
  }
}

/**
 * PIMC label for every candidate of the current decision. Returns null when fewer than
 * `minWorlds` worlds were solved inside the budget (the decision is then not recorded).
 */
export function labelDecision(game, plays, { solver, worlds, minWorlds, seed }) {
  const observation = searchObservation(game, game.turn);
  const sums = new Float64Array(plays.length);
  let used = 0;
  for (const hands of sampleWorlds(observation, { count: worlds, seed })) {
    const values = worldValues(
      solver,
      positionOf(
        game,
        hands.map((hand) => hand.map((id) => deck[id])),
      ),
      plays,
    );
    if (!values) continue;
    values.forEach((v, i) => (sums[i] += v));
    used++;
  }
  if (used < minWorlds) return { q: null, used };
  return { q: Array.from(sums, (s) => s / used), used };
}

/**
 * Play one round; `decide(file, state)` returns champion values. With a fixed decide() the round
 * is deterministic per seed. Returns recorded rows and descriptive statistics.
 */
export async function playRound(
  seed,
  {
    decide,
    champion,
    solver,
    threshold,
    worlds,
    minWorlds,
    temperature,
    followLabel,
    random = seededRandom(seed ^ 0x51c3a7e5),
  },
) {
  const game = createRound(seed);
  const rows = [];
  const stats = {
    decisions: 0,
    skipped: 0,
    worldsUsed: 0,
    trueChecked: 0,
    labelBestTrueOptimal: 0,
    championTrueOptimal: 0,
    labelBestTrueRegret: 0,
    championTrueRegret: 0,
  };
  for (let ply = 0; ply < 1000; ply++) {
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const state = policyState(game, player, 0, plays);
      const values = await decide(champion, state);
      const championIndex = argmax(values);
      index = championIndex;
      if (remaining(game) <= threshold) {
        const label = labelDecision(game, plays, {
          solver,
          worlds,
          minWorlds,
          seed: (seed * 1009 + ply * 7919) >>> 0,
        });
        stats.worldsUsed += label.used;
        if (label.q) {
          stats.decisions++;
          const best = argmax(label.q);
          for (let i = 0; i < plays.length; i++)
            rows.push({
              x: encodeSample(state, state.actions[i]),
              y: label.q[i],
              cards: remaining(game),
            });
          // Diagnostic only: how the label's best move and the champion fare in the true deal.
          const truth = worldValues(solver, positionOf(game, game.hands), plays);
          if (truth) {
            const top = Math.max(...truth);
            stats.trueChecked++;
            stats.labelBestTrueOptimal += Number(truth[best] === top);
            stats.championTrueOptimal += Number(truth[championIndex] === top);
            stats.labelBestTrueRegret += top - truth[best];
            stats.championTrueRegret += top - truth[championIndex];
          }
          index =
            random() < followLabel
              ? best
              : explore(values, { type: 'softmax', temperature }, random).index;
        } else stats.skipped++;
      }
    }
    const result = advanceRound(game, plays[index]);
    if (result) return { rows, result, stats, plies: ply + 1 };
  }
  throw Error('Round did not terminate');
}

function writeShard(dir, name, rows, meta) {
  const x = new Int8Array(rows.length * FEATURES),
    o = new Int8Array(rows.length * ORACLE),
    y = new Float32Array(rows.length);
  rows.forEach((row, i) => {
    x.set(row.x, i * FEATURES);
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
  if (!config || !Number.isInteger(slot))
    throw Error('Usage: pimc-actor.mjs --run=<dir> --slot=<n>');
  const {
    threshold,
    temperature,
    shardRows,
    worlds,
    minWorlds,
    followLabel,
    solver: budget,
  } = config.actor;
  const blocks = Array.isArray(config.actor.slotSeeds[slot][0])
    ? config.actor.slotSeeds[slot]
    : [config.actor.slotSeeds[slot]];
  const advance = (seed) => {
    const index = blocks.findIndex(([start, end]) => seed >= start && seed < end);
    if (index < 0) throw Error(`Seed ${seed} outside reserved blocks`);
    return seed + 1 < blocks[index][1] ? seed + 1 : (blocks[index + 1]?.[0] ?? Infinity);
  };
  const statePath = join(run, 'actors', `slot-${slot}.json`);
  mkdirSync(join(run, 'actors'), { recursive: true });
  mkdirSync(join(run, 'shards'), { recursive: true });
  const saved = readJSON(statePath, { nextSeed: blocks[0][0], shards: 0, rounds: 0, rows: 0 });
  if (saved.nextSeed === null) saved.nextSeed = Infinity;
  saved.totals ||= {};
  const pool = await createModelPool(ort, { threads: 1, limit: 2 });
  const decide = (file, state) => pool.values(file, state);
  const solver = createSolver(budget);
  const deadline = Date.parse(config.deadline);
  let buffer = [],
    seeds = [],
    shardStats = {};
  const add = (into, stats) => {
    for (const [k, v] of Object.entries(stats)) into[k] = (into[k] || 0) + v;
  };
  const flush = () => {
    if (!buffer.length) return;
    const name = `s${slot}-${String(saved.shards).padStart(6, '0')}`;
    writeShard(join(run, 'shards'), name, buffer, {
      slot,
      seeds: [seeds[0], seeds.at(-1)],
      labels: 'pimc-mean',
      threshold,
      worlds,
      stats: shardStats,
      createdAt: new Date().toISOString(),
    });
    saved.shards++;
    saved.rows += buffer.length;
    add(saved.totals, shardStats);
    buffer = [];
    seeds = [];
    shardStats = {};
  };
  while (Number.isFinite(saved.nextSeed)) {
    if (existsSync(join(run, 'STOP')) || Date.now() >= deadline) break;
    const seed = saved.nextSeed;
    const round = await playRound(seed, {
      decide,
      champion: config.champion.file,
      solver,
      threshold,
      worlds,
      minWorlds,
      temperature,
      followLabel,
    });
    buffer.push(...round.rows);
    add(shardStats, round.stats);
    seeds.push(seed);
    saved.nextSeed = advance(seed);
    saved.rounds++;
    if (buffer.length >= shardRows) {
      flush();
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
