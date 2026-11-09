/**
 * Hand-inference network v1: public-view features and hidden-hand targets.
 *
 * The feature vector is computed from the MOVER'S public view only: own hand, every public log
 * entry (who played which cards as which shape, who passed), hand counts and the level. It never
 * reads another seat's hand; `publicView` copies only those fields out of a game, and `features`
 * rejects any object that carries `hands`.
 *
 * Relative seats: r = 1 next (p+1), 2 partner (p+2), 3 previous (p+3).
 * Faces use the champion's 54-face index (`cardIndex` in web/src/ai/encoding.mjs): both physical
 * copies of a face (ids f and f+54) share one index, so every count is 0..2 per face.
 *
 * Shape buckets (148), keyed by the play fields of combinations.js `analyze` (type, value, n):
 *   single  value 2..17  (2..14 natural, 15 level card, 16 small joker, 17 big joker)  16
 *   pair    value 2..17                                                                16
 *   triple  value 2..15                                                                14
 *   full    value 2..15  (value of the triple)                                         14
 *   straight start 1..10 (combinations.js stores the lowest start rank, A-low = 1)     10
 *   pairs3  start 1..12                                                                12
 *   trip2   start 1..13                                                                13
 *   bomb    n in {4, 5, 6+} x value 2..15                                              42
 *   sflush  start 1..10                                                                10
 *   jokers  one bucket                                                                  1
 * A pass is attributed to the open trick shape, which is always the most recent play in the log
 * (a pass is never a lead, and a play always becomes the open trick).
 *
 * Layout (1,238 uint8 features, all small integer counts):
 *   own hand face counts                                           54
 *   unseen face counts (2 - own - every played copy)               54
 *   faces played by r = 1..3                                       3 x 54
 *   hand counts of r = 0..3 (0 = mover)                            4
 *   out flags of r = 1..3                                          3
 *   level one-hot (2..14)                                          13
 *   shapes played by r = 1..3 (leads and follows)                  3 x 148
 *   passes by r = 1..3 against an OPPONENT's open trick, by shape  3 x 148
 *   passes by r = 1..3 against the PARTNER's open trick, by type   3 x 10
 *   leads by r = 1..3, by type                                     3 x 10
 * The order of actions is reduced to these counts in v1; a sequence model is a later version.
 *
 * Target: for each face and r = 1..3, how many of that face's unseen copies seat r holds (0..2).
 * The target is hidden information used only as a supervised label (owner-approved); it is never
 * an input.
 */
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { cardIndex } from '../../../web/src/ai/encoding.mjs';

export const FEATURE_VERSION = 'belief-v1';
export const FACES = 54;
export const SEATS = 3;
export const TARGETS = FACES * SEATS;

export const TYPES = [
  'single',
  'pair',
  'triple',
  'full',
  'straight',
  'pairs3',
  'trip2',
  'bomb',
  'sflush',
  'jokers',
];

const RANGES = {
  single: [2, 17],
  pair: [2, 17],
  triple: [2, 15],
  full: [2, 15],
  straight: [1, 10],
  pairs3: [1, 12],
  trip2: [1, 13],
  sflush: [1, 10],
};
const BOMB_SIZES = 3;
const BUCKET_OFFSET = {};
let buckets = 0;
for (const type of TYPES) {
  BUCKET_OFFSET[type] = buckets;
  if (type === 'bomb') buckets += BOMB_SIZES * 14;
  else if (type === 'jokers') buckets += 1;
  else buckets += RANGES[type][1] - RANGES[type][0] + 1;
}
export const SHAPE_BUCKETS = buckets;

/** Bucket index of a play shape {type, value, n}. Throws on a shape outside the documented scheme. */
export function shapeBucket({ type, value, n }) {
  const base = BUCKET_OFFSET[type];
  if (base === undefined) throw Error(`Unknown play type ${type}`);
  if (type === 'jokers') return base;
  if (type === 'bomb') {
    if (!(n >= 4 && n <= 10) || !(value >= 2 && value <= 15)) throw Error('Bomb outside buckets');
    return base + (Math.min(n, 6) - 4) * 14 + (value - 2);
  }
  const [lo, hi] = RANGES[type];
  if (!Number.isInteger(value) || value < lo || value > hi)
    throw Error(`Shape value outside buckets: ${type} ${value}`);
  return base + value - lo;
}

const blocks = [
  ['own', FACES],
  ['unseen', FACES],
  ['played', SEATS * FACES],
  ['counts', 4],
  ['out', SEATS],
  ['level', 13],
  ['shapes', SEATS * SHAPE_BUCKETS],
  ['passOpponent', SEATS * SHAPE_BUCKETS],
  ['passPartner', SEATS * TYPES.length],
  ['leads', SEATS * TYPES.length],
];
export const LAYOUT = {};
let width = 0;
for (const [name, size] of blocks) {
  LAYOUT[name] = [width, width + size];
  width += size;
}
export const FEATURES = width;

const isCards = (cards) => Array.isArray(cards) && cards.length > 0;

