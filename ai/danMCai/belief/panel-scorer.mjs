/**
 * Window 3, S7 (M5): descriptive scorer of a candidate network on the held-out human panel.
 * DESCRIPTIVE ONLY: nothing here is a reward, loss, gate or acceptance metric (AGENTS.md: trick
 * wins, bombs, jokers, cover and hand shape are intermediate signals; S6 is the only acceptance).
 *
 * Panel (registered before any 017w existed, RT/window3-20261109/human-panel.json, M3):
 *   - the 1,458 unassisted human real decisions (> 1 legal candidate) of the 31 recorded rounds,
 *     rebuilt by replaying the private records exactly as the W3 audit did
 *     (human-endgames.mjs loadRecord/replay/matchCandidate, de-duplicated by record id, snapshot
 *     20261108 then 20261109, files sorted); checked row by row against the frozen audit rows;
 *   - the 269 unassisted human lead positions of the lead audit (lead, > 1 candidate, no finishing
 *     move), checked against the frozen lead rows;
 *   - the solver panels: the section-67 critical decisions (115) and, when present, the S7a set.
 *
 * A model's choice at a position is the web/evaluator convention: the finishing move if one exists,
 * else the single candidate, else the first arg-max of its values. Models are scored as follows:
 *   - no `extras` input (champion 017): championValues on policyState, exactly as the audit;
 *   - a 215-wide `extras` input (017w, the wrapped initial): exactly midgame-search.mjs
 *     focalRawDecision: masked game, 53 public extras (encodePolicyExtrasBatch via
 *     rawPolicyState) + 162 beliefMarginals(--belief, publicView(masked game, mover)), from the
 *     mover's public view only (createFocalRawScorer).
 * Champion 017 (the reference) is always scored; every other model is reported against it.
 *
 * Measures per model (definitions of the W3 audit and lead audit, unchanged):
 *   bomb rate at the bomb-legal follows; joker on an opponent's single/pair of K or lower; structure
 *   cost per play (plays-to-empty after the play minus (before - 1)); agreement with the human move;
 *   uncovered multi-card lead rate and the owner's pattern (a controlling single/pair was available
 *   and an uncovered multi-card combination was led) at the lead positions; optimal-move rate on the
 *   solver panels (value of the chosen move = row value when the choice equals 017's or the human's
 *   move, else one exact null-window check `keepsValue` with the panel's budget, capped by
 *   --solve-minutes in total; budget overruns are counted as unscored). Belief v1 log loss per
 *   unseen copy on the 1,458 positions (network probabilities vs the uniform baseline, truth from
 *   the records; no model involved). Paired differences model minus 017 with a round-cluster
 *   bootstrap (2,000 draws). Output: aggregates only; positions only by anonymous index; no
 *   nickname, room, record id, match id or file name.
 *
 *   node panel-scorer.mjs --model=<onnx>[,<label>=<onnx>...] --out=<report.json>
 *        [--parity=1] [--belief=<onnx>] [--audit-rows=<json>] [--lead-rows=<jsonl>]
 *        [--raw=<dir>,<dir>] [--panel=<human-panel.json>] [--solver-rows=<rows.json>]
 *        [--s7a-rows=<rows.json>|none] [--solve-minutes=10] [--deadline=<ISO>]
 *        [--stop-file=<path>[,<path>]] [--positions-out=<json>]
 *
 * --parity=1 (S7 acceptance of the scorer itself, M5): the model must reproduce 017's choices on
 * every panel position and the audit's published 017 numbers; the report gains `identical` and
 * `positions` (the 1,458) and the process exits 1 when anything differs.
 *
 * Imports resolve against the repository root: the root of this file's checkout when it sits in
 * ai/danMCai/belief/, else $PANEL_SCORER_ROOT, else the working directory (the window-3 copy
 * RT/window3-20261109/S7/scorer.mjs is run from the frozen checkout src-b).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REQUIRED = ['ai/danMCai/belief/midgame-search.mjs', 'web/src/ai/candidates.js'];
export function findRoot(self = SELF) {
  const options = [
    resolve(dirname(self), '../../..'),
    process.env.PANEL_SCORER_ROOT,
    process.cwd(),
  ].filter(Boolean);
  for (const root of options) if (REQUIRED.every((f) => existsSync(join(root, f)))) return root;
  throw Error(`No repository root found (tried ${options.join(', ')})`);
}
export const ROOT = findRoot();
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const [
  { loadRecord, replay, matchCandidate },
  { createSolver, positionFromGame, SolverBudget },
  { candidates },
  { policyState },
  { championValues },
  { isBomb },
  { isWild },
  { publicView, hiddenTarget },
  { beliefMarginals, createBeliefModel, uniformProbabilities },
  { scoreProbabilities },
  { createFocalRawScorer, maskHidden, rawPolicyState, FOCAL_RAW_EXTRAS, DEFAULT_CHAMPION },
] = await Promise.all(
  [
    'ai/danMCai/endgame/human-endgames.mjs',
    'ai/danMCai/endgame/solver.mjs',
    'web/src/ai/candidates.js',
    'web/src/ai/observation.js',
    'web/src/ai/search/inference.mjs',
    'web/src/core/combinations.js',
    'web/src/core/cards.js',
    'ai/danMCai/belief/features.mjs',
    'ai/danMCai/belief/sampler.mjs',
    'ai/danMCai/belief/metrics.mjs',
    'ai/danMCai/belief/midgame-search.mjs',
  ].map(load),
);
async function loadOrt() {
  const file = createRequire(join(ROOT, 'package.json')).resolve('onnxruntime-node');
  const mod = await import(pathToFileURL(file).href);
  return mod.InferenceSession ? mod : mod.default;
}

const RT = '/Users/stevensun/guandan-runtime.noindex/window3-20261109';
const HG = '/Users/stevensun/Desktop/guandanai/ai/shared/data/human-games';
export const DEFAULTS = Object.freeze({
  belief: '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx',
  auditRows: `${RT}/inputs/w3design/audit-rows.json`,
  leadRows:
    '/Users/stevensun/guandan-runtime.noindex/window3-prep-20261109/lead-audit/rows-human.jsonl',
  raw: process.env.PANEL_SCORER_RAW
    ? process.env.PANEL_SCORER_RAW.split(',')
    : [`${HG}/d1-snapshot-20261108/raw`, `${HG}/d1-snapshot-20261109/raw`],
  panel: `${RT}/human-panel.json`,
  solverRows:
    '/Users/stevensun/Desktop/guandanai/ai/danMCai/workspace/human-endgame-optimality-20261108/rows.json',
  s7aRows: `${RT}/S7a/rows.json`,
  // budgets of the panels (section 67 run.json; S7a s7a.sh); a re-check uses the panel's budget
  solverBudget: { maxNodes: 5_000_000, maxMs: 30_000 },
  s7aBudget: { maxNodes: 50_000_000, maxMs: 300_000 },
});
/** The audit's published 017 numbers (W3 audit, lead audit, MODEL_STUDY section 67). */
export const PUBLISHED_017 = Object.freeze({
  decisions: 1458,
  bomb: [368, 1022],
  joker: [22, 88],
  structureCost: [506, 1026],
  agreement: [651, 1458],
  leads: 269,
  uncoveredMultiLead: [40, 269],
  ownerPattern: [24, 269],
  solverCritical: [84, 115],
});

