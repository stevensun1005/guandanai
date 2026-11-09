import { setPriority, constants } from 'node:os';
/**
 * Post-game review of finished rounds (cloud D1 records; trust=unverified_browser).
 *
 * After a round every hand is public, so the end of the round can be solved exactly. For each
 * round the solvable tail is found exactly as in the human-endgame audit (walk back from the last
 * action with one shared solver; stop at the first position above --max-cards or over budget). For
 * every decision of the selected seat(s) in the tail the tool reports, in the mover team's signed
 * round points (+-1/+-2/+-3 of the whole round, never tempo, trick or bomb proxies):
 *
 *  - the position value and the exact value of the move actually played (loss = best - played);
 *  - the set of value-keeping candidates (all optimal moves);
 *  - the solver principal line: from that position, every seat repeatedly plays its first
 *    value-keeping candidate to the end of the round (and, for a losing move, the same line after
 *    the move that was actually played).
 *
 * These are "perfect-information hindsight optimal" values: the best result if every player could
 * see all four hands. A player who only sees their own hand cannot always reach them. Optionally
 * (--pimc=K) a losing decision at <= --pimc-cards cards is re-scored from the mover's own view:
 * K worlds of the unseen cards are sampled uniformly from public information (plus tribute cards
 * the mover gave or received), every candidate is solved exactly in each world (labelDecision of
 * the PIMC actor), and the report says in how many worlds the played move also loses. That is an
 * ESTIMATE (uniform belief ignores what earlier plays reveal) and is always reported separately.
 *
 * Nothing is uploaded and nothing is written next to the records.
 *
 *   node ai/danMCai/review/review.mjs --raw=<dir of round-*.json | one file> [--seat=n|all]
 *        [--out=<dir>] [--max-cards=40] [--max-nodes=5000000] [--max-ms=30000] [--pimc=8]
 *        [--pimc-cards=20] [--workers=4] [--rounds=<file,...>] [--limit=<n>]
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleWorlds } from '../../shared/search/belief.mjs';
import { searchObservation } from '../../shared/search/pimc.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { validateRecord } from '../../../web/src/collection/validate.mjs';
import { cardText, isWild, makeDeck, sortHand, TYPE_NAME } from '../../../web/src/core/cards.js';
import { cloneGame, loadRecord, matchCandidate, replay } from '../endgame/human-endgames.mjs';
import { labelDecision } from '../endgame/pimc-actor.mjs';
import {
  createSolver,
  positionFromGame,
  signedPoints,
  SolverBudget,
  step,
} from '../endgame/solver.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_OUT = join(ROOT, 'ai/danMCai/workspace/review');
export const DEFAULTS = Object.freeze({
  maxCards: 40,
  maxNodes: 5_000_000,
  maxMs: 30_000,
  pimc: 0,
  pimcCards: 20,
});
export const VALUE_KIND = 'perfect-information-hindsight-signed-round-points';

const deck = makeDeck();
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);
const forMover = (team0Value, seat) => (seat % 2 === 0 ? team0Value : -team0Value);
const budgeted = (fn) => {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof SolverBudget)) throw error;
    return null;
  }
};

/** Cards in Chinese notation, high to low; the level heart (wild) is marked 配. */
export function cardsText(cards, level) {
  return sortHand(cards.slice(), level)
    .map((card) => cardText(card) + (isWild(card, level) ? '(配)' : ''))
    .join(' ');
}

/** A play (or null = pass) as plain JSON with readable text. */
export function playJSON(play, level) {
  if (!play) return { pass: true, text: '不要' };
  return {
    type: play.type,
    value: play.value,
    n: play.n,
    cards: play.cards.map((card) => card.id),
    text: `${TYPE_NAME[play.type] || play.type} ${cardsText(play.cards, level)}`,
  };
}

const handJSON = (hand, level) => ({
  cards: sortHand(hand.slice(), level).map((card) => card.id),
  text: cardsText(hand, level),
});

/**
 * Solver principal line from a position: every seat plays its first value-keeping candidate (in
 * candidates() order) until the round ends. Returns the plies and the final result; `value` is the
 * signed result for team 0 and always equals the position's exact value.
 */
