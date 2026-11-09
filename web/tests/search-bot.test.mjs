/**
 * Belief-search research bot (menu id 9001): the browser port must make exactly the Node research
 * bot's choices (ai/danMCai/belief/midgame-search.mjs) on the same public information, with
 * deterministic stand-ins for the two networks so the test needs no model files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import {
  DEFAULTS,
  endgameDecision as nodeEndgame,
  maskHidden,
  searchDecision as nodeMidgame,
  worldSeed as nodeWorldSeed,
} from '../../ai/danMCai/belief/midgame-search.mjs';
import { SEARCH } from '../../ai/danMCai/endgame/evaluate.mjs';
import { createSolver } from '../../ai/danMCai/endgame/solver.mjs';
import { advanceRound, createRound, seededRandom } from '../../ai/shared/simulation/simulation.mjs';
import { searchObservation } from '../../ai/shared/search/pimc.mjs';
import { sampleBeliefWorlds } from '../../ai/danMCai/belief/sampler.mjs';
import { candidates } from '../src/ai/candidates.js';
import { policyState } from '../src/ai/observation.js';
import { cardIndex } from '../src/ai/encoding.mjs';
import {
  FIRST_LOAD_WAIT_MS,
  NODE_SOLVER_MS,
  SEARCH_BOT_V1,
  SEARCH_BUDGETS,
  hardTimeoutMs,
  searchBand,
  worldSeed,
} from '../src/ai/search/constants.mjs';
import {
  SearchBudgetError,
  argmax,
  endgameDecision,
  midgameDecision,
  pimcLabelFromWorlds,
  pimcPick,
  remainingCards,
  searchBotDecision,
} from '../src/ai/search/core.mjs';
import { coachSearchValues } from '../src/ai/search/coach.mjs';
import { restoreGame, searchPayload } from '../src/ai/search/payload.mjs';
import {
  KnownCardsError,
  publicKnownCards,
  BIG_JOKER_FACE,
} from '../src/ai/search/known-cards.mjs';
import { createSearchClient, deviceClass } from '../src/ai/search/client.js';
import {
  CLINT_BRAIN_MS,
  HARD_MS,
  REASON_MS,
  RULES_ONLY_TIMEOUT_MS,
  TURN_MS,
  clintBrainMs,
} from '../src/ai/turn-timing.mjs';
import { readFileSync } from 'node:fs';
import {
  BOT_CHOICES,
  DEFAULT_BOT_MODEL,
  NEURAL_DEFAULT_MODEL,
  SEARCH_BOTS,
  botIdentity,
  botModel,
  botModelId,
  botModelName,
  searchBot,
  searchBotManifest,
  validateCatalog,
} from '../src/ai/model-catalog.mjs';
import catalog from '../src/ai/model-catalog.json' with { type: 'json' };
import { validateRecord } from '../src/collection/validate.mjs';
import { collectedRound } from './fixtures/collected-round.mjs';
import { nodeStub } from '../tools/node-stub.mjs';
import { COACH_MODEL_ID, COACH_SEARCH_BOT_ID } from '../src/coach/evaluation.mjs';
import { normalizeBotPreferences, storedBotPreferences } from '../src/lobby/bot-setup.js';

const PLAY_MS_SOURCE = readFileSync(new URL('../src/game/clock.js', import.meta.url), 'utf8');

/* Deterministic stand-ins: a hash of the public inputs, never of hidden cards. */
function mix(...parts) {
  let h = 2166136261;
  for (const part of parts)
    for (const ch of String(part)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}
const fakeValues = (state) =>
  Float32Array.from(state.actions, (ids) => {
    const h = mix(state.p, state.log.length, state.hand.length, ids.join('.'));
    return ((h % 20001) - 10000) / 10000;
  });
const fakeProbabilities = (view) => {
  const probs = new Float32Array(162);
  for (let i = 0; i < 162; i++) probs[i] = 0.05 + (mix(view.p, view.log.length, i) % 1000) / 1000;
  return probs;
};
const nodeConfig = (solver) => ({
  ...DEFAULTS,
  worldsSource: 'belief',
  endgame: 'pimc',
  endgameWorlds: 'belief',
  champion: 'stand-in',
  values: async (_file, state) => fakeValues(state),
  belief: { probabilities: async (view) => fakeProbabilities(view) },
  solver,
});
const webContext = (solver) => ({
  values: async (state) => fakeValues(state),
  probabilities: async (view) => fakeProbabilities(view),
  solver,
  offset: 0,
  now: () => 0,
});
// Small deterministic node budget (no clock) so both solvers skip the same worlds.
const testSolver = () => createSolver({ maxNodes: 40_000, maxMs: 1e9, maxTable: 1e9 });

/** Real decisions of a stand-in champion round: [{game copy, seed, band}] in the search bands. */
function bandPositions(seed, perBand = 2) {
  const game = createRound(seed);
  const found = { midgame: 0, endgame: 0 },
    out = [];
  for (let ply = 0; ply < 1000; ply++) {
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[p].length);
    if (index < 0 && plays.length === 1) index = 0;
    const band = searchBand(remainingCards(game));
    if (index < 0 && band && found[band] < perBand && ply % 3 === 0) {
      found[band]++;
      out.push({ game: structuredClone(game), seed, band });
    }
    if (index < 0) index = argmax(fakeValues(policyState(game, p, 0, plays)));
    if (advanceRound(game, plays[index])) return out;
  }
  throw Error('Round did not terminate');
}