export const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);
const band = (total) =>
  total > 80 ? '>80' : total > 60 ? '61-80' : total > 40 ? '41-60' : total > 20 ? '21-40' : '<=20';
const without = (hand, play) => {
  if (!play) return hand;
  const ids = new Set(play.cards.map((c) => c.id));
  return hand.filter((c) => !ids.has(c.id));
};
/** First maximum (lib.mjs argmax convention). */
export function firstMax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}
/** Web/evaluator choice: finishing move, single candidate, else first arg-max of `values`. */
export function choiceIndex(plays, handLength, values) {
  const finish = plays.findIndex((p) => p && p.cards.length === handLength);
  if (finish >= 0) return finish;
  if (plays.length === 1) return 0;
  return firstMax(values);
}

/* ---------------------------------------------------------------------------------------------
 * Plays-to-empty (copied unchanged from the W3 audit's w3-minplays.mjs): exact minimum number of
 * legal plays that empty a hand, ignoring other seats; ties toward fewer singles, then fewer low
 * singles. Suits are ignored.
 * ------------------------------------------------------------------------------------------- */
const memo = new Map();
const COST_PLAY = 10000,
  COST_SINGLE = 100;
function solve(cnt, sj, bj, w, L) {
  const key = cnt.join('') + '|' + sj + bj + w + '|' + L;
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let r = 0;
  for (let i = 2; i <= 14; i++)
    if (cnt[i]) {
      r = i;
      break;
    }
  if (!r) {
    let cost = 0;
    if (sj === 2 && bj === 2) cost += COST_PLAY;
    else {
      if (sj) cost += COST_PLAY + (sj === 1 ? COST_SINGLE : 0);
      if (bj) cost += COST_PLAY + (bj === 1 ? COST_SINGLE : 0);
    }
    if (w) cost += COST_PLAY + (w === 1 ? COST_SINGLE : 0);
    memo.set(key, cost);
    return cost;
  }
  let best = Infinity;
  const c = cnt[r];
  const tryRest = (extra) => {
    const v = COST_PLAY + extra + solve(cnt, sj, bj, w, L);
    if (v < best) best = v;
  };
  for (let j = 1; j <= c; j++) {
    for (let x = 0; x <= (j === c ? w : 0); x++) {
      const n = j + x;
      cnt[r] -= j;
      w -= x;
      tryRest(n === 1 ? COST_SINGLE + (r < 11 && r !== L ? 1 : 0) : 0);
      if (n === 3) {
        for (let p = 2; p <= 14; p++) {
          if (p === r || !cnt[p]) continue;
          const jp = Math.min(2, cnt[p]),
            xp = 2 - jp;
          if (xp > w) continue;
          cnt[p] -= jp;
          w -= xp;
          tryRest(0);
          cnt[p] += jp;
          w += xp;
        }
        if (w >= 2) {
          w -= 2;
          tryRest(0);
          w += 2;
        }
        if (sj === 2) {
          sj = 0;
          tryRest(0);
          sj = 2;
        }
        if (bj === 2) {
          bj = 0;
          tryRest(0);
          bj = 2;
        }
      }
      if (n === 2) {
        for (let t = 2; t <= 14; t++) {
          if (t === r || !cnt[t]) continue;
          const jt = Math.min(3, cnt[t]),
            xt = 3 - jt;
          if (xt > w) continue;
          cnt[t] -= jt;
          w -= xt;
          tryRest(0);
          cnt[t] += jt;
          w += xt;
        }
      }
      cnt[r] += j;
      w += x;
    }
  }
  for (const [len, need] of [
    [5, 1],
    [3, 2],
    [2, 3],
  ]) {
    for (let s = 1; s + len - 1 <= 14; s++) {
      let inside = false,
        wilds = 0;
      const used = [];
      for (let o = 0; o < len; o++) {
        const rank = s + o === 1 ? 14 : s + o;
        if (rank === r) inside = true;
        const j = Math.min(need, cnt[rank]);
        wilds += need - j;
        used.push([rank, j]);
      }
      if (!inside || wilds > w) continue;
      for (const [rank, j] of used) cnt[rank] -= j;
      w -= wilds;
      tryRest(0);
      for (const [rank, j] of used) cnt[rank] += j;
      w += wilds;
    }
  }
  memo.set(key, best);
  return best;
}
export function minPlays(hand, L) {
  if (!hand.length) return { plays: 0, singles: 0, lowSingles: 0 };
  const cnt = new Array(15).fill(0);
  let sj = 0,
    bj = 0,
    w = 0;
  for (const card of hand) {
    if (card.r === 16) sj++;
    else if (card.r === 17) bj++;
    else if (isWild(card, L)) w++;
    else cnt[card.r]++;
  }
  const cost = solve(cnt, sj, bj, w, L);
  return {
    plays: Math.floor(cost / COST_PLAY),
    singles: Math.floor((cost % COST_PLAY) / COST_SINGLE),
    lowSingles: cost % COST_SINGLE,
  };
}
/** Structure cost of a play: extra plays-to-empty it adds (0 for a pass, not counted as a play). */
export const structureCost = (hand, play, L, before = minPlays(hand, L)) =>
  play ? minPlays(without(hand, play), L).plays - (before.plays - 1) : 0;

/* ---------------------------------------------------------------------------------------------
 * Lead classification (copied unchanged from the lead audit's lead-audit.mjs classify): W1 own
 * same-type cover after the lead, u the highest same-type non-bomb reply formable from the union of
 * the other hands, boss = no reply exists, W2, bomb kept, uncovered = no W1 and no bomb.
 * ------------------------------------------------------------------------------------------- */