export function principalLine(solver, position, { maxPlies = 400 } = {}) {
  const plies = [];
  let p = position;
  for (let ply = 0; ply < maxPlies; ply++) {
    const v = solver.value(p);
    const plays = candidates(p.hands[p.turn], p.L, p.trick?.play || null);
    const play = plays.find((move) => solver.keepsValue(p, move, v));
    if (play === undefined) throw Error('No value-keeping move in principal line');
    plies.push({ seat: p.turn, lead: !p.trick, play: playJSON(play, p.L) });
    const next = step(p, play);
    if (next.result) return { plies, result: next.result, value: signedPoints(next.result, 0) };
    p = next.position;
  }
  throw Error('Principal line did not terminate');
}

/** Cards the mover knows from the tribute exchange (what it gave, what it got back). */
export function tributeKnowledge(record, seat) {
  const known = [];
  for (const t of record.tribute || []) {
    if (t.from === seat) known.push({ seat: t.to, card: t.card });
    if (t.to === seat) known.push({ seat: t.from, card: t.returnCard });
  }
  return known;
}

const decisionSeed = (recordId, index) =>
  createHash('sha256').update(`review:${recordId}:${index}`).digest().readUInt32LE(0);

/**
 * Re-score one decision from the mover's own view with `worlds` public-information worlds.
 * The mean per candidate comes from labelDecision (the PIMC actor's label); per-world counts use
 * the same seed, so the same worlds. Returns null when no world was solved in budget.
 */
export function pimcRescore(game, plays, playedIndex, { solver, worlds, seed, known = [] }) {
  const view = cloneGame(game);
  // Tribute cards still unplayed and not back in the mover's own hand.
  const own = new Set(view.hands[view.turn].map((card) => card.id));
  view.publicKnownCards = known.filter(({ card }) => !own.has(card));
  const label = labelDecision(view, plays, { solver, worlds, minWorlds: 1, seed });
  if (!label.q) return { worlds, used: label.used, estimate: null };
  const observation = searchObservation(view, view.turn);
  let used = 0,
    losing = 0;
  for (const hands of sampleWorlds(observation, { count: worlds, seed })) {
    const position = {
      ...positionFromGame(view),
      hands: hands.map((hand) => hand.map((id) => deck[id])),
    };
    const values = budgeted(() =>
      plays.map((play) => forMover(solver.actionValue(position, play), view.turn)),
    );
    if (!values) continue;
    used++;
    if (values[playedIndex] < Math.max(...values)) losing++;
  }
  // Integer world values summed in the same order, so equal means compare exactly.
  const top = Math.max(...label.q);
  const best = label.q[playedIndex] === top ? playedIndex : label.q.indexOf(top);
  const verdict =
    used === 0
      ? 'unknown'
      : losing === used
        ? 'all-worlds'
        : losing * 2 > used
          ? 'most-worlds'
          : losing === 0
            ? 'hindsight-only'
            : 'few-worlds';
  return {
    worlds,
    used,
    losingWorlds: losing,
    verdict,
    meanPlayed: label.q[playedIndex],
    meanBest: label.q[best],
    pimcBest: playJSON(plays[best], game.L),
    pimcBestIndex: best,
    playedIsPimcBest: best === playedIndex,
  };
}

/**
 * Review one validated record. `seats` selects the reviewed seats (default all four).
 * Returns plain JSON: round info, the solvable tail and one entry per reviewed decision.
 */