test('frozen search settings equal the held-out-tested Node bot', () => {
  for (const key of ['lo', 'hi', 'worlds', 'k', 'net', 'endgameHi'])
    assert.equal(SEARCH_BOT_V1[key], DEFAULTS[key], key);
  assert.equal(SEARCH_BOT_V1.endgameWorlds, SEARCH.worlds);
  assert.equal(SEARCH_BOT_V1.minWorlds, SEARCH.minWorlds);
  assert.equal(SEARCH_BOT_V1.tieTolerance, SEARCH.tieTolerance);
  assert.equal(SEARCH_BOT_V1.solverMaxNodes, SEARCH.solver.maxNodes);
  assert.equal(SEARCH_BOT_V1.worldSeed, SEARCH.worldSeed);
  for (const [seed, ply] of [
    [990023757, 0],
    [4294967295, 211],
    [7, 44],
  ])
    assert.equal(worldSeed(seed, ply), nodeWorldSeed(seed, ply));
  for (const budget of Object.values(SEARCH_BUDGETS)) {
    assert.ok(
      budget.solverMs <= SEARCH.solver.maxMs && budget.solverTable <= SEARCH.solver.maxTable,
    );
    // owner 2026-11-09: 60 s per move like a human, at most 50 s of reasoning from the turn
    // start, 10 s kept for the fallback move; a hung worker is replaced at 52 s
    assert.equal(budget.midgameMs, REASON_MS);
    assert.equal(budget.endgameMs, REASON_MS);
    assert.equal(hardTimeoutMs(budget), HARD_MS);
    assert.ok(hardTimeoutMs(budget) + RULES_ONLY_TIMEOUT_MS < TURN_MS, 'fallback before 60 s');
  }
  assert.deepEqual([TURN_MS, REASON_MS, HARD_MS, CLINT_BRAIN_MS], [60_000, 50_000, 52_000, 30_000]);
  assert.equal(PLAY_MS_SOURCE.includes('PLAY_MS = 60000'), true, 'the human turn clock is 60 s');
  assert.ok(FIRST_LOAD_WAIT_MS <= 10_000, 'a first load never holds a table for a whole budget');
  assert.equal(searchBand(41), null);
  assert.equal(searchBand(40), 'midgame');
  assert.equal(searchBand(21), 'midgame');
  assert.equal(searchBand(20), 'endgame');
});

test('browser search core makes exactly the Node research bot decisions', async () => {
  let midgame = 0,
    endgame = 0,
    differs = 0;
  for (let seed = 731900100; seed < 731900106; seed++)
    for (const { game, band } of bandPositions(seed)) {
      const p = game.turn;
      const masked = restoreGame(searchPayload(game, p, 0, seed));
      if (band === 'midgame') {
        const node = await nodeMidgame(game, seed, nodeConfig(null));
        const web = await midgameDecision(masked, seed, webContext(null));
        for (const key of ['index', 'championIndex', 'roots', 'tied'])
          assert.deepEqual(web[key], node[key], `${seed} ${key}`);
        assert.deepEqual(web.means, node.means);
        assert.deepEqual(web.outcome, node.outcome);
        assert.deepEqual(web.worlds, node.worlds);
        differs += Number(web.index !== web.championIndex);
        midgame++;
      } else {
        const node = await nodeEndgame(game, seed, nodeConfig(testSolver()));
        const web = await endgameDecision(masked, seed, webContext(testSolver()));
        assert.equal(web.index, node.index, `${seed} endgame index`);
        assert.equal(web.used, node.used);
        assert.equal(web.minWorldsFallback, node.fallback);
        assert.deepEqual(web.worlds, node.worlds);
        differs += Number(web.index !== web.championIndex);
        endgame++;
      }
    }
  assert.ok(midgame >= 8 && endgame >= 8, `${midgame} midgame / ${endgame} endgame positions`);
  assert.ok(differs > 0, 'the stand-in search deviates from the champion somewhere');
});

test('the worker payload carries only public information and the own hand', async () => {
  for (const { game, seed } of bandPositions(731900200, 3)) {
    const p = game.turn;
    const payload = searchPayload(game, p, 0, seed);
    assert.ok(!('hands' in payload));
    const restored = restoreGame(payload);
    assert.deepEqual(searchObservation(restored, p), searchObservation(maskHidden(game, p), p));
    const other = (p + 1) % 4;
    if (restored.hands[other].length) assert.throws(() => restored.hands[other][0].id, /Hidden/);
    // Permuting the hidden cards between the other seats cannot change the payload.
    const swapped = structuredClone(game);
    const [a, b] = [(p + 1) % 4, (p + 3) % 4];
    const n = Math.min(swapped.hands[a].length, swapped.hands[b].length);
    for (let i = 0; i < n; i++)
      [swapped.hands[a][i], swapped.hands[b][i]] = [swapped.hands[b][i], swapped.hands[a][i]];
    assert.deepEqual(searchPayload(swapped, p, 0, seed), payload);
    const result = await searchBotDecision(restored, seed, webContext(testSolver()));
    assert.ok(result && Number.isInteger(result.index));
  }
  const game = createRound(5);
  assert.throws(() => searchPayload(game, (game.turn + 1) % 4, 0, 1), /seat to move/);
});

