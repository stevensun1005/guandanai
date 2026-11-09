import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';
import { seededRandom } from '../../shared/simulation/simulation.mjs';
import {
  ACTION_FIELDS,
  DENIAL_KINDS,
  FACES,
  FEATURES,
  FEATURES_V3,
  FEATURE_SPECS,
  HISTORY,
  LAYOUT,
  LAYOUT_V3,
  SEATS,
  TYPES,
  faceValue,
  featureSpec,
  features,
  featuresFor,
  publicActions,
  publicView,
} from '../belief/features.mjs';
import { generateBlock, playRecordedRound, writeBlock } from '../belief/generate.mjs';
import { resolveBeliefFeatures } from '../belief/sampler.mjs';

function randomChooser(seed) {
  const random = seededRandom(seed);
  return async (game, plays) => Math.floor(random() * plays.length);
}

async function positions(seeds, { band = [1, 108], every = 7 } = {}) {
  const out = [];
  for (const seed of seeds)
    await playRecordedRound(seed, {
      choose: randomChooser(seed),
      band,
      every,
      onTurn(game, view) {
        out.push({
          view,
          game: { ...game, hands: game.hands.map((h) => h.slice()), log: game.log.slice() },
        });
      },
    });
  return out;
}

test('v1 output is byte-identical to the pre-v3 features (golden hash) under every v1 spelling', async () => {
  // Golden computed with features.mjs before v3 was added (commit c66b7b3): 222 random-play views.
  const list = await positions([3, 4, 5, 21, 22], { every: 3 });
  assert.equal(list.length, 222);
  const hash = (fn) => {
    const h = createHash('sha256');
    for (const { view } of list) h.update(fn(view));
    return h.digest('hex');
  };
  const golden = '6b25f8f0b5943d33d6055f1e25973615f42f14492b59ed9a68332bf0f55600ad';
  assert.equal(hash(features), golden);
  assert.equal(
    hash((v) => featuresFor(v)),
    golden,
  );
  for (const version of ['v1', 'belief-v1', 1])
    assert.equal(
      hash((v) => featuresFor(v, { version })),
      golden,
    );
  // v3 extends v1: its first 1,238 bytes are the v1 vector.
  for (const { view } of list.slice(0, 60))
    assert.deepEqual(featuresFor(view, { version: 'v3' }).subarray(0, FEATURES), features(view));
});

test('v3 layout is contiguous, under 3,000 features, and the specs resolve by any spelling', () => {
  assert.equal(FEATURES, 1238);
  assert.equal(
    FEATURES_V3,
    1238 + SEATS * HISTORY * ACTION_FIELDS + DENIAL_KINDS.length * SEATS * FACES,
  );
  assert.equal(FEATURES_V3, 2984);
  assert.ok(FEATURES_V3 < 3000);
  let at = 0;
  for (const [name, [a, b]] of Object.entries(LAYOUT_V3)) {
    assert.equal(a, at, name);
    at = b;
  }
  assert.equal(at, FEATURES_V3);
  for (const key of Object.keys(LAYOUT)) assert.deepEqual(LAYOUT_V3[key], LAYOUT[key]);
  assert.equal(featureSpec().version, 'belief-v1');
  assert.equal(featureSpec('belief-v3'), FEATURE_SPECS.v3);
  assert.equal(featureSpec(3), FEATURE_SPECS.v3);
  assert.throws(() => featureSpec('v2'));
  assert.equal(FEATURE_SPECS.v1.faceBlocks.length, 5);
  assert.equal(FEATURE_SPECS.v3.faceBlocks.length, 5 + 9);
  for (const start of FEATURE_SPECS.v3.faceBlocks) assert.ok(start + FACES <= FEATURES_V3);
  assert.equal(faceValue(0, 2), 15); // heart 2 at level 2
  assert.equal(faceValue(1, 3), 2);
  assert.equal(faceValue(48, 2), 14);
  assert.equal(faceValue(52, 2), 16);
  assert.equal(faceValue(53, 9), 17);
});