/** Copy only the mover's public view out of a simulated game (cards become physical ids). */
export function publicView(game, seat) {
  return {
    p: seat,
    hand: game.hands[seat].map((card) => card.id),
    counts: game.hands.map((hand) => hand.length),
    level: game.L,
    log: game.log.map((e) => ({
      p: e.p,
      cards: e.cards?.length ? e.cards.map((card) => card.id) : null,
      ...(e.cards?.length ? { type: e.type, value: e.value, n: e.n } : {}),
    })),
  };
}

/** Shape of a public play; a missing shape is inferred only when it is unambiguous. */
function playShape(entry, previous, level, deck) {
  if (entry.type) return { type: entry.type, value: entry.value, n: entry.n ?? entry.cards.length };
  if (!deck) throw Error('Public play without shape and no deck to infer it');
  const valid = analyze(
    entry.cards.map((id) => deck[id]),
    level,
  ).filter((s) => beats(s, previous));
  if (valid.length !== 1) throw Error('Missing or ambiguous public shape; refusing to guess');
  return valid[0];
}

/**
 * Feature vector (Uint8Array(FEATURES)) of a public view {p, hand, counts, level, log}.
 * Deterministic: the same public view always gives the same bytes.
 */
export function features(view, { deck = null } = {}) {
  if (!view || 'hands' in view) throw Error('Belief features accept only a public view');
  const { p, hand, counts, level, log } = view;
  if (!Number.isInteger(p) || p < 0 || p > 3) throw Error('Invalid mover');
  if (hand.length !== counts[p]) throw Error('Own count does not match own hand');
  if (!(level >= 2 && level <= 14)) throw Error('Invalid level');
  const x = new Uint8Array(FEATURES);
  const rel = (seat) => (seat - p + 4) % 4;
  const own = LAYOUT.own[0],
    unseen = LAYOUT.unseen[0],
    played = LAYOUT.played[0];
  const seen = new Int16Array(FACES);
  for (const id of hand) {
    x[own + cardIndex(id)]++;
    seen[cardIndex(id)]++;
  }
  // Public replay of trick boundaries, mirroring advanceRound: a trick closes once every other
  // seat that still holds cards has passed since the last play; the next play is then a lead.
  const left = counts.slice();
  for (const entry of log) if (isCards(entry.cards)) left[entry.p] += entry.cards.length;
  let open = null,
    owner = -1,
    passes = 0;
  for (const entry of log) {
    const r = rel(entry.p);
    if (isCards(entry.cards)) {
      const shape = playShape(entry, open, level, deck);
      for (const id of entry.cards) {
        seen[cardIndex(id)]++;
        if (r) x[played + (r - 1) * FACES + cardIndex(id)]++;
      }
      if (r) {
        x[LAYOUT.shapes[0] + (r - 1) * SHAPE_BUCKETS + shapeBucket(shape)]++;
        if (!open) x[LAYOUT.leads[0] + (r - 1) * TYPES.length + TYPES.indexOf(shape.type)]++;
      }
      left[entry.p] -= entry.cards.length;
      open = shape;
      owner = entry.p;
      passes = 0;
    } else {
      if (!open) throw Error('Public pass without an open trick');
      if (r) {
        if ((owner - entry.p + 4) % 2)
          x[LAYOUT.passOpponent[0] + (r - 1) * SHAPE_BUCKETS + shapeBucket(open)]++;
        else x[LAYOUT.passPartner[0] + (r - 1) * TYPES.length + TYPES.indexOf(open.type)]++;
      }
      passes++;
    }
    const others = [0, 1, 2, 3].filter((s) => s !== owner && left[s] > 0).length;
    if (passes >= others) {
      open = null;
      passes = 0;
    }
  }
  let hidden = 0;
  for (let f = 0; f < FACES; f++) {
    if (seen[f] > 2) throw Error('More than two copies of a face seen');
    x[unseen + f] = 2 - seen[f];
    hidden += 2 - seen[f];
  }
  if (hidden !== counts.reduce((n, c, s) => n + (s === p ? 0 : c), 0))
    throw Error('Public counts do not conserve 108 physical cards');
  for (let r = 0; r < 4; r++) x[LAYOUT.counts[0] + r] = counts[(p + r) % 4];
  for (let r = 1; r < 4; r++) x[LAYOUT.out[0] + r - 1] = counts[(p + r) % 4] === 0 ? 1 : 0;
  x[LAYOUT.level[0] + level - 2] = 1;
  return x;
}

/** Target (Uint8Array(162), index face * 3 + r - 1): unseen copies of each face held by seat r. */
export function hiddenTarget(game, seat) {
  const y = new Uint8Array(TARGETS);
  for (let r = 1; r < 4; r++)
    for (const card of game.hands[(seat + r) % 4]) y[cardIndex(card.id) * SEATS + r - 1]++;
  return y;
}

/** Unseen copies per face (sum of the target over seats), from public information only. */
export function unseenCounts(x) {
  return x.subarray(LAYOUT.unseen[0], LAYOUT.unseen[1]);
}
