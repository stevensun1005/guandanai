/** Independent paired COMPLETE-ROUND evaluation, never used to select training checkpoints. */
import * as ort from 'onnxruntime-node';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import { freemem } from 'node:os';
import { selectTribute } from './select.mjs';
import { seededRandom } from '../simulation/simulation.mjs';
import { readJSON, writeJSON, option } from '../../danMCai/training/continuous/lib.mjs';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');

export function summarize(rows) {
  const groups = new Map();
  const out = {
    rounds: rows.length,
    wins: 0,
    losses: 0,
    draws: 0,
    doubleUps: 0,
    doubleDowns: 0,
    signedPoints: 0,
  };
  for (const r of rows) {
    out[r.winner === r.side ? 'wins' : 'losses']++;
    const points = (r.winner === r.side ? 1 : -1) * r.points;
    out.signedPoints += points;
    if (r.order[0] % 2 === r.order[1] % 2)
      out[r.order[0] % 2 === r.side ? 'doubleUps' : 'doubleDowns']++;
    if (!groups.has(r.seed)) groups.set(r.seed, []);
    groups.get(r.seed).push(points);
  }
  const paired = [...groups.values()].map((xs) => {
    if (xs.length !== 2) throw Error('Incomplete seed pair');
    return (xs[0] + xs[1]) / 2;
  });
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  if (!paired.length) throw Error('No completed pairs');
  const rng = seededRandom(3799999900),
    boot = [];
  for (let b = 0; b < 10000; b++)
    boot.push(mean(paired.map(() => paired[Math.floor(rng() * paired.length)])));
  boot.sort((a, b) => a - b);
  return {
    ...out,
    pairs: paired.length,
    winRate: out.wins / out.rounds,
    meanPairedPoints: mean(paired),
    ci95: [boot[249], boot[9749]],
  };
}

export async function evaluate(
  run,
  { seedBase = 4000000000, pairs = 128, test = false, runtimeRoot = root } = {},
) {
  const protocol = readJSON(join(run, 'protocol.json')),
    best = readJSON(join(run, 'learner/best.json'));
  if (!protocol || !best) throw Error('No trained candidate');
  if (!test && Date.now() < Date.parse(protocol.deadlineUTC))
    throw Error('Independent evaluation is sealed until cutoff');
  if (!test)
    for (const [file, digest] of Object.entries(protocol.sourceSHA256))
      if (
        sha(Buffer.from(readFileSync(join(runtimeRoot, file), 'utf8').replaceAll('\r\n', '\n'))) !==
        digest
      )
        throw Error('Frozen evaluation source mismatch: ' + file);
  const { continuation } = await import(
    pathToFileURL(join(runtimeRoot, 'ai/shared/tribute/neural.mjs')).href
  );
  const { scenario } = await import(
    pathToFileURL(join(runtimeRoot, 'ai/shared/tribute/scenarios.mjs')).href
  );
  const { applyLearnedTribute, baselineTributeChoice } = await import(
    pathToFileURL(join(runtimeRoot, 'ai/shared/simulation/match-simulation.mjs')).href
  );
  const protocolSHA = sha(readFileSync(join(run, 'protocol.json')));
  if (best.protocolSHA256 !== protocolSHA) throw Error('Candidate protocol mismatch');
  if (!test && (seedBase !== 4000000000 || pairs !== protocol.independentProtocol.pairsPerHead))
    throw Error('Independent seed allocation changed');
  const bytes = readFileSync(join(run, 'learner/best.onnx'));
  if (sha(bytes) !== best.sha256) throw Error('Specialist SHA mismatch');
  const engine = await ort.InferenceSession.create(bytes, {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  if (
    JSON.stringify(engine.inputNames) !== '["features"]' ||
    JSON.stringify(engine.outputNames) !== '["values"]'
  )
    throw Error('Specialist ONNX interface mismatch');
  const predict = async (rows, n) => {
    const input = new ort.Tensor('float32', rows, [n, 389]);
    let result;
    try {
      result = await engine.run({ features: input });
      return Float32Array.from(result.values.data);
    } finally {
      input.dispose();
      if (result) Object.values(result).forEach((t) => t.dispose());
    }
  };
  const file = join(run, test ? 'evaluation-smoke.json' : 'independent.json');
  const result = readJSON(file, {
    schema: 1,
    kind: test ? 'test' : 'independent-complete-round',
    candidate: best,
    protocolSHA,
    models: protocol.models,
    seedBase,
    pairs,
    heads: [[], []],
    complete: false,
  });
  if (
    result.protocolSHA !== protocolSHA ||
    result.candidate.sha256 !== best.sha256 ||
    result.seedBase !== seedBase ||
    result.pairs !== pairs
  )
    throw Error('Evaluation resume fingerprint mismatch');
  try {
    for (let head = 0; head < 2; head++) {
      const teacher = await continuation(runtimeRoot, protocol.models[head], { delayMs: 0 });
      try {
        for (let i = result.heads[head].length; i < pairs * 2; i++) {
          while (freemem() < 4 * 2 ** 30) await new Promise((r) => setTimeout(r, 2000));
          const seed = seedBase + Math.floor(i / 2),
            side = i % 2,
            { game, order } = scenario(seed);
          const phase = await applyLearnedTribute(game, order, (obs) => {
            const baseline = baselineTributeChoice(obs);
            return obs.player % 2 === side ? selectTribute(obs, head, predict, baseline) : baseline;
          });
          game.turn = phase.leader;
          result.heads[head].push({
            seed,
            side,
            ...(await teacher.playRound(game, {
              check: async () => {
                while (freemem() < 4 * 2 ** 30) await new Promise((r) => setTimeout(r, 2000));
              },
            })),
          });
          result.updatedUTC = new Date().toISOString();
          writeJSON(file, result);
          writeJSON(join(run, 'evaluation-progress.json'), {
            head,
            completed: result.heads.map((rs) => rs.length),
            planned: [pairs * 2, pairs * 2],
            updatedUTC: result.updatedUTC,
          });
          if (protocol.progressMirror)
            writeJSON(
              join(dirname(protocol.progressMirror), 'evaluation-progress.json'),
              readJSON(join(run, 'evaluation-progress.json')),
            );
        }
      } finally {
        await teacher.close();
      }
    }
    result.summaries = result.heads.map(summarize);
    result.accepted =
      result.summaries.every((s) => s.meanPairedPoints >= 0 && s.ci95[0] >= 0) &&
      result.summaries.some((s) => s.meanPairedPoints > 0);
    result.complete = true;
    result.completedUTC = new Date().toISOString();
    writeJSON(file, result);
    return result;
  } finally {
    await engine.release();
  }
}
if (
  process.argv[1] &&
  pathToFileURL(realpathSync(resolve(process.argv[1]))).href === import.meta.url
)
  evaluate(resolve(option('run')), {
    test: process.argv.includes('--test'),
    seedBase: Number(option('seed', '4000000000')),
    pairs: Number(option('pairs', '128')),
  })
    .then((r) => console.log(JSON.stringify(r.summaries)))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
