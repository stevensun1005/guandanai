/**
 * Belief-weighted world sampling for search.
 *
 * Model: every unseen physical card c independently "prefers" relative seat r with weight
 * p[face(c)][r] (the belief network's output, or the uniform baseline), and a world is drawn from
 *
 *   P(world) proportional to  prod_c p[face(c)][seat(c)]   subject to the EXACT hand counts.
 *
 * Sampling is exact for that distribution: a backward dynamic programme over the unseen cards
 * (state = how many of the remaining cards seat r=1 and r=2 still need; r=3 takes the rest) gives
 * the count-conditioned partition function in log space, and each world is then drawn card by card
 * from the exact conditional. This replaces the usual IPF/Sinkhorn marginal fitting plus
 * approximate sequential sampling: multiplying all of one seat's weights by a constant leaves the
 * count-conditioned distribution unchanged, so no per-seat calibration is needed, and counts and
 * the unseen multiset hold exactly by construction.
 *
 * With uniform weights every count-consistent deal is equally likely, i.e. the same distribution
 * as `sampleWorlds` in ai/shared/search/belief.mjs (a uniform shuffle dealt by counts). The output
 * world format is identical (hands[4] of physical ids, hands[p] = own hand), so search code can
 * swap it in. Seeded and deterministic. No actual opponent hands are accepted.
 *
 * Probabilities are indexed probs[face * 3 + r - 1] with the champion face index (cardIndex) and
 * relative seat r = 1 next, 2 partner, 3 previous.
 */
import { unseenPhysicalCards } from '../../../web/src/analysis/concepts.mjs';
import { seededRandom } from '../../shared/simulation/simulation.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FACES, FEATURE_SPECS, SEATS, TARGETS, featureSpec, featuresFor } from './features.mjs';

const FLOOR = 1e-12;
const deck = makeDeck();

/** Uniform baseline: p_r proportional to the remaining hand counts of the three other seats. */
export function uniformProbabilities(view) {
  const counts = [1, 2, 3].map((r) => view.counts[(view.p + r) % 4]);
  const total = counts.reduce((a, b) => a + b, 0);
  const p = new Float64Array(TARGETS);
  for (let f = 0; f < FACES; f++)
    for (let r = 0; r < SEATS; r++) p[f * SEATS + r] = total ? counts[r] / total : 1 / 3;
  return p;
}

function logAdd(a, b) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  return a > b ? a + Math.log1p(Math.exp(b - a)) : b + Math.log1p(Math.exp(a - b));
}

/** Validated pool split into fixed (publicly known) cards and the cards to sample. */
function partition(view, fixedCards) {
  const pool = unseenPhysicalCards(view),
    unseen = new Set(pool),
    fixed = [[], [], [], []],
    assigned = new Set();
  const played = new Set(view.log.flatMap((e) => e.cards || []));
  for (const { seat, card } of fixedCards) {
    if (
      !Number.isInteger(seat) ||
      seat < 0 ||
      seat > 3 ||
      !Number.isInteger(card) ||
      card < 0 ||
      card > 107 ||
      assigned.has(card)
    )
      throw Error('Invalid public fixed card');
    assigned.add(card);
    if (played.has(card)) continue;
    if (seat === view.p) {
      if (!view.hand.includes(card)) throw Error('Contradictory known own card');
    } else {
      if (!unseen.has(card) || fixed[seat].length >= view.counts[seat])
        throw Error('Contradictory public card ownership');
      fixed[seat].push(card);
    }
  }
  const cards = pool.filter((id) => !assigned.has(id));
  const caps = [1, 2, 3].map((r) => view.counts[(view.p + r) % 4] - fixed[(view.p + r) % 4].length);
  if (caps.some((c) => c < 0) || caps.reduce((a, b) => a + b, 0) !== cards.length)
    throw Error('Belief count mismatch');
  return { cards, caps, fixed };
}

/** Log weights per card [N][3], normalized per card; -Infinity for seats with no capacity. */
function logWeights(cards, caps, probs) {
  if (probs.length !== TARGETS) throw Error('Belief probabilities must have 162 entries');
  return cards.map((id) => {
    const f = cardIndex(id),
      w = [0, 1, 2].map((r) => {
        const v = Number(probs[f * SEATS + r]);
        if (!(v >= 0) || !Number.isFinite(v)) throw Error('Invalid belief probability');
        return caps[r] > 0 ? Math.max(v, FLOOR) : 0;
      });
    const total = w[0] + w[1] + w[2];
    return w.map((v) => (v > 0 ? Math.log(v / total) : -Infinity));
  });
}

/**
 * Backward log partition: Z[k][a][b] = log sum over assignments of cards k..N-1 with exactly a to
 * r=1, b to r=2 and the rest to r=3 (within capacity) of the product of weights.
 */
