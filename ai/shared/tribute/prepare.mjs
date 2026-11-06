/** One immutable, bounded Windows experiment; rerunning refuses to replace its protocol. */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { option } from '../../danMCai/training/continuous/lib.mjs';
import { resolveChampion } from './champion.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = resolve(option('run', 'ai/danMCai/runs/tribute-20261106'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sourceSHA256 = {};
for (const dir of [
  'ai/shared/tribute',
  'ai/shared/simulation',
  'web/src/core',
  'web/src/ai',
  'ai/danMCai/training/continuous',
]) {
  for (const entry of readdirSync(join(root, dir), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(mjs|js|py)$/.test(entry.name) || entry.name === 'dashboard.mjs')
      continue;
    const full = join(entry.parentPath || entry.path, entry.name);
    const relative = full.slice(root.length).replaceAll('\\', '/').replace(/^\//, '');
    sourceSHA256[relative] = sha(readFileSync(full, 'utf8').replaceAll('\r\n', '\n'));
  }
}
const catalog = JSON.parse(readFileSync(join(root, 'web/src/ai/model-catalog.json')));
const champion = resolveChampion(root, catalog);
const guanzero = catalog.models.filter((m) => m.config.history === 'guanzero-v1').at(-1);
if (!guanzero) throw Error('Missing GuanZero integration target');
const parentRun = option('inherit-run');
const parent = parentRun && JSON.parse(readFileSync(join(resolve(parentRun), 'progress.json')));
if (parent && !['awaiting-fusion', 'stopped'].includes(parent.stage))
  throw Error('Stop parent before changing protocol');
if (parent && Date.parse(parent.deadlineUTC) !== Date.parse('2026-11-06T13:00:00.000Z'))
  throw Error('Parent cutoff changed');
if (Date.now() >= Date.parse('2026-11-06T13:00:00.000Z'))
  throw Error('Training window has expired');
if (parent) {
  const raw = readFileSync(join(resolve(parentRun), 'progress.json'));
  writeFileSync(join(resolve(parentRun), 'progress-at-champion-transition.json'), raw, {
    flag: 'wx',
  });
}
const protocol = {
  schema: 1,
  protocolRevision: parent ? 2 : 1,
  experiment: 'tribute-20261106',
  kind: 'development-training',
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  deadlineUTC: '2026-11-06T13:00:00.000Z',
  deadlineEpochSeconds: 1793970000,
  timezone: 'America/Toronto',
  objective: 'completed-round signed upgrade points, centered within decision',
  encoding: 'public-tribute-389-v1',
  architecture: [389, 256, 128, 2],
  models: [champion, guanzero], // Named integration targets; not both training teachers.
  rolloutModels: [champion, champion],
  teacherPolicy: 'latest-verified-danMCai-champion-at-batch-start',
  ...(parent
    ? {
        lineage: {
          parentRun: resolve(parentRun),
          parentProtocolSHA256: sha(readFileSync(join(resolve(parentRun), 'protocol.json'))),
          previousProgress: parent,
          checkpointSHA256: sha(readFileSync(join(resolve(parentRun), 'learner/latest.pt'))),
        },
        progressMirror: join(resolve(parentRun), 'progress.json'),
      }
    : {}),
  heads: ['danMCai', 'GuanZero'],
  provider: 'dml',
  delayMs: 0,
  seedAllocation: {
    smoke: [3799000000, 3799999999],
    train: [3800000000, 3899999999],
    development: [3900000000, 3999999999],
    independent: [4000000000, 4000000127],
  },
  independentProtocol: {
    pairsPerHead: 128,
    team: 'two specialist-equipped bots versus two identical frozen teachers with historical original tribute',
    seatSwap: true,
    metric: 'signed upgrade-point difference per seed pair',
    acceptance:
      'both head mean differences >= 0, at least one > 0, and both lower 95% seed-cluster bootstrap confidence limits >= 0; otherwise preserve current web behavior',
    scope: 'single complete round; not full match through A',
  },
  resources: { samplers: 1, nativeThreads: 1, priority: 'below-normal', minimumFreeGiB: 4 },
  finalizeRoot: resolve(option('finalize-root', root)),
  sourceSHA256,
};
if (Date.parse(protocol.deadlineUTC) / 1000 !== protocol.deadlineEpochSeconds)
  throw Error('Deadline mismatch');
mkdirSync(run, { recursive: true });
writeFileSync(join(run, 'protocol.json'), JSON.stringify(protocol, null, 2) + '\n', { flag: 'wx' });
if (parent) {
  writeFileSync(
    join(run, 'progress.json'),
    JSON.stringify(
      {
        iteration: parent.iteration,
        trainSeeds: parent.trainSeeds,
        developmentSeeds: parent.developmentSeeds,
        trainingGroups: 0,
        developmentGroups: 0,
        rows: 0,
        completedCounterfactualRounds: 0,
        skippedCases: 0,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  execFileSync(
    option('python', 'python'),
    [join(root, 'ai/shared/tribute/inherit.py'), `--run=${run}`],
    { stdio: 'inherit' },
  );
}
console.log(
  JSON.stringify({
    run,
    deadline: protocol.deadlineUTC,
    sourceFiles: Object.keys(sourceSHA256).length,
  }),
);
