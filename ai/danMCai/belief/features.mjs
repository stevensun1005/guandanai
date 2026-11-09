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
 * The order of actions is reduced to these counts in v1. belief-v3 (`featuresFor(view, {version:
 * 'v3'})`, documented below) appends the ordered per-seat action history and per-face denial counts;
 * `features` itself is and stays the v1 vector.
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

/* ------------------------------------------------------------------------------------------------
 * belief-v3: v1 plus ORDERED public history and per-face "denial" counts.
 *
 * The v3 vector is the v1 vector (bytes 0..1,237, identical) followed by two blocks:
 *
 *   history  3 seats x HISTORY slots x ACTION_FIELDS        3 x 12 x 35 = 1,260
 *     For relative seat r = 1..3, that seat's last HISTORY public actions (plays and passes),
 *     slot 0 = most recent. Fields of one action (all uint8):
 *       0      present (1 if the slot holds an action)
 *       1      pass
 *       2..11  type one-hot (the play's type; for a pass, the type of the open trick it passed)
 *       12..28 value one-hot 1..17 (play value, or the open trick's value for a pass; none for
 *              jokers, whose value is not a rank)
 *       29     number of cards (the play's, or the open trick's for a pass)
 *       30     lead (play into an empty trick)
 *       31     the open trick it followed or passed belonged to the actor's PARTNER
 *       32     the open trick it followed or passed belonged to an OPPONENT of the actor
 *       33     the actor's cards left after the action
 *       34     plies ago (log entries after this one, capped at 255)
 *   denial   3 kinds x 3 seats x 54 faces                         486
 *     kind k = single, pair, triple. denial[k][r][f] counts the passes of seat r against an
 *     OPPONENT's open trick of kind k whose value is below the value of face f under the level
 *     (level rank = 15, jokers 16/17), i.e. how many times r declined a trick that a single / pair
 *     / triple of face f would have beaten in rank (wild cards and bombs are ignored; the count is
 *     a public statistic, not a claim that r cannot hold f). Capped at 255.
 *
 * Total 2,984 uint8 features. Everything is computed from the same public view as v1 (own hand,
 * public log with shapes, hand counts, level); hidden hands never enter. Each (kind, seat) denial
 * block is a 54-face block in the champion face order, so the trainer's suit permutation applies
 * to it like to the v1 face blocks (FEATURE_SPECS.v3.faceBlocks).
 * ---------------------------------------------------------------------------------------------- */
export const HISTORY = 12;
export const ACTION_FIELDS = 35;
export const DENIAL_KINDS = ['single', 'pair', 'triple'];
const V1_FEATURES = FEATURES;

export const LAYOUT_V3 = { ...LAYOUT };
LAYOUT_V3.history = [V1_FEATURES, V1_FEATURES + SEATS * HISTORY * ACTION_FIELDS];
LAYOUT_V3.denial = [
  LAYOUT_V3.history[1],
  LAYOUT_V3.history[1] + DENIAL_KINDS.length * SEATS * FACES,
];
export const FEATURES_V3 = LAYOUT_V3.denial[1];

/** Start offsets of every 54-face block (suit permutations act on these). */
const V1_FACE_BLOCKS = [
  LAYOUT.own[0],
  LAYOUT.unseen[0],
  ...[0, 1, 2].map((r) => LAYOUT.played[0] + r * FACES),
];

export const FEATURE_SPECS = {
  v1: {
    version: 'belief-v1',
    features: FEATURES,
    layout: LAYOUT,
    faceBlocks: V1_FACE_BLOCKS,
  },
  v3: {
    version: 'belief-v3',
    features: FEATURES_V3,
    layout: LAYOUT_V3,
    faceBlocks: [
      ...V1_FACE_BLOCKS,
      ...Array.from(
        { length: DENIAL_KINDS.length * SEATS },
        (_, k) => LAYOUT_V3.denial[0] + k * FACES,
      ),
    ],
  },
};

/** Feature spec of 'v1' | 'v3' | 'belief-v1' | 'belief-v3' | 1 | 3 (default v1). */
export function featureSpec(version = 'v1') {
  const key = String(version ?? 'v1')
    .replace(/^belief-/, '')
    .replace(/^(\d)$/, 'v$1');
  const spec = FEATURE_SPECS[key];
  if (!spec) throw Error(`Unknown belief feature version ${version}`);
  return spec;
}