test('a search that exceeds its budget is discarded as a whole', async () => {
  const positions = [731900300, 731900301].flatMap((seed) => bandPositions(seed, 1));
  for (const { game, seed, band } of positions) {
    const masked = restoreGame(searchPayload(game, game.turn, 0, seed));
    let calls = 0;
    const ctx = {
      ...webContext(testSolver()),
      now: () => calls++,
      deadline: band === 'midgame' ? 40 : 3, // mid-rollout / after a few solver calls
    };
    await assert.rejects(searchBotDecision(masked, seed, ctx), (error) => {
      assert.ok(error instanceof SearchBudgetError);
      assert.equal(error.stage, band);
      return true;
    });
  }
});

test('a clock-stopped solver call under a shorter-than-Node limit falls back as a whole', async () => {
  assert.equal(NODE_SOLVER_MS, SEARCH.solver.maxMs);
  // both shipped budgets use the Node per-call limit; the rule below guards a shorter budget
  assert.equal(SEARCH_BUDGETS.desktop.solverMs, NODE_SOLVER_MS);
  assert.equal(SEARCH_BUDGETS.mobile.solverMs, NODE_SOLVER_MS);
  const positions = [];
  for (let seed = 731900700; positions.length < 6 && seed < 731900760; seed++)
    for (const position of bandPositions(seed, 2))
      if (position.band === 'endgame') positions.push(position);
  let stopped = 0;
  for (const { game, seed } of positions) {
    const masked = () => restoreGame(searchPayload(game, game.turn, 0, seed));
    const full = await endgameDecision(masked(), seed, webContext(testSolver()));
    // An already-expired clock stops every call that reaches 1,024 nodes.
    const clock = () => createSolver({ maxNodes: 40_000, maxMs: -1, maxTable: 1e9 });
    let strict;
    try {
      strict = await endgameDecision(masked(), seed, {
        ...webContext(clock()),
        solverTimeIsBudget: true,
      });
    } catch (error) {
      assert.ok(error instanceof SearchBudgetError);
      assert.equal(error.stage, 'endgame');
      stopped++;
      continue;
    }
    // No call reached the clock check: the decision is the unbudgeted one.
    assert.equal(strict.index, full.index);
    assert.equal(strict.used, full.used);
  }
  assert.ok(stopped > 0, 'some endgame call reaches the clock check');
  // A node-limit stop is the tested Node rule: the world is skipped, never a fallback.
  const { game, seed } = positions[0];
  const tiny = createSolver({ maxNodes: 1, maxMs: 1e9, maxTable: 1e9 });
  const skipped = await endgameDecision(
    restoreGame(searchPayload(game, game.turn, 0, seed)),
    seed,
    { ...webContext(tiny), solverTimeIsBudget: true },
    { ...SEARCH_BOT_V1, solverMaxNodes: 1 },
  );
  assert.equal(skipped.minWorldsFallback, true);
  assert.equal(skipped.index, skipped.championIndex);
});

test('solver calls are capped by the time left to the 50 s mark; a capped stop falls back', async () => {
  const positions = [];
  for (let seed = 731900700; positions.length < 6 && seed < 731900760; seed++)
    for (const position of bandPositions(seed, 2))
      if (position.band === 'endgame') positions.push(position);
  let compared = 0,
    stopped = 0;
  for (const { game, seed } of positions) {
    const masked = () => restoreGame(searchPayload(game, game.turn, 0, seed));
    const full = await endgameDecision(masked(), seed, webContext(testSolver()));
    // 3 s or more left before every call: the shared solver runs every call, as without a deadline
    {
      const capped = [];
      const roomy = await endgameDecision(masked(), seed, {
        ...webContext(testSolver()),
        now: () => 0,
        deadline: REASON_MS,
        solverMs: NODE_SOLVER_MS,
        cappedSolver: (ms) => capped.push(ms),
      });
      assert.equal(capped.length, 0);
      assert.equal(roomy.index, full.index);
    }
    // 1.5 s left: every call runs on a solver limited to the 1.5 s left (never past the mark)
    const limits = [];
    const capped =
      (maxMs, maxNodes = 40_000) =>
      (ms) => {
        limits.push(ms);
        return createSolver({ maxNodes, maxMs, maxTable: 1e9 });
      };
    const late = {
      ...webContext(testSolver()),
      now: () => REASON_MS - 1500,
      deadline: REASON_MS,
      solverMs: NODE_SOLVER_MS,
    };
    if (full.used === full.worlds.length) {
      // a capped call that finishes gives the same exact value: the same decision
      const finished = await endgameDecision(masked(), seed, {
        ...late,
        cappedSolver: capped(1e9, 1e9),
      });
      assert.equal(finished.index, full.index);
      assert.equal(finished.used, full.used);
      compared++;
    }
    // a capped call stopped by its node limit (its own cold table) also discards the search
    try {
      const nodes = await endgameDecision(masked(), seed, { ...late, cappedSolver: capped(1e9) });
      assert.equal(nodes.index, full.index);
    } catch (error) {
      assert.ok(error instanceof SearchBudgetError);
    }
    assert.ok(limits.length > 0 && limits.every((ms) => ms === 1500));
    // the time left runs out inside a capped call: the whole search is discarded (017)
    try {
      const strict = await endgameDecision(masked(), seed, { ...late, cappedSolver: capped(-1) });
      assert.equal(strict.index, full.index, 'no call reached the clock check');
    } catch (error) {
      assert.ok(error instanceof SearchBudgetError);
      assert.equal(error.stage, 'endgame');
      stopped++;
    }
  }
  assert.ok(compared > 0 && stopped > 0, `${compared} compared / ${stopped} stopped`);
});