export const MULTI = new Set(['full', 'straight', 'pairs3', 'trip2']);
export function classifyLead(hand, play, unseen, L, cache = new Map()) {
  if (isBomb(play)) return { type: 'bombish', bomb: true };
  const after = without(hand, play);
  const own = candidates(after, L, play);
  const same = own.filter((p) => p && !isBomb(p) && p.type === play.type);
  const bomb = own.some((p) => p && isBomb(p));
  const ck = play.type + ':' + play.value + ':' + play.n;
  let u = cache.get(ck);
  if (u === undefined && (play.type === 'single' || play.type === 'pair')) {
    const cnt = {};
    let wild = 0;
    for (const c of unseen) {
      if (isWild(c, L)) wild++;
      else {
        const v = c.r >= 16 ? c.r : c.r === L ? 15 : c.r;
        cnt[v] = (cnt[v] || 0) + 1;
      }
    }
    let best = null;
    for (const [k, n] of Object.entries(cnt)) {
      const v = Number(k);
      const ok = play.type === 'single' ? n >= 1 : n >= 2 || (v < 16 && n >= 1 && wild >= 1);
      if (ok && (best === null || v > best)) best = v;
    }
    if (play.type === 'single' && wild && (best === null || 15 > best)) best = 15;
    if (play.type === 'pair' && wild >= 2 && (best === null || 15 > best)) best = 15;
    u = best !== null && best > play.value ? best : null;
    cache.set(ck, u);
  }
  if (u === undefined) {
    const theirs = candidates(unseen, L, play).filter(
      (p) => p && !isBomb(p) && p.type === play.type,
    );
    u = theirs.length ? Math.max(...theirs.map((p) => p.value)) : null;
    cache.set(ck, u);
  }
  const m = same.length ? Math.max(...same.map((p) => p.value)) : null;
  const w1 = same.length > 0;
  const boss = u === null;
  return {
    type: play.type,
    value: play.value,
    n: play.n,
    w1,
    m,
    u,
    boss,
    w2: boss || (w1 && m >= u),
    w2strict: boss || (w1 && m > u),
    bomb,
    uncovered: !w1 && !bomb,
  };
}
/** Controlling single / pair lead alternatives (W2 status) at a lead position. */
export function controllingAlternatives(hand, plays, unseen, L, cache) {
  let ctlSingle = false,
    ctlPair = false;
  const seen = new Set();
  for (const p of plays) {
    if (!p || isBomb(p) || (p.type !== 'single' && p.type !== 'pair')) continue;
    const k = p.type + p.value + p.cards.map((c) => (isWild(c, L) ? 'w' : '')).join('');
    if (seen.has(k)) continue;
    seen.add(k);
    if (classifyLead(hand, p, unseen, L, cache).w2) {
      if (p.type === 'single') ctlSingle = true;
      else ctlPair = true;
    }
  }
  return { ctlSingle, ctlPair };
}
const uncoveredMulti = (c) => MULTI.has(c.type) && c.uncovered === true;

/* ---------------------------------------------------------------------------------------------
 * Models
 * ------------------------------------------------------------------------------------------- */
function extrasWidth(session) {
  if (!session.inputNames.includes('extras')) return 0;
  const metadata = session.inputMetadata;
  const list = Array.isArray(metadata) ? metadata : Object.values(metadata ?? {});
  const width = list.find((m) => m?.name === 'extras')?.shape?.[1];
  return typeof width === 'number' ? width : -1;
}
/** Scorer for one network; `marginalsOf(key, game, player)` supplies cached belief marginals. */
export async function createModelScorer(ort, file, label, marginalsOf) {
  const session = await ort.InferenceSession.create(file, {
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
  });
  const width = extrasWidth(session);
  const info = { label, path: file, sha256: sha256(file), extrasWidth: width };
  if (width === 0) {
    const values = championValues(ort, session);
    return {
      ...info,
      scoring: 'no extras: championValues(policyState) as the W3 audit',
      async values(key, game, player, plays) {
        return Array.from(await values(policyState(game, player, 0, plays)));
      },
      close: () => session.release(),
    };
  }
  await session.release();
  if (width !== FOCAL_RAW_EXTRAS)
    throw Error(`${label}: extras width ${width} is not supported (0 or ${FOCAL_RAW_EXTRAS})`);
  const raw = await createFocalRawScorer(ort, file, { threads: 1 });
  return {
    ...info,
    scoring:
      'focal raw 215: midgame-search.mjs createFocalRawScorer on rawPolicyState(masked game) with ' +
      '53 public extras + 162 beliefMarginals(belief, publicView(masked game, mover))',
    async values(key, game, player, plays) {
      const masked = maskHidden(game, player);
      const marginals = await marginalsOf(key, masked, player);
      return Array.from(await raw.values(rawPolicyState(masked, player, plays), marginals));
    },
    close: () => raw.close(),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Statistics
 * ------------------------------------------------------------------------------------------- */
function mulberry(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/**
 * Round-cluster bootstrap of a statistic of per-cluster sums. `items` = [{cluster, ...}],
 * `stat(sums)` receives the summed fields (`fields`) over a resample; returns [lo, hi] (95%).
 */
export function clusterBootstrap(items, fields, stat, { draws = 2000, seed = 20261110 } = {}) {
  const byCluster = new Map();
  for (const item of items) {
    const sums = byCluster.get(item.cluster) || Object.fromEntries(fields.map((f) => [f, 0]));
    for (const f of fields) sums[f] += item[f] || 0;
    byCluster.set(item.cluster, sums);
  }
  const clusters = [...byCluster.values()];
  if (clusters.length < 2) return null;
  const random = mulberry(seed);
  const stats = [];
  for (let d = 0; d < draws; d++) {
    const total = Object.fromEntries(fields.map((f) => [f, 0]));
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[Math.floor(random() * clusters.length)];
      for (const f of fields) total[f] += c[f];
    }
    const v = stat(total);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  return stats.length
    ? [stats[Math.floor(0.025 * stats.length)], stats[Math.ceil(0.975 * stats.length) - 1]]
    : null;
}
/** Rate with a round-cluster interval from per-position {cluster, num, den}. */
function rate(items, extra = {}) {
  const num = items.reduce((s, i) => s + i.num, 0),
    den = items.reduce((s, i) => s + i.den, 0);
  return {
    num,
    den,
    value: den ? num / den : null,
    ci95: clusterBootstrap(items, ['num', 'den'], (t) => (t.den ? t.num / t.den : NaN)),
    clusters: new Set(items.filter((i) => i.den).map((i) => i.cluster)).size,
    ...extra,
  };
}
/** Paired difference (b minus a) of two ratios on the same clusters. */
function pairedDifference(itemsA, itemsB) {
  const byKey = new Map();
  for (const i of itemsA) byKey.set(i.pos, { cluster: i.cluster, na: i.num, da: i.den });
  for (const i of itemsB) {
    const e = byKey.get(i.pos) || { cluster: i.cluster, na: 0, da: 0 };
    Object.assign(e, { nb: i.num, db: i.den });
    byKey.set(i.pos, e);
  }
  const items = [...byKey.values()];
  const f = (t) => (t.da && t.db ? t.nb / t.db - t.na / t.da : NaN);
  const total = items.reduce(
    (t, i) => {
      for (const k of ['na', 'da', 'nb', 'db']) t[k] += i[k] || 0;
      return t;
    },
    { na: 0, da: 0, nb: 0, db: 0 },
  );
  return {
    point: f(total),
    ci95: clusterBootstrap(items, ['na', 'da', 'nb', 'db'], f),
    positions: items.length,
    clusters: new Set(items.map((i) => i.cluster)).size,
    interval: 'round-cluster bootstrap, 2,000 draws, percentile; descriptive, not a test',
  };
}

/* ---------------------------------------------------------------------------------------------
 * Panel replay
 * ------------------------------------------------------------------------------------------- */
const desc = (play) =>
  play
    ? {
        type: play.type,
        value: play.value,
        n: play.n,
        bomb: isBomb(play),
        ranks: play.cards
          .map((c) => c.r)
          .sort((a, b) => a - b)
          .join('.'),
      }
    : { pass: true };
const jokerSpend = (trick, play) =>
  !!(
    trick &&
    play &&
    ['single', 'pair'].includes(trick.type) &&
    play.type === trick.type &&
    play.value >= 16
  );

/** Sources in the audit's order (directories in order, files sorted, de-duplicated by record id). */
export function loadSources(dirs) {
  const sources = [],
    seen = new Set();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)
      .filter((f) => /^round-\d+\.json$/.test(f))
      .sort()) {
      const file = join(dir, f);
      const { record, checked } = loadRecord(file);
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      sources.push({ file, record, checked, sha256: sha256(file) });
    }
  }
  return sources;
}
const roundKey = (record) => record.matchId.slice(0, 8) + ':' + record.round;