/** Rank value of a champion face index under the level (as combinations.js `val`). */
export function faceValue(f, level) {
  if (f === 52) return 16;
  if (f === 53) return 17;
  const rank = Math.floor(f / 4) + 2;
  return rank === level ? 15 : rank;
}

/**
 * Annotated public replay: one record per log entry with the actor's relative seat, pass flag,
 * the shape (play) or open trick shape (pass), lead flag, the open trick owner before the action,
 * and the actor's cards left after it. Mirrors the v1 replay exactly (same trick boundaries).
 */
export function publicActions(view, { deck = null } = {}) {
  const { p, counts, level, log } = view;
  const rel = (seat) => (seat - p + 4) % 4;
  const left = counts.slice();
  for (const entry of log) if (isCards(entry.cards)) left[entry.p] += entry.cards.length;
  const out = [];
  let open = null,
    openCards = 0,
    owner = -1,
    passes = 0;
  for (const entry of log) {
    const record = { seat: entry.p, r: rel(entry.p), owner, open };
    if (isCards(entry.cards)) {
      const shape = playShape(entry, open, level, deck);
      left[entry.p] -= entry.cards.length;
      Object.assign(record, { pass: false, shape, n: entry.cards.length, lead: !open });
      open = shape;
      openCards = entry.cards.length;
      owner = entry.p;
      passes = 0;
    } else {
      if (!open) throw Error('Public pass without an open trick');
      Object.assign(record, { pass: true, shape: open, n: openCards, lead: false });
      passes++;
    }
    record.left = left[entry.p];
    out.push(record);
    const others = [0, 1, 2, 3].filter((s) => s !== owner && left[s] > 0).length;
    if (passes >= others) {
      open = null;
      passes = 0;
    }
  }
  return out;
}

const cap = (v) => Math.min(255, v);

/** v3 feature vector (Uint8Array(FEATURES_V3)); bytes 0..1,237 equal features(view). */
function featuresV3(view, options) {
  const x = new Uint8Array(FEATURES_V3);
  x.set(features(view, options), 0); // also validates the view
  const actions = publicActions(view, options);
  const H = LAYOUT_V3.history[0],
    D = LAYOUT_V3.denial[0];
  const filled = [0, 0, 0];
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    if (!a.r || filled[a.r - 1] >= HISTORY) continue;
    const o = H + ((a.r - 1) * HISTORY + filled[a.r - 1]++) * ACTION_FIELDS;
    x[o] = 1;
    x[o + 1] = a.pass ? 1 : 0;
    x[o + 2 + TYPES.indexOf(a.shape.type)] = 1;
    if (a.shape.type !== 'jokers' && a.shape.value >= 1 && a.shape.value <= 17)
      x[o + 12 + a.shape.value - 1] = 1;
    x[o + 29] = cap(a.n);
    x[o + 30] = a.lead ? 1 : 0;
    if (!a.lead && a.owner >= 0) x[o + ((a.owner - a.seat + 4) % 2 ? 32 : 31)] = 1;
    x[o + 33] = a.left;
    x[o + 34] = cap(actions.length - 1 - i);
  }
  for (const a of actions) {
    if (!a.r || !a.pass || !((a.owner - a.seat + 4) % 2)) continue;
    const k = DENIAL_KINDS.indexOf(a.shape.type);
    if (k < 0) continue;
    const o = D + (k * SEATS + a.r - 1) * FACES;
    for (let f = 0; f < FACES; f++)
      if (faceValue(f, view.level) > a.shape.value && x[o + f] < 255) x[o + f]++;
  }
  return x;
}

/**
 * Versioned features: v1 (default, byte-identical to `features`) or v3. Accepts the same public
 * view and options as `features`, plus `version`.
 */
export function featuresFor(view, { version = 'v1', deck = null } = {}) {
  const spec = featureSpec(version);
  return spec.version === 'belief-v3' ? featuresV3(view, { deck }) : features(view, { deck });
}