/** A deal with a public tribute (and return) applied and some plays made. */
function tributeScenario(seed) {
  const random = seededRandom(seed);
  const game = createRound(seed);
  const pick = (n) => Math.floor(random() * n);
  const double = random() < 0.4;
  const givers = double ? [0, 2].map((s) => (s + pick(2)) % 4) : [pick(4)];
  const trib = [];
  const unique = [...new Set(givers)];
  for (const g of unique) {
    const r = (g + 1 + 2 * pick(2)) % 4; // an opponent receives
    const hand = game.hands[g];
    const tc = hand.reduce((best, c) => (c.r > best.r ? c : best), hand[0]);
    game.hands[g] = hand.filter((c) => c !== tc);
    game.hands[r].push(tc);
    trib.push({ g, r, tc });
  }
  for (const t of trib) {
    const hand = game.hands[t.r];
    const rc = random() < 0.2 && hand.includes(t.tc) ? t.tc : hand[pick(hand.length)];
    game.hands[t.r] = hand.filter((c) => c !== rc);
    game.hands[t.g].push(rc);
    t.rc = rc;
  }
  game.trib = trib;
  const plies = pick(30);
  for (let ply = 0; ply < plies; ply++) {
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[p].length);
    if (index < 0) index = argmax(fakeValues(policyState(game, p, 0, plays)));
    if (advanceRound(game, plays[index])) return null;
  }
  return game;
}

test('public tribute and return cards fix consistent worlds or fall back', () => {
  let checked = 0;
  for (let seed = 731900400; seed < 731900600; seed++) {
    const game = tributeScenario(seed);
    if (!game) continue;
    const p = game.turn;
    const restored = restoreGame(searchPayload(game, p, 0, seed));
    const view = searchObservation(restored, p);
    const worlds = sampleBeliefWorlds(view, fakeProbabilities(view), { count: 8, seed });
    for (const hands of worlds) {
      assert.deepEqual(
        hands.map((h) => h.length),
        game.hands.map((h) => h.length),
      );
      for (const { seat, card } of view.publicKnownCards) assert.ok(hands[seat].includes(card));
      // Every known face is truly held in the real deal (public deductions never err).
      for (const { seat, card } of view.publicKnownCards)
        assert.ok(game.hands[seat].some((c) => cardIndex(c.id) === cardIndex(card)));
    }
    checked++;
  }
  assert.ok(checked > 150);
  // Anti-tribute: the named giver holds both big jokers; the mover's own seat is skipped.
  const game = createRound(11);
  const p = game.turn,
    g = (p + 1) % 4;
  const jokers = game.hands.flat().filter((c) => c.r === 17);
  for (const joker of jokers) {
    const owner = game.hands.findIndex((h) => h.includes(joker));
    if (owner === g) continue;
    const swap = game.hands[g].find((c) => c.r !== 17);
    game.hands[owner] = game.hands[owner].map((c) => (c === joker ? swap : c));
    game.hands[g] = game.hands[g].map((c) => (c === swap ? joker : c));
  }
  game.kang = { has: [{ g, n: 2 }] };
  const known = publicKnownCards(
    searchObservation(restoreGame(searchPayload(game, p, 0, 1)), p),
    searchPayload(game, p, 0, 1).exchanges,
  );
  assert.deepEqual(
    known.map((k) => [k.seat, cardIndex(k.card)]),
    [
      [g, BIG_JOKER_FACE],
      [g, BIG_JOKER_FACE],
    ],
  );
  // A contradiction (more known cards than the seat holds) is a fallback, not a guess.
  const view = searchObservation(restoreGame(searchPayload(game, p, 0, 1)), p);
  const three = {
    kang: {
      has: [
        { g, n: 2 },
        { g: (g + 2) % 4, n: 1 },
      ],
    },
  };
  assert.throws(() => publicKnownCards(view, three), KnownCardsError);
});