/** Solver panel rows (human-endgames.mjs rows.json) -> Map(key -> row) of critical decisions. */
export function solverPanel(file) {
  if (!file || file === 'none' || !existsSync(file)) return null;
  const rounds = JSON.parse(readFileSync(file, 'utf8'));
  const map = new Map();
  for (const round of rounds)
    for (const r of round.decisions) {
      const critical =
        !r.auto && r.candidates > 1 && r.optimalMoves !== null && r.optimalMoves < r.candidates;
      if (critical && r.best !== null && r.champion !== null)
        map.set(`${r.round}:${r.index}`, { ...r });
    }
  return { file, sha256: sha256(file), rounds: rounds.length, critical: map };
}

function checkStop(opts) {
  if (opts.deadline && Date.now() >= opts.deadline) throw Error('deadline reached');
  for (const f of opts.stopFiles || []) if (existsSync(f)) throw Error(`stop file ${f}`);
}

/**
 * Replay every panel record once; at each panel position score every model. Returns the raw
 * per-position material (kept in memory, never written with identifiers).
 */
export async function scorePanel(opts) {
  const ort = opts.ort ?? (await loadOrt());
  const sources = loadSources(opts.raw);
  if (!sources.length) throw Error('No private records found');
  const belief = await createBeliefModel(ort, opts.belief, { threads: 1 });
  const marginalCache = new Map();
  const marginalsOf = async (key, masked, player) => {
    let m = marginalCache.get(key);
    if (!m) {
      m = await beliefMarginals(belief, publicView(masked, player));
      marginalCache.set(key, m);
    }
    return m;
  };
  const models = [];
  for (const { label, path } of opts.models)
    models.push(await createModelScorer(ort, path, label, marginalsOf));
  const panels = { solver: solverPanel(opts.solverRows), s7a: solverPanel(opts.s7aRows) };
  const decisions = [],
    leads = [],
    solverPositions = [];
  const clusterOf = new Map();
  let leadId = 0;
  for (const { record, checked } of sources) {
    const cluster = clusterOf.size;
    clusterOf.set(record.id, cluster);
    const rk = roundKey(record);
    const L = record.level;
    const res = checked.result;
    const signed = (seat) => (res.team === seat % 2 ? 1 : -1) * res.up;
    for (const { index, action, game, play } of replay(record)) {
      checkStop(opts);
      const seat = action.seat;
      const hand = game.hands[seat];
      const trick = game.trick;
      const plays = candidates(hand, L, trick?.play ?? null);
      const real = plays.length > 1;
      const finish = plays.findIndex((p) => p && p.cards.length === hand.length);
      const human = action.actor === 'human';
      const unassisted = human && action.assisted !== true;
      const isLead = !trick && real && finish < 0;
      const key = `${rk}:${index}`;
      const s67 = panels.solver?.critical.get(key);
      const s7a = panels.s7a?.critical.get(key);
      const isDecision = unassisted && real;
      if (isLead) leadId++;
      if (!isDecision && !s67 && !s7a) continue;
      const actual = matchCandidate(plays, play);
      const choices = {};
      for (const m of models) {
        const values = real ? await m.values(key, game, seat, plays) : [0];
        if (values.length !== plays.length) throw Error(`${m.label}: values do not match`);
        choices[m.label] = choiceIndex(plays, hand.length, values);
      }
      if (isDecision) {
        const before = minPlays(hand, L);
        const sameType = trick
          ? plays.filter((p) => p && !isBomb(p) && p.type === trick.play.type)
          : [];
        const minBeat = sameType.length ? Math.min(...sameType.map((p) => p.value)) : null;
        const trickDesc = trick
          ? { ...desc(trick.play), mate: trick.player === (seat + 2) % 4 }
          : null;
        const nofin = finish < 0;
        const bombCand = plays.some((p) => p && isBomb(p));
        const jokerCand =
          !!trick &&
          ['single', 'pair'].includes(trick.play.type) &&
          sameType.some((p) => p.value >= 16);
        const bombOpp = nofin && !!trick && bombCand;
        const jokerOpp =
          nofin &&
          jokerCand &&
          ['single', 'pair'].includes(trick.play.type) &&
          !trickDesc.bomb &&
          minBeat !== null &&
          !trickDesc.mate &&
          trick.play.value <= 13;
        const row = {
          pos: decisions.length,
          cluster,
          key,
          total: remaining(game),
          lead: !trick,
          actual,
          humanPlay: desc(play),
          humanBomb: !!play && isBomb(play),
          humanJoker: jokerSpend(trick?.play, play),
          humanCost: structureCost(hand, play, L, before),
          bombOpp,
          jokerOpp,
          choice: {},
        };
        for (const m of models) {
          const c = plays[choices[m.label]];
          row.choice[m.label] = {
            index: choices[m.label],
            play: desc(c),
            bomb: !!c && isBomb(c),
            joker: jokerSpend(trick?.play, c),
            cost: structureCost(hand, c, L, before),
          };
        }
        // belief v1 log loss vs uniform (truth from the record; the network sees the public view)
        const view = publicView(maskHidden(game, seat), seat);
        const probs = await belief.probabilities(view);
        const y = hiddenTarget(game, seat);
        const sb = scoreProbabilities(probs, y),
          su = scoreProbabilities(uniformProbabilities(view), y);
        row.belief = { copies: sb.copies, ll: sb.logLikelihood, llUniform: su.logLikelihood };
        if (isLead && unassisted) {
          const unseen = game.hands.filter((_, s) => s !== seat).flat();
          const cache = new Map();
          const ctl = controllingAlternatives(hand, plays, unseen, L, cache);
          const lead = {
            pos: leads.length,
            id: `P${String(leadId).padStart(4, '0')}`,
            cluster,
            ...ctl,
            human: play ? classifyLead(hand, play, unseen, L, cache) : null,
            choice: {},
          };
          for (const m of models)
            lead.choice[m.label] = classifyLead(hand, plays[choices[m.label]], unseen, L, cache);
          leads.push(lead);
        }
        decisions.push(row);
      }
      for (const [name, row] of [
        ['solver', s67],
        ['s7a', s7a],
      ]) {
        if (!row) continue;
        solverPositions.push({
          panel: name,
          cluster,
          key,
          row,
          seat,
          assisted: action.assisted === true,
          actual,
          plays,
          position: positionFromGame(game),
          choices: { ...choices },
        });
      }
    }
  }
  for (const m of models) await m.close();
  await belief.close();
  return {
    sources,
    models: models.map(({ values, close, ...info }) => info),
    decisions,
    leads,
    solverPositions,
    panels,
    beliefInfo: {
      path: opts.belief,
      sha256: sha256(opts.belief),
      featureVersion: belief.featureVersion,
    },
  };
}