function partitionTable(lw, caps) {
  const n = lw.length,
    A = caps[0] + 1,
    B = caps[1] + 1;
  const z = new Float64Array((n + 1) * A * B).fill(-Infinity);
  const at = (k, a, b) => (k * A + a) * B + b;
  z[at(n, 0, 0)] = 0;
  for (let k = n - 1; k >= 0; k--) {
    const left = n - k;
    for (let a = 0; a < A && a <= left; a++)
      for (let b = 0; b < B && a + b <= left; b++) {
        const c = left - a - b;
        if (c > caps[2]) continue;
        let v = -Infinity;
        if (a > 0) v = logAdd(v, lw[k][0] + z[at(k + 1, a - 1, b)]);
        if (b > 0) v = logAdd(v, lw[k][1] + z[at(k + 1, a, b - 1)]);
        if (c > 0) v = logAdd(v, lw[k][2] + z[at(k + 1, a, b)]);
        z[at(k, a, b)] = v;
      }
  }
  if (!(z[at(0, caps[0], caps[1])] > -Infinity)) throw Error('No world matches the hand counts');
  return { z, at };
}

/**
 * Sample `count` complete hidden deals from the belief, exactly respecting hand counts and the
 * unseen card multiset. Same signature and output as sampleWorlds plus the probabilities.
 */
export function sampleBeliefWorlds(
  view,
  probs,
  { count = 8, seed, fixedCards = view.publicKnownCards || [] } = {},
) {
  if (
    'hands' in view ||
    !Number.isInteger(seed) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > 1024
  )
    throw Error('Invalid public belief request');
  if (view.hand.length !== view.counts[view.p]) throw Error('Wrong own count');
  const { cards, caps, fixed } = partition(view, fixedCards);
  const lw = logWeights(cards, caps, probs);
  const { z, at } = partitionTable(lw, caps);
  const random = seededRandom(seed),
    worlds = [];
  for (let w = 0; w < count; w++) {
    const hands = fixed.map((h) => h.slice());
    hands[view.p] = view.hand.slice();
    let a = caps[0],
      b = caps[1];
    for (let k = 0; k < cards.length; k++) {
      const c = cards.length - k - a - b;
      const options = [
        a > 0 ? lw[k][0] + z[at(k + 1, a - 1, b)] : -Infinity,
        b > 0 ? lw[k][1] + z[at(k + 1, a, b - 1)] : -Infinity,
        c > 0 ? lw[k][2] + z[at(k + 1, a, b)] : -Infinity,
      ];
      const max = Math.max(...options);
      const weights = options.map((v) => (v === -Infinity ? 0 : Math.exp(v - max)));
      let u = random() * (weights[0] + weights[1] + weights[2]),
        r = 0;
      while (r < 2 && (u -= weights[r]) > 0) r++;
      if (weights[r] === 0) r = weights.findIndex((v) => v > 0);
      if (r === 0) a--;
      else if (r === 1) b--;
      hands[(view.p + r + 1) % 4].push(cards[k]);
    }
    if (hands.some((h, p) => h.length !== view.counts[p])) throw Error('Belief count mismatch');
    worlds.push(hands);
  }
  return worlds;
}

/** Unnormalized belief log score of a complete deal: sum over hidden cards of log p[face][seat]. */
export function beliefLogScore(view, probs, hands) {
  let total = 0;
  for (let r = 1; r < 4; r++)
    for (const id of hands[(view.p + r) % 4])
      total += Math.log(Math.max(Number(probs[cardIndex(id) * SEATS + r - 1]), FLOOR));
  return total;
}

/**
 * Belief marginals as 162 network inputs (index face * 3 + r - 1, r = 1 next, 2 partner, 3
 * previous): the expected number of unseen copies of each face held by seat r. The network's
 * per-face seat probabilities are raked with one positive scale per seat until every face sums to
 * its unseen copies (0..2) and every seat sums to its public hand count, so the values are on a card
 * scale and consistent with the counts; a seat with no cards gets zeros. Public view only.
 * `views` may be one view or an array (one batched network call); the result matches its shape.
 */
export async function beliefMarginals(model, views) {
  const list = Array.isArray(views) ? views : [views];
  if (!list.length) return [];
  const probs = await model.probabilities(list);
  const rows = list.map((view, i) => rakeMarginals(view, probs[i]));
  return Array.isArray(views) ? rows : rows[0];
}

