import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectedRound } from '../../../web/tests/fixtures/collected-round.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { validateRecord } from '../../../web/src/collection/validate.mjs';
import { makeDeck } from '../../../web/src/core/cards.js';
import { advanceRound } from '../../shared/simulation/simulation.mjs';
import { cloneGame, matchCandidate, replay } from '../endgame/human-endgames.mjs';
import { createSolver, positionFromGame, solveEndgame } from '../endgame/solver.mjs';
import {
  assertSafeOut,
  parseSeats,
  pimcRescore,
  playerSummary,
  reviewRecord,
  seatSummary,
  tributeKnowledge,
} from '../review/review.mjs';
import {
  EXACT_LABEL,
  ESTIMATE_LABEL,
  renderHTML,
  renderMarkdown,
  valueText,
} from '../review/report.mjs';

// Fixture deals (the collectedRound test fixture's own seeds, as in human-endgames.test.mjs).
const SEEDS = [9301001, 9301002, 9301003];
const MAX_CARDS = 16;
const reviews = new Map();
const reviewed = (seed, options = {}) => {
  const key = `${seed}:${JSON.stringify(options)}`;
  if (!reviews.has(key))
    reviews.set(key, reviewRecord(collectedRound(seed), { maxCards: MAX_CARDS, ...options }));
  return reviews.get(key);
};
const statesOf = (record) => {
  const states = new Map();
  for (const { index, game } of replay(record)) states.set(index, cloneGame(game));
  return states;
};
const DECK = makeDeck();
const faceKey = (cards) =>
  cards
    .map((c) => c.r * 4 + 'SHCDJ'.indexOf(c.s))
    .sort((a, b) => a - b)
    .join('.');
// Moves compare by shape and faces: the two physical copies of a face are interchangeable.
const playKey = (play) =>
  play.pass || !play.cards
    ? '-'
    : `${play.type}:${play.value}:${play.n}:${faceKey(play.cards.map((c) => (typeof c === 'number' ? DECK[c] : c)))}`;

test('optimal sets, played values and losses agree with an independent solveEndgame', () => {
  let checked = 0,
    flagged = 0;
  for (const seed of SEEDS) {
    const record = collectedRound(seed);
    const review = reviewed(seed);
    assert.ok(review.tail.actions > 0, `seed ${seed} has a solvable tail`);
    const states = statesOf(record);
    for (const d of review.decisions) {
      const game = states.get(d.index);
      const exact = solveEndgame(positionFromGame(game), { perspective: d.seat });
      assert.equal(d.best, exact.value, `position value ${seed}#${d.index}`);
      const optimalFaces = new Set(
        exact.actions
          .filter((a) => a.value === exact.value)
          .map((a) => playKey(a.play || { pass: true })),
      );
      const deck = game.hands.flat();
      const reported = new Set(d.optimal.map(playKey));
      assert.deepEqual(reported, optimalFaces, `optimal set ${seed}#${d.index}`);
      assert.equal(d.optimalCount, optimalFaces.size);
      assert.equal(d.candidates, exact.actions.length);
      const recorded = record.actions[d.index];
      const play = recorded.cards
        ? exact.actions.find(
            (a) =>
              a.play &&
              a.play.type === recorded.type &&
              a.play.value === recorded.value &&
              a.play.n === recorded.n &&
              faceKey(a.play.cards) ===
                faceKey(recorded.cards.map((id) => deck.find((c) => c.id === id))),
          )
        : exact.actions.find((a) => !a.play);
      assert.ok(play, 'played move is a candidate in the fixture');
      assert.equal(d.playedValue, play.value);
      assert.equal(d.loss, exact.value - play.value);
      assert.equal(d.flagged, d.loss > 0);
      checked++;
      flagged += Number(d.flagged);
    }
  }
  assert.ok(checked >= 20, `checked ${checked} decisions`);
  assert.ok(flagged >= 1, 'the fixtures contain at least one losing move');
});