/**
 * Optimal flags on the solver panels. 017's value comes from the row; another model's choice uses
 * the row when it equals 017's or the human's move, else one keepsValue check (panel budget).
 */
export function solverOptimal(solverPositions, models, reference, opts) {
  const started = Date.now();
  const capMs = (opts.solveMinutes ?? 10) * 60_000;
  const stopped = () => (opts.stopFiles || []).some((f) => existsSync(f));
  // One live solver per panel (positions of a round are contiguous, so a round's checks still share
  // its table); finished rounds' tables are released, which bounds memory.
  const current = {};
  const out = [];
  let checks = 0,
    overBudget = 0,
    skipped = 0,
    consistency = { checked: 0, inconsistent: 0 };
  for (const sp of solverPositions) {
    const { row } = sp;
    const best = row.best;
    const ref = sp.choices[reference];
    // the stored champion move: equal to the human's iff championSameAsHuman
    consistency.checked++;
    if (row.championSameAsHuman !== (sp.actual >= 0 && ref === sp.actual))
      consistency.inconsistent++;
    const entry = {
      panel: sp.panel,
      cluster: sp.cluster,
      pos: out.length,
      assisted: sp.assisted,
      human: row.human === best,
      optimal: {},
    };
    for (const label of models) {
      const c = sp.choices[label];
      if (c === ref) entry.optimal[label] = row.champion === best;
      else if (sp.actual >= 0 && c === sp.actual && row.human !== null)
        entry.optimal[label] = row.human === best;
      else {
        const elapsed = Date.now() - started;
        const toDeadline = opts.deadline ? opts.deadline - Date.now() : Infinity;
        if (elapsed >= capMs || toDeadline <= 0 || stopped()) {
          entry.optimal[label] = null;
          skipped++;
          continue;
        }
        // the panel round's solver (its table is shared by that round's checks); each check has
        // the panel's budget, cut to the time left under --solve-minutes and before --deadline
        const budget = sp.panel === 's7a' ? opts.s7aBudget : opts.solverBudget;
        const sk = `${sp.panel}:${sp.cluster}`;
        const maxMs = Math.max(1000, Math.min(budget.maxMs, capMs - elapsed, toDeadline));
        if (current[sp.panel]?.key !== sk || current[sp.panel].maxMs !== maxMs)
          current[sp.panel] = {
            key: sk,
            maxMs,
            solver: createSolver({ maxNodes: budget.maxNodes, maxMs }),
          };
        const v0 = sp.seat % 2 === 0 ? best : -best;
        checks++;
        try {
          entry.optimal[label] = current[sp.panel].solver.keepsValue(sp.position, sp.plays[c], v0);
        } catch (error) {
          // budget overrun, or the transposition table outgrowing a Map (RangeError): unscored
          if (!(error instanceof SolverBudget || error instanceof RangeError)) throw error;
          entry.optimal[label] = null;
          overBudget++;
          delete current[sp.panel];
        }
      }
    }
    out.push(entry);
  }
  return {
    entries: out,
    checks,
    overBudget,
    skippedForTime: skipped,
    seconds: (Date.now() - started) / 1000,
    consistency,
  };
}

/* ---------------------------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------------------------- */
const NOT_A_GATE = 'descriptive only, not a gate, not acceptance, not a win rate';

