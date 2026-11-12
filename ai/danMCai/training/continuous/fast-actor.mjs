/**
 * Fast continuous self-play actor: same lineups, exploration, labels, seeds and shard format as
 * actor.mjs, but it plays many matches at once in one process, scores all their pending
 * decisions as one GPU batch (DirectML, CPU fallback) and caches candidate generation.
 *
 *   node ai/danMCai/training/continuous/fast-actor.mjs --run=<run> --slot=<n> [--games=48] [--provider=dml]
 *                                           [--stop-file=<path>]
 *
 * It writes actor-<slot>.json / results-<slot>.jsonl / a<slot>-*.json exactly like actor.mjs, so
 * the supervisor's PFSP statistics, the learner and the reports read it unchanged. Shard
 * manifests and the status file record actorImplementation "fast" and the inference provider.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { actorSeedReader } from './actor-seeds.mjs';
import { seededRandom } from '../../../shared/simulation/simulation.mjs';
import { encodePolicyExtras } from '../../../../web/src/ai/policy-features.mjs';
import { beliefMarginals, createBeliefModel } from '../../belief/sampler.mjs';
import { createBatchedPool } from './batch-inference.mjs';
import { createCandidateCache } from './fast-candidates.mjs';
import { playMatchWith } from './fast-rollout.mjs';
import {
  MAX_ACTORS,
  ShardWriter,
  TRAIN_SEED_SPAN,
  encodeSample,
  explore,
  extrasWidth,
  labelMatch,
  option,
  pfspWeights,
  readJSON,
  runPaths,
  sample,
  sha256,
  writeJSON,
} from './lib.mjs';

const paths = runPaths(option('run', 'ai/danMCai/runs/main'));
const slot = Number(option('slot', '0'));
const games = Number(option('games', '48'));
const provider = option('provider', 'dml');
const matchLimit = Number(option('matches', '0'));
// Optional per-machine stop flag: finish current matches, flush shards, exit.
const stopFile = option('stop-file', '');
if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ACTORS) throw Error('Invalid actor slot');
if (!Number.isInteger(games) || games < 1 || games > 512) throw Error('Invalid concurrent games');
if (!['dml', 'cpu'].includes(provider)) throw Error('Provider must be dml or cpu');
const config = readJSON(paths.config);
const nextRoot = actorSeedReader(config, slot);
if (!config) throw Error(`Missing ${paths.config}; start the run with supervisor.mjs`);
const sessionLimit = Number(option('session-limit', config.fastActor?.sessionLimit ?? '6'));

const statusFile = join(paths.actors, `actor-${slot}.json`);
const resultsFile = join(paths.actors, `results-${slot}.jsonl`);
const previous = readJSON(statusFile, {});
const status = {
  slot,
  pid: process.pid,
  actorImplementation: 'fast',
  concurrentGames: games,
  sessionLimit,
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
  extrasWidth(config.extrasMode) || 53,
);
// 'public-belief': one belief-network call per decision (batched across this process's games),
// raked to 162 card-scale marginals that every candidate row of the decision shares.
let belief = null;
const beliefStats = { calls: 0, views: 0, ms: 0 };
if (config.extrasMode === 'public-belief') {
  if (!config.beliefModel) throw Error('extrasMode public-belief requires config.beliefModel');
  const file = resolve(config.beliefModel);
  const digest = sha256(file);
  if (config.beliefSHA256 && digest !== config.beliefSHA256)
    throw Error('Belief model changed since the run was frozen');
  belief = {
    model: await createBeliefModel(ort, file),
    sha256: digest,
    queue: [],
    scheduled: false,
  };
}
/** The mover's public view (belief/features.mjs publicView layout) from a policy state. */
const viewOf = (state) => ({
  p: state.p,
  hand: state.hand,
  counts: state.counts,
  level: state.level,
  log: state.context.log.map((e) =>
    e.cards?.length
      ? { p: e.p, cards: e.cards.map((card) => card.id), type: e.type, value: e.value, n: e.n }
      : { p: e.p, cards: null },
  ),
});
function marginalsOf(state) {
  if (!belief) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    belief.queue.push({ view: viewOf(state), resolve, reject });
    if (belief.scheduled) return;
    belief.scheduled = true;
    setImmediate(async () => {
      const jobs = belief.queue.splice(0);
      belief.scheduled = false;
      const t = performance.now();
      try {
        const rows = await beliefMarginals(
          belief.model,
          jobs.map((job) => job.view),
        );
        jobs.forEach((job, i) => job.resolve(rows[i]));
      } catch (error) {
        jobs.forEach((job) => job.reject(error));
      }
      beliefStats.calls++;
      beliefStats.views += jobs.length;
      beliefStats.ms += performance.now() - t;
    });
  });
}
const pool = await createBatchedPool(ort, { provider, sessionLimit });
const cache = createCandidateCache({ limit: 512 });
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

