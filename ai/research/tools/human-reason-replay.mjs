/** Synthetic reasoning decisions labelled only by the completed single-round result. */
import { appendFileSync, existsSync } from 'node:fs';
import { constants, freemem, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import * as ort from 'onnxruntime-node';
import {
  BAND,
  buildActorProtocol,
  createActorConfig,
  labelRound,
  playActorRound,
} from '../../danMCai/training/continuous/search-actor.mjs';
import {
  option,
  readJSON,
  sha256,
  ShardWriter,
  writeJSON,
} from '../../danMCai/training/continuous/lib.mjs';

const root = resolve(option('run', ''));
const protocol = readJSON(join(root, 'protocol.json'));
const plan = protocol.reasonReplay;
const train = join(root, 'training');
const shards = join(train, 'shards');
const deadline = Date.parse(protocol.trainingDeadlineUTC);
const stopped = () =>
  Date.now() >= deadline || existsSync(join(root, 'STOP')) || existsSync(join(train, 'STOP'));
const statusFile = join(root, 'reason-replay-status.json');
const status = {
  phase: 'starting',
  completedRounds: 0,
  publishedRows: 0,
  fallbacks: 0,
  deviations: 0,
};
const save = () => writeJSON(statusFile, { ...status, updatedAtUTC: new Date().toISOString() });

if (
  existsSync(statusFile) ||
  sha256(join(root, 'protocol.json')) !== readJSON(join(root, 'registration.json')).protocolSHA256
)
  throw Error('Closed or changed reason replay registration');
setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
save();
const teacher = buildActorProtocol({
  ...plan.settings,
  start: Math.min(...plan.seeds),
  rounds: plan.seeds.length,
  champion: protocol.initialModel,
  'allow-champion': '1',
  belief: protocol.evaluationModels.belief.localFile,
});
if (
  teacher.championSHA256 !== protocol.initialModelSHA256 ||
  teacher.beliefSHA256 !== protocol.evaluationModels.belief.sha256
)
  throw Error('Reason teacher identity changed');
const writer = new ShardWriter(shards, 'reason-replay');
let config;
try {
  while ((!existsSync(shards) || freemem() < 5 * 1024 ** 3) && !stopped()) await wait(1000);
  if (!stopped()) {
    config = await createActorConfig(teacher, ort);
    for (const seed of plan.seeds) {
      while (freemem() < 5 * 1024 ** 3 && !stopped()) {
        status.phase = 'memory-paused';
        save();
        await wait(5000);
      }
      if (stopped()) break;
      status.phase = 'running';
      const round = await playActorRound(seed, config);
      if (stopped()) break;
      const searched = round.rows.filter((row) => row.band !== BAND.above);
      const labelled = labelRound(searched, round.result).map(({ features, targets }) => ({
        features,
        targets,
      }));
      if (labelled.length) {
        writer.add(labelled, teacher.championSHA256.slice(0, 16));
        writer.flush({
          actorImplementation: 'reason-replay',
          seed,
          winner: round.result.winner,
          points: round.result.points,
          beliefSHA256: teacher.beliefSHA256,
          championSHA256: teacher.championSHA256,
          fallbacks: round.stats.endgameFallbacks,
        });
      }
      status.completedRounds++;
      status.publishedRows += labelled.length;
      status.fallbacks += round.stats.endgameFallbacks;
      status.deviations += round.stats.differs + round.stats.endgameDiffers;
      appendFileSync(
        join(root, 'results-reason-replay.jsonl'),
        JSON.stringify({
          seed,
          rows: labelled.length,
          winner: round.result.winner,
          points: round.result.points,
          fallbacks: round.stats.endgameFallbacks,
        }) + '\n',
      );
      save();
      global.gc?.();
    }
  }
  status.phase = stopped() ? 'stopped' : 'complete';
} catch (error) {
  status.phase = 'failed';
  status.error = String(error);
  throw error;
} finally {
  if (config) await config.close();
  save();
}