test('v3 features are deterministic, public-only and invariant to permuting the hidden hands', async () => {
  const list = await positions([3, 4, 5, 6]);
  assert.ok(list.length > 25);
  const [{ view, game }] = list;
  assert.deepEqual(
    featuresFor(view, { version: 'v3' }),
    featuresFor(structuredClone(view), { version: 'v3' }),
  );
  assert.throws(() => featuresFor({ ...view, hands: game.hands }, { version: 'v3' }));
  let nonTrivialHistory = 0;
  for (const [i, { game }] of list.entries()) {
    const p = game.turn;
    const others = [1, 2, 3].map((r) => (p + r) % 4);
    const hidden = others.flatMap((s) => game.hands[s]);
    const random = seededRandom(2000 + i);
    for (let k = hidden.length - 1; k > 0; k--) {
      const j = Math.floor(random() * (k + 1));
      [hidden[k], hidden[j]] = [hidden[j], hidden[k]];
    }
    const permuted = { ...game, hands: game.hands.slice() };
    for (const s of others) permuted.hands[s] = hidden.splice(0, game.hands[s].length);
    const a = publicView(game, p),
      b = publicView(permuted, p);
    assert.deepEqual(a, b);
    const xa = featuresFor(a, { version: 'v3' });
    assert.deepEqual(xa, featuresFor(b, { version: 'v3' }));
    if (xa.subarray(...LAYOUT_V3.history).some(Boolean)) nonTrivialHistory++;
  }
  assert.ok(nonTrivialHistory > list.length / 2);
});

/** Relabel the non-heart suits of every physical card id (spade -> club -> diamond -> spade). */
function relabel(id) {
  const deckIndex = id >= 54 ? 54 : 0,
    n = id % 54;
  if (n >= 52) return id;
  const suit = Math.floor(n / 13),
    next = { 0: 2, 1: 1, 2: 3, 3: 0 }[suit]; // ids: 0 spades, 1 hearts, 2 clubs, 3 diamonds
  return deckIndex + next * 13 + (n % 13);
}

test('every face-indexed v3 block is listed in faceBlocks (suit relabelling is a block permutation)', async () => {
  const list = await positions([7, 8], { band: [1, 100], every: 9 });
  const faceMap = new Int32Array(FACES); // face of relabelled card
  for (let id = 0; id < 54; id++) faceMap[cardIndex(id)] = cardIndex(relabel(id));
  for (const { view } of list) {
    const moved = {
      ...view,
      hand: view.hand.map(relabel),
      log: view.log.map((e) => ({ ...e, cards: e.cards ? e.cards.map(relabel) : e.cards })),
    };
    const x = featuresFor(view, { version: 'v3' }),
      y = featuresFor(moved, { version: 'v3' });
    const expected = Uint8Array.from(x);
    for (const start of FEATURE_SPECS.v3.faceBlocks)
      for (let f = 0; f < FACES; f++) expected[start + faceMap[f]] = x[start + f];
    assert.deepEqual(y, expected);
  }
});