function rakeMarginals(view, probs) {
  if (!view || 'hands' in view) throw Error('Belief marginals accept only a public view');
  if (probs.length !== TARGETS) throw Error('Belief probabilities must have 162 entries');
  const unseen = new Float64Array(FACES).fill(2);
  for (const id of view.hand) unseen[cardIndex(id)]--;
  for (const entry of view.log) for (const id of entry.cards || []) unseen[cardIndex(id)]--;
  if (unseen.some((u) => u < 0)) throw Error('More than two copies of a face seen');
  const counts = [1, 2, 3].map((r) => view.counts[(view.p + r) % 4]);
  const hidden = unseen.reduce((a, b) => a + b, 0);
  if (hidden !== counts[0] + counts[1] + counts[2]) throw Error('Belief count mismatch');
  const out = new Float32Array(TARGETS);
  if (!hidden) return out;
  const p = Float64Array.from(probs, (v) => {
    if (!(v >= 0) || !Number.isFinite(v)) throw Error('Invalid belief probability');
    return Math.max(v, FLOOR);
  });
  const scale = counts.map((c) => (c > 0 ? 1 : 0)),
    m = new Float64Array(TARGETS);
  for (let iteration = 0; iteration < 500; iteration++) {
    const columns = [0, 0, 0];
    for (let f = 0; f < FACES; f++) {
      if (!unseen[f]) continue;
      let total = 0;
      for (let r = 0; r < SEATS; r++) total += p[f * SEATS + r] * scale[r];
      for (let r = 0; r < SEATS; r++) {
        m[f * SEATS + r] = (unseen[f] * p[f * SEATS + r] * scale[r]) / total;
        columns[r] += m[f * SEATS + r];
      }
    }
    let error = 0;
    for (let r = 0; r < SEATS; r++) {
      error = Math.max(error, Math.abs(columns[r] - counts[r]));
      if (counts[r] > 0) scale[r] *= counts[r] / columns[r];
    }
    if (error < 1e-7) break;
  }
  out.set(m);
  return out;
}

/**
 * Feature version of a belief network: the explicit `featureVersion` option, else the
 * `featureVersion` of its training report (`report` object, `reportFile`, or train-report.json next
 * to the ONNX), else belief-v1 (window-1 models and every model trained before v3). When the ONNX
 * declares a fixed input width it must match; with no explicit or reported version a width that
 * matches exactly one known version selects it. Returns the feature spec.
 */
export function resolveBeliefFeatures(
  file,
  { featureVersion, report, reportFile, inputWidth } = {},
) {
  let version = featureVersion ?? null,
    source = version ? 'option' : null;
  if (!version) {
    let data = report ?? null;
    const path = reportFile ?? (file ? join(dirname(file), 'train-report.json') : null);
    if (!data && path && existsSync(path)) data = JSON.parse(readFileSync(path, 'utf8'));
    if (data?.featureVersion) [version, source] = [data.featureVersion, 'report'];
  }
  const known = Number.isInteger(inputWidth) && inputWidth > 0;
  if (!version && known) {
    const match = Object.values(FEATURE_SPECS).filter((s) => s.features === inputWidth);
    if (match.length === 1) [version, source] = [match[0].version, 'width'];
  }
  const spec = featureSpec(version ?? 'v1');
  if (known && spec.features !== inputWidth)
    throw Error(
      `Belief network input width ${inputWidth} does not match ${spec.version} (${spec.features}, from ${source ?? 'default'})`,
    );
  return { ...spec, source: source ?? 'default' };
}

/**
 * Belief network for Node: ONNX input `features` [batch, F] float32, output `probs`
 * [batch, 54, 3]; F and the feature version come from resolveBeliefFeatures (default v1). Views
 * without play shapes (e.g. policyState) have them inferred from the cards.
 */
export async function createBeliefModel(
  ort,
  file,
  { threads = 1, featureVersion, report, reportFile } = {},
) {
  const session = await ort.InferenceSession.create(file, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    graphOptimizationLevel: 'all',
  });
  const width = session.inputMetadata?.[0]?.shape?.[1];
  let spec;
  try {
    spec = resolveBeliefFeatures(file, {
      featureVersion,
      report,
      reportFile,
      inputWidth: typeof width === 'number' ? width : undefined,
    });
  } catch (error) {
    await session.release();
    throw error;
  }
  const FEATURES = spec.features;
  return {
    featureVersion: spec.version,
    features: FEATURES,
    featureSource: spec.source,
    async probabilities(views) {
      const list = Array.isArray(views) ? views : [views];
      const x = new Float32Array(list.length * FEATURES);
      list.forEach((view, i) =>
        x.set(featuresFor(view, { version: spec.version, deck }), i * FEATURES),
      );
      const output = await session.run({
        features: new ort.Tensor('float32', x, [list.length, FEATURES]),
      });
      const data = output.probs.data;
      if (data.length !== list.length * TARGETS || !data.every(Number.isFinite))
        throw Error('Invalid belief output');
      const rows = list.map((_, i) => data.slice(i * TARGETS, (i + 1) * TARGETS));
      return Array.isArray(views) ? rows : rows[0];
    },
    async close() {
      await session.release();
    },
  };
}
