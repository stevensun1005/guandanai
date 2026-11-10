/**
 * Window 3, S7: descriptive replay of midgame-search.mjs runs (S6 arms A and B) to measure the
 * round-end hand structure and the hand-over value correlation that the per-pair rows do not hold
 * (M6: rows carry points/order/plies only). DESCRIPTIVE ONLY: not a gate, not acceptance, not a
 * win rate; bombs, jokers and singles are intermediate signals (AGENTS.md).
 *
 * Each deal of a run is played again with that run's own protocol (run.json -> createConfig) by a
 * copy of midgame-search.mjs playRound whose decisions are unchanged (same candidate set, search,
 * endgame solver, worlds, focal raw network); only observations are added. The replayed round is
 * compared with the stored row (points, plies, order): the endgame solver has a time budget, so a
 * replay under a different load can differ; the matched count is reported.
 *
 * Per focal seat-round (the focal team's two seats), definitions of the W3 audit (SIM9001
 * baselines: all four seats danMCai-reason, single rounds, no tribute):
 *   - round end, focal seats with cards left: singles of the minimum decomposition (1.60), holds a
 *     joker (20.8%), holds a bomb (3.3%);
 *   - first player out, the focal seats still holding cards: holds a bomb (30.5%), holds a joker
 *     (34.6%);
 *   - table cards at the seat's first bomb while following, seat-rounds with a bomb opportunity
 *     while following: median (76).
 * Hand-over: at the focal team's first real decision with <= hi cards, max Q of champion 017
 * (policyState, as handover-oracle.mjs) and of the --q-model (215 extras, fed as focalRawDecision)
 * against that round's signed points (Pearson; S1 measured 0.58 for 017).
 *
 *   node arm-replay.mjs --runs=<dirA>,<dirB> [--labels=A,B] [--q-model=<onnx>] --out=<json>
 *        [--deadline=<ISO>] [--stop-file=<path>[,<path>]] [--max-pairs=<n>]
 *
 * Imports resolve against the repository root as in panel-scorer.mjs (this checkout, else
 * $PANEL_SCORER_ROOT, else the working directory).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REQUIRED = ['ai/danMCai/belief/midgame-search.mjs', 'web/src/ai/candidates.js'];
function findRoot() {
  const options = [
    resolve(dirname(SELF), '../../..'),
    process.env.PANEL_SCORER_ROOT,
    process.cwd(),
  ].filter(Boolean);
  for (const root of options) if (REQUIRED.every((f) => existsSync(join(root, f)))) return root;
  throw Error(`No repository root found (tried ${options.join(', ')})`);
}
export const ROOT = findRoot();
const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const [
  { advanceRound, createRound },
  { candidates },
  { policyState },
  { isBomb },
  { publicView },
  { beliefMarginals },
  ms,
  { argmax },
] = await Promise.all(
  [
    'ai/shared/simulation/simulation.mjs',
    'web/src/ai/candidates.js',
    'web/src/ai/observation.js',
    'web/src/core/combinations.js',
    'ai/danMCai/belief/features.mjs',
    'ai/danMCai/belief/sampler.mjs',
    'ai/danMCai/belief/midgame-search.mjs',
    'ai/danMCai/training/continuous/lib.mjs',
  ].map(load),
);
// plays-to-empty from the scorer next to this file (repository: panel-scorer.mjs; window-3 copy:
// S7/scorer.mjs), else from the repository root
async function loadScorer() {
  for (const name of ['panel-scorer.mjs', 'scorer.mjs']) {
    const file = join(dirname(SELF), name);
    if (existsSync(file)) return import(pathToFileURL(file).href);
  }
  return load('ai/danMCai/belief/panel-scorer.mjs');
}
const { minPlays } = await loadScorer();
async function loadOrt() {
  const file = createRequire(join(ROOT, 'package.json')).resolve('onnxruntime-node');
  const mod = await import(pathToFileURL(file).href);
  return mod.InferenceSession ? mod : mod.default;
}

export const SIM9001 = Object.freeze({
  endSingles: 1.6,
  endJoker: 0.208,
  endBomb: 0.033,
  firstOutBomb: 0.305,
  firstOutJoker: 0.346,
  firstBombMedian: 76,
  source: 'W3 audit tables 4a/4c and first-bomb table (162 simulated rounds, all seats 9001)',
});
export const S1_REFERENCE_CORR_017 = 0.58;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);
function handInfo(hand, L) {
  const mp = minPlays(hand, L);
  const bomb = hand.length >= 4 && candidates(hand, L, null).some((p) => p && isBomb(p));
  return { cards: hand.length, singles: mp.singles, joker: hand.some((c) => c.r >= 16), bomb };
}

/**
 * midgame-search.mjs playRound with observations added. Decisions are made by the same exported
 * functions in the same order, so the round is the one the run played (up to solver time budgets).
 */