export function buildReport(scored, solver, opts) {
  const labels = scored.models.map((m) => m.label);
  const reference = opts.reference;
  const D = scored.decisions,
    Ld = scored.leads;
  const per = (label) => {
    const item = (pos, cluster, num, den) => ({ pos, cluster, num, den });
    const bomb = D.filter((r) => r.bombOpp).map((r) =>
      item(r.pos, r.cluster, Number(r.choice[label].bomb), 1),
    );
    const joker = D.filter((r) => r.jokerOpp).map((r) =>
      item(r.pos, r.cluster, Number(r.choice[label].joker), 1),
    );
    const cost = D.map((r) =>
      item(r.pos, r.cluster, r.choice[label].cost, Number(!r.choice[label].play.pass)),
    );
    const agree = D.map((r) =>
      item(r.pos, r.cluster, Number(r.actual >= 0 && r.choice[label].index === r.actual), 1),
    );
    const ctl = (l) => l.ctlSingle || l.ctlPair;
    const unc = Ld.map((l) => item(l.pos, l.cluster, Number(uncoveredMulti(l.choice[label])), 1));
    const uncB = Ld.map((l) =>
      item(l.pos, l.cluster, Number(uncoveredMulti(l.choice[label]) && !l.choice[label].boss), 1),
    );
    const owner = Ld.map((l) =>
      item(l.pos, l.cluster, Number(ctl(l) && uncoveredMulti(l.choice[label])), 1),
    );
    const ownerB = Ld.map((l) =>
      item(
        l.pos,
        l.cluster,
        Number(ctl(l) && uncoveredMulti(l.choice[label]) && !l.choice[label].boss),
        1,
      ),
    );
    const multi = Ld.map((l) =>
      item(
        l.pos,
        l.cluster,
        Number(uncoveredMulti(l.choice[label])),
        Number(MULTI.has(l.choice[label].type)),
      ),
    );
    const solverItems = (panel, keep = () => true) =>
      (solver?.entries || [])
        .filter((e) => e.panel === panel && keep(e) && e.optimal[label] !== null)
        .map((e) => item(e.pos, e.cluster, Number(e.optimal[label]), 1));
    const unscored = (panel) =>
      (solver?.entries || []).filter((e) => e.panel === panel && e.optimal[label] === null).length;
    return {
      bomb,
      joker,
      cost,
      agree,
      unc,
      uncB,
      owner,
      ownerB,
      multi,
      solver: solverItems('solver'),
      solverUnassisted: solverItems('solver', (e) => !e.assisted),
      s7a: solverItems('s7a'),
      unscored: { solver: unscored('solver'), s7a: unscored('s7a') },
    };
  };
  const items = Object.fromEntries(labels.map((l) => [l, per(l)]));
  const metricNames = {
    bomb: 'bombed / bomb-legal follow (real decision, no finishing move, following, bomb legal)',
    joker:
      "joker played / joker possible on an opponent's single or pair of K or lower (no finishing move)",
    cost: 'structure cost per play (plays-to-empty after minus (before - 1); passes excluded)',
    agree: 'same move as the unassisted human',
    unc: 'uncovered multi-card lead / all lead positions',
    uncB: 'uncovered and beatable multi-card lead / all lead positions',
    owner:
      "owner's pattern: controlling single/pair available AND uncovered multi-card lead / all lead positions",
    ownerB: "owner's pattern, beatable lead only / all lead positions",
    multi: 'uncovered / multi-card leads chosen',
    solver: 'section-67 critical decisions: chosen move keeps the exact value',
    solverUnassisted: 'section-67 critical decisions, unassisted only',
    s7a: 'S7a critical decisions: chosen move keeps the exact value',
  };
  const metrics = {};
  for (const l of labels) {
    metrics[l] = {};
    for (const [k, name] of Object.entries(metricNames))
      metrics[l][k] = { what: name, ...rate(items[l][k]) };
    metrics[l].solver.unscored = items[l].unscored.solver;
    metrics[l].s7a.unscored = items[l].unscored.s7a;
    metrics[l].choicesDifferentFrom017 = {
      decisions: D.filter((r) => r.choice[l].index !== r.choice[reference].index).length,
      leads: Ld.filter((x) => JSON.stringify(x.choice[l]) !== JSON.stringify(x.choice[reference]))
        .length,
      solverPositions: scored.solverPositions.filter((s) => s.choices[l] !== s.choices[reference])
        .length,
    };
  }
  const item = (pos, cluster, num, den) => ({ pos, cluster, num, den });
  const humans = {
    note: 'the recorded unassisted human moves at the same positions (reference)',
    bomb: rate(D.filter((r) => r.bombOpp).map((r) => item(r.pos, r.cluster, +r.humanBomb, 1))),
    joker: rate(D.filter((r) => r.jokerOpp).map((r) => item(r.pos, r.cluster, +r.humanJoker, 1))),
    cost: rate(D.map((r) => item(r.pos, r.cluster, r.humanCost, Number(!r.humanPlay.pass)))),
    unc: rate(
      Ld.map((l) => item(l.pos, l.cluster, Number(!!l.human && uncoveredMulti(l.human)), 1)),
    ),
    owner: rate(
      Ld.map((l) =>
        item(
          l.pos,
          l.cluster,
          Number(!!l.human && (l.ctlSingle || l.ctlPair) && uncoveredMulti(l.human)),
          1,
        ),
      ),
    ),
    solver: rate(
      (solver?.entries || [])
        .filter((e) => e.panel === 'solver')
        .map((e) => item(e.pos, e.cluster, +e.human, 1)),
    ),
    s7a: rate(
      (solver?.entries || [])
        .filter((e) => e.panel === 's7a')
        .map((e) => item(e.pos, e.cluster, +e.human, 1)),
    ),
  };
  const paired = {};
  for (const l of labels) {
    if (l === reference) continue;
    paired[`${l} minus ${reference}`] = Object.fromEntries(
      Object.keys(metricNames).map((k) => [k, pairedDifference(items[reference][k], items[l][k])]),
    );
  }
  // belief v1 log loss per unseen copy
  const B = D.map((r) => ({ pos: r.pos, cluster: r.cluster, total: r.total, ...r.belief }));
  const beliefBlock = (rows) => {
    const copies = rows.reduce((s, r) => s + r.copies, 0);
    const ll = rows.reduce((s, r) => s + r.ll, 0),
      lu = rows.reduce((s, r) => s + r.llUniform, 0);
    return {
      positions: rows.length,
      copies,
      beliefLogLossPerCopy: copies ? -ll / copies : null,
      uniformLogLossPerCopy: copies ? -lu / copies : null,
      differenceBeliefMinusUniform: copies ? (lu - ll) / copies : null,
      ci95: clusterBootstrap(rows, ['copies', 'll', 'llUniform'], (t) =>
        t.copies ? (t.llUniform - t.ll) / t.copies : NaN,
      ),
    };
  };
  const bands = ['>80', '61-80', '41-60', '21-40', '<=20'];
  const beliefReport = {
    what:
      'belief v1 log loss per unseen copy (network probabilities on the mover public view; truth = ' +
      'the recorded hands; metrics.mjs scoreProbabilities) vs the uniform baseline; difference < 0 = ' +
      'the network is better than uniform; round-cluster bootstrap',
    selfPlayReference: { belief: 0.793, uniform: 0.976, note: 'champion self-play (S7 plan)' },
    trainingRangeNote:
      'belief v1 was trained on single level-2 rounds without tribute at 21-80 cards (champion ' +
      'self-play); human rounds include other levels, tribute and > 80 cards (outside that range)',
    model: scored.beliefInfo,
    all: beliefBlock(B),
    trainingBand21to80: beliefBlock(B.filter((r) => r.total >= 21 && r.total <= 80)),
    byBand: Object.fromEntries(
      bands.map((b) => [b, beliefBlock(B.filter((r) => band(r.total) === b))]),
    ),
  };
  return {
    labels,
    reference,
    metrics,
    humans,
    paired,
    belief: beliefReport,
    counts: {
      decisions: D.length,
      bombLegalFollows: D.filter((r) => r.bombOpp).length,
      jokerOpportunities: D.filter((r) => r.jokerOpp).length,
      leadPositions: Ld.length,
      solverCritical: (solver?.entries || []).filter((e) => e.panel === 'solver').length,
      s7aCritical: (solver?.entries || []).filter((e) => e.panel === 's7a').length,
      rounds: new Set(D.map((r) => r.cluster)).size,
    },
  };
}

