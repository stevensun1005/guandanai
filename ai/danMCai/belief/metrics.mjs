/**
 * P1 belief-quality metrics on held-out champion self-play (belief vs the uniform baseline).
 *
 * Rounds are replayed with the same champion-greedy loop as generate.mjs on seeds the network was
 * not trained or validated on. At each recorded turn, from the mover's public view only:
 *   - logLikelihoodPerCopy: mean log p(true seat) over unseen copies (higher is better);
 *   - top1PerCopy: share of unseen copies whose true seat is the arg-max seat (ties share credit);
 *   - overlap: expected share of unseen copies that a sampled world puts on the right seat, for
 *     worlds from sampleBeliefWorlds (belief) and sampleWorlds (uniform);
 *   - truePercentile: percentile of the TRUE deal's belief log score among N uniform worlds
 *     (ties count half; the uniform model scores every count-consistent deal equally, so 0.5).
 * The true hands are used only to score, never as an input. These are inference-quality metrics,
 * not playing strength; a seed-cluster normal interval is given for the log-likelihood difference.
 *
 *   node ai/danMCai/belief/metrics.mjs --belief=<onnx> --seeds=a..b --out=<file.json>
 *        [--champion=<onnx>] [--band=21-80] [--every=1] [--samples=8] [--worlds=32] [--seed=1]
 *        [--train-report=<json>]
 *
 * The training report (default: train-report.json next to the ONNX) lists the generation seed
 * ranges the network was trained and validated on; metrics refuse seeds overlapping them, and
 * refuse to run without a report unless --train-report=none is given explicitly. The feature
 * version (v1 or v3) is taken from that report (default v1 when absent; the ONNX input width is
 * checked) and recorded in the summary; --features=v1|v3 overrides it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sampleWorlds } from '../../shared/search/belief.mjs';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';
import { FACES, SEATS, TARGETS, hiddenTarget } from './features.mjs';
import {
  CHAMPION_SHA256,
  DEFAULT_CHAMPION,
  championChooser,
  onTable,
  parseRange,
  playRecordedRound,
} from './generate.mjs';
import {
  beliefLogScore,
  createBeliefModel,
  sampleBeliefWorlds,
  uniformProbabilities,
} from './sampler.mjs';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

/** Copies-weighted log-likelihood sum and fractional top-1 hits of one probability vector. */
export function scoreProbabilities(probs, y) {
  let copies = 0,
    logLikelihood = 0,
    hits = 0;
  for (let f = 0; f < FACES; f++) {
    const row = [0, 1, 2].map((r) => Number(probs[f * SEATS + r]));
    const best = Math.max(...row),
      winners = row.map((v) => v >= best - 1e-9);
    const ties = winners.filter(Boolean).length;
    for (let r = 0; r < SEATS; r++) {
      const k = y[f * SEATS + r];
      if (!k) continue;
      copies += k;
      logLikelihood += k * Math.log(Math.max(row[r], 1e-30));
      if (winners[r]) hits += k / ties;
    }
  }
  return { copies, logLikelihood, hits };
}

/** Target-format counts (face * 3 + r - 1) of a sampled world's hidden hands. */
export function worldTarget(view, hands) {
  const y = new Uint8Array(TARGETS);
  for (let r = 1; r < 4; r++)
    for (const id of hands[(view.p + r) % 4]) y[cardIndex(id) * SEATS + r - 1]++;
  return y;
}

/** Share of the true unseen copies a world puts on the right seat. */
export function overlap(world, truth) {
  let same = 0,
    copies = 0;
  for (let i = 0; i < TARGETS; i++) {
    same += Math.min(world[i], truth[i]);
    copies += truth[i];
  }
  return copies ? same / copies : 1;
}

/** Percentile of `value` among `others` (ties count half). */
export function percentile(value, others) {
  let below = 0;
  for (const o of others) below += o < value - 1e-9 ? 1 : Math.abs(o - value) <= 1e-9 ? 0.5 : 0;
  return below / others.length;
}

/** Seed ranges of the data a belief network was trained/validated on, from its train report. */
export function trainingSeedRanges(report) {
  const protocols = report.dataProtocols || (report.dataProtocol ? [report.dataProtocol] : []);
  const ranges = protocols.map((p) => p.seeds);
  if (!ranges.length || !ranges.every((r) => Array.isArray(r) && r.length === 2))
    throw Error('Training report lists no data seed ranges');
  return ranges;
}

/** Throws if [a, b] overlaps any training range. */
export function assertHeldOut([a, b], ranges) {
  for (const [lo, hi] of ranges)
    if (a <= hi && lo <= b)
      throw Error(`Metric seeds ${a}..${b} overlap training seeds ${lo}..${hi}`);
}

function meanInterval(values) {
  const n = values.length,
    mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0;
  return { mean, ci95: [mean - (1.96 * sd) / Math.sqrt(n), mean + (1.96 * sd) / Math.sqrt(n)], n };
}

