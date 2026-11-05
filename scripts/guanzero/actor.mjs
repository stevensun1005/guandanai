import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { playMatch } from '../lib/match-rollout.mjs';
import { seededRandom } from '../lib/simulation.mjs';
import {
  paths,
  readJSON,
  writeJSON,
  option,
  trainSeed,
  encodeRow,
  labels,
  writeShard,
  createInference,
  stopped,
} from './lib.mjs';
const p = paths(option('run', 'work/guanzero/guanzero-adp')),
  slot = Number(option('slot', '0'));
const config = readJSON(join(p.root, 'config.json'));
if (!config) throw Error('Start with GuanZero run.mjs');
trainSeed(slot, 0);
const file = join(p.actors, `actor-${slot}.json`),
  log = join(p.actors, `results-${slot}.jsonl`);
const status = { matches: 0, rows: 0, nextSeed: 0, ...readJSON(file, {}), slot, pid: process.pid };
const inference = await createInference();
let stopping = false;
process.on('SIGINT', () => (stopping = true));
process.on('SIGTERM', () => (stopping = true));
function save() {
  writeJSON(file, { ...status, updatedAt: new Date().toISOString() });
}
try {
  while (!stopping && !stopped(p)) {
    const count = status.nextSeed++,
      seed = trainSeed(slot, count),
      random = seededRandom((seed ^ config.seed) >>> 0);
    save(); // Reserve the seed before playing, including interrupted matches.
    let round = null;
    const rows = [];
    const versions = new Set();
    const result = await playMatch({
      seed,
      team: 0,
      mode: 'self',
      decide: async (state) => {
        if (state.match.round !== round) {
          if (stopping || stopped(p)) throw Error('GuanZero actor stopping');
          round = state.match.round;
          for (let attempt = 0; ; attempt++) {
            const latest = readJSON(join(p.models, 'latest.json'));
            try {
              await inference.load(join(p.models, latest.file));
              versions.add(latest.version);
              status.loadedModel = latest.version;
              break;
            } catch (error) {
              if (attempt >= 2 || error.code !== 'ENOENT') throw error;
            }
          }
        }
        const values = await inference.values(state);
        const greedy = values.reduce((best, v, i) => (v > values[best] ? i : best), 0);
        const index = random() < 0.01 ? Math.floor(random() * values.length) : greedy;
        rows.push({
          features: encodeRow(state, index),
          team: state.p % 2,
          round: state.match.round,
        });
        if (rows.length % 100 === 0) {
          status.currentRows = rows.length;
          save();
        }
        return { index };
      },
    });
    const shard = writeShard(p.shards, labels(rows, result), {
      slot,
      seed,
      models: [...versions],
      matches: 1,
    });
    status.matches++;
    status.rows += rows.length;
    status.currentRows = 0;
    save();
    appendFileSync(
      log,
      JSON.stringify({
        t: new Date().toISOString(),
        seed,
        shard,
        rows: rows.length,
        rounds: result.history.length,
        winner: result.winner,
      }) + '\n',
    );
    console.log(
      JSON.stringify({ kind: 'match', slot, seed, rows: rows.length, matches: status.matches }),
    );
    if (Number(option('matches', '0')) && status.matches >= Number(option('matches', '0'))) break;
  }
} catch (error) {
  if (!stopping && !stopped(p)) throw error;
} finally {
  save();
  await inference.close();
}