export async function replayRound(seed, focalTeam, cfg, qModel) {
  const game = createRound(seed);
  const focal = (seat) => seat % 2 === focalTeam;
  const endgameOn = (cfg.endgame ?? 'none') === 'pimc';
  const rawOn = !!cfg.focalRaw;
  const seats = Object.fromEntries(
    [focalTeam, focalTeam + 2].map((s) => [s, { bombOpp: false, firstBomb: null }]),
  );
  let handover = null,
    firstOut = null;
  for (let ply = 0; ply < 1000; ply++) {
    if (ply !== game.log.length) throw Error('Ply must equal the public log length');
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const cards = remaining(game);
      const inBand = focal(player) && cards >= cfg.lo && cards <= cfg.hi;
      const inEndgame = endgameOn && focal(player) && cards <= cfg.endgameHi;
      if (focal(player) && cards <= cfg.hi && handover === null) {
        const q017 = await cfg.values(cfg.champion, policyState(game, player, 0, plays));
        let qw = null;
        if (qModel) {
          const masked = ms.maskHidden(game, player);
          const marginals = await beliefMarginals(
            cfg.belief ?? qModel.belief,
            publicView(masked, player),
          );
          qw = await qModel.scorer.values(ms.rawPolicyState(masked, player, plays), marginals);
        }
        handover = { q017: Math.max(...q017), qModel: qw ? Math.max(...qw) : null, cards };
      }
      if (inEndgame && cfg.mode === 'search')
        index = (await ms.endgameDecision(game, seed, cfg)).index;
      else if (inBand && cfg.mode === 'search')
        index = (await ms.searchDecision(game, seed, cfg)).index;
      else if (
        rawOn &&
        focal(player) &&
        (cfg.mode === 'raw' || (cfg.mode === 'search' && cards > cfg.hi))
      )
        index = (await ms.focalRawDecision(game, cfg)).index;
      else index = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
      if (focal(player) && game.trick && plays.some((p) => p && isBomb(p))) {
        const s = seats[player];
        s.bombOpp = true;
        if (s.firstBomb === null && plays[index] && isBomb(plays[index])) s.firstBomb = cards;
      }
    }
    const play = plays[index];
    const result = advanceRound(game, play);
    if (!firstOut && play && game.hands[player].length === 0) {
      firstOut = {};
      for (const s of Object.keys(seats).map(Number))
        if (s !== player && game.hands[s].length) firstOut[s] = handInfo(game.hands[s], game.L);
    }
    if (result) {
      const points = result.winner === focalTeam ? result.points : -result.points;
      const end = {};
      for (const s of Object.keys(seats).map(Number))
        if (result.order[0] !== s && game.hands[s].length) end[s] = handInfo(game.hands[s], game.L);
      return {
        points,
        order: result.order.slice(),
        plies: ply + 1,
        seats,
        firstOut,
        end,
        handover,
      };
    }
  }
  throw Error('Round did not terminate');
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n,
    my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const share = (xs) => ({
  num: xs.filter(Boolean).length,
  den: xs.length,
  value: xs.length ? xs.filter(Boolean).length / xs.length : null,
});
const mean = (xs) => ({
  n: xs.length,
  value: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
});

/** Aggregates of replayed rounds (one entry per round). */
export function summarizeRounds(rounds) {
  const end = rounds.flatMap((r) => Object.values(r.end));
  const fo = rounds.flatMap((r) => Object.values(r.firstOut || {}));
  const seats = rounds.flatMap((r) => Object.values(r.seats));
  const hand = rounds.filter((r) => r.handover);
  const firstBombs = seats.filter((s) => s.bombOpp && s.firstBomb !== null).map((s) => s.firstBomb);
  return {
    rounds: rounds.length,
    matchedStoredRows: rounds.filter((r) => r.matched).length,
    endSingles: mean(end.map((x) => x.singles)),
    endJoker: share(end.map((x) => x.joker)),
    endBomb: share(end.map((x) => x.bomb)),
    firstOutBomb: share(fo.map((x) => x.bomb)),
    firstOutJoker: share(fo.map((x) => x.joker)),
    seatRoundsWithBombOpportunity: seats.filter((s) => s.bombOpp).length,
    seatRoundsWithBombWhileFollowing: firstBombs.length,
    firstBombTableCardsMedian: median(firstBombs),
    handover: {
      rounds: hand.length,
      corrQ017Result: pearson(
        hand.map((r) => r.handover.q017),
        hand.map((r) => r.points),
      ),
      corrQModelResult: hand.every((r) => r.handover.qModel !== null)
        ? pearson(
            hand.map((r) => r.handover.qModel),
            hand.map((r) => r.points),
          )
        : null,
    },
  };
}

/** S1 rows: corr(champion max Q at the first focal <= hi decision, round points) per arm. */
export function s1Handover(dir) {
  if (!dir || !existsSync(join(dir, 'run.json'))) return null;
  const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  const out = {};
  for (const arm of run.arms || []) {
    const sub = join(dir, arm);
    if (!existsSync(sub)) continue;
    const { rows } = ms.collect(sub, run.workers ?? 3, run.start);
    const rounds = rows.flatMap((r) => [r.a, r.b]).filter((r) => Number.isFinite(r.handoverQ));
    out[arm] = {
      pairsContiguous: rows.length,
      rounds: rounds.length,
      corrQ017Result: pearson(
        rounds.map((r) => r.handoverQ),
        rounds.map((r) => r.points),
      ),
    };
  }
  return out;
}