export function reviewRecord(record, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const checked = opts.checked || validateRecord(record);
  const seats = opts.seats || [0, 1, 2, 3];
  const solver = opts.solver || createSolver({ maxNodes: opts.maxNodes, maxMs: opts.maxMs });
  const signedFor = (team) => (checked.result.team === team ? 1 : -1) * checked.result.up;
  const states = [];
  for (const { index, action, game, play } of replay(record))
    states.push({ index, action, play, game: cloneGame(game) });

  // Solvable tail, exactly as the audit: depends only on the solver, never on the moves.
  const tail = [];
  let stop = { reason: 'start-of-round', index: null, cards: null };
  for (let i = states.length - 1; i >= 0; i--) {
    const { game, index } = states[i];
    const cards = remaining(game);
    if (cards > opts.maxCards) {
      stop = { reason: 'card-cap', index, cards };
      break;
    }
    const started = performance.now();
    const value0 = budgeted(() => solver.value(positionFromGame(game)));
    if (value0 === null) {
      stop = { reason: 'budget', index, cards, ms: Math.round(performance.now() - started) };
      break;
    }
    tail.unshift({ ...states[i], value0 });
  }

  const decisions = [];
  for (const { index, action, game, play, value0 } of tail) {
    const seat = game.turn;
    if (!seats.includes(seat)) continue;
    const position = positionFromGame(game);
    const plays = candidates(game.hands[seat], game.L, game.trick?.play || null);
    const playedIndex = matchCandidate(plays, play);
    const best = forMover(value0, seat);
    const entry = {
      index,
      fromEnd: record.actions.length - index,
      seat,
      actor: action.actor,
      assisted: action.assisted === true,
      tableCards: remaining(game),
      counts: game.hands.map((hand) => hand.length),
      hand: handJSON(game.hands[seat], game.L),
      hands: game.hands.map((hand) => handJSON(hand, game.L)),
      trick: game.trick
        ? { player: game.trick.player, play: playJSON(game.trick.play, game.L) }
        : null,
      out: game.out.slice(),
      candidates: plays.length,
      forced: plays.length === 1,
      best,
      played: { ...playJSON(play, game.L), inCandidates: playedIndex >= 0 },
    };
    try {
      const playedValue = forMover(solver.actionValue(position, play), seat);
      const optimal = plays.filter((move) => solver.keepsValue(position, move, value0));
      const line = principalLine(solver, position);
      Object.assign(entry, {
        playedValue,
        loss: best - playedValue,
        optimal: optimal.map((move) => playJSON(move, game.L)),
        optimalCount: optimal.length,
        line: { plies: line.plies, value: forMover(line.value, seat), order: line.result.order },
      });
      entry.flagged = entry.loss > 0;
      if (entry.flagged) {
        const after = step(position, play);
        if (!after.result) {
          const rest = principalLine(solver, after.position);
          entry.afterPlayed = {
            plies: rest.plies,
            value: forMover(rest.value, seat),
            order: rest.result.order,
          };
        }
      }
    } catch (error) {
      if (!(error instanceof SolverBudget)) throw error;
      entry.unscored = true;
      entry.flagged = false;
    }
    if (entry.flagged && opts.pimc > 0 && entry.tableCards <= opts.pimcCards) {
      const scored = playedIndex >= 0 ? plays : [...plays, play];
      entry.pimc = pimcRescore(game, scored, playedIndex >= 0 ? playedIndex : plays.length, {
        solver,
        worlds: opts.pimc,
        seed: decisionSeed(record.id, index),
        known: tributeKnowledge(record, seat),
      });
    }
    decisions.push(entry);
  }

  const start = tail[0];
  return {
    id: record.id,
    match: record.matchId.slice(0, 8),
    round: record.round,
    label: `${record.matchId.slice(0, 8)}:${record.round}`,
    level: record.level,
    startedAt: record.startedAt || null,
    players: (record.seats || []).map((s) => ({
      id: s?.id ? String(s.id).slice(0, 8) : null,
      human: s?.human ?? null,
    })),
    actions: record.actions.length,
    result: {
      team: checked.result.team,
      up: checked.result.up,
      order: checked.order,
      team0: signedFor(0),
    },
    tribute: (record.tribute || []).map((t) => ({ ...t })),
    tail: {
      actions: tail.length,
      startIndex: start ? start.index : null,
      startCards: start ? remaining(start.game) : null,
      startTurn: start ? start.game.turn : null,
      startHands: start ? start.game.hands.map((hand) => handJSON(hand, start.game.L)) : null,
      startTrick: start?.game.trick
        ? { player: start.game.trick.player, play: playJSON(start.game.trick.play, start.game.L) }
        : null,
      exactTeam0: start ? start.value0 : null,
      stop,
    },
    seats: seats.slice(),
    decisions,
  };
}

/** Review one file of a stored record (server-added fields stripped and validated). */
export function reviewFile(file, options = {}) {
  const { record, checked } = loadRecord(file);
  return {
    file: basename(file),
    sha256: sha256File(file),
    ...reviewRecord(record, { ...options, checked }),
  };
}