test('principal lines are legal and end with the reported value', () => {
  let lines = 0;
  for (const seed of SEEDS) {
    const record = collectedRound(seed);
    const states = statesOf(record);
    for (const d of reviewed(seed).decisions) {
      const check = (line, start, expected) => {
        const game = cloneGame(start);
        let result = null;
        for (const [i, ply] of line.plies.entries()) {
          assert.ok(!result, 'line continues after the round ended');
          assert.equal(game.turn, ply.seat, `seat of ply ${i}`);
          assert.equal(ply.lead, !game.trick);
          const plays = candidates(game.hands[game.turn], game.L, game.trick?.play || null);
          const move = ply.play.pass
            ? null
            : plays.find((p) => p && playKey(p) === playKey(ply.play));
          assert.ok(ply.play.pass ? plays.includes(null) : move, `legal ply ${i}`);
          result = advanceRound(game, move);
        }
        assert.ok(result, 'line reaches the end of the round');
        const team = d.seat % 2;
        const signed = result.winner === team ? result.points : -result.points;
        assert.equal(signed, expected);
        assert.equal(line.value, expected);
        assert.deepEqual(result.order, line.order);
      };
      const start = states.get(d.index);
      check(d.line, start, d.best);
      if (d.afterPlayed) {
        const after = cloneGame(start);
        const plays = candidates(after.hands[after.turn], after.L, after.trick?.play || null);
        const recorded = record.actions[d.index];
        const played = recorded.cards
          ? plays[
              matchCandidate(plays, {
                type: recorded.type,
                value: recorded.value,
                n: recorded.n,
                cards: recorded.cards.map((id) => after.hands[after.turn].find((c) => c.id === id)),
              })
            ]
          : null;
        assert.ok(
          !advanceRound(after, played),
          'a losing move that ends the round has no line after it',
        );
        check(d.afterPlayed, after, d.playedValue);
      }
      lines++;
    }
  }
  assert.ok(lines >= 20);
});

test('seat selection reviews only the chosen seats and keeps their entries unchanged', () => {
  assert.deepEqual(parseSeats('all'), [0, 1, 2, 3]);
  assert.deepEqual(parseSeats('2,0,2'), [0, 2]);
  assert.deepEqual(parseSeats('3,1'), [1, 3]);
  for (const bad of ['4', 'x', '', ' ', '0,', '1.0', '0x1', '1e0', '-0'])
    assert.throws(() => parseSeats(bad), `rejects ${JSON.stringify(bad)}`);
  for (const seed of SEEDS) {
    const all = reviewed(seed);
    for (const seat of [0, 1, 2, 3]) {
      const one = reviewed(seed, { seats: [seat] });
      assert.deepEqual(one.seats, [seat]);
      assert.ok(one.decisions.every((d) => d.seat === seat));
      assert.deepEqual(
        one.decisions.map((d) => [d.index, d.loss, d.optimalCount]),
        all.decisions.filter((d) => d.seat === seat).map((d) => [d.index, d.loss, d.optimalCount]),
      );
      assert.deepEqual(one.tail, all.tail, 'the tail does not depend on the seat');
    }
  }
});

test('PIMC re-scoring runs only on flagged small decisions and is kept apart from exact totals', () => {
  const rounds = SEEDS.map((seed) => ({
    file: `fixture-${seed}`,
    ...reviewed(seed, { pimc: 8, pimcCards: 20 }),
  }));
  let estimated = 0;
  for (const round of rounds)
    for (const d of round.decisions) {
      if (!d.flagged || d.tableCards > 20) {
        assert.equal(d.pimc, undefined);
        continue;
      }
      estimated++;
      assert.equal(d.pimc.worlds, 8);
      assert.ok(d.pimc.used >= 1 && d.pimc.used <= 8);
      assert.ok(d.pimc.losingWorlds >= 0 && d.pimc.losingWorlds <= d.pimc.used);
      assert.ok(d.pimc.meanBest >= d.pimc.meanPlayed);
      assert.ok(
        ['all-worlds', 'most-worlds', 'few-worlds', 'hindsight-only'].includes(d.pimc.verdict),
      );
    }
  assert.ok(estimated >= 1);
  const summary = seatSummary(rounds);
  const exact = rounds
    .flatMap((r) => r.decisions)
    .reduce((s, d) => s + (d.unscored ? 0 : d.loss), 0);
  assert.equal(
    summary.reduce((s, r) => s + r.lostPoints, 0),
    exact,
  );
  const review = {
    raw: 'fixture',
    trust: 'test',
    options: {
      maxCards: MAX_CARDS,
      maxNodes: 1,
      maxMs: 1,
      pimc: 8,
      pimcCards: 20,
      seats: [0, 1, 2, 3],
    },
    rounds,
    summary,
  };
  const md = renderMarkdown(review);
  const html = renderHTML(review);
  for (const text of [md, html]) {
    assert.ok(text.includes(EXACT_LABEL));
    assert.ok(text.includes(ESTIMATE_LABEL));
    for (const round of rounds) assert.ok(text.includes(round.label));
  }
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('prefers-color-scheme: dark'));
  assert.ok(!/<script|https?:\/\//.test(html), 'self-contained, no scripts or remote assets');
});

