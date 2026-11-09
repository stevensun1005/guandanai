import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDeck } from '../../../web/src/core/cards.js';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';
import { seededRandom } from '../../shared/simulation/simulation.mjs';
import { sampleWorlds } from '../../shared/search/belief.mjs';
import {
  FACES,
  FEATURES,
  LAYOUT,
  SHAPE_BUCKETS,
  TARGETS,
  TYPES,
  features,
  hiddenTarget,
  publicView,
  shapeBucket,
} from '../belief/features.mjs';
import {
  blocksOf,
  championChooser,
  generateBlock,
  parseRange,
  playRecordedRound,
  writeBlock,
} from '../belief/generate.mjs';
import { beliefLogScore, sampleBeliefWorlds, uniformProbabilities } from '../belief/sampler.mjs';
import {
  assertHeldOut,
  overlap,
  percentile,
  scoreProbabilities,
  trainingSeedRanges,
  worldTarget,
} from '../belief/metrics.mjs';

const deck = makeDeck();

/** Seeded random legal policy (never reads hidden hands for anything but legality). */
function randomChooser(seed) {
  const random = seededRandom(seed);
  return async (game, plays) => Math.floor(random() * plays.length);
}

/** Collect (game snapshot, view) pairs from a few random rounds. */
async function positions(seeds, band = [1, 108]) {
  const out = [];
  for (const seed of seeds)
    await playRecordedRound(seed, {
      choose: randomChooser(seed),
      band,
      every: 7,
      onTurn(game, view) {
        out.push({
          view,
          hands: game.hands.map((h) => h.slice()),
          game: { ...game, hands: game.hands.map((h) => h.slice()), log: game.log.slice() },
        });
      },
    });
  return out;
}

test('bucket scheme is complete, injective and the layout stays under 1,500 features', () => {
  assert.equal(SHAPE_BUCKETS, 148);
  assert.equal(FEATURES, 1238);
  assert.ok(FEATURES < 1500);
  assert.equal(LAYOUT.leads[1], FEATURES);
  const seen = new Set();
  const add = (shape) => {
    const b = shapeBucket(shape);
    assert.ok(b >= 0 && b < SHAPE_BUCKETS);
    seen.add(`${shape.type}:${b}`);
    return b;
  };
  for (let v = 2; v <= 17; v++) add({ type: 'single', value: v, n: 1 });
  for (let v = 2; v <= 17; v++) add({ type: 'pair', value: v, n: 2 });
  for (let v = 2; v <= 15; v++) add({ type: 'triple', value: v, n: 3 });
  for (let v = 2; v <= 15; v++) add({ type: 'full', value: v, n: 5 });
  for (let v = 1; v <= 10; v++) add({ type: 'straight', value: v, n: 5 });
  for (let v = 1; v <= 12; v++) add({ type: 'pairs3', value: v, n: 6 });
  for (let v = 1; v <= 13; v++) add({ type: 'trip2', value: v, n: 6 });
  for (let n = 4; n <= 6; n++) for (let v = 2; v <= 15; v++) add({ type: 'bomb', value: v, n });
  for (let v = 1; v <= 10; v++) add({ type: 'sflush', value: v, n: 5 });
  add({ type: 'jokers', value: 99, n: 4 });
  assert.equal(seen.size, SHAPE_BUCKETS);
  // Bombs of 6 or more cards share the 6+ bucket.
  assert.equal(
    shapeBucket({ type: 'bomb', value: 9, n: 8 }),
    shapeBucket({ type: 'bomb', value: 9, n: 6 }),
  );
  assert.throws(() => shapeBucket({ type: 'single', value: 1, n: 1 }));
  assert.throws(() => shapeBucket({ type: 'quad', value: 5, n: 4 }));
});

test('features are deterministic and rejected for anything carrying hidden hands', async () => {
  const [{ view, game }] = await positions([11]);
  assert.deepEqual(features(view), features(structuredClone(view)));
  assert.throws(() => features({ ...view, hands: game.hands }));
});

test('permuting the other seats hidden cards with public information fixed leaves features unchanged', async () => {
  const list = await positions([3, 4, 5]);
  assert.ok(list.length > 20);
  let checked = 0;
  for (const [i, { game }] of list.entries()) {
    const p = game.turn;
    const others = [1, 2, 3].map((r) => (p + r) % 4);
    const hidden = others.flatMap((s) => game.hands[s]);
    const random = seededRandom(1000 + i);
    for (let k = hidden.length - 1; k > 0; k--) {
      const j = Math.floor(random() * (k + 1));
      [hidden[k], hidden[j]] = [hidden[j], hidden[k]];
    }
    const permuted = { ...game, hands: game.hands.slice() };
    for (const s of others) permuted.hands[s] = hidden.splice(0, game.hands[s].length);
    const a = publicView(game, p),
      b = publicView(permuted, p);
    assert.deepEqual(a, b);
    assert.deepEqual(features(a), features(b));
    // The target does see the hidden hands: it must change when a non-trivial swap happened.
    checked++;
  }
  assert.equal(checked, list.length);
});