test('history slots and denial counts follow the public replay', () => {
  // Mover 0, level 2. Seat 1 leads single 10S, seat 2 passes (partner of 0, opponent of 1), seat 3
  // passes (partner's trick), seat 0 passes: trick closes. Seat 1 leads a pair of fives, seat 2
  // follows with a pair of nines (beats an opponent), seat 3 passes against seat 2's pair.
  const ten = 8,
    fives = [3, 57],
    nines = [7, 61];
  const hand = Array.from({ length: 27 }, (_, i) => 70 + i);
  const view = {
    p: 0,
    hand,
    counts: [27, 24, 25, 27],
    level: 2,
    log: [
      { p: 1, cards: [ten], type: 'single', value: 10, n: 1 },
      { p: 2, cards: null },
      { p: 3, cards: null },
      { p: 0, cards: null },
      { p: 1, cards: fives, type: 'pair', value: 5, n: 2 },
      { p: 2, cards: nines, type: 'pair', value: 9, n: 2 },
      { p: 3, cards: null },
    ],
  };
  const x = featuresFor(view, { version: 'v3' });
  const slot = (r, k) => LAYOUT_V3.history[0] + ((r - 1) * HISTORY + k) * ACTION_FIELDS;
  const fields = (r, k) => Array.from(x.subarray(slot(r, k), slot(r, k) + ACTION_FIELDS));
  // Seat 1 (r = 1): slot 0 = pair 5 lead, slot 1 = single 10 lead.
  let a = fields(1, 0);
  assert.equal(a[0], 1);
  assert.equal(a[1], 0);
  assert.equal(a[2 + TYPES.indexOf('pair')], 1);
  assert.equal(a[12 + 5 - 1], 1);
  assert.equal(a[29], 2);
  assert.equal(a[30], 1);
  assert.equal(a[31] + a[32], 0);
  assert.equal(a[33], 24);
  assert.equal(a[34], 2);
  a = fields(1, 1);
  assert.equal(a[2 + TYPES.indexOf('single')], 1);
  assert.equal(a[12 + 10 - 1], 1);
  assert.equal(a[33], 26);
  assert.equal(a[34], 6);
  assert.equal(fields(1, 2)[0], 0);
  // Seat 2 (r = 2): slot 0 = pair 9 following an opponent; slot 1 = pass against an opponent.
  a = fields(2, 0);
  assert.deepEqual([a[0], a[1], a[30], a[31], a[32], a[33], a[34]], [1, 0, 0, 0, 1, 25, 1]);
  a = fields(2, 1);
  assert.deepEqual([a[0], a[1], a[29], a[32], a[33]], [1, 1, 1, 1, 27]);
  assert.equal(a[2 + TYPES.indexOf('single')], 1);
  // Seat 3 (r = 3): slot 0 = pass against seat 2's pair 9 (opponent), slot 1 = pass on partner.
  a = fields(3, 0);
  assert.deepEqual([a[1], a[29], a[31], a[32], a[34]], [1, 2, 0, 1, 0]);
  assert.equal(a[12 + 9 - 1], 1);
  a = fields(3, 1);
  assert.deepEqual([a[1], a[31], a[32]], [1, 1, 0]);
  // The mover's own pass is not in any history slot.
  const present = [1, 2, 3].map((r) =>
    Array.from({ length: HISTORY }, (_, k) => x[slot(r, k)]).reduce((s, v) => s + v),
  );
  assert.deepEqual(present, [2, 2, 2]);
  // Denial: seat 2 passed an opponent's single 10 -> faces above 10 (J..A, level 2s, jokers).
  const denial = (kind, r, f) =>
    x[LAYOUT_V3.denial[0] + (DENIAL_KINDS.indexOf(kind) * SEATS + r - 1) * FACES + f];
  for (let f = 0; f < FACES; f++) {
    assert.equal(denial('single', 2, f), faceValue(f, 2) > 10 ? 1 : 0, `face ${f}`);
    assert.equal(denial('single', 3, f), 0); // passed the partner's single: no denial
    assert.equal(denial('pair', 3, f), faceValue(f, 2) > 9 ? 1 : 0); // seat 2 is seat 3's opponent
    assert.equal(denial('pair', 1, f) + denial('triple', 2, f), 0);
  }
  assert.equal(denial('single', 2, 0), 1); // heart 2 is the level card (15)
  assert.equal(denial('single', 2, cardIndex(ten)), 0);
});

test('the public replay recovers the engine lead flags and trick owners', async () => {
  // The engine logs `lead` but publicView strips it; the replay must rebuild it (and the owner
  // of the open trick each follow or pass answered) from public information alone.
  const list = await positions([31, 32, 33, 34], { every: 11 });
  let plays = 0;
  for (const { view, game } of list) {
    const actions = publicActions(view);
    assert.equal(actions.length, game.log.length);
    let owner = -1;
    for (const [i, entry] of game.log.entries()) {
      const a = actions[i];
      if (entry.cards?.length) {
        plays++;
        assert.equal(a.lead, entry.lead, `entry ${i}`);
        if (!entry.lead) assert.equal(a.owner, owner);
        owner = entry.p;
      } else assert.equal(a.owner, owner);
    }
  }
  assert.ok(plays > 200);
});

