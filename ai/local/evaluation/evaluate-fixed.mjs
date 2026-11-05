/** Fixed whole-match comparisons with two identical models on each team. */
import * as ort from 'onnxruntime-node';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, freemem, setPriority } from 'node:os';
import { createTableInference } from '../../shared/simulation/table-inference.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { option, writeJSON } from '../training/continuous/lib.mjs';
import { roundCounts } from './evaluate-independent.mjs';

export function fixedLineup(opponent, team, champion, latest) {
  if (!['clint-rule', 'latest-model'].includes(opponent) || ![0, 1].includes(team))
    throw Error('Invalid fixed comparison');
  return {
    team,
    mode: opponent === 'clint-rule' ? 'rule' : 'self',
    ruleVersion: 'rules-v2',
    evaluate: true,
    tablePolicy: (game, player) => {
      if (player % 2 === team) return champion.decide(game, player, 'balanced');
      if (opponent !== 'latest-model' || !latest)
        throw Error('Clint must use its independent rule path');
      return latest.decide(game, player, 'balanced');
    },
  };
}
export async function runFixed({ protocol, run, shard = 0, shards = 1 }) {
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 0 || shard >= shards)
    throw Error('Invalid shard');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const bytes = readFileSync(protocol),
    plan = JSON.parse(bytes);
  const hash = (v) => createHash('sha256').update(v).digest('hex'),
    protocolSHA256 = hash(bytes);
  for (const [path, sha] of Object.entries(plan.sourceSHA256))
    if (hash(readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n')) !== sha)
      throw Error('Frozen source changed: ' + path);
  if (
    !['clint-rule', 'latest-model'].includes(plan.opponent) ||
    !plan.seeds.length ||
    new Set(plan.seeds).size !== plan.seeds.length
  )
    throw Error('Invalid fixed protocol');
  const load = (model, name) => {
    const file = join(run, 'models', name + '.onnx');
    if (hash(readFileSync(file)) !== model.sha256) throw Error('Frozen model changed: ' + name);
    return createTableInference({ policy: file, config: model.config, runtime: ort });
  };
  while (freemem() < plan.resources.reserveGiB * 1024 ** 3)
    await new Promise((r) => setTimeout(r, 1000));
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
  const champion = load(plan.model, 'champion'),
    latest = plan.opponentModel ? load(plan.opponentModel, 'latest') : null;
  mkdirSync(run, { recursive: true });
  const output = join(run, `worker-${shard}.jsonl`),
    statusFile = join(run, `worker-${shard}.json`);
  const seeds = plan.seeds.filter((_, i) => i % shards === shard);
  const previous = existsSync(output)
    ? readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
  for (let i = 0; i < previous.length; i++)
    if (previous[i].seed !== seeds[i] || previous[i].protocolSHA256 !== protocolSHA256)
      throw Error('Resume protocol mismatch');
  const startedAtUTC = new Date().toISOString();
  let completed = previous.length;
  const status = (phase, error = null) =>
    writeJSON(statusFile, {
      phase,
      error,
      pid: process.pid,
      shard,
      shards,
      protocolSHA256,
      startedAtUTC,
      updatedAtUTC: new Date().toISOString(),
      completedPairs: completed,
      plannedPairs: seeds.length,
      completedMatches: completed * 2,
      plannedMatches: seeds.length * 2,
      rssBytes: process.memoryUsage().rss,
      opponent: plan.opponent,
      model: plan.model.version,
      opponentVersion: plan.opponentModel?.version || 'Clint-rules-v2',
    });
  try {
    await champion.session();
    if (latest) await latest.session();
    status('running');
    for (const seed of seeds.slice(completed)) {
      while (freemem() < plan.resources.reserveGiB * 1024 ** 3 || existsSync(join(run, 'PAUSE'))) {
        status('waiting-for-memory');
        await new Promise((r) => setTimeout(r, 1000));
      }
      const games = [];
      for (const team of [0, 1]) {
        const result = await playMatch({
          seed,
          ...fixedLineup(plan.opponent, team, champion, latest),
        });
        games.push({ ...result, cooperation: roundCounts(result) });
      }
      appendFileSync(output, JSON.stringify({ seed, protocolSHA256, games }) + '\n');
      completed++;
      status('running');
      if (completed % 10 === 0)
        console.log(`${plan.opponent}: ${completed}/${seeds.length} complete seed pairs`);
    }
    status('complete');
  } catch (error) {
    status('failed', error.message);
    throw error;
  } finally {
    await champion.close();
    if (latest) await latest.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  await runFixed({
    protocol: resolve(option('protocol', '')),
    run: resolve(option('run', '')),
    shard: Number(option('shard', '0')),
    shards: Number(option('shards', '1')),
  });
