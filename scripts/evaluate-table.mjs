import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from '../src/ai/models.mjs';
import { BOT_PROFILES } from '../src/ai/profiles.js';
import { playMatch } from './lib/match-rollout.mjs';
import { createTableInference } from './lib/table-inference.mjs';

const root = new URL('../', import.meta.url);
const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const pairs = Number(option('pairs', '1000'));
const seed = Number(option('seed', '73000104'));
const styles = option('styles', 'balanced').split(',');
const opponent = option('opponent', 'rule');
const policy = resolve(option('policy', fileURLToPath(new URL('ai/policy.onnx', root))));
const configPath = option('config', '');
const config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : MODELS.policy;
const output = resolve(option('output', 'work/validation/table-evaluation.json'));
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  pairs > 100000 ||
  !Number.isSafeInteger(seed) ||
  seed < 0 ||
  seed + pairs > 2 ** 32 ||
  !['rule', 'balanced'].includes(opponent) ||
  new Set(styles).size !== styles.length ||
  styles.some((id) => !BOT_PROFILES.some((profile) => profile.id === id))
)
  throw Error('Invalid table evaluation configuration');
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const sourceHash = async (file) =>
  createHash('sha256')
    .update((await readFile(file, 'utf8')).replaceAll('\r\n', '\n'))
    .digest('hex');
const sources = ['scripts/evaluate-table.mjs'];
for (const directory of ['src/', 'scripts/lib/'])
  for (const file of await readdir(new URL(directory, root), { recursive: true }))
    if (/\.m?js$/.test(file)) sources.push(directory + file.replaceAll('\\', '/'));
sources.sort();
const runtimePackage = JSON.parse(
  await readFile(new URL('node_modules/onnxruntime-web/package.json', root), 'utf8'),
);
const tested = createTableInference({ policy, config });
const baseline = opponent === 'balanced' ? createTableInference() : null;
const report = {
  schema: 1,
  purpose: 'development',
  pipeline: 'Shared table preparation + Worker decision function; Node browser WASM runtime',
  limitations: [
    'Not a browser UI/network test or a final held-out acceptance.',
    'Tribute choices use the existing automatic policies; no human tribute decisions.',
    'Endgame wall-clock budgets and floating-point ties can vary across machines.',
    'Intervals are per style; no multiple-comparison correction or repeated-peeking guarantee.',
  ],
  metric: 'Whole-match team wins / all matches; draws included',
  rules: { tribute: true, aFail: 'draw', from: 2, through: 'A' },
  seed,
  pairs,
  opponent,
  config,
  modelSHA256: await hash(policy),
  responseSHA256: await hash(new URL('ai/response.onnx', root)),
  ...(baseline ? { opponentSHA256: await hash(new URL('ai/policy.onnx', root)) } : {}),
  sourceSHA256: Object.fromEntries(
    await Promise.all(sources.map(async (file) => [file, await sourceHash(new URL(file, root))])),
  ),
  sourceHashConvention: 'UTF-8 source text with CRLF normalized to LF; model hashes use raw bytes',
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    runtime: 'onnxruntime-web',
    version: runtimePackage.version,
  },
  results: [],
};
await mkdir(dirname(output), { recursive: true });
const warmup = performance.now();
try {
  await tested.session();
  if (baseline) await baseline.session();
  report.warmupSeconds = (performance.now() - warmup) / 1000;
  const started = performance.now();
  for (const style of styles) {
    const results = [];
    for (let pair = 0; pair < pairs; pair++) {
      const games = [];
      for (const team of [0, 1]) {
        const game = await playMatch({
          seed: seed + pair,
          team,
          mode: opponent === 'rule' ? 'rule' : 'self',
          evaluate: true,
          tablePolicy: (game, player) =>
            player % 2 === team
              ? tested.decide(game, player, style)
              : baseline.decide(game, player, 'balanced'),
        });
        games.push(game);
      }
      results.push({ seed: seed + pair, games });
      if ((pair + 1) % 10 === 0) console.log(`${style}: ${pair + 1}/${pairs} paired seeds`);
    }
    const games = results.flatMap((pair) => pair.games);
    const wins = games.filter((game) => game.winner === game.neuralTeam).length;
    const draws = games.filter((game) => game.winner === null).length;
    const mean = wins / games.length;
    const radius = Math.sqrt(Math.log(40) / (2 * pairs));
    report.results.push({
      style,
      matches: games.length,
      wins,
      losses: games.length - wins - draws,
      draws,
      winRate: mean,
      seedClusterHoeffding95: [Math.max(0, mean - radius), Math.min(1, mean + radius)],
      roundPointsMean:
        games.reduce(
          (sum, game) =>
            sum +
            game.history.reduce(
              (total, round) => total + (round.team === game.neuralTeam ? round.up : -round.up),
              0,
            ),
          0,
        ) / games.reduce((sum, game) => sum + game.history.length, 0),
      results,
    });
    report.elapsedSeconds = (performance.now() - started) / 1000;
    report.stats = {
      tested: { ...tested.stats },
      ...(baseline ? { baseline: { ...baseline.stats } } : {}),
    };
    report.testedInferenceDecisionsPerSecond = tested.stats.inferences / report.elapsedSeconds;
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(
      JSON.stringify({
        style,
        wins,
        losses: games.length - wins - draws,
        draws,
        matches: games.length,
      }),
    );
  }
} finally {
  await tested.close();
  if (baseline) await baseline.close();
}