test('passes are bucketed against the open trick and trick boundaries follow the public replay', () => {
  // Mover 0. Seat 1 leads single 10 of spades, seats 2, 3 and 0 pass (trick closes), then seat 1
  // leads a pair of fives. Seat 2 passed an opponent's trick, seat 3 its partner's.
  const ten = 8,
    fives = [3, 57];
  const hand = Array.from({ length: 27 }, (_, i) => 70 + i); // excludes both copies of 10S, 5S
  const view = {
    p: 0,
    hand,
    counts: [27, 24, 27, 27],
    level: 2,
    log: [
      { p: 1, cards: [ten], type: 'single', value: 10, n: 1 },
      { p: 2, cards: null },
      { p: 3, cards: null },
      { p: 0, cards: null },
      { p: 1, cards: fives, type: 'pair', value: 5, n: 2 },
    ],
  };
  const x = features(view);
  const at = (block, r, i, width) => x[LAYOUT[block][0] + (r - 1) * width + i];
  const single10 = shapeBucket({ type: 'single', value: 10, n: 1 });
  const pair5 = shapeBucket({ type: 'pair', value: 5, n: 2 });
  assert.equal(at('shapes', 1, single10, SHAPE_BUCKETS), 1);
  assert.equal(at('shapes', 1, pair5, SHAPE_BUCKETS), 1);
  assert.equal(at('leads', 1, TYPES.indexOf('single'), TYPES.length), 1);
  assert.equal(at('leads', 1, TYPES.indexOf('pair'), TYPES.length), 1);
  assert.equal(at('passOpponent', 2, single10, SHAPE_BUCKETS), 1);
  assert.equal(at('passPartner', 3, TYPES.indexOf('single'), TYPES.length), 1);
  assert.equal(at('passOpponent', 3, single10, SHAPE_BUCKETS), 0);
  // The mover's own pass is not a feature about another seat.
  const passTotal = (block) => x.slice(LAYOUT[block][0], LAYOUT[block][1]).reduce((a, b) => a + b);
  assert.equal(passTotal('passOpponent') + passTotal('passPartner'), 2);
  assert.equal(x[LAYOUT.played[0] + cardIndex(ten)], 1);
  assert.equal(x[LAYOUT.played[0] + cardIndex(3)], 2);
  assert.equal(x[LAYOUT.unseen[0] + cardIndex(ten)], 1);
  assert.equal(x[LAYOUT.unseen[0] + cardIndex(3)], 0);
  assert.deepEqual(Array.from(x.slice(LAYOUT.counts[0], LAYOUT.counts[1])), [27, 24, 27, 27]);
  assert.equal(x[LAYOUT.level[0]], 1);
  // A shape-less public play is inferred from the cards when unambiguous.
  const bare = { ...view, log: view.log.map(({ p, cards }) => ({ p, cards })) };
  assert.deepEqual(features(bare, { deck }), x);
  // Inconsistent counts are refused.
  assert.throws(() => features({ ...view, counts: [27, 24, 27, 26] }));
});

test('targets count unseen copies per seat and sum to the public unseen block', async () => {
  const list = await positions([21, 22]);
  for (const { game, view } of list) {
    const x = features(view),
      y = hiddenTarget(game, view.p);
    assert.equal(y.length, TARGETS);
    for (let f = 0; f < FACES; f++)
      assert.equal(y[f * 3] + y[f * 3 + 1] + y[f * 3 + 2], x[LAYOUT.unseen[0] + f]);
    for (let r = 1; r < 4; r++) {
      let n = 0;
      for (let f = 0; f < FACES; f++) n += y[f * 3 + r - 1];
      assert.equal(n, view.counts[(view.p + r) % 4]);
    }
  }
});