async function main() {
  const ort = await import('onnxruntime-node');
  const { createModelPool, sha256 } = await import('../training/continuous/lib.mjs');
  const beliefFile = resolve(option('belief'));
  const champion = resolve(option('champion', DEFAULT_CHAMPION));
  const [a, b] = parseRange(option('seeds'), 'seeds');
  const band = parseRange(option('band', '21-80'), 'band');
  const every = Number(option('every', 1)),
    samples = Number(option('samples', 8)),
    worldsN = Number(option('worlds', 32)),
    baseSeed = Number(option('seed', 1));
  const out = resolve(option('out'));
  const reportOption = option('train-report', join(dirname(beliefFile), 'train-report.json'));
  let trainingSeeds = null,
    trainReport = null;
  if (reportOption !== 'none') {
    if (!existsSync(reportOption))
      throw Error(`No training report at ${reportOption}; pass --train-report=<json> or none`);
    trainReport = JSON.parse(readFileSync(reportOption, 'utf8'));
    trainingSeeds = trainingSeedRanges(trainReport);
    assertHeldOut([a, b], trainingSeeds);
  }
  const championSHA256 = sha256(champion);
  const pool = await createModelPool(ort, { threads: 1, limit: 1 });
  const belief = await createBeliefModel(ort, beliefFile, {
    featureVersion: option('features', undefined),
    ...(trainReport ? { report: trainReport } : {}),
  });
  const choose = championChooser((state) => pool.values(champion, state));
  const totals = { belief: { copies: 0, ll: 0, hits: 0 }, uniform: { copies: 0, ll: 0, hits: 0 } };
  const overlaps = { belief: 0, uniform: 0 };
  let decisions = 0,
    percentileSum = 0;
  const perSeedDiff = [],
    byBand = {};
  const t0 = Date.now();
  for (let seed = a; seed <= b; seed++) {
    const seedSum = { copies: 0, belief: 0, uniform: 0 };
    await playRecordedRound(seed, {
      choose,
      band,
      every,
      async onTurn(game, view) {
        const y = hiddenTarget(game, view.p);
        const pb = await belief.probabilities(view),
          pu = uniformProbabilities(view);
        const sb = scoreProbabilities(pb, y),
          su = scoreProbabilities(pu, y);
        totals.belief.copies += sb.copies;
        totals.belief.ll += sb.logLikelihood;
        totals.belief.hits += sb.hits;
        totals.uniform.copies += su.copies;
        totals.uniform.ll += su.logLikelihood;
        totals.uniform.hits += su.hits;
        seedSum.copies += sb.copies;
        seedSum.belief += sb.logLikelihood;
        seedSum.uniform += su.logLikelihood;
        const key = `${Math.floor((onTable(game) - 1) / 20) * 20 + 1}-${Math.floor((onTable(game) - 1) / 20) * 20 + 20}`;
        const bb = (byBand[key] ||= { decisions: 0, copies: 0, belief: 0, uniform: 0 });
        bb.decisions++;
        bb.copies += sb.copies;
        bb.belief += sb.logLikelihood;
        bb.uniform += su.logLikelihood;
        const sampleSeed = (baseSeed * 1_000_003 + seed * 1009 + decisions) | 0;
        const bw = sampleBeliefWorlds(view, pb, { count: samples, seed: sampleSeed });
        const uw = sampleWorlds(view, { count: samples, seed: sampleSeed });
        for (const w of bw) overlaps.belief += overlap(worldTarget(view, w), y) / samples;
        for (const w of uw) overlaps.uniform += overlap(worldTarget(view, w), y) / samples;
        const truth = game.hands.map((h) => h.map((c) => c.id));
        const ranked = sampleWorlds(view, { count: worldsN, seed: sampleSeed ^ 0x5bd1e995 });
        percentileSum += percentile(
          beliefLogScore(view, pb, truth),
          ranked.map((w) => beliefLogScore(view, pb, w)),
        );
        decisions++;
      },
    });
    if (seedSum.copies) perSeedDiff.push((seedSum.belief - seedSum.uniform) / seedSum.copies);
  }
  await belief.close();
  await pool.close();
  const per = (t) => ({
    logLikelihoodPerCopy: t.ll / t.copies,
    logLossPerCopy: -t.ll / t.copies,
    top1PerCopy: t.hits / t.copies,
  });
  const summary = {
    belief: beliefFile,
    beliefSHA256: sha256(beliefFile),
    beliefFeatureVersion: belief.featureVersion,
    beliefFeatureSource: belief.featureSource,
    champion,
    championSHA256,
    championIsFrozen017: championSHA256 === CHAMPION_SHA256,
    seeds: [a, b],
    trainingSeeds,
    heldOutChecked: trainingSeeds !== null,
    band,
    every,
    samples,
    worlds: worldsN,
    rounds: b - a + 1,
    decisions,
    unseenCopies: totals.belief.copies,
    beliefModel: {
      ...per(totals.belief),
      expectedOverlap: overlaps.belief / decisions,
      trueDealPercentileAmongUniformWorlds: percentileSum / decisions,
    },
    uniform: {
      ...per(totals.uniform),
      expectedOverlap: overlaps.uniform / decisions,
      trueDealPercentileAmongUniformWorlds: 0.5,
    },
    logLikelihoodGainPerCopy: {
      ...meanInterval(perSeedDiff),
      interval: 'per-seed mean (belief - uniform) log-likelihood per copy; seed-cluster normal',
    },
    byTableCards: Object.fromEntries(
      Object.entries(byBand)
        .sort(([x], [y]) => parseInt(x) - parseInt(y))
        .map(([k, v]) => [
          k,
          {
            decisions: v.decisions,
            beliefLogLossPerCopy: -v.belief / v.copies,
            uniformLogLossPerCopy: -v.uniform / v.copies,
          },
        ]),
    ),
    seconds: (Date.now() - t0) / 1000,
    note: 'Inference-quality (P1) metrics on held-out champion self-play; not playing strength.',
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
