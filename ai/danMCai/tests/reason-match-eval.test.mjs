import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { advanceRound, createRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { createMatchRound } from '../../shared/simulation/match-simulation.mjs';
import { playMatch } from '../../shared/simulation/match-rollout.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { RULES_ONLY } from '../../../web/src/rule-bot/runtime.mjs';
import { BRAIN_STAT } from '../../../web/src/rule-bot/endgame-brain.mjs';
import {
  closeTally,
  createReasonBot,
  createWebClint,
  emptyTally,
  exchangeRecords,
  openOutput,
  parseSeeds,
  playReasonMatch,
  readPairs,
  searchSeedOf,
  summarize,
} from '../belief/reason-match-eval.mjs';

const remaining = (game) => game.hands.reduce((n, h) => n + h.length, 0);
const match = (previousOrder, levels = [3, 2]) => ({
  levels,
  lvlTeam: 0,
  aFails: [0, 0],
  round: 2,
  previousOrder,
});

test('exchange records rebuild the public tribute and return of a single tribute', () => {
  const order = [0, 1, 2, 3];
  for (let seed = 1; seed < 40; seed++) {
    const game = createMatchRound(seed, match(order));
    const { trib, kang } = exchangeRecords(createRound(seed).hands, game, order);
    if (kang) continue;
    assert.equal(trib.length, 1);
    const [t] = trib;
    assert.deepEqual([t.g, t.r, game.turn], [3, 0, 3]);
    assert.ok(game.hands[0].includes(t.tc) && game.hands[3].includes(t.rc));
    assert.ok(createRound(seed).hands[3].some((c) => c.id === t.tc.id));
    assert.ok(createRound(seed).hands[0].some((c) => c.id === t.rc.id));
    assert.ok(game.hands.every((h) => h.length === 27));
  }
});

test('exchange records of a double tribute put the leader first; anti-tribute names the jokers', () => {
  const order = [0, 2, 1, 3];
  let paid = 0,
    resisted = 0;
  for (let seed = 1; seed < 400 && (!paid || !resisted); seed++) {
    const game = createMatchRound(seed, match(order));
    const record = exchangeRecords(createRound(seed).hands, game, order);
    if (record.kang) {
      resisted++;
      assert.deepEqual(record.trib, []);
      assert.equal(record.kang.leader, 0);
      assert.equal(
        record.kang.has.reduce((s, x) => s + x.n, 0),
        [1, 3].reduce((s, g) => s + game.hands[g].filter((c) => c.r === 17).length, 0),
      );
      assert.equal(game.turn, 0);
    } else {
      paid++;
      assert.equal(record.trib.length, 2);
      assert.equal(record.trib[0].g, game.turn);
      assert.deepEqual(record.trib.map((t) => t.g).sort(), [1, 3]);
      assert.deepEqual(record.trib.map((t) => t.r).sort(), [0, 2]);
      for (const t of record.trib)
        assert.ok(game.hands[t.r].includes(t.tc) && game.hands[t.g].includes(t.rc));
    }
  }
  assert.ok(paid > 0 && resisted > 0, 'found both a paid and a resisted double tribute');
  assert.deepEqual(exchangeRecords(createRound(5).hands, createRound(5), null), {});
});

/** A cheap deterministic focal policy that never reads hidden cards. */
const cheap = (game, p) => {
  const plays = candidates(game.hands[p], game.L, game.trick?.play);
  return plays[(game.log.length * 7) % plays.length];
};

test('without exchange records the match loop is exactly playMatch (rule mode, table policy)', async () => {
  for (const [seed, team] of [
    [3838190777, 0],
    [3838190777, 1],
  ]) {
    const ours = await playReasonMatch({
      seed,
      focalTeam: team,
      focal: cheap,
      clint: 'rules-only',
      exchanges: false,
    });
    const theirs = await playMatch({
      seed,
      team,
      mode: 'rule',
      ruleVersion: 'rules-v2',
      evaluate: true,
      tablePolicy: async (game, p) => cheap(game, p),
    });
    assert.equal(ours.winner, theirs.winner);
    assert.deepEqual(
      ours.history.map(({ exchange: _, ...h }) => h),
      theirs.history,
    );
  }
});

test('the web Clint seat with the brain off plays exactly the development-suite rules-v2', async () => {
  for (const [seed, team] of [
    [3838190779, 0],
    [3838190779, 1],
  ]) {
    const web = await playReasonMatch({
      seed,
      focalTeam: team,
      focal: cheap,
      clintSettings: RULES_ONLY,
    });
    const suite = await playReasonMatch({
      seed,
      focalTeam: team,
      focal: cheap,
      clint: 'rules-only',
    });
    assert.equal(web.clint, 'web');
    assert.equal(web.clintBrain.calls, 0);
    assert.deepEqual(web.history, suite.history);
  }
});

test('the web Clint seat runs the 残局大脑 when every hand holds at most 12 cards', () => {
  for (let s = 9100; ; s++) {
    const game = createRound(s);
    game.tok = 'brain-test:' + s;
    game.round = 1;
    const random = seededRandom(s ^ 0x5bd1e995);
    let found = false;
    for (let ply = 0; ply < 1000; ply++) {
      const p = game.turn;
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      if (game.hands.every((h) => h.length <= 12) && game.hands[p].length > 1 && plays.length > 2) {
        found = true;
        break;
      }
      if (advanceRound(game, plays[Math.floor(random() * plays.length)])) break;
    }
    if (!found) continue;
    const before = BRAIN_STAT.calls;
    const p = game.turn;
    const play = createWebClint(1, { ms: 1500, worldMs: 500 })(game, p);
    assert.equal(BRAIN_STAT.calls, before + 1);
    if (play) assert.ok(play.cards.every((c) => game.hands[p].includes(c)));
    else assert.ok(game.trick);
    delete game.tok;
    assert.throws(() => createWebClint(1)(game, p), /game.tok/);
    return;
  }
});

test('a complete match with exchange records reports levels, A-failures and timing', async () => {
  const m = await playReasonMatch({
    seed: 3838190778,
    focalTeam: 1,
    focal: cheap,
    clintSettings: RULES_ONLY,
  });
  assert.ok(['win', 'loss', 'draw'].includes(m.focalResult));
  assert.equal(m.rounds, m.history.length);
  assert.equal(m.history[0].exchange, 'none');
  assert.ok(m.history.slice(1).every((h) => ['paid', 'resisted'].includes(h.exchange)));
  assert.equal(m.finalLevels.length, 2);
  assert.ok(m.finalLevels.every((l) => l >= 2 && l <= 14));
  assert.equal(m.focalFinalLevel, m.finalLevels[1]);
  assert.ok(m.time.focalDecisions > 0 && m.time.opponentDecisions > 0);
  if (m.winner !== null) assert.equal(m.history.at(-1).win, true);
});

/** Random legal play until a real decision with `lo`..`hi` cards on the table. */
function position(seed, lo, hi) {
  for (let s = seed; ; s++) {
    const game = createRound(s);
    const random = seededRandom(s ^ 0x5bd1e995);
    for (let ply = 0; ply < 1000; ply++) {
      const p = game.turn;
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      const n = remaining(game);
      if (
        n >= lo &&
        n <= hi &&
        plays.length > 2 &&
        !plays.some((x) => x && x.cards.length === game.hands[p].length)
      )
        return game;
      if (advanceRound(game, plays[Math.floor(random() * plays.length)])) break;
    }
  }
}

const stubValues = async (state) =>
  Float32Array.from(state.actions, (ids, i) => ids.length + 0.001 * ((i * 37) % 11));
const stubProbabilities = async () => new Float32Array(54 * 3).fill(1 / 3);
const stubBot = (extra = {}) => {
  const tableCalls = [];
  const bot = createReasonBot({
    values: stubValues,
    probabilities: stubProbabilities,
    tableDecide: async (state) => {
      tableCalls.push(state);
      const v = await stubValues(state);
      return { index: v.indexOf(Math.max(...v)) };
    },
    ...extra,
  });
  return { bot, tableCalls };
};

test('a midgame decision searches within the budget and records it', async () => {
  const game = position(7100, 21, 40);
  const { bot, tableCalls } = stubBot();
  const tally = emptyTally();
  const play = await bot.decide(game, game.turn, { searchSeed: 12345 }, tally);
  const key = (x) =>
    x
      ? x.cards
          .map((c) => c.id)
          .sort((a, b) => a - b)
          .join(',')
      : 'pass';
  const legal = candidates(game.hands[game.turn], game.L, game.trick?.play).map(key);
  assert.ok(legal.includes(key(play)));
  assert.equal(tally.midgame.requests, 1);
  assert.equal(tally.midgame.completed, 1);
  assert.equal(tally.champion, 0);
  assert.equal(tableCalls.length, 0);
  const closed = closeTally(tally);
  assert.equal(closed.midgame.searchMs.n, 1);
  assert.equal(closed.midgame.fallbackCount, 0);
});

test('a budget overrun plays champion 017 and is counted; a reply past the hard limit too', async () => {
  const game = position(7200, 21, 40);
  let clock = 0;
  const { bot, tableCalls } = stubBot({ now: () => (clock += 1000) });
  const tally = emptyTally();
  await bot.decide(game, game.turn, { searchSeed: 1 }, tally);
  assert.deepEqual(tally.midgame.fallbacks, { budget: 1 });
  assert.equal(tally.champion, 1);
  assert.equal(tableCalls.length, 1);

  let slow = 0;
  const timeout = stubBot({ now: () => (slow += 20_000) });
  const t2 = emptyTally();
  const solver = timeout.bot.engine.solver;
  await timeout.bot.decide(game, game.turn, { searchSeed: 1 }, t2);
  assert.deepEqual(t2.midgame.fallbacks, { timeout: 1 });
  assert.notEqual(timeout.bot.engine.solver, solver, 'a timed-out worker loses its solver table');
});

test('outside the search bands and on finishing moves the bot does not search', async () => {
  const game = createRound(7300);
  const { bot, tableCalls } = stubBot();
  const tally = emptyTally();
  await bot.decide(game, game.turn, { searchSeed: 1 }, tally);
  assert.equal(tally.midgame.requests + tally.endgame.requests, 0);
  assert.equal(tableCalls.length, 1);
});

test('search seeds are fixed 32-bit hashes of the round seed', () => {
  assert.equal(searchSeedOf(42), searchSeedOf(42));
  assert.notEqual(searchSeedOf(42), searchSeedOf(43));
  for (const s of [0, 1, 2 ** 32 - 1]) assert.ok(searchSeedOf(s) >= 0 && searchSeedOf(s) < 2 ** 32);
});

test('seeds parse from a range or a file and must be distinct 32-bit integers', () => {
  assert.deepEqual(parseSeeds({ seeds: '3838190000..3838190001' }), [3838190000, 3838190001]);
  assert.throws(() => parseSeeds({ seeds: '5..4' }));
  assert.throws(() => parseSeeds({}));
  const dir = mkdtempSync(join(tmpdir(), 'reason-seeds-'));
  try {
    writeFileSync(join(dir, 's.json'), '[1, 1]');
    assert.throws(() => parseSeeds({ seedsFile: join(dir, 's.json') }));
    writeFileSync(join(dir, 's.json'), '[7, 3]');
    assert.deepEqual(parseSeeds({ seedsFile: join(dir, 's.json') }), [7, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const fakeMatch = (seed, focalTeam, winner, levels = [14, 9]) => ({
  seed,
  focalTeam,
  neuralTeam: focalTeam,
  winner,
  focalResult: winner === null ? 'draw' : winner === focalTeam ? 'win' : 'loss',
  finalLevels: levels,
  focalFinalLevel: levels[focalTeam],
  opponentFinalLevel: levels[1 - focalTeam],
  aFails: [0, 0],
  focalAFails: 0,
  opponentAFails: 0,
  rounds: 2,
  history: [
    { team: 0, up: 2 },
    { team: winner ?? 1, up: 1 },
  ],
  focal: closeTally(emptyTally()),
  time: { wallMs: 100 },
});

test('output directories keep one protocol and resume by completed pairs', async () => {
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'reason-out-'));
  try {
    const seeds = [11, 12];
    const sha = createHash('sha256').update(JSON.stringify(seeds)).digest('hex');
    const protocol = { protocol: 'test', seeds: { file: 'seeds.json', sha256: sha } };
    const out = join(dir, 'run');
    const digest = openOutput(out, protocol, seeds);
    assert.equal(openOutput(out, protocol, seeds), digest);
    assert.throws(() => openOutput(out, { ...protocol, protocol: 'other' }, seeds), /different/);
    const foreign = join(dir, 'foreign');
    openOutput(foreign, protocol, seeds);
    rmSync(join(foreign, 'protocol.json'));
    assert.throws(() => openOutput(foreign, protocol, seeds), /not empty/);

    const row = (index, seed) => ({
      protocolSHA256: digest,
      index,
      seed,
      matches: [fakeMatch(seed, 0, 0), fakeMatch(seed, 1, 0)],
    });
    appendFileSync(join(out, 'pairs.jsonl'), JSON.stringify(row(1, 12)) + '\n');
    appendFileSync(join(out, 'pairs.jsonl'), '{"torn'); // a crash mid-write
    assert.deepEqual(
      readPairs(out, digest, seeds).map((r) => r.index),
      [1],
    );
    appendFileSync(join(out, 'pairs.jsonl'), JSON.stringify(row(0, 99)) + '\n');
    assert.throws(() => readPairs(out, digest, seeds), /Invalid pair record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('summary counts wins, losses and draws with seed-pair cluster intervals', async () => {
  const rows = [
    { index: 0, matches: [fakeMatch(1, 0, 0), fakeMatch(1, 1, 1)] },
    { index: 1, matches: [fakeMatch(2, 0, 1, [9, 14]), fakeMatch(2, 1, null, [14, 14])] },
    { index: 2, matches: [fakeMatch(3, 0, 0), fakeMatch(3, 1, 0)] },
  ];
  const s = await summarize(rows);
  assert.equal(s.pairs, 3);
  assert.deepEqual([s.matches, s.wins, s.losses, s.draws], [6, 3, 2, 1]);
  assert.equal(s.matchWinRate, 0.5);
  assert.ok(s.confidence95.matchWinRate[0] <= 0.5 && s.confidence95.matchWinRate[1] >= 0.5);
  assert.equal(s.netMatchScore, 1 / 6);
  assert.deepEqual(s.pairOutcomes, { '2-0': 1, '1.5-0.5': 0, '1-1': 1, '0.5-1.5': 1, '0-2': 0 });
  assert.equal(s.perSide.focalTeam0.matches, 3);
  assert.equal(s.perSide.focalTeam0.wins, 2);
  assert.equal(s.perSide.focalTeam1.wins, 1);
  assert.equal(s.perSide.focalTeam1.draws, 1);
  assert.equal(s.meanFinalLevelDifference, (5 - 5 - 5 + 0 + 5 - 5) / 6);
  assert.equal(s.aFailures.matchesEndedByADraw, 1);
});

test('an endgame decision runs the exact-solver search and records it', async () => {
  const game = position(7400, 6, 12);
  const { bot } = stubBot();
  const tally = emptyTally();
  await bot.decide(game, game.turn, { searchSeed: 9 }, tally);
  const e = closeTally(tally).endgame;
  assert.equal(e.requests, 1);
  assert.equal(e.completed + e.fallbackCount, 1);
  assert.equal(tally.midgame.requests, 0);
});
