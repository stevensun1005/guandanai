/** Continuous self-play actor: plays complete matches with the newest model and writes sample shards. */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { playMatch } from '../../../shared/simulation/match-rollout.mjs';
import { actorSeedReader } from './actor-seeds.mjs';
import { seededRandom } from '../../../shared/simulation/simulation.mjs';
import {
  MAX_ACTORS,
  ShardWriter,
  TRAIN_SEED_SPAN,
  createModelPool,
  encodeSample,
  explore,
  labelMatch,
  option,
  pfspWeights,
  readJSON,
  runPaths,
  sample,
  writeJSON,
} from './lib.mjs';

const paths = runPaths(option('run', 'ai/danMCai/runs/main'));
const slot = Number(option('slot', '0'));
const matchLimit = Number(option('matches', '0'));
if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ACTORS) throw Error('Invalid actor slot');
const config = readJSON(paths.config);
const nextRoot = actorSeedReader(config, slot);
if (!config) throw Error(`Missing ${paths.config}; start the run with supervisor.mjs`);

const statusFile = join(paths.actors, `actor-${slot}.json`);
const resultsFile = join(paths.actors, `results-${slot}.jsonl`);
const previous = readJSON(statusFile, {});
const status = {
  slot,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  matches: previous.matches || 0,
  decisions: previous.decisions || 0,
  rows: previous.rows || 0,
  shardSequence: previous.shardSequence || 0,
  nextSeed: previous.nextSeed ?? config.actorSeedOffset ?? 0,
  failures: previous.failures || 0,
  recent: { since: Date.now(), decisions: 0, matches: 0 },
};
if (!Number.isInteger(status.nextSeed) || status.nextSeed < 0 || status.nextSeed >= TRAIN_SEED_SPAN)
  throw Error('Actor seed block exhausted or invalid');
const writer = new ShardWriter(
  paths.shards,
  `a${String(slot).padStart(2, '0')}`,
  status.shardSequence,
);
const pool = await createModelPool(ort, { threads: 1 });
const random = seededRandom((config.learner.seed ^ (slot * 0x9e3779b1)) >>> 0);
const mix = Object.entries(config.actorMix);

function chooseLineup() {
  let mode =
    mix[
      sample(
        mix.map(([, weight]) => weight),
        random,
      )
    ][0];
  const league = readJSON(paths.leagueMeta, { members: [], stats: {} });
  if (mode === 'league' && !league.members.length) mode = 'self';
  if (mode !== 'league') return { mode, opponent: mode };
  const member = league.members[sample(pfspWeights(league.members, league.stats), random)];
  return { mode: 'snapshot', opponent: member.id, file: join(paths.league, member.file) };
}

function flush() {
  const name = writer.flush({ actor: slot });
  status.shardSequence = writer.sequence;
  writeJSON(statusFile, { ...status, updatedAt: new Date().toISOString() });
  return name;
}

let stopping = false;
const stop = () => (stopping = true);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

while (
  !stopping &&
  !existsSync(paths.stop) &&
  (!matchLimit || status.matches < matchLimit) &&
  status.nextSeed < (config.actorSeedEnd ?? TRAIN_SEED_SPAN)
) {
  const latest = readJSON(paths.latest);
  if (!latest) throw Error('No latest model published');
  const model = join(paths.models, latest.file);
  const lineup = chooseLineup();
  const team = random() < 0.5 ? 0 : 1;
  const seed = nextRoot(status.nextSeed++);
  const rows = [];
  let decisions = 0;
  try {
    const result = await playMatch({
      seed,
      team,
      mode: lineup.mode,
      snapshotInfer: lineup.file ? (state) => pool.values(lineup.file, state) : null,
      decide: async (state) => {
        const values = await pool.values(model, state);
        const { index } = explore(values, config.exploration, random);
        rows.push({
          features: encodeSample(state, state.actions[index]),
          team: state.p % 2,
          round: state.match.round,
        });
        decisions++;
        return { index };
      },
    });
    writer.add(labelMatch(rows, result), latest.version);
    status.matches++;
    status.decisions += decisions;
    status.rows += rows.length;
    status.recent.decisions += decisions;
    status.recent.matches++;
    appendFileSync(
      resultsFile,
      JSON.stringify({
        t: Date.now(),
        model: latest.version,
        mode: lineup.mode === 'snapshot' ? 'league' : lineup.mode,
        opponent: lineup.opponent,
        team,
        winner: result.winner,
        rounds: result.stats.rounds,
        decisions,
        seed,
      }) + '\n',
    );
  } catch (error) {
    status.failures++;
    appendFileSync(
      resultsFile,
      JSON.stringify({ t: Date.now(), error: String(error?.message || error), seed }) + '\n',
    );
    if (status.failures > 20 && status.failures > status.matches / 10) throw error;
  }
  const age = (Date.now() - writer.started) / 1000;
  if (writer.rows >= config.shardRows || (writer.rows && age >= config.shardSeconds)) flush();
  else writeJSON(statusFile, { ...status, updatedAt: new Date().toISOString() });
}
flush();
await pool.close();
