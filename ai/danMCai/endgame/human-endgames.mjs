/**
 * Exact-solver audit of real human endgames (cloud D1 records; trust=unverified_browser).
 *
 * Each record is replayed with the web rules. Two diagnostics, both scored with the exact
 * perfect-information team-minimax solver on the signed round result (+-1/+-2/+-3 for the mover's
 * team: going out first is not the only goal, avoiding a double-down -3 -> -2 counts too):
 *
 *  Solvable tail: each round is walked back from its last action; every position is solved until
 *  the first one above --max-cards cards or over the solver budget. The tail depends only on the
 *  solver, never on the moves played, and covers early double-up endings with many cards left.
 *
 *  1. Decision audit: every human decision in the tail. The solver values every candidate; the
 *     human's actual move, the champion's greedy choice and the endgame student's greedy choice are
 *     compared with the best value (regret = best - chosen).
 *  2. Takeover: from the first tail position, a model plays one seat (or both seats of a team) and
 *     the other seats play solver-optimal moves with all hands visible. The model reaches the
 *     position's exact value only if every one of its moves is value-preserving; it cannot exceed it.
 *
 * The models see only their own hand and public history (policyState), as in the web game. The
 * perfect-information optimum is an upper bound that a hidden-information player cannot always
 * reach; it is a diagnostic, not a training target or acceptance metric. Records are never written
 * to the output: rows hold seats, counts and values only.
 *
 *   node ai/danMCai/endgame/human-endgames.mjs --raw=<dir of round-*.json> --champion=<onnx>
 *        --student=<onnx> --out=<dir> [--max-cards=40]
 *        [--max-nodes=5000000] [--max-ms=30000] [--workers=8] [--keep-assisted=<prefix,...>]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { validateRecord } from '../../../web/src/collection/validate.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { analyze, beats } from '../../../web/src/core/combinations.js';
import { argmax, createModelPool, sha256 } from '../training/continuous/lib.mjs';
import { createSolver, positionFromGame, SolverBudget } from './solver.mjs';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);
const faces = (cards) =>
  cards
    .map((c) => c.r * 4 + 'SHCDJ'.indexOf(c.s))
    .sort((a, b) => a - b)
    .join('.');

/** Load and validate one stored record (server-added fields stripped, as human-examples does). */
export function loadRecord(file) {
  const {
    result,
    levelsAfter,
    remaining: rest,
    trust,
    ...record
  } = JSON.parse(readFileSync(file, 'utf8'));
  const checked = validateRecord(record);
  return { record, checked };
}

export const cloneGame = (game) => ({
  ...game,
  hands: game.hands.map((hand) => hand.slice()),
  levels: game.levels.slice(),
  log: game.log.slice(),
  out: game.out.slice(),
  trick: game.trick ? { player: game.trick.player, play: game.trick.play } : null,
});

/** Replay a validated record as a simulation game, yielding the state before every action. */
export function* replay(record) {
  const deck = makeDeck();
  const game = {
    hands: record.hands.map((hand) => hand.map((id) => deck[id])),
    L: record.level,
    levels: record.match.levels.slice(),
    log: [],
    trick: null,
    passes: 0,
    out: [],
    turn: record.leader,
  };
  for (let index = 0; index < record.actions.length; index++) {
    const action = record.actions[index];
    if (action.seat !== game.turn) throw Error(`Replay turn mismatch at ${record.id}#${index}`);
    let play = null;
    if (action.cards) {
      const cards = action.cards.map((id) => game.hands[game.turn].find((c) => c.id === id));
      const shape = analyze(cards, game.L).find(
        (s) =>
          s.type === action.type &&
          s.value === action.value &&
          s.n === action.n &&
          beats(s, game.trick?.play),
      );
      play = { ...shape, cards };
    }
    yield { index, action, game, play };
    const result = advanceRound(game, play);
    if (result) return;
  }
}

/** Candidate index of a recorded play (same faces and shape), or -1 when the generator omits it. */
export function matchCandidate(plays, play) {
  if (!play) return plays.indexOf(null);
  const key = faces(play.cards);
  return plays.findIndex(
    (c) =>
      c &&
      c.type === play.type &&
      c.value === play.value &&
      c.n === play.n &&
      faces(c.cards) === key,
  );
}

/** Greedy model choice with the web/evaluator conventions: finishing move and single candidate auto. */
export async function modelChoice(values, file, game, plays) {
  const player = game.turn;
  let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
  if (index >= 0) return { index, auto: 'finish' };
  if (plays.length === 1) return { index: 0, auto: 'single' };
  return { index: argmax(await values(file, policyState(game, player, 0, plays))), auto: null };
}