const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Per-seat totals across rounds (exact values only; PIMC counts reported separately). */
export function seatSummary(rounds) {
  const rows = new Map();
  for (const round of rounds)
    for (const d of round.decisions) {
      const row = rows.get(d.seat) || {
        seat: d.seat,
        rounds: new Set(),
        decisions: 0,
        choices: 0,
        scored: 0,
        flagged: 0,
        lostPoints: 0,
        nonHuman: 0,
        assisted: 0,
        pimcChecked: 0,
        pimcMostWorlds: 0,
        pimcHindsightOnly: 0,
      };
      row.rounds.add(round.label);
      row.decisions++;
      if (!d.forced) row.choices++;
      if (d.actor !== 'human') row.nonHuman++;
      if (d.assisted) row.assisted++;
      if (!d.unscored) {
        row.scored++;
        // A move outside the candidate list could beat the candidates' value; never count a gain.
        row.lostPoints += Math.max(0, d.loss);
        if (d.flagged) row.flagged++;
      }
      if (d.pimc?.used) {
        row.pimcChecked++;
        if (d.pimc.verdict === 'all-worlds' || d.pimc.verdict === 'most-worlds')
          row.pimcMostWorlds++;
        if (d.pimc.verdict === 'hindsight-only') row.pimcHindsightOnly++;
      }
      rows.set(d.seat, row);
    }
  return [...rows.values()]
    .sort((a, b) => a.seat - b.seat)
    .map((row) => ({ ...row, rounds: row.rounds.size }));
}

/**
 * Per-player totals across rounds, keyed by the anonymous player ID prefix stored in each record
 * (seat numbers can be different people in different matches). Exact values only.
 */
export function playerSummary(rounds) {
  const rows = new Map();
  for (const round of rounds)
    for (const d of round.decisions) {
      const player = round.players?.[d.seat]?.id || `${round.match}#${d.seat}`;
      const row = rows.get(player) || {
        player,
        seats: new Set(),
        rounds: new Set(),
        decisions: 0,
        scored: 0,
        flagged: 0,
        lostPoints: 0,
        assisted: 0,
      };
      row.seats.add(d.seat);
      row.rounds.add(round.label);
      row.decisions++;
      if (d.assisted) row.assisted++;
      if (!d.unscored) {
        row.scored++;
        row.lostPoints += Math.max(0, d.loss);
        if (d.flagged) row.flagged++;
      }
      rows.set(player, row);
    }
  return [...rows.values()]
    .sort((a, b) => a.player.localeCompare(b.player))
    .map((row) => ({
      ...row,
      seats: [...row.seats].sort((a, b) => a - b),
      rounds: row.rounds.size,
    }));
}

export function parseSeats(text = 'all') {
  if (text === 'all') return [0, 1, 2, 3];
  const parts = String(text).split(',');
  if (parts.some((s) => !/^[0-3]$/.test(s.trim())))
    throw Error(`Invalid --seat=${text} (use 0-3, a comma list, or all)`);
  return [...new Set(parts.map((s) => Number(s.trim())))].sort((a, b) => a - b);
}

/** Resolve symlinks (for example /tmp -> /private/tmp) through the nearest existing ancestor. */
const realish = (path) => {
  let head = resolve(path);
  const rest = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...rest);
};

/** Refuse to write into the data snapshot (or any shared data directory). `raw` is optional. */
export function assertSafeOut(out, raw = null) {
  const inside = (child, parent) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
  };
  const outs = [resolve(out), realish(out)];
  const forbidden = [join(ROOT, 'ai/shared/data'), realish(join(ROOT, 'ai/shared/data'))];
  if (raw) {
    const rawDir = existsSync(raw) && statSync(raw).isDirectory() ? raw : dirname(raw);
    forbidden.push(resolve(rawDir), realish(rawDir));
  }
  if (
    outs.some(
      (o) =>
        forbidden.some((dir) => inside(o, dir)) ||
        (o.split(sep).join('/') + '/').includes('/ai/shared/data/'),
    )
  )
    throw Error(`Refusing to write the review into the data directory: ${out}`);
}

export function listRecords(raw, { rounds = null, limit = null } = {}) {
  let files = statSync(raw).isDirectory()
    ? readdirSync(raw)
        .filter((f) => /^round-\d+\.json$/.test(f))
        .sort()
        .map((f) => join(raw, f))
    : [raw];
  if (rounds) {
    const wanted = new Set(rounds);
    files = files.filter((f) => wanted.has(basename(f)));
  }
  if (limit) files = files.slice(0, limit);
  return files;
}

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

/** Integer option in [min, max]; an empty, non-numeric or fractional value is an error. */
function intOption(name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const text = option(name);
  const value = text === undefined ? fallback : Number(text);
  if (text === '' || !Number.isInteger(value) || value < min || value > max)
    throw Error(`Invalid --${name}=${text} (integer ${min}..${max})`);
  return value;
}