test('the research bot is the menu default over champion 017, which backs its fallbacks', () => {
  const bot = searchBot('9001');
  assert.equal(SEARCH_BOTS.length, 1);
  // Owner deployment decision 2026-11-09, not an acceptance: new seats default to 9001.
  assert.equal(DEFAULT_BOT_MODEL, '9001');
  assert.equal(NEURAL_DEFAULT_MODEL, '017');
  assert.equal(catalog.defaultId, '017');
  assert.equal(COACH_MODEL_ID, '017');
  assert.equal(COACH_SEARCH_BOT_ID, '9001');
  assert.equal(BOT_CHOICES.at(-1).id, '9001');
  assert.equal(botModelId('9001'), '9001');
  assert.equal(botModel('9001').id, '017');
  assert.equal(botModelName('9001'), 'danMCai-reason-v000855042');
  // the collection identity keeps its version string through the 2026-11-09 rename
  assert.equal(bot.version, 'v000855042-bsearch1-16d76783');
  assert.equal(
    bot.belief.sha256,
    '16d767830e4536180fac56d744e95934b7525ab67b18d27df4f33066033d65e9',
  );
  assert.deepEqual({ ...bot.search }, { ...SEARCH_BOT_V1 });
  const digest = createHash('sha256')
    .update(JSON.stringify(searchBotManifest(bot, botModel('017'))))
    .digest('hex');
  assert.deepEqual(botIdentity('9001'), { id: '9001', sha256: digest, version: bot.version });
  assert.notEqual(digest, botModel('017').sha256);
  assert.equal(botIdentity('017').sha256, botModel('017').sha256);
  assert.equal(botIdentity('clint-rule').sha256, null);
  const copy = () => structuredClone(catalog);
  assert.equal(validateCatalog(copy()).searchBots.length, 1);
  for (const mutate of [
    (c) => (c.searchBots[0].id = '017'),
    (c) => (c.searchBots[0].base = '026'),
    (c) => (c.searchBots[0].base = '999'),
    (c) => (c.searchBots[0].search.worlds = 16),
    (c) => (c.searchBots[0].belief.url = 'https://example.com/belief.onnx'),
    (c) => (c.searchBots[0].belief.file = 'bot-017.onnx'),
    (c) => (c.searchBots[0].sha256 = 'bad'),
    (c) => (c.searchBots[0].version = 'v 1'),
    (c) => (c.defaultId = '9001'),
    // the menu default is the current champion or a search bot over exactly that champion
    (c) => (c.selection.defaultChoice = '012'),
    (c) => (c.selection.defaultChoice = 'clint-rule'),
    (c) => (c.selection.danMCaiChampions = ['012', '017']) && (c.defaultId = '012'),
  ]) {
    const value = copy();
    mutate(value);
    assert.throws(() => validateCatalog(value));
  }
});

test('a fresh profile defaults every seat to 9001; saved choices survive only while offered', () => {
  assert.deepEqual(normalizeBotPreferences(storedBotPreferences(null, null)), {
    S: '9001',
    E: '9001',
    N: '9001',
    W: '9001',
  });
  // v1 stored all four seats on any change, so its '017' is the old implicit default
  const legacy = { S: '017', E: 'clint-rule', N: '012', W: '017' };
  // 012 (previous champion) left the menu on 2026-11-09: it falls back to the default
  assert.deepEqual(normalizeBotPreferences(storedBotPreferences(null, legacy)), {
    S: '9001',
    E: 'clint-rule',
    N: '9001',
    W: '9001',
  });
  // v2 stores only explicit non-default seats, including a deliberate 017
  assert.deepEqual(normalizeBotPreferences(storedBotPreferences({ E: '017' }, legacy)), {
    S: '9001',
    E: '017',
    N: '9001',
    W: '9001',
  });
  // v2 entries pointing to retired menu entries (P0, previous champion, older GuanZero)
  assert.deepEqual(
    normalizeBotPreferences(storedBotPreferences({ S: '001', E: '012', N: '025', W: '026' })),
    { S: '9001', E: '9001', N: '9001', W: '026' },
  );
  const value = structuredClone(catalog);
  delete value.selection.defaultChoice;
  assert.equal(validateCatalog(value).defaultId, '017');
});

test('collection records accept the research bot identity without a collector change', () => {
  const record = collectedRound();
  const identity = botIdentity('9001');
  for (const seat of record.seats) seat.bot = identity;
  for (const action of record.actions) if (action.model) action.model = identity;
  assert.ok(validateRecord(record));
});