test('history keeps only the latest 12 actions per seat, most recent first', async () => {
  const [{ view }] = (await positions([12], { band: [1, 20], every: 1000 })).slice(-1);
  assert.ok(view.log.length > 40);
  const x = featuresFor(view, { version: 'v3' });
  for (let r = 1; r <= 3; r++) {
    const seat = (view.p + r) % 4;
    const own = view.log.map((e, i) => [e, i]).filter(([e]) => e.p === seat);
    const expect = own.slice(-HISTORY).reverse();
    for (let k = 0; k < HISTORY; k++) {
      const o = LAYOUT_V3.history[0] + ((r - 1) * HISTORY + k) * ACTION_FIELDS;
      if (k >= expect.length) {
        assert.equal(x[o], 0);
        continue;
      }
      const [entry, index] = expect[k];
      assert.equal(x[o], 1);
      assert.equal(x[o + 1], entry.cards?.length ? 0 : 1);
      assert.equal(x[o + 34], Math.min(255, view.log.length - 1 - index));
    }
  }
});

test('generation and shard metadata carry the feature version', async () => {
  const v1 = await generateBlock([7], { choose: randomChooser(1), band: [21, 80], every: 2 });
  const v3 = await generateBlock([7], {
    choose: randomChooser(1),
    band: [21, 80],
    every: 2,
    version: 'v3',
  });
  assert.equal(v1.featureVersion, 'belief-v1');
  assert.equal(v3.featureVersion, 'belief-v3');
  assert.equal(v1.rows, v3.rows);
  assert.equal(v3.x.length, v3.rows * FEATURES_V3);
  assert.deepEqual(v1.y, v3.y);
  for (let i = 0; i < v1.rows; i++)
    assert.deepEqual(
      v3.x.subarray(i * FEATURES_V3, i * FEATURES_V3 + FEATURES),
      v1.x.subarray(i * FEATURES, (i + 1) * FEATURES),
    );
  const dir = mkdtempSync(join(tmpdir(), 'belief-v3-'));
  try {
    assert.equal(writeBlock(dir, 7, 7, v3).featureVersion, 'belief-v3');
    assert.equal(writeBlock(dir, 8, 8, v1).features, FEATURES);
    assert.equal(readFileSync(join(dir, 'b7.x.u8')).length, v3.rows * FEATURES_V3);
    assert.throws(() => writeBlock(dir, 9, 9, { ...v3, featureVersion: 'belief-v1' }));
    assert.ok(!existsSync(join(dir, 'b9.x.u8')), 'a rejected block writes no shard files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('belief models resolve their feature version from option, report or input width', () => {
  const dir = mkdtempSync(join(tmpdir(), 'belief-v3-'));
  try {
    const onnx = join(dir, 'belief.onnx');
    // No report: default v1, or inferred from a known width.
    assert.equal(resolveBeliefFeatures(onnx).version, 'belief-v1');
    assert.equal(resolveBeliefFeatures(onnx, { inputWidth: 1238 }).version, 'belief-v1');
    assert.equal(resolveBeliefFeatures(onnx, { inputWidth: 2984 }).version, 'belief-v3');
    assert.throws(() => resolveBeliefFeatures(onnx, { inputWidth: 999 }));
    // Window-1 style report without a version field -> v1; v3 report next to the ONNX -> v3.
    writeFileSync(join(dir, 'train-report.json'), JSON.stringify({ features: 1238 }));
    assert.equal(resolveBeliefFeatures(onnx, { inputWidth: 1238 }).version, 'belief-v1');
    writeFileSync(join(dir, 'train-report.json'), JSON.stringify({ featureVersion: 'belief-v3' }));
    const spec = resolveBeliefFeatures(onnx, { inputWidth: 2984 });
    assert.equal(spec.version, 'belief-v3');
    assert.equal(spec.source, 'report');
    assert.throws(() => resolveBeliefFeatures(onnx, { inputWidth: 1238 }));
    // Explicit option and explicit report object take precedence over the adjacent file.
    assert.equal(resolveBeliefFeatures(onnx, { featureVersion: 'v1' }).version, 'belief-v1');
    assert.equal(
      resolveBeliefFeatures(onnx, { report: { featureVersion: 'belief-v1' } }).version,
      'belief-v1',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