const forMover = (team0Value, seat) => (seat % 2 === 0 ? team0Value : -team0Value);
const budgeted = (fn) => {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof SolverBudget)) throw error;
    return null;
  }
};

async function auditRound(file, config) {
  const { record, checked } = loadRecord(file);
  const keepAssisted = config.keepAssisted.some((prefix) => record.matchId.startsWith(prefix));
  const signedFor = (team) => (checked.result.team === team ? 1 : -1) * checked.result.up;
  const solver = createSolver(config.budget);
  const states = [];
  for (const { index, action, game, play } of replay(record))
    states.push({ index, action, play, game: cloneGame(game) });
  // Solvable tail: walk back from the last action and stop at the first position that is above
  // the card cap or exceeds the solver budget. Depends only on the solver, never on the moves.
  const tail = [];
  let stop = 'start-of-round';
  for (let i = states.length - 1; i >= 0; i--) {
    const { game } = states[i];
    if (remaining(game) > config.maxCards) {
      stop = 'card-cap';
      break;
    }
    const started = performance.now();
    const value0 = budgeted(() => solver.value(positionFromGame(game)));
    if (value0 === null) {
      stop = 'budget';
      break;
    }
    tail.unshift({ ...states[i], value0, ms: Math.round(performance.now() - started) });
  }
  const decisions = [];
  for (const { index, action, game, play, value0, ms } of tail) {
    if (action.actor !== 'human') continue;
    const position = positionFromGame(game);
    const seat = game.turn;
    const plays = candidates(game.hands[seat], game.L, game.trick?.play || null);
    const champion = await modelChoice(config.values, config.champion, game, plays);
    const student = await modelChoice(config.values, config.student, game, plays);
    const valueOf = (move) => budgeted(() => forMover(solver.actionValue(position, move), seat));
    const optimal = budgeted(() =>
      plays.reduce((n, move) => n + Number(solver.keepsValue(position, move, value0)), 0),
    );
    const row = {
      round: record.matchId.slice(0, 8) + ':' + record.round,
      match: record.matchId.slice(0, 8),
      index,
      fromEnd: record.actions.length - index,
      seat,
      cards: remaining(game),
      own: game.hands[seat].length,
      counts: game.hands.map((h) => h.length),
      candidates: plays.length,
      assisted: action.assisted === true,
      assistedKept: action.assisted === true && keepAssisted,
      leading: !game.trick,
      auto: champion.auto,
      teamOutcome: signedFor(seat % 2),
      best: forMover(value0, seat),
      optimalMoves: optimal,
      humanPass: !play,
      humanOutsideCandidates: matchCandidate(plays, play) < 0,
      human: valueOf(play),
      champion: valueOf(plays[champion.index]),
      student: valueOf(plays[student.index]),
      championSameAsHuman: matchCandidate([plays[champion.index]], play) === 0,
      studentSameAsHuman: matchCandidate([plays[student.index]], play) === 0,
      ms,
    };
    decisions.push(row);
  }
  const roundInfo = {
    round: record.matchId.slice(0, 8) + ':' + record.round,
    actions: record.actions.length,
    tailActions: tail.length,
    tailStartCards: tail.length ? remaining(tail[0].game) : null,
    tailStop: stop,
    outcomeTeam0: signedFor(0),
  };

  const takeovers = [];
  if (tail.length) {
    const start = tail[0].game;
    for (const model of ['champion', 'student'])
      for (const control of [
        ...[0, 1, 2, 3].filter((s) => start.hands[s].length).map((s) => [s]),
        [0, 2],
        [1, 3],
      ]) {
        const team = control[0] % 2;
        const entry = {
          round: roundInfo.round,
          match: record.matchId.slice(0, 8),
          startIndex: tail[0].index,
          startCards: remaining(start),
          model,
          control,
          team,
          exact: forMover(tail[0].value0, team),
          actual: signedFor(team),
        };
        const game = cloneGame(start);
        let modelMoves = 0,
          modelDecisions = 0,
          modelMistakes = 0,
          firstMistakeCards = null;
        try {
          for (let ply = 0; ply < 400; ply++) {
            const player = game.turn;
            const position = positionFromGame(game);
            const plays = candidates(game.hands[player], game.L, game.trick?.play || null);
            const value0 = solver.value(position);
            let index;
            if (control.includes(player)) {
              const choice = await modelChoice(config.values, config[model], game, plays);
              index = choice.index;
              modelMoves++;
              if (!choice.auto) modelDecisions++;
              if (!solver.keepsValue(position, plays[index], value0)) {
                modelMistakes++;
                if (firstMistakeCards === null) firstMistakeCards = remaining(game);
              }
            } else index = plays.findIndex((move) => solver.keepsValue(position, move, value0));
            const result = advanceRound(game, plays[index]);
            if (result) {
              entry.outcome = result.winner === team ? result.points : -result.points;
              break;
            }
          }
          Object.assign(entry, { modelMoves, modelDecisions, modelMistakes, firstMistakeCards });
        } catch (error) {
          if (!(error instanceof SolverBudget)) throw error;
          entry.budgetExceeded = true;
        }
        takeovers.push(entry);
      }
  }
  return { file: file.split('/').at(-1), ...roundInfo, decisions, takeovers };
}