/** Reproduction checks against the frozen audit rows and lead rows (017 = `reference`). */
export function reproduction(scored, opts) {
  const ref = opts.reference;
  const out = {};
  if (opts.auditRows && existsSync(opts.auditRows)) {
    const audit = JSON.parse(readFileSync(opts.auditRows, 'utf8'));
    const H = audit.rows.filter((r) => r.actor === 'human' && !r.assisted && r.nCand > 1);
    const byKey = new Map(H.map((r) => [`${r.match}:${r.round}:${r.index}`, r]));
    const c = {
      auditRows: H.length,
      matched: 0,
      championIndexEqual: 0,
      humanIndexEqual: 0,
      championCostEqual: 0,
      humanCostEqual: 0,
      bombOppEqual: 0,
    };
    for (const r of scored.decisions) {
      const a = byKey.get(r.key);
      if (!a) continue;
      c.matched++;
      c.championIndexEqual += Number(a.champ.index === r.choice[ref].index);
      c.humanIndexEqual += Number(a.actIndex === r.actual);
      c.championCostEqual += Number(a.champCost === r.choice[ref].cost);
      c.humanCostEqual += Number(a.cost === r.humanCost);
      const bombOpp = !a.finishAvailable && a.trick !== null && a.bombCand;
      c.bombOppEqual += Number(bombOpp === r.bombOpp);
    }
    c.sha256 = sha256(opts.auditRows);
    out.auditRows = c;
  }
  if (opts.leadRows && existsSync(opts.leadRows)) {
    const rows = readFileSync(opts.leadRows, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => r.group === 'H-un');
    const byId = new Map(rows.map((r) => [r.id, r]));
    const fields = ['type', 'value', 'n', 'w1', 'm', 'u', 'boss', 'w2', 'bomb', 'uncovered'];
    const same = (a, b) => !!a && !!b && fields.every((f) => (a[f] ?? null) === (b[f] ?? null));
    const c = { leadRows: rows.length, matched: 0, championEqual: 0, humanEqual: 0, ctlEqual: 0 };
    for (const l of scored.leads) {
      const r = byId.get(l.id);
      if (!r) continue;
      c.matched++;
      c.championEqual += Number(same(r.champ, l.choice[ref]));
      c.humanEqual += Number((r.actual === null && l.human === null) || same(r.actual, l.human));
      c.ctlEqual += Number(r.ctlSingle === l.ctlSingle && r.ctlPair === l.ctlPair);
    }
    c.sha256 = sha256(opts.leadRows);
    out.leadRows = c;
  }
  return out;
}

/** Parity of `label` with 017 on every panel position, plus the published 017 numbers. */
export function parityBlock(scored, solver, report, label, opts) {
  const ref = opts.reference;
  const audit = report.reproduction?.auditRows;
  const leadsSame = scored.leads.filter(
    (l) => JSON.stringify(l.choice[label]) === JSON.stringify(l.choice[ref]),
  ).length;
  const solverSame = scored.solverPositions.filter(
    (s) => s.choices[label] === s.choices[ref],
  ).length;
  const m = report.metrics[label];
  const pair = (x) => [x.num, x.den];
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1];
  const published = {
    decisions: [report.counts.decisions, PUBLISHED_017.decisions],
    bomb: [pair(m.bomb), PUBLISHED_017.bomb],
    joker: [pair(m.joker), PUBLISHED_017.joker],
    structureCost: [pair(m.cost), PUBLISHED_017.structureCost],
    agreement: [pair(m.agree), PUBLISHED_017.agreement],
    leads: [report.counts.leadPositions, PUBLISHED_017.leads],
    uncoveredMultiLead: [pair(m.unc), PUBLISHED_017.uncoveredMultiLead],
    ownerPattern: [pair(m.owner), PUBLISHED_017.ownerPattern],
    solverCritical: [pair(m.solver), PUBLISHED_017.solverCritical],
  };
  const publishedMatch = Object.fromEntries(
    Object.entries(published).map(([k, [got, want]]) => [
      k,
      { got, published: want, match: Array.isArray(want) ? eq(got, want) : got === want },
    ]),
  );
  const auditIdentical = audit ? audit.championIndexEqual : null;
  const identical = scored.decisions.filter(
    (r) => r.choice[label].index === r.choice[ref].index,
  ).length;
  const ok =
    identical === PUBLISHED_017.decisions &&
    scored.decisions.length === PUBLISHED_017.decisions &&
    leadsSame === scored.leads.length &&
    solverSame === scored.solverPositions.length &&
    (audit
      ? audit.championIndexEqual === audit.auditRows && audit.matched === audit.auditRows
      : true) &&
    Object.values(publishedMatch).every((x) => x.match);
  return {
    model: label,
    identical,
    positions: scored.decisions.length,
    leadsIdentical: leadsSame,
    leads: scored.leads.length,
    solverPositionsIdentical: solverSame,
    solverPositions: scored.solverPositions.length,
    championChoicesEqualToFrozenAuditRows: auditIdentical,
    publishedMatch,
    pass: ok,
  };
}