test('generation records only the band, subsamples deterministically and round-trips shards', async () => {
  assert.deepEqual(parseRange('3,838,121,000..3,838,121,004'), [3838121000, 3838121004]);
  assert.deepEqual(parseRange('21-80'), [21, 80]);
  assert.throws(() => parseRange('9..3'));
  assert.deepEqual(blocksOf([10, 24], 5), [
    [10, 14],
    [15, 19],
    [20, 24],
  ]);
  const choose = (seed) => randomChooser(seed);
  const a = await generateBlock([7, 8], { choose: choose(1), band: [21, 80], every: 2 });
  const b = await generateBlock([7, 8], { choose: choose(1), band: [21, 80], every: 2 });
  assert.ok(a.rows > 10);
  assert.deepEqual(a.x, b.x);
  assert.deepEqual(a.y, b.y);
  for (let i = 0; i < a.rows; i++) {
    const table = a.m[i * 4 + 3];
    assert.ok(table >= 21 && table <= 80);
  }
  const all = await generateBlock([7, 8], { choose: choose(1), band: [21, 80], every: 1 });
  assert.ok(all.rows >= 2 * a.rows - 2 && all.rows <= 2 * a.rows + 2);
  const dir = mkdtempSync(join(tmpdir(), 'belief-'));
  try {
    const meta = writeBlock(dir, 7, 8, a);
    assert.equal(meta.rows, a.rows);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'b7.x.u8'))), a.x);
    assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'b7.y.u8'))), a.y);
    const m = readFileSync(join(dir, 'b7.m.u32'));
    assert.deepEqual(new Uint32Array(m.buffer, m.byteOffset, m.length / 4), a.m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('development seeds above 2^31 are stored exactly in the shard metadata', async () => {
  const seed = 3838129990;
  const block = await generateBlock([seed], { choose: randomChooser(5), band: [1, 108], every: 9 });
  assert.ok(block.rows > 0);
  for (let i = 0; i < block.rows; i++) assert.equal(block.m[i * 4], seed);
  const dir = mkdtempSync(join(tmpdir(), 'belief-'));
  try {
    writeBlock(dir, seed, seed, block);
    const m = readFileSync(join(dir, `b${seed}.m.u32`));
    assert.equal(new Uint32Array(m.buffer, m.byteOffset, m.length / 4)[0], seed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('softmax champion play is reseeded per round, independent of how blocks are split', async () => {
  // Stand-in values: any deterministic function of the public state.
  const values = async (state) => state.actions.map((ids, i) => ((ids.length * 7 + i) % 5) / 2);
  const make = () => championChooser(values, { temperature: 1 });
  const together = await generateBlock([3838129991, 3838129992], {
    choose: make(),
    band: [21, 80],
    every: 3,
  });
  const second = await generateBlock([3838129992], { choose: make(), band: [21, 80], every: 3 });
  const tail = together.rows - second.rows;
  assert.ok(second.rows > 0 && tail > 0);
  assert.deepEqual(together.x.subarray(tail * FEATURES), second.x);
  assert.deepEqual(together.y.subarray(tail * TARGETS), second.y);
});

test('metrics refuse seeds overlapping the training data', () => {
  const ranges = trainingSeedRanges({
    dataProtocols: [{ seeds: [100, 199] }, { seeds: [300, 399] }],
  });
  assert.doesNotThrow(() => assertHeldOut([200, 299], ranges));
  assert.throws(() => assertHeldOut([150, 250], ranges));
  assert.throws(() => assertHeldOut([399, 400], ranges));
  assert.throws(() => trainingSeedRanges({}));
});

/** Late-game view with four unseen cards (two copies of one face), caps (2, 1, 1). */
function tinyView() {
  const unseen = [5, 5 + 54, 20, 40];
  const hand = [0];
  const played = deck.map((c) => c.id).filter((id) => !unseen.includes(id) && !hand.includes(id));
  return {
    view: { p: 0, hand, counts: [1, 2, 1, 1], level: 2, log: [{ p: 0, cards: played }] },
    unseen,
  };
}

const key = (view, hands) =>
  [1, 2, 3]
    .map((r) =>
      hands[(view.p + r) % 4]
        .slice()
        .sort((a, b) => a - b)
        .join('.'),
    )
    .join('|');

function frequencies(view, probs, worlds) {
  const counts = new Map();
  for (let s = 0; s < worlds / 1000; s++)
    for (const hands of sampleBeliefWorlds(view, probs, { count: 1000, seed: 77 + s })) {
      const k = key(view, hands);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  return counts;
}

/** Exact count-conditioned distribution by enumeration. */
function exact(view, unseen, probs) {
  const caps = [1, 2, 3].map((r) => view.counts[r]);
  const out = new Map();
  let total = 0;
  const visit = (i, hands, left) => {
    if (i === unseen.length) {
      let w = 1;
      for (let r = 0; r < 3; r++) for (const id of hands[r]) w *= probs[cardIndex(id) * 3 + r];
      const full = [view.hand, ...hands];
      const k = key(view, full);
      out.set(k, (out.get(k) || 0) + w);
      total += w;
      return;
    }
    for (let r = 0; r < 3; r++)
      if (left[r]) {
        const next = hands.map((h) => h.slice());
        next[r].push(unseen[i]);
        const l = left.slice();
        l[r]--;
        visit(i + 1, next, l);
      }
  };
  visit(0, [[], [], []], caps);
  for (const [k, v] of out) out.set(k, v / total);
  return out;
}

test('belief sampler respects counts and the unseen multiset exactly and is deterministic', async () => {
  const list = await positions([31, 32]);
  for (const [i, { view }] of list.entries()) {
    const random = seededRandom(i + 5);
    const probs = Float64Array.from({ length: TARGETS }, () => random() + 0.01);
    const worlds = sampleBeliefWorlds(view, probs, { count: 4, seed: i });
    assert.deepEqual(worlds, sampleBeliefWorlds(view, probs, { count: 4, seed: i }));
    const unseen = sampleWorlds(view, { count: 1, seed: 1 })[0]
      .filter((_, s) => s !== view.p)
      .flat()
      .sort((a, b) => a - b);
    for (const hands of worlds) {
      assert.deepEqual(hands[view.p], view.hand);
      hands.forEach((h, s) => assert.equal(h.length, view.counts[s]));
      assert.deepEqual(
        hands
          .filter((_, s) => s !== view.p)
          .flat()
          .sort((a, b) => a - b),
        unseen,
      );
    }
  }
  assert.throws(() =>
    sampleBeliefWorlds({ ...list[0].view, hands: [] }, uniformProbabilities(list[0].view), {
      seed: 1,
    }),
  );
  assert.throws(() => sampleBeliefWorlds(list[0].view, new Float64Array(10), { seed: 1 }));
});

test('uniform probabilities reduce to a uniform deal, matching sampleWorlds', () => {
  const { view } = tinyView();
  const n = 24000;
  const belief = frequencies(view, uniformProbabilities(view), n);
  const uniform = new Map();
  for (let s = 0; s < n / 1000; s++)
    for (const hands of sampleWorlds(view, { count: 1000, seed: 500 + s })) {
      const k = key(view, hands);
      uniform.set(k, (uniform.get(k) || 0) + 1);
    }
  // 4 physical cards, caps (2, 1, 1): 12 equally likely deals (copies of one face are distinct).
  assert.equal(belief.size, 12);
  assert.equal(uniform.size, 12);
  for (const [k, c] of belief) {
    assert.ok(Math.abs(c / n - 1 / 12) < 0.012, `${k} ${c / n}`);
    assert.ok(Math.abs(c / n - uniform.get(k) / n) < 0.015);
  }
});

test('non-uniform belief sampling matches the exact count-conditioned distribution', () => {
  const { view, unseen } = tinyView();
  const random = seededRandom(9);
  const probs = Float64Array.from({ length: TARGETS }, () => 0.05 + random());
  const n = 30000;
  const sampled = frequencies(view, probs, n),
    truth = exact(view, unseen, probs);
  assert.equal(sampled.size, truth.size);
  for (const [k, p] of truth) assert.ok(Math.abs((sampled.get(k) || 0) / n - p) < 0.012, k);
  // A confident belief concentrates the world on the believed seat.
  const sure = new Float64Array(TARGETS).fill(1 / 3);
  sure[cardIndex(20) * 3 + 2] = 1e6; // face of id 20 almost surely with the previous seat
  const worlds = sampleBeliefWorlds(view, sure, { count: 200, seed: 3 });
  assert.ok(worlds.every((hands) => hands[3].includes(20)));
});

test('metric helpers score probabilities, overlaps and percentiles', async () => {
  const [{ game, view }] = await positions([41], [40, 60]);
  const y = hiddenTarget(game, view.p);
  const truth = game.hands.map((h) => h.map((c) => c.id));
  const u = uniformProbabilities(view);
  const su = scoreProbabilities(u, y);
  const perfect = new Float64Array(TARGETS);
  for (let f = 0; f < FACES; f++) {
    const total = y[f * 3] + y[f * 3 + 1] + y[f * 3 + 2];
    for (let r = 0; r < 3; r++) perfect[f * 3 + r] = total ? y[f * 3 + r] / total : 1 / 3;
  }
  const sp = scoreProbabilities(perfect, y);
  assert.equal(su.copies, sp.copies);
  assert.ok(sp.logLikelihood > su.logLikelihood);
  assert.ok(sp.hits >= su.hits);
  assert.equal(overlap(worldTarget(view, truth), y), 1);
  const w = sampleWorlds(view, { count: 1, seed: 2 })[0];
  const o = overlap(worldTarget(view, w), y);
  assert.ok(o >= 0 && o <= 1);
  assert.equal(percentile(1, [0, 1, 2, 3]), 0.375);
  // The uniform model scores every count-consistent deal alike.
  const worlds = sampleWorlds(view, { count: 5, seed: 4 });
  const scores = worlds.map((h) => beliefLogScore(view, u, h));
  assert.equal(percentile(beliefLogScore(view, u, truth), scores), 0.5);
});