test('PIMC re-scoring never depends on the hidden hands of the other seats', () => {
  let checked = 0;
  for (const seed of SEEDS)
    for (const { game, play } of replay(collectedRound(seed))) {
      if (game.hands.reduce((s, h) => s + h.length, 0) > 12) continue;
      const plays = candidates(game.hands[game.turn], game.L, game.trick?.play || null);
      if (plays.length < 2) continue;
      const index = Math.max(0, matchCandidate(plays, play));
      const run = (g) =>
        pimcRescore(g, plays, index, { solver: createSolver(), worlds: 6, seed: 7 + checked });
      const others = [0, 1, 2, 3].filter((s) => s !== game.turn);
      const pool = others.flatMap((s) => game.hands[s]).reverse();
      const swapped = cloneGame(game);
      let k = 0;
      for (const s of others) swapped.hands[s] = pool.slice(k, (k += game.hands[s].length));
      assert.deepEqual(run(swapped), run(cloneGame(game)), `${seed} hidden-hand independent`);
      checked++;
    }
  assert.ok(checked >= 3, `checked ${checked}`);
});

test('player summary groups by anonymous player ID, and values never print as -0', () => {
  const rounds = SEEDS.map((seed) => reviewed(seed));
  const players = playerSummary(rounds);
  const ids = new Set(rounds.flatMap((r) => r.players.map((p) => p.id)));
  assert.ok(players.every((p) => ids.has(p.player)));
  assert.equal(
    players.reduce((s, p) => s + p.decisions, 0),
    rounds.reduce((s, r) => s + r.decisions.length, 0),
  );
  assert.equal(
    players.reduce((s, p) => s + p.lostPoints, 0),
    seatSummary(rounds).reduce((s, r) => s + r.lostPoints, 0),
  );
  assert.equal(valueText(0), '0');
  assert.equal(valueText(-3), '−3（被双下）');
  assert.equal(valueText(0.5), '+0.50');
});

test('tribute knowledge covers only cards the seat itself gave or received', () => {
  const record = { tribute: [{ from: 3, to: 2, card: 107, returnCard: 0 }] };
  assert.deepEqual(tributeKnowledge(record, 3), [{ seat: 2, card: 107 }]);
  assert.deepEqual(tributeKnowledge(record, 2), [{ seat: 3, card: 0 }]);
  assert.deepEqual(tributeKnowledge(record, 0), []);
});

test('command line writes JSON, Markdown and HTML and refuses the data directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-'));
  const raw = join(dir, 'raw');
  mkdirSync(raw);
  for (const [i, seed] of [9301001, 9301003].entries())
    writeFileSync(
      join(raw, `round-00000000000${i}.json`),
      JSON.stringify({ ...validateRecord(collectedRound(seed)), trust: 'unverified_browser' }),
    );
  assert.throws(() => assertSafeOut(join(raw, 'review'), raw));
  assert.doesNotThrow(() => assertSafeOut(join(dir, 'out'), raw));
  // A symlinked path into the raw directory is still refused.
  const link = join(dir, 'link');
  symlinkSync(raw, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertSafeOut(join(link, 'review'), raw));
  assert.throws(() => assertSafeOut(join(dir, 'x', 'ai', 'shared', 'data', 'y')));
  const script = fileURLToPath(new URL('../review/review.mjs', import.meta.url));
  const out = join(dir, 'out');
  execFileSync(
    process.execPath,
    [
      script,
      `--raw=${raw}`,
      `--out=${out}`,
      '--seat=0,1',
      `--max-cards=${MAX_CARDS}`,
      '--workers=2',
    ],
    { stdio: 'pipe' },
  );
  for (const name of ['review.json', 'review.md', 'review.html'])
    assert.ok(existsSync(join(out, name)), name);
  assert.ok(!existsSync(join(out, '.part-0.json')));
  const review = JSON.parse(readFileSync(join(out, 'review.json'), 'utf8'));
  assert.equal(review.rounds.length, 2);
  assert.deepEqual(review.options.seats, [0, 1]);
  assert.ok(review.rounds.every((r) => r.decisions.every((d) => d.seat <= 1)));
  assert.throws(() =>
    execFileSync(process.execPath, [script, `--raw=${raw}`, `--out=${join(raw, 'x')}`], {
      stdio: 'pipe',
    }),
  );
  for (const bad of ['--seat=', '--workers=abc', '--max-cards=x', '--pimc=1.5'])
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, `--raw=${raw}`, `--out=${join(dir, 'bad')}`, bad], {
          stdio: 'pipe',
        }),
      bad,
    );
  assert.ok(!existsSync(join(dir, 'bad', 'review.json')));
});