async function worker() {
  const files = JSON.parse(option('files'));
  const pool = await createModelPool(ort, { threads: 1, limit: 2 });
  const config = {
    values: (file, state) => pool.values(file, state),
    champion: option('champion'),
    student: option('student'),
    maxCards: Number(option('max-cards')),
    budget: { maxNodes: Number(option('max-nodes')), maxMs: Number(option('max-ms')) },
    keepAssisted: (option('keep-assisted', '') || '').split(',').filter(Boolean),
  };
  const rows = [];
  for (const file of files) rows.push(await auditRound(file, config));
  writeFileSync(option('part-out'), JSON.stringify(rows));
  await pool.close();
}

async function main() {
  const raw = resolve(option('raw'));
  const out = resolve(option('out'));
  mkdirSync(out, { recursive: true });
  const files = readdirSync(raw)
    .filter((f) => /^round-\d+\.json$/.test(f))
    .sort()
    .map((f) => join(raw, f));
  const workers = Math.min(Number(option('workers', 8)), files.length);
  const args = {
    champion: resolve(option('champion')),
    student: resolve(option('student')),
    'max-cards': option('max-cards', 40),
    'max-nodes': option('max-nodes', 5_000_000),
    'max-ms': option('max-ms', 30_000),
    'keep-assisted': option('keep-assisted', ''),
  };
  const run = {
    ...args,
    raw,
    rounds: files.length,
    recordsSHA256: Object.fromEntries(files.map((f) => [f.split('/').at(-1), sha256(f)])),
    championSHA256: sha256(args.champion),
    studentSHA256: sha256(args.student),
    workers,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify(run, null, 2));
  const self = fileURLToPath(import.meta.url);
  // Longest records first spread the slow rounds across workers.
  const parts = Array.from({ length: workers }, () => []);
  files.forEach((f, i) => parts[i % workers].push(f));
  await Promise.all(
    parts.map(
      (part, i) =>
        new Promise((done, fail) => {
          const child = spawn(
            'nice',
            [
              '-n',
              '10',
              process.execPath,
              self,
              '--worker',
              `--files=${JSON.stringify(part)}`,
              `--part-out=${join(out, `part-${i}.json`)}`,
              ...Object.entries(args).map(([k, v]) => `--${k}=${v}`),
            ],
            { stdio: 'inherit' },
          );
          child.on('exit', (code) =>
            code === 0 ? done() : fail(Error(`worker ${i} exit ${code}`)),
          );
        }),
    ),
  );
  const rounds = parts
    .map((_, i) => JSON.parse(readFileSync(join(out, `part-${i}.json`), 'utf8')))
    .flat();
  writeFileSync(join(out, 'rows.json'), JSON.stringify(rounds));
  writeFileSync(
    join(out, 'run.json'),
    JSON.stringify({ ...run, finishedAt: new Date().toISOString() }, null, 2),
  );
  console.log(`audited ${rounds.length} rounds -> ${out}`);
}

/** Deterministic round-cluster bootstrap (mulberry32) for a ratio of sums over rounds. */
function bootstrap(groups, num, den, { draws = 2000, seed = 20261108 } = {}) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const keys = [...groups.keys()];
  const stats = [];
  for (let d = 0; d < draws; d++) {
    let n = 0,
      m = 0;
    for (let i = 0; i < keys.length; i++) {
      const rows = groups.get(keys[Math.floor(random() * keys.length)]);
      n += num(rows);
      m += den(rows);
    }
    if (m > 0) stats.push(n / m);
  }
  stats.sort((x, y) => x - y);
  return stats.length
    ? [stats[Math.floor(0.025 * stats.length)], stats[Math.ceil(0.975 * stats.length) - 1]]
    : null;
}