test('device classes and the bundled search worker', async () => {
  assert.equal(deviceClass({ userAgent: 'iPhone', hardwareConcurrency: 6 }), 'mobile');
  assert.equal(deviceClass({ userAgent: 'Mac', hardwareConcurrency: 4 }), 'mobile');
  assert.equal(
    deviceClass({ userAgent: 'Mac', hardwareConcurrency: 10, deviceMemory: 8 }),
    'desktop',
  );
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await build({
    entryPoints: [root + 'web/src/ai/search-worker.mjs'],
    bundle: true,
    format: 'esm',
    write: false,
    external: ['./vendor/*'],
    plugins: [nodeStub],
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  assert.ok(!/from ['"]node:/.test(code) && !/import\(['"]node:/.test(code));
  assert.ok(!code.includes('onnxruntime-node'));
});

test('coach values are exactly the research bot search values of every searched move', async () => {
  let midgame = 0,
    endgame = 0;
  for (let seed = 731900100; seed < 731900102; seed++)
    for (const { game, band } of bandPositions(seed)) {
      const masked = () => restoreGame(searchPayload(game, game.turn, 0, seed));
      if (band === 'midgame') {
        const bot = await midgameDecision(masked(), seed, webContext(null));
        const coach = await coachSearchValues(masked(), seed, webContext(null));
        assert.equal(coach.kind, 'midgame');
        assert.deepEqual(Array.from(coach.base), Array.from(bot.base));
        assert.equal(coach.evaluated, bot.roots.length);
        coach.values.forEach((value, i) =>
          assert.equal(value, bot.roots.includes(i) ? bot.means[bot.roots.indexOf(i)] : null),
        );
        midgame++;
      } else {
        const bot = await endgameDecision(masked(), seed, webContext(testSolver()));
        let pauses = 0;
        const coach = await coachSearchValues(masked(), seed, {
          ...webContext(testSolver()),
          pause: async () => pauses++,
        });
        const label = pimcLabelFromWorlds(
          masked(),
          coach.plays,
          bot.worlds,
          testSolver(),
          SEARCH_BOT_V1.minWorlds,
        );
        assert.equal(coach.kind, 'endgame');
        assert.equal(coach.used, bot.used);
        assert.deepEqual(coach.values, label.q);
        assert.equal(pauses, bot.worlds.length, 'a task boundary between worlds');
        // the coach's best searched move is the bot's move (same tie rule)
        if (coach.values) assert.equal(pimcPick(label, bot.base).index, bot.index);
        else assert.equal(bot.minWorldsFallback, true);
        endgame++;
      }
    }
  assert.ok(midgame >= 4 && endgame >= 4, `${midgame} midgame / ${endgame} endgame positions`);
  const outside = createRound(3);
  assert.equal(await coachSearchValues(outside, 1, webContext(null)), null);
});

/** Fake search workers: record posts, reply on demand. */
function fakeWorkers() {
  const workers = [];
  const spawn = () => {
    const worker = {
      posted: [],
      terminated: false,
      postMessage(message) {
        this.posted.push(message);
      },
      terminate() {
        this.terminated = true;
      },
      reply(id, result) {
        this.onmessage({ data: { id, result } });
      },
    };
    workers.push(worker);
    return worker;
  };
  return { workers, spawn };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('table searches take the shared worker before the move coach', async () => {
  // 1. a running coach job is asked to stop; the table search is posted after it ends
  {
    const { workers, spawn } = fakeWorkers();
    const client = createSearchClient({ version: 't', device: 'desktop', spawn });
    const coach = client.evaluate('9001', { p: 0 });
    await tick();
    const [worker] = workers;
    assert.equal(worker.posted[0].type, 'init');
    worker.reply(worker.posted[0].id, { ready: true });
    await tick();
    const job = worker.posted.at(-1);
    assert.equal(job.type, 'coach');
    const table = client.decide('9001', { p: 1 });
    assert.deepEqual(worker.posted.at(-1), { type: 'cancel', id: job.id });
    await tick();
    assert.ok(!worker.posted.some((m) => m.type === 'search'), 'one job at a time');
    worker.reply(job.id, { fallback: true, reason: 'cancelled' });
    assert.equal((await coach).reason, 'cancelled');
    await tick();
    const search = worker.posted.at(-1);
    assert.equal(search.type, 'search');
    worker.reply(search.id, { ok: true, index: 1, championIndex: 0, ms: 5 });
    assert.equal((await table).index, 1);
    assert.equal(client.stats.requests, 1);
    assert.equal(client.stats.searched, 1);
    assert.equal(client.stats.coach.requests, 1);
    assert.equal(client.stats.coach.preempted, 1);
    assert.equal(workers.length, 1);
  }
  // 2. a coach job stuck in one long solver call: the worker is replaced and reloaded first
  {
    const { workers, spawn } = fakeWorkers();
    const client = createSearchClient({ version: 't', device: 'desktop', spawn });
    const coach = client.evaluate('9001', { p: 0 });
    await tick();
    workers[0].reply(workers[0].posted[0].id, { ready: true });
    await tick();
    const table = client.decide('9001', { p: 1 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(workers[0].terminated, true);
    assert.equal((await coach).reason, 'preempted');
    const fresh = workers[1];
    assert.equal(fresh.posted[0].type, 'init');
    assert.equal(fresh.posted.length, 1, 'the search waits for the reload');
    fresh.reply(fresh.posted[0].id, { ready: true });
    await tick();
    assert.equal(fresh.posted[1].type, 'search');
    fresh.reply(fresh.posted[1].id, { ok: true, index: 0, championIndex: 0, ms: 5 });
    assert.equal((await table).ok, true);
  }
  // 3. a coach request while a table search runs waits for it
  {
    const { workers, spawn } = fakeWorkers();
    const client = createSearchClient({ version: 't', device: 'desktop', spawn });
    const table = client.decide('9001', { p: 1 });
    await tick();
    const [worker] = workers;
    worker.reply(worker.posted[0].id, { ready: true });
    await tick();
    const search = worker.posted.at(-1);
    assert.equal(search.type, 'search');
    const coach = client.evaluate('9001', { p: 0 });
    await tick();
    assert.equal(worker.posted.at(-1), search, 'no coach job and no cancel of a table job');
    worker.reply(search.id, { ok: true, index: 0, championIndex: 0, ms: 5 });
    await table;
    await tick();
    const job = worker.posted.at(-1);
    assert.equal(job.type, 'coach');
    worker.reply(job.id, { ok: true, kind: 'endgame', plays: [], values: [], ms: 3 });
    assert.equal((await coach).ok, true);
    // switching the coach off cancels only its own work
    const again = client.evaluate('9001', { p: 0 });
    await tick();
    const next = worker.posted.at(-1);
    client.cancelCoach();
    assert.deepEqual(worker.posted.at(-1), { type: 'cancel', id: next.id });
    worker.reply(next.id, { fallback: true, reason: 'cancelled' });
    assert.equal((await again).fallback, true);
  }
});

test('a coach job past its hard timeout is replaced alone; a queued table search still runs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn });
  const coach = client.evaluate('9001', { p: 0 });
  await flush();
  workers[0].reply(workers[0].posted[0].id, { ready: true });
  await flush();
  assert.equal(workers[0].posted.at(-1).type, 'coach');
  // the table request arrives just before the coach job's hard timeout, inside the preempt window
  t.mock.timers.tick(hardTimeoutMs(SEARCH_BUDGETS.desktop) - 100);
  const table = client.decide('9001', { p: 1 });
  await flush();
  t.mock.timers.tick(100);
  assert.equal((await coach).reason, 'timeout');
  assert.equal(workers[0].terminated, true);
  const fresh = workers[1];
  assert.equal(fresh.posted[0].type, 'init');
  fresh.reply(fresh.posted[0].id, { ready: true });
  await flush();
  assert.equal(fresh.posted[1].type, 'search');
  fresh.reply(fresh.posted[1].id, { ok: true, index: 0, championIndex: 0, ms: 5 });
  assert.equal((await table).ok, true);
  assert.deepEqual(client.stats.fallbacks, {});
});

test('a slow first load waits FIRST_LOAD_WAIT_MS, not the 50 s search budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn });
  assert.equal(client.stats.firstLoadWaitMs, FIRST_LOAD_WAIT_MS);
  let settled = null;
  const table = client.decide('9001', { p: 1 }).then((r) => (settled = r));
  await flush();
  assert.equal(workers[0].posted[0].type, 'init');
  t.mock.timers.tick(FIRST_LOAD_WAIT_MS - 1);
  await flush();
  assert.equal(settled, null);
  t.mock.timers.tick(1);
  await table;
  assert.equal(settled.reason, 'loading');
  assert.ok(FIRST_LOAD_WAIT_MS < SEARCH_BUDGETS.desktop.midgameMs);
  // the load continues in the background; the next decision searches
  workers[0].reply(workers[0].posted[0].id, { ready: true });
  await flush();
  const next = client.decide('9001', { p: 1 });
  await flush();
  const search = workers[0].posted.at(-1);
  assert.equal(search.type, 'search');
  workers[0].reply(search.id, { ok: true, index: 0, championIndex: 0, ms: 5 });
  assert.equal((await next).ok, true);
});

test("a new coach request stops the previous turn's running coach search", async () => {
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn });
  const old = client.evaluate('9001', { p: 0, turn: 'old' });
  await tick();
  const [worker] = workers;
  worker.reply(worker.posted[0].id, { ready: true });
  await tick();
  const job = worker.posted.at(-1);
  assert.equal(job.type, 'coach');
  const fresh = client.evaluate('9001', { p: 0, turn: 'new' });
  await tick();
  assert.deepEqual(worker.posted.at(-1), { type: 'cancel', id: job.id });
  worker.reply(job.id, { fallback: true, reason: 'cancelled' });
  assert.equal((await old).reason, 'cancelled');
  await tick();
  const next = worker.posted.at(-1);
  assert.equal(next.type, 'coach');
  assert.equal(next.payload.turn, 'new');
  worker.reply(next.id, { ok: true, kind: 'endgame', plays: [], values: [], ms: 3 });
  assert.equal((await fresh).ok, true);
  assert.equal(workers.length, 1, 'no worker replacement: the table solver cache is kept');
});

test('a superseded coach job that has not stopped still yields to a table search within PREEMPT_MS', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn });
  const old = client.evaluate('9001', { p: 0, turn: 'old' });
  await flush();
  workers[0].reply(workers[0].posted[0].id, { ready: true });
  await flush();
  const job = workers[0].posted.at(-1);
  assert.equal(job.type, 'coach');
  // the next turn's coach request asks it to stop, but it is inside one long solver call
  const fresh = client.evaluate('9001', { p: 0, turn: 'new' });
  await flush();
  assert.deepEqual(workers[0].posted.at(-1), { type: 'cancel', id: job.id });
  const table = client.decide('9001', { p: 1 });
  await flush();
  assert.equal(workers[0].posted.length, 3, 'no second cancel; the preempt timer still runs');
  // a table request drops queued coach jobs (that turn's coach shows champion values)
  assert.equal((await fresh).reason, 'preempted');
  t.mock.timers.tick(500);
  assert.equal((await old).reason, 'preempted');
  assert.equal(workers[0].terminated, true);
  const next = workers[1];
  assert.equal(next.posted[0].type, 'init');
  next.reply(next.posted[0].id, { ready: true });
  await flush();
  assert.equal(next.posted[1].type, 'search');
  next.reply(next.posted[1].id, { ok: true, index: 0, championIndex: 0, ms: 5 });
  assert.equal((await table).ok, true);
  assert.equal(client.stats.coach.preempted, 1);
});