const option = (argv, name, fallback) =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

export async function main(argv) {
  const ort = await loadOrt();
  const runs = option(argv, 'runs', '')
    .split(',')
    .filter(Boolean)
    .map((d) => resolve(d));
  const labels = option(argv, 'labels', runs.map((_, i) => 'ABCDEFG'[i]).join(',')).split(',');
  const out = resolve(option(argv, 'out'));
  const deadlineOpt = option(argv, 'deadline', null);
  const deadline = deadlineOpt ? Date.parse(deadlineOpt) : Infinity;
  const stopFiles = option(argv, 'stop-file', '').split(',').filter(Boolean);
  const maxPairs = Number(option(argv, 'max-pairs', Infinity));
  const qModelFile = option(argv, 'q-model', null);
  const stopped = () => Date.now() >= deadline || stopFiles.some((f) => existsSync(f));
  const arms = [];
  for (const [i, dir] of runs.entries()) {
    const run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    const { rows } = ms.collect(dir, run.workers, run.start);
    const cfg = await ms.createConfig(run, ort);
    arms.push({
      label: labels[i],
      dir,
      run,
      rows: new Map(rows.map((r) => [r.seed, r])),
      cfg,
      rounds: [],
    });
  }
  let qModel = null;
  if (qModelFile && arms.length) {
    const beliefFile = arms.find((a) => a.run.belief)?.run.belief;
    const { createBeliefModel } = await load('ai/danMCai/belief/sampler.mjs');
    qModel = {
      file: qModelFile,
      sha256: sha256(qModelFile),
      scorer: await ms.createFocalRawScorer(ort, qModelFile, { threads: 1 }),
      belief: await createBeliefModel(ort, beliefFile, { threads: 1 }),
    };
  }
  const common = arms.length
    ? [...arms[0].rows.keys()].filter((s) => arms.every((a) => a.rows.has(s))).sort((a, b) => a - b)
    : [];
  const started = Date.now();
  let pairs = 0,
    stopReason = arms.length ? 'all stored pairs replayed' : 'no runs given';
  outer: for (const seed of common) {
    if (pairs >= maxPairs) {
      stopReason = `--max-pairs ${maxPairs}`;
      break;
    }
    const done = [];
    for (const arm of arms) {
      const stored = arm.rows.get(seed);
      for (const [team, key] of [
        [0, 'a'],
        [1, 'b'],
      ]) {
        if (stopped()) {
          stopReason = 'deadline or STOP';
          break outer;
        }
        const r = await replayRound(seed, team, arm.cfg, qModel);
        const s = stored[key];
        r.matched =
          r.points === s.points &&
          r.plies === s.plies &&
          JSON.stringify(r.order) === JSON.stringify(s.order);
        r.seed = seed;
        done.push([arm, r]);
      }
    }
    for (const [arm, r] of done) arm.rounds.push(r); // whole pairs of every arm only
    pairs++;
  }
  const summary = Object.fromEntries(arms.map((a) => [a.label, summarizeRounds(a.rounds)]));
  const result = {
    schema: 'w3-s7-arm-replay-v1',
    kind: 'descriptive only, not a gate, not acceptance, not a win rate',
    generatedAt: new Date().toISOString(),
    tool: { file: SELF, sha256: sha256(SELF), root: ROOT },
    runs: arms.map((a) => ({
      label: a.label,
      dir: a.dir,
      storedContiguousPairs: a.rows.size,
      focalRawModel: a.run.focalRawModel ?? null,
      focalRawModelSHA256: a.run.focalRawModelSHA256 ?? null,
    })),
    qModel: qModel ? { file: qModel.file, sha256: qModel.sha256 } : null,
    pairsReplayed: pairs,
    seedRange: pairs ? [common[0], common[pairs - 1]] : null,
    stopReason,
    seconds: (Date.now() - started) / 1000,
    summary,
    baselines: { SIM9001, s1Corr017: S1_REFERENCE_CORR_017 },
    s1Handover: s1Handover(option(argv, 's1', null)),
    note:
      "focal seats only; replayed rounds are the runs' own deals (first pairs of the contiguous " +
      'prefix), not a random sample of the run; SIM9001 baselines are self-play with all four seats ' +
      '9001 against itself, the S6 arms face raw 017 seats, so the comparison mixes opponents',
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2));
  for (const a of arms) await a.cfg.close();
  if (qModel) {
    await qModel.scorer.close();
    await qModel.belief.close();
  }
  console.log(JSON.stringify({ out, pairs, stopReason, seconds: result.seconds }));
}

if (process.argv[1] && resolve(process.argv[1]) === SELF)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(3);
  });