function parseModels(spec) {
  return spec
    .split(',')
    .filter(Boolean)
    .map((s) => {
      const eq = s.indexOf('=');
      const path = resolve(eq > 0 ? s.slice(eq + 1) : s);
      const label = eq > 0 ? s.slice(0, eq) : basename(path).replace(/\.onnx$/, '');
      return { label, path };
    });
}

/** Full run: score, solver panels, report object (aggregates only). */
export async function run(opts) {
  const started = Date.now();
  const reference = '017';
  const models = [{ label: reference, path: opts.champion }, ...opts.models];
  const labels = models.map((m) => m.label);
  if (new Set(labels).size !== labels.length) throw Error('Duplicate model labels');
  const scored = await scorePanel({ ...opts, models });
  const scoreSeconds = (Date.now() - started) / 1000;
  const solver = solverOptimal(scored.solverPositions, labels, reference, opts);
  const report = buildReport(scored, solver, { reference });
  report.reproduction = reproduction(scored, { ...opts, reference });
  const panelFile = opts.panel && existsSync(opts.panel) ? opts.panel : null;
  const registered = panelFile
    ? new Set(JSON.parse(readFileSync(panelFile, 'utf8')).files.rawRecords.sha256OfFiles)
    : null;
  const result = {
    schema: 'w3-s7-panel-scorer-v1',
    kind: NOT_A_GATE,
    generatedAt: new Date().toISOString(),
    scorer: { file: SELF, sha256: sha256(SELF), root: ROOT },
    privacy:
      'aggregates only; positions by anonymous index; no nickname, room, record id, match id or file name',
    records: {
      rounds: scored.sources.length,
      registeredInPanel: registered
        ? scored.sources.filter((s) => registered.has(s.sha256)).length
        : null,
      panelFile: panelFile ? { path: panelFile, sha256: sha256(panelFile) } : null,
      trust: 'unverified_browser',
    },
    models: scored.models,
    inputs: {
      solverRows: scored.panels.solver
        ? {
            path: scored.panels.solver.file,
            sha256: scored.panels.solver.sha256,
            rounds: scored.panels.solver.rounds,
          }
        : null,
      s7aRows: scored.panels.s7a
        ? {
            path: scored.panels.s7a.file,
            sha256: scored.panels.s7a.sha256,
            rounds: scored.panels.s7a.rounds,
          }
        : null,
      solverBudget: opts.solverBudget,
      s7aBudget: opts.s7aBudget,
    },
    solverChecks: {
      keepsValueChecks: solver.checks,
      overBudget: solver.overBudget,
      skippedForTime: solver.skippedForTime,
      seconds: solver.seconds,
      cap: `${opts.solveMinutes ?? 10} min in total`,
      storedChampionConsistency: solver.consistency,
    },
    timing: { scoreSeconds, totalSeconds: (Date.now() - started) / 1000 },
    ...report,
  };
  if (opts.parity) {
    const target = opts.models[opts.models.length - 1]?.label ?? reference;
    Object.assign(result, parityBlock(scored, solver, report, target, { reference }));
  }
  if (opts.positionsOut) {
    const rows = scored.decisions.map((r) => ({
      pos: r.pos,
      round: r.cluster,
      choice: Object.fromEntries(labels.map((l) => [l, r.choice[l].index])),
    }));
    writeFileSync(opts.positionsOut, JSON.stringify({ kind: NOT_A_GATE, rows }));
  }
  return result;
}

const option = (argv, name, fallback) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

export function parseOptions(argv) {
  const s7a = option(argv, 's7a-rows', DEFAULTS.s7aRows);
  const deadline = option(argv, 'deadline', null);
  return {
    models: parseModels(option(argv, 'model', '')),
    champion: resolve(option(argv, 'champion', DEFAULT_CHAMPION)),
    belief: resolve(option(argv, 'belief', DEFAULTS.belief)),
    auditRows: option(argv, 'audit-rows', DEFAULTS.auditRows),
    leadRows: option(argv, 'lead-rows', DEFAULTS.leadRows),
    raw: option(argv, 'raw', DEFAULTS.raw.join(',')).split(',').filter(Boolean),
    panel: option(argv, 'panel', DEFAULTS.panel),
    solverRows: option(argv, 'solver-rows', DEFAULTS.solverRows),
    s7aRows: s7a === 'none' ? null : s7a,
    solverBudget: DEFAULTS.solverBudget,
    s7aBudget: DEFAULTS.s7aBudget,
    solveMinutes: Number(option(argv, 'solve-minutes', 10)),
    deadline: deadline ? Date.parse(deadline) : null,
    stopFiles: option(argv, 'stop-file', '').split(',').filter(Boolean),
    parity: option(argv, 'parity', '0') === '1',
    out: option(argv, 'out', null),
    positionsOut: option(argv, 'positions-out', null),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const opts = parseOptions(process.argv.slice(2));
  if (!opts.out) {
    console.error('--out=<report.json> is required');
    process.exit(2);
  }
  run(opts)
    .then((result) => {
      mkdirSync(dirname(resolve(opts.out)), { recursive: true });
      writeFileSync(opts.out, JSON.stringify(result, null, 2));
      const brief = Object.fromEntries(
        result.labels.map((l) => [
          l,
          Object.fromEntries(
            ['bomb', 'joker', 'cost', 'agree', 'unc', 'owner', 'solver', 's7a'].map((k) => [
              k,
              result.metrics[l][k].value === null ? null : +result.metrics[l][k].value.toFixed(4),
            ]),
          ),
        ]),
      );
      console.log(JSON.stringify({ out: opts.out, timing: result.timing, metrics: brief }));
      if (opts.parity) {
        console.log(
          `parity ${result.model}: identical ${result.identical} of ${result.positions}, pass ${result.pass}`,
        );
        process.exit(result.pass ? 0 : 1);
      }
    })
    .catch((error) => {
      console.error(error);
      process.exit(3);
    });
}