function saveStatus() {
  writeJSON(statusFile, {
    ...status,
    inference: { ...pool.stats },
    ...(belief ? { belief: { sha256: belief.sha256, ...beliefStats } } : {}),
    candidateCache: { ...cache.stats },
    memory: process.memoryUsage(),
    updatedAt: new Date().toISOString(),
  });
}

function flush() {
  writer.flush({
    actor: slot,
    actorImplementation: 'fast',
    provider: pool.stats.provider,
    ...(config.extrasMode ? { extrasMode: config.extrasMode } : {}),
    ...(belief ? { beliefSHA256: belief.sha256 } : {}),
  });
  status.shardSequence = writer.sequence;
  saveStatus();
}

let stopping = false;
const stop = () => (stopping = true);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
const running = () =>
  !stopping &&
  !existsSync(paths.stop) &&
  !(stopFile && existsSync(stopFile)) &&
  status.nextSeed < (config.actorSeedEnd ?? TRAIN_SEED_SPAN) &&
  (!matchLimit || status.matches < matchLimit);

let started = 0;
async function lane() {
  while (running() && (!matchLimit || started < matchLimit)) {
    started++;
    const latest = readJSON(paths.latest);
    if (!latest) throw Error('No latest model published');
    const model = join(paths.models, latest.file);
    const lineup = chooseLineup();
    const team = random() < 0.5 ? 0 : 1;
    const seed = nextRoot(status.nextSeed++);
    if (status.nextSeed >= TRAIN_SEED_SPAN) throw Error('Actor seed block exhausted');
    const rows = [];
    let decisions = 0;
    try {
      const result = await playMatchWith({
        seed,
        team,
        mode: lineup.mode,
        candidates: cache.candidates,
        // Snapshot opponents get the same extras as the learner seats (ignored by models
        // without an extras input).
        snapshotInfer: lineup.file
          ? config.extrasMode
            ? async (state) =>
                pool.values(lineup.file, state, config.extrasMode, await marginalsOf(state))
            : (state) => pool.values(lineup.file, state)
          : null,
        decide: async (state) => {
          const marginals = await marginalsOf(state);
          const values = await pool.values(model, state, config.extrasMode, marginals);
          const { index } = explore(values, config.exploration, random);
          let extras = null;
          if (config.extrasMode === 'public') extras = encodePolicyExtras(state, index);
          else if (config.extrasMode === 'public-belief') {
            extras = new Float32Array(extrasWidth('public-belief'));
            extras.set(encodePolicyExtras(state, index));
            extras.set(marginals, 53);
          } else if (config.extrasMode) extras = new Float32Array(53);
          rows.push({
            features: encodeSample(state, state.actions[index]),
            ...(extras ? { extras } : {}),
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
          actorImplementation: 'fast',
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
    else saveStatus();
  }
}

await Promise.all(Array.from({ length: games }, () => lane()));
flush();
await pool.close();
if (belief) await belief.model.close();