/** Preregistered summary: rates with round-cluster 95% bootstrap intervals, regrets, takeovers. */
export function summarize(rounds, { studentCards = 32 } = {}) {
  const rate = (rows, pick, keep = () => true) => {
    const kept = rows.filter((r) => keep(r) && r[pick] !== null && r.best !== null);
    const groups = new Map();
    for (const r of kept) groups.set(r.round, [...(groups.get(r.round) || []), r]);
    const hits = (rs) => rs.filter((r) => r[pick] === r.best).length;
    const regret = kept.reduce((sum, r) => sum + (r.best - r[pick]), 0);
    return {
      decisions: kept.length,
      rounds: groups.size,
      optimal: hits(kept),
      optimalRate: kept.length ? hits(kept) / kept.length : null,
      ci95: bootstrap(groups, hits, (rs) => rs.length),
      meanRegret: kept.length ? regret / kept.length : null,
      totalRegret: regret,
    };
  };
  const decisions = rounds.flatMap((r) => r.decisions);
  const choice = (r) => !r.auto && r.candidates > 1; // a real choice for the models
  const critical = (r) => choice(r) && r.optimalMoves !== null && r.optimalMoves < r.candidates;
  const unassisted = (r) => !r.assisted;
  const studentScope = (r) => r.cards <= studentCards;
  const buckets = [
    [1, 8],
    [9, 16],
    [17, 24],
    [25, 32],
    [33, 40],
  ];
  const block = (keep) => ({
    human: rate(decisions, 'human', keep),
    champion: rate(decisions, 'champion', keep),
    student: rate(decisions, 'student', (r) => keep(r) && studentScope(r)),
  });
  const humanErrors = (r) => critical(r) && r.human !== null && r.human < r.best;
  const takeovers = rounds.flatMap((r) => r.takeovers);
  const tk = (keep) => {
    const rows = takeovers.filter((t) => keep(t) && !t.budgetExceeded && t.outcome !== undefined);
    const groups = new Map();
    for (const t of rows) groups.set(t.round, [...(groups.get(t.round) || []), t]);
    const hits = (ts) => ts.filter((t) => t.outcome === t.exact).length;
    return {
      runs: rows.length,
      rounds: groups.size,
      reachedExact: hits(rows),
      reachedExactRate: rows.length ? hits(rows) / rows.length : null,
      ci95: bootstrap(groups, hits, (ts) => ts.length),
      meanShortfall: rows.length
        ? rows.reduce((sum, t) => sum + (t.exact - t.outcome), 0) / rows.length
        : null,
      budgetExceeded: takeovers.filter((t) => keep(t) && t.budgetExceeded).length,
      outcomes: rows.reduce((m, t) => {
        const k = `${t.actual}->${t.exact}->${t.outcome}`;
        m[k] = (m[k] || 0) + 1;
        return m;
      }, {}),
    };
  };
  const takeoverBlock = (extra) =>
    Object.fromEntries(
      ['champion', 'student'].flatMap((model) =>
        ['seat', 'team'].map((kind) => [
          `${model}/${kind}`,
          tk(
            (t) =>
              t.model === model &&
              (kind === 'seat' ? t.control.length === 1 : t.control.length === 2) &&
              extra(t),
          ),
        ]),
      ),
    );
  return {
    rounds: rounds.length,
    tails: rounds.map(({ round, actions, tailActions, tailStartCards, tailStop }) => ({
      round,
      actions,
      tailActions,
      tailStartCards,
      tailStop,
    })),
    humanDecisions: decisions.length,
    humanOutsideCandidates: decisions.filter((r) => r.humanOutsideCandidates).length,
    unscored: decisions.filter((r) =>
      [r.human, r.champion, r.student, r.optimalMoves].includes(null),
    ).length,
    decisionAudit: {
      choices: block(choice),
      critical: block(critical),
      criticalUnassisted: block((r) => critical(r) && unassisted(r)),
      byCards: Object.fromEntries(
        buckets.map(([lo, hi]) => [
          `${lo}-${hi}`,
          block((r) => critical(r) && r.cards >= lo && r.cards <= hi),
        ]),
      ),
      afterHumanError: {
        note: 'Critical decisions where the human move lost value: did the model pick a value-keeping move there?',
        champion: rate(decisions, 'champion', humanErrors),
        student: rate(decisions, 'student', (r) => humanErrors(r) && studentScope(r)),
      },
    },
    takeover: {
      all: takeoverBlock(() => true),
      teamFellShort: takeoverBlock((t) => t.actual < t.exact),
      lossTurnable: takeoverBlock((t) => t.actual < 0 && t.exact > 0),
      doubleDownAvoidable: takeoverBlock((t) => t.actual === -3 && t.exact > -3),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const summaryOnly = option('summarize');
  (process.argv.includes('--worker')
    ? worker()
    : summaryOnly
      ? Promise.resolve().then(() => {
          const out = resolve(summaryOnly);
          const rounds = JSON.parse(readFileSync(join(out, 'rows.json'), 'utf8'));
          const summary = summarize(rounds);
          writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
          console.log(JSON.stringify(summary.decisionAudit.critical, null, 2));
        })
      : main()
  ).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