/** A fake clock (the client's `now`) next to mocked timers. */
function turnClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { at: 0 };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const advance = async (ms) => {
    clock.at += ms;
    t.mock.timers.tick(ms);
    await flush();
  };
  return { clock, now: () => clock.at, flush, advance };
}

test('a table search gets the time left to the 50 s mark of its turn and is dropped at 52 s', async (t) => {
  const { clock, now, flush, advance } = turnClock(t);
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn, now });
  assert.equal(client.stats.hardTimeoutMs, HARD_MS);
  // the turn started 800 ms ago (thinking pause); the networks then take 3 s to load
  let settled = null;
  const table = client.decide('9001', { p: 1 }, { startedAt: -800 }).then((r) => (settled = r));
  await flush();
  await advance(3000);
  workers[0].reply(workers[0].posted[0].id, { ready: true });
  await flush();
  const search = workers[0].posted.at(-1);
  assert.equal(search.type, 'search');
  assert.equal(search.remainingMs, REASON_MS - 800 - 3000, 'the pause and the load count');
  // the worker never answers: at 52 s from the turn start it is replaced
  await advance(HARD_MS - 800 - 3000 - 1);
  assert.equal(settled, null);
  await advance(1);
  await table;
  assert.equal(settled.fallback, true);
  assert.equal(settled.reason, 'timeout');
  assert.equal(workers[0].terminated, true);
  assert.ok(clock.at - -800 <= HARD_MS, 'the champion plays from 52 s, well before 60 s');
  // worker replaced, then the next move searches normally
  const start = clock.at;
  const next = client.decide('9001', { p: 2 }, { startedAt: start });
  await flush();
  assert.equal(workers.length, 2);
  workers[1].reply(workers[1].posted[0].id, { ready: true });
  await flush();
  const again = workers[1].posted.at(-1);
  assert.equal(again.type, 'search');
  assert.equal(again.remainingMs, REASON_MS);
  workers[1].reply(again.id, { ok: true, index: 2, championIndex: 0, ms: 9 });
  assert.equal((await next).index, 2);
  assert.deepEqual(client.stats.fallbacks, { timeout: 1 });
});