function cliOptions() {
  return {
    seats: parseSeats(option('seat', 'all')),
    maxCards: intOption('max-cards', DEFAULTS.maxCards, 1, 108),
    maxNodes: intOption('max-nodes', DEFAULTS.maxNodes, 1),
    maxMs: intOption('max-ms', DEFAULTS.maxMs, 1),
    pimc: intOption('pimc', DEFAULTS.pimc, 0, 1024),
    pimcCards: intOption('pimc-cards', DEFAULTS.pimcCards, 1, 108),
  };
}

async function worker() {
  const files = JSON.parse(option('files'));
  const options = cliOptions();
  writeFileSync(option('part-out'), JSON.stringify(files.map((f) => reviewFile(f, options))));
}

async function main() {
  const raw = resolve(option('raw') ?? '');
  if (!option('raw')) throw Error('Usage: review.mjs --raw=<dir or round JSON> [--seat=n|all]');
  const out = resolve(option('out', DEFAULT_OUT));
  assertSafeOut(out, raw);
  const options = cliOptions();
  const files = listRecords(raw, {
    rounds: option('rounds') ? option('rounds').split(',') : null,
    limit: option('limit') ? intOption('limit', null, 1) : null,
  });
  if (!files.length) throw Error(`No round-*.json records in ${raw}`);
  const workers = Math.min(intOption('workers', 4, 1, 64), files.length);
  mkdirSync(out, { recursive: true });
  const startedAt = new Date().toISOString();
  const parts = Array.from({ length: workers }, () => []);
  files.forEach((f, i) => parts[i % workers].push(f));
  const self = fileURLToPath(import.meta.url);
  const passthrough = process.argv.filter((a) =>
    /^--(seat|max-cards|max-nodes|max-ms|pimc|pimc-cards)=/.test(a),
  );
  const children = [];
  const stopAll = () => children.forEach((child) => child.exitCode === null && child.kill());
  await Promise.all(
    parts.map(
      (part, i) =>
        new Promise((done, fail) => {
          const child = spawn(
            process.platform === 'win32' ? process.execPath : 'nice',
            [
              ...(process.platform === 'win32' ? [] : ['-n', '10', process.execPath]),
              self,
              '--worker',
              `--files=${JSON.stringify(part)}`,
              `--part-out=${join(out, `.part-${i}.json`)}`,
              ...passthrough,
            ],
            { stdio: 'inherit', windowsHide: true },
          );
          children.push(child);
          if (process.platform === 'win32' && child.pid) {
            try {
              setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
            } catch (error) {
              if (error.code !== 'ERR_SYSTEM_ERROR' || error.info?.code !== 'ESRCH') {
                stopAll();
                fail(error);
                return;
              }
            }
          }
          child.on('error', fail);
          child.on('exit', (code) =>
            code === 0 ? done() : fail(Error(`review worker ${i} exit ${code}`)),
          );
        }),
    ),
  ).catch((error) => {
    // One failed worker stops the others instead of leaving them running after exit.
    stopAll();
    for (let i = 0; i < workers; i++) rmSync(join(out, `.part-${i}.json`), { force: true });
    throw error;
  });
  const rounds = parts
    .flatMap((_, i) => JSON.parse(readFileSync(join(out, `.part-${i}.json`), 'utf8')))
    .sort((a, b) => a.file.localeCompare(b.file));
  const review = {
    kind: 'post-game-review',
    valueKind: VALUE_KIND,
    trust: 'unverified_browser',
    raw,
    options,
    workers,
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: seatSummary(rounds),
    players: playerSummary(rounds),
    rounds,
  };
  writeFileSync(join(out, 'review.json'), JSON.stringify(review));
  const { writeReports } = await import('./report.mjs');
  const written = writeReports(review, out);
  for (let i = 0; i < workers; i++) rmSync(join(out, `.part-${i}.json`), { force: true });
  console.log(
    `reviewed ${rounds.length} rounds -> ${[join(out, 'review.json'), ...written].join(', ')}`,
  );
}

/** True when this module is the entry script (robust to symlinks such as /tmp on macOS). */
export const isEntry = (url) => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
};

if (isEntry(import.meta.url)) {
  (process.argv.includes('--worker') ? worker() : main()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
