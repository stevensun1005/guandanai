/** Fixed, preregistered 2v2 evaluation. No training or model selection occurs here. */
import * as ort from 'onnxruntime-node';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, freemem, setPriority } from 'node:os';
import { createTableInference } from '../../shared/simulation/table-inference.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { option, writeJSON } from '../training/continuous/lib.mjs';

export function roundCounts(result) {
  const counts = { rounds: 0, firsts: 0, doubleWins: 0, doubleLosses: 0, isolatedFirsts: 0 };
  const ranks = { 12: 0, 13: 0, 14: 0, 23: 0, 24: 0, 34: 0 };
  for (const round of result.history) {
    if (new Set(round.order).size !== 4 || round.order.some((p) => ![0, 1, 2, 3].includes(p)))
      throw Error('Invalid finishing order');
    const places = round.order.flatMap((p, index) =>
      p % 2 === result.neuralTeam ? [index + 1] : [],
    );
    const key = places.join('');
    if (!Object.hasOwn(ranks, key)) throw Error('Invalid team ranks');
    ranks[key]++;
    counts.rounds++;
    counts.firsts += Number(places[0] === 1);
    counts.doubleWins += Number(key === '12');
    counts.doubleLosses += Number(key === '34');
    counts.isolatedFirsts += Number(key === '14');
  }
  for (const key of ['rounds', 'doubleWins', 'doubleLosses', 'isolatedFirsts'])
    if (result.stats[key] !== counts[key]) throw Error(`Rollout/finishing-order mismatch: ${key}`);
  return { ...counts, ranks };
}

export async function runIndependent({ protocol, run, shard, shards = 2 }) {
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shard >= shards)
    throw Error('Invalid evaluation shard');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const planBytes = readFileSync(protocol);
  const plan = JSON.parse(planBytes);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const protocolSHA256 = hash(planBytes);
  for (const [file, fingerprint] of Object.entries(plan.sourceSHA256))
    if (hash(readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n')) !== fingerprint)
      throw Error(`Preregistered source changed: ${file}`);
  const model = join(run, 'models/deployed.onnx');
  if (hash(readFileSync(model)) !== plan.model.sha256) throw Error('Frozen model changed');
  if (plan.opponent !== 'original-rule' || plan.seeds.length !== 1000)
    throw Error('Unexpected registered experiment');
  if (new Set(plan.seeds).size !== plan.seeds.length) throw Error('Repeated match seeds');
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  mkdirSync(run, { recursive: true });
  const output = join(run, `worker-${shard}.jsonl`);
  const statusFile = join(run, `worker-${shard}.json`);
  const seeds = plan.seeds.filter((_, index) => index % shards === shard);
  const previous = existsSync(output)
    ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  for (let i = 0; i < previous.length; i++)
    if (previous[i].seed !== seeds[i] || previous[i].protocolSHA256 !== protocolSHA256)
      throw Error('Existing evaluation does not match the protocol');
  const inference = createTableInference({
    policy: model,
    config: plan.model.config,
    runtime: ort,
  });
  const startedAtUTC = new Date().toISOString();
  let completed = previous.length;
  const status = (phase) =>
    writeJSON(statusFile, {
      phase,
      pid: process.pid,
      shard,
      shards,
      protocolSHA256,
      startedAtUTC,
      updatedAtUTC: new Date().toISOString(),
      completedPairs: completed,
      plannedPairs: seeds.length,
      completedMatches: completed * 2,
      rssBytes: process.memoryUsage().rss,
    });
  try {
    await inference.session();
    status('running');
    for (const seed of seeds.slice(completed)) {
      while (freemem() < plan.resources.reserveGiB * 1024 ** 3) {
        status('waiting-for-memory');
        await new Promise((done) => setTimeout(done, 1000));
      }
      const games = [];
      for (const team of [0, 1]) {
        const result = await playMatch({
          seed,
          team,
          mode: 'rule',
          evaluate: true,
          tablePolicy: (game, player) => inference.decide(game, player, 'balanced'),
        });
        games.push({ ...result, cooperation: roundCounts(result) });
      }
      appendFileSync(output, JSON.stringify({ seed, protocolSHA256, games }) + '\n');
      completed++;
      status('running');
      if (completed % 10 === 0) console.log(`worker ${shard}: ${completed}/${seeds.length} pairs`);
    }
    status('complete');
  } catch (error) {
    status('failed');
    throw error;
  } finally {
    await inference.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  await runIndependent({
    protocol: resolve(option('protocol', '')),
    run: resolve(option('run', '')),
    shard: Number(option('shard', '0')),
    shards: Number(option('shards', '2')),
  });