test('a fallback never sticks: after a failed search, worker error or failed load the next move searches', async (t) => {
  const { now, flush, advance } = turnClock(t);
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn, now });
  // 1. the first load fails: the next move loads again at once (no back-off)
  const first = client.decide('9001', { p: 1 });
  await flush();
  workers[0].onmessage({ data: { id: workers[0].posted[0].id, error: 'fetch failed' } });
  assert.equal((await first).reason, 'error');
  const second = client.decide('9001', { p: 1 });
  await flush();
  const init = workers[0].posted.at(-1);
  assert.equal(init.type, 'init', 'the load is retried by the next move');
  workers[0].reply(init.id, { ready: true });
  await flush();
  // 2. the search itself falls back (budget): the next move searches
  workers[0].reply(workers[0].posted.at(-1).id, { fallback: true, reason: 'budget' });
  assert.equal((await second).reason, 'budget');
  const third = client.decide('9001', { p: 1 });
  await flush();
  const search = workers[0].posted.at(-1);
  assert.equal(search.type, 'search');
  workers[0].reply(search.id, { ok: true, index: 1, championIndex: 0, ms: 4 });
  assert.equal((await third).index, 1);
  // 3. the worker crashes mid-search: it is replaced and the next move searches
  const fourth = client.decide('9001', { p: 1 });
  await flush();
  workers[0].onerror();
  assert.equal((await fourth).reason, 'error');
  assert.equal(workers[0].terminated, true);
  const fifth = client.decide('9001', { p: 1 });
  await flush();
  workers[1].reply(workers[1].posted[0].id, { ready: true });
  await flush();
  workers[1].reply(workers[1].posted.at(-1).id, { ok: true, index: 0, championIndex: 0, ms: 3 });
  assert.equal((await fifth).ok, true);
  // 4. a slow first load: the wait is capped by the time left, and the next move searches
  const slow = createSearchClient({ version: 't', device: 'desktop', spawn, now });
  let settled = null;
  const loading = slow
    .decide('9001', { p: 1 }, { startedAt: now() - 45_000 })
    .then((r) => (settled = r));
  await flush();
  await advance(4_999);
  assert.equal(settled, null);
  await advance(1);
  await loading;
  assert.equal(settled.reason, 'loading', 'waited the 5 s left, not FIRST_LOAD_WAIT_MS');
  workers.at(-1).reply(workers.at(-1).posted[0].id, { ready: true });
  await flush();
  const after = slow.decide('9001', { p: 1 });
  await flush();
  const late = workers.at(-1).posted.at(-1);
  assert.equal(late.type, 'search');
  workers.at(-1).reply(late.id, { ok: true, index: 0, championIndex: 0, ms: 3 });
  assert.equal((await after).ok, true);
  assert.equal(client.stats.searched, 2);
});

test('a table search that could only start after the 50 s mark is not posted', async (t) => {
  const { now, flush, advance } = turnClock(t);
  const { workers, spawn } = fakeWorkers();
  const client = createSearchClient({ version: 't', device: 'desktop', spawn, now });
  const coach = client.evaluate('9001', { p: 0 });
  await flush();
  workers[0].reply(workers[0].posted[0].id, { ready: true });
  await flush();
  const job = workers[0].posted.at(-1);
  assert.equal(job.type, 'coach');
  const table = client.decide('9001', { p: 1 }, { startedAt: now() - REASON_MS + 200 });
  await flush();
  // the coach job replies only after the 50 s mark (inside the 500 ms preempt window)
  await advance(300);
  workers[0].reply(job.id, { fallback: true, reason: 'cancelled' });
  await coach;
  const result = await table;
  assert.equal(result.reason, 'budget');
  assert.ok(!workers[0].posted.some((m) => m.type === 'search'));
});

test('Clint brain budget: 30 s, never past the 50 s mark of the turn, rules only after it', () => {
  assert.equal(clintBrainMs(800), CLINT_BRAIN_MS);
  assert.equal(clintBrainMs(25_000), 25_000);
  assert.equal(clintBrainMs(REASON_MS), 0);
  assert.equal(clintBrainMs(70_000), 0);
});
