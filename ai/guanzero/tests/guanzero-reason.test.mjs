import { snapshot as windowSnapshot } from '../../research/tools/window-dashboard.mjs';
import { acquireWorkerLock, workerAlive } from '../training/worker-lock.mjs';
import { sourceClosure } from '../training/source-closure.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SEARCH_BOT_V1, SEARCH_BUDGETS } from '../../../web/src/ai/search/constants.mjs';
import { restoreGame } from '../../../web/src/ai/search/payload.mjs';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import {
  REASON_V1_BUDGET,
  REASON_V2_BUDGET,
  REASON_V2_MOVE,
  REASON_PROTOCOLS,
  verifyReasonMetadata,
  reasonPayload,
  reasonContext,
  reasonProtocol,
  reasonStats,
  deadlineSolver,
  chooseReason,
} from '../training/reason.mjs';
import {
  SearchBudgetError,
  argmax,
  searchBand,
  remainingCards,
} from '../../../web/src/ai/search/core.mjs';
import { SolverBudget, createSolver } from '../../danMCai/endgame/solver.mjs';
import { TARGETS } from '../../danMCai/belief/features.mjs';
import { policyState } from '../../../web/src/ai/observation.js';
import { candidates } from '../../../web/src/ai/candidates.js';
import { reasonMatch, reasonProtocolDigest, evaluateReason } from '../training/evaluate-reason.mjs';
import { evaluate } from '../training/evaluate.mjs';
import { reasonPanel, runDevelopmentSuites } from '../training/development-suite.mjs';
import { suiteOpponents, REASON_V1_PANEL, REASON_V2_PANEL } from '../training/opponents.mjs';
import { validSuiteReport } from '../training/suite-reports.mjs';
import { MIXED_PANEL, MIXED_PAIRS, suitePairs } from '../training/opponents.mjs';
import { CHAMPION_REASON_PANEL, CHAMPION_REASON_PAIRS } from '../training/opponents.mjs';
import { effectiveOpponents } from '../training/opponent-retirement.mjs';
import { freezeClint, clintProtocolDigest } from '../training/evaluate-clint.mjs';
import { verifyEvaluatedSuite } from '../../publishing/evaluated-suite.mjs';
import { guanzeroCards } from '../../research/tools/guanzero-stages.mjs';

const hash = (b) => createHash('sha256').update(b).digest('hex');
function identities(protocol = REASON_V1_PANEL) {
  const champion = {
    id: 'champion',
    name: 'danMCai-v000001',
    version: 'v000001',
    mode: 'snapshot',
    modelSHA256: hash('champion'),
    gate: { gate: 1, evidence: 'ai/research/evaluation/test/gate-00001.json' },
  };
  const manifest = {
    schema: 'danMCai-search-bot-v1',
    id: '9001',
    kind: 'belief-search',
    base: { id: '017', version: champion.version, sha256: champion.modelSHA256 },
    belief: { sha256: hash('belief'), featureVersion: 'belief-v1' },
    search: { ...SEARCH_BOT_V1 },
    core: 'search-v1',
  };
  const identity = {
    id: 'reason',
    name: 'danMCai-reason-v000001',
    version: 'v000001-bsearch1',
    mode: 'self',
    manifest,
    modelSHA256: hash(JSON.stringify(manifest)),
    gate: champion.gate,
    budget: { ...REASON_PROTOCOLS[protocol].budget },
    execution: REASON_PROTOCOLS[protocol].execution,
    ...(protocol !== REASON_V1_PANEL && {
      protocol,
      move: structuredClone(REASON_PROTOCOLS[protocol].move),
    }),
    sourceSHA256: { 'reason-code.mjs': hash('code') },
  };
  return { champion, reason: { ...identity, evaluationSHA256: hash(JSON.stringify(identity)) } };
}
test('new three-opponent panel does not relabel any historical panels', () => {
  assert.deepEqual(suiteOpponents({ opponentPanel: 'clint-champion-reason-v1' }), [
    'clint',
    'champion',
    'reason',
  ]);
  assert.deepEqual(suiteOpponents({ opponentPanel: 'clint-champion-reason-v2' }), [
    'clint',
    'champion',
    'reason',
  ]);
  assert.deepEqual(suiteOpponents({ opponentPanel: 'clint-champion-v1' }), ['clint', 'champion']);
  assert.deepEqual(suiteOpponents({ opponentPanel: 'random-clint-champion-v1' }), [
    'random',
    'clint',
    'champion',
  ]);
  assert.equal(suiteOpponents({}).length, 5);
  assert.throws(() => suiteOpponents({ opponentPanel: 'invented' }));
});
test('reason identity binds both networks, desktop budgets and the accepted base', () => {
  const { champion, reason } = identities();
  verifyReasonMetadata(reason, champion);
  for (const change of [
    { budget: SEARCH_BUDGETS.mobile },
    // the 50 s web budget (2026-11-09) is a deployment change, not protocol v1
    { budget: SEARCH_BUDGETS.desktop },
    {
      manifest: {
        ...reason.manifest,
        belief: { ...reason.manifest.belief, sha256: hash('wrong') },
      },
    },
    { sourceSHA256: { 'new.mjs': hash('new') } },
  ])
    assert.throws(() => verifyReasonMetadata({ ...reason, ...change }, champion));
  assert.throws(() =>
    verifyReasonMetadata(reason, { ...champion, modelSHA256: hash('new champion') }),
  );
  assert.throws(() => verifyReasonMetadata(reason, { ...champion, gate: { gate: 2 } }));
});
test('protocol v2 identity binds the 50 s move rule; v1 identities stay without a protocol field', () => {
  const { champion, reason } = identities(REASON_V2_PANEL);
  verifyReasonMetadata(reason, champion);
  assert.equal(reasonProtocol(reason), REASON_V2_PANEL);
  assert.equal(reasonProtocol(identities().reason), REASON_V1_PANEL);
  assert.deepEqual(REASON_V2_BUDGET, {
    midgameMs: 50_000,
    endgameMs: 50_000,
    solverMs: 3000,
    solverTable: 300_000,
  });
  assert.equal(REASON_V2_MOVE.reasoningDeadlineMs + REASON_V2_MOVE.fallbackReserveMs, 60_000);
  const { protocol, move, ...withoutProtocol } = reason;
  assert.equal(protocol, REASON_V2_PANEL);
  assert.ok(move);
  for (const change of [
    { budget: { ...REASON_V1_BUDGET } },
    { execution: 'web-desktop-policy-native-onnx-v1' },
    { move: { ...REASON_V2_MOVE, failuresSticky: true } },
    { move: { ...REASON_V2_MOVE, statistics: ['budgetFallback'] } },
    { protocol: 'clint-champion-reason-v3' },
  ])
    assert.throws(() => verifyReasonMetadata({ ...reason, ...change }, champion));
  // a 50 s budget without the v2 protocol field is neither v1 nor v2
  assert.throws(() => verifyReasonMetadata(withoutProtocol, champion));
  // an explicit v1 field would give v1 batches a second identity
  const v1 = identities().reason;
  assert.throws(() => verifyReasonMetadata({ ...v1, protocol: REASON_V1_PANEL }, champion));
  assert.throws(() => verifyReasonMetadata({ ...v1, move: REASON_V2_MOVE }, champion));
});
test('v2 context: 50 s deadline from decision start in both bands, solver capped by time left', () => {
  const engine = {
    protocol: REASON_V2_PANEL,
    budget: REASON_V2_BUDGET,
    params: SEARCH_BOT_V1,
    stats: reasonStats(REASON_V2_PANEL),
    solver: { actionValue: () => 'shared' },
  };
  for (const band of ['midgame', 'endgame']) {
    const context = reasonContext(engine, 100, band, () => 101);
    assert.equal(context.deadline, 50_100);
    assert.equal(context.solverTimeIsBudget, false);
  }
  let clock = 0;
  const made = [];
  engine.createSolver = (options) => {
    made.push(options);
    return {
      actionValue: () => {
        if (options.fail) throw options.fail;
        return 'capped';
      },
    };
  };
  const solver = deadlineSolver(engine, 50_000, () => clock);
  clock = 46_999; // 3,001 ms left: the shared solver keeps its own 3 s limit
  assert.equal(solver.actionValue({}, null), 'shared');
  clock = 48_800; // 1,200 ms left: a solver limited to the time left
  assert.equal(solver.actionValue({}, null), 'capped');
  assert.deepEqual(made[0], {
    maxNodes: SEARCH_BOT_V1.solverMaxNodes,
    maxMs: 1200,
    maxTable: REASON_V2_BUDGET.solverTable,
  });
  assert.equal(engine.stats.solverDeadlineCapped, 1);
  // a clock stop of a capped call is the deadline: discard the search, play the champion
  engine.createSolver = (options) => ({
    actionValue: () => {
      throw new SolverBudget(options.maxNodes - 1);
    },
  });
  assert.throws(() => solver.actionValue({}, null), SearchBudgetError);
  // a node-limit stop is still the tested Node rule (skip that world)
  engine.createSolver = (options) => ({
    actionValue: () => {
      throw new SolverBudget(options.maxNodes + 1);
    },
  });
  assert.throws(() => solver.actionValue({}, null), SolverBudget);
  clock = 50_000;
  assert.throws(() => solver.actionValue({}, null), SearchBudgetError);
  // v1 keeps the shared solver and its 3 / 4 s deadlines
  const v1 = reasonContext(
    { ...engine, protocol: undefined, budget: REASON_V1_BUDGET },
    0,
    'endgame',
  );
  assert.equal(v1.deadline, 4000);
  assert.equal(v1.solver, engine.solver);
});
test('v2 fallback is never sticky: a budget fallback does not stop the next move from searching', async () => {
  const game = createRound(123);
  for (const hand of game.hands) hand.splice(9); // 36 cards: midgame band
  const p = game.turn,
    plays = candidates(game.hands[p], game.L, null);
  let clock = 1000;
  const deadlines = [];
  let call = 0;
  const engine = {
    protocol: REASON_V2_PANEL,
    budget: REASON_V2_BUDGET,
    params: SEARCH_BOT_V1,
    stats: reasonStats(REASON_V2_PANEL),
    now: () => clock,
    values: async (s) => s.actions.map((_, i) => (i === 0 ? 1 : 0)),
    decide: async (masked, seed, ctx) => {
      deadlines.push(ctx.deadline);
      if (call++ === 0) {
        clock += 50_001; // the first search runs past its deadline
        assert.ok(ctx.now() > ctx.deadline);
        throw new SearchBudgetError('midgame');
      }
      assert.equal(masked.hands[p].length, 9);
      clock += 400;
      return { plays, index: plays.length - 1 };
    },
  };
  const first = await chooseReason(engine, game, p, 7);
  assert.deepEqual(first, plays[0]); // champion fallback
  const start = clock;
  const second = await chooseReason(engine, game, p, 7);
  assert.deepEqual(second, plays.at(-1)); // searched again and played the search choice
  assert.deepEqual(deadlines, [1000 + 50_000, start + 50_000]);
  assert.equal(engine.stats.budgetFallback, 1);
  assert.equal(engine.stats.midgame, 2);
  assert.equal(engine.stats.changedFromChampion, 1);
  assert.equal(engine.stats.searchesOver30s, 1);
  assert.equal(engine.stats.searchesOver3s, 1);
  assert.equal(engine.stats.maxSearchMs, 50_001);
  for (const key of REASON_V2_MOVE.statistics) assert.ok(Number.isFinite(engine.stats[key]), key);
  assert.equal(reasonStats().maxSearchMs, undefined); // v1 counters keep their registered shape
});
test('v2 real search: several consecutive failures, then healthy moves equal a fresh engine', async () => {
  // Real searchBotDecision / exact solver; only the networks and the clock are injected.
  // Legal positions reached by play (card counts conserved), with a real choice to make.
  const position = (most) => {
    const game = createRound(123);
    for (;;) {
      const p = game.turn,
        plays = candidates(game.hands[p], game.L, game.trick?.play),
        left = game.hands.reduce((n, h) => n + h.length, 0);
      const finish = plays.some((a) => a && a.cards.length === game.hands[p].length);
      if (left <= most && plays.length > 1 && !finish) return game;
      assert.equal(advanceRound(game, plays.find((a) => a) ?? null), null);
    }
  };
  const values = async (s) => s.actions.map((_, i) => ((i * 7919) % 13) / 13);
  const probabilities = async () => new Float32Array(TARGETS).fill(0.25);
  const fresh = () => {
    let clock = 1000;
    const engine = {
      protocol: REASON_V2_PANEL,
      budget: REASON_V2_BUDGET,
      params: SEARCH_BOT_V1,
      stats: reasonStats(REASON_V2_PANEL),
      now: () => clock,
      values,
      probabilities,
      solver: createSolver({
        maxNodes: SEARCH_BOT_V1.solverMaxNodes,
        maxMs: REASON_V2_BUDGET.solverMs,
        maxTable: REASON_V2_BUDGET.solverTable,
      }),
    };
    return { engine, advance: (ms) => (clock += ms) };
  };
  const midgame = position(36),
    endgame = position(14);
  assert.equal(
    searchBand(remainingCards(restoreGame(reasonPayload(midgame, midgame.turn, 11)))),
    'midgame',
  );
  assert.equal(
    searchBand(remainingCards(restoreGame(reasonPayload(endgame, endgame.turn, 11)))),
    'endgame',
  );
  const { engine, advance } = fresh();
  const decide = (game) => chooseReason(engine, game, game.turn, 11);
  const championOf = async (game) => {
    const plays = candidates(game.hands[game.turn], game.L, game.trick?.play);
    return plays[argmax(await values(policyState(game, game.turn, 0, plays)))];
  };
  // 1. midgame: the champion inference itself uses up the 50 s (clock counts from decision start)
  engine.values = async (s) => (advance(50_001), values(s));
  assert.deepEqual(await decide(midgame), await championOf(midgame));
  engine.values = values;
  // 2. endgame: deadline passes during the belief inference, before the first solver call
  engine.probabilities = async (v) => (advance(50_001), probabilities(v));
  assert.deepEqual(await decide(endgame), await championOf(endgame));
  // 3. endgame: 1 s left, the capped solver is stopped by the clock
  engine.probabilities = async (v) => (advance(49_000), probabilities(v));
  engine.createSolver = ({ maxNodes }) => ({
    actionValue: () => {
      throw new SolverBudget(maxNodes - 1);
    },
  });
  assert.deepEqual(await decide(endgame), await championOf(endgame));
  engine.probabilities = probabilities;
  delete engine.createSolver;
  assert.equal(engine.stats.budgetFallback, 3);
  assert.equal(engine.stats.solverDeadlineCapped, 1);
  assert.equal(engine.stats.midgame, 1);
  assert.equal(engine.stats.endgame, 2);
  // 4. healthy moves after the failures: searched, and identical to an engine that never failed
  const before = { ...engine.stats };
  const reference = fresh().engine;
  for (const game of [midgame, endgame])
    assert.deepEqual(await decide(game), await chooseReason(reference, game, game.turn, 11));
  assert.equal(engine.stats.budgetFallback, 3); // no new fallback
  assert.equal(engine.stats.midgame, 2);
  assert.equal(engine.stats.endgame, 3);
  assert.ok(engine.stats.inferences > before.inferences);
  for (const key of ['changedFromChampion', 'minWorldsFallback', 'inferences', 'budgetFallback'])
    assert.equal(engine.stats[key] - before[key], reference.stats[key], key);
});
test('opponent policy cannot see other hands; swapping hidden cards preserves its payload', () => {
  const game = createRound(123),
    p = game.turn,
    seed = 19;
  const before = reasonPayload(game, p, seed),
    others = [0, 1, 2, 3].filter((x) => x !== p);
  [game.hands[others[0]][0], game.hands[others[1]][0]] = [
    game.hands[others[1]][0],
    game.hands[others[0]][0],
  ];
  assert.deepEqual(reasonPayload(game, p, seed), before);
  const masked = restoreGame(before);
  assert.throws(() => masked.hands[others[0]][0].id, /Hidden card/);
  assert.deepEqual(
    masked.hands[p].map((c) => c.id),
    before.hand,
  );
});
test('reason evaluation uses actual desktop deadlines and separate team policies', async () => {
  const budget = REASON_V1_BUDGET;
  const context = reasonContext({ budget }, 100, 'midgame', () => 101);
  assert.equal(context.deadline, 3100);
  assert.equal(context.solverTimeIsBudget, false);
  let guan = 0,
    base = 0;
  const engine = {
    values: async (s) => {
      base++;
      return s.actions.map((_, i) => (i === 0 ? 1 : 0));
    },
    stats: { decisions: 0, forced: 0, baseOnly: 0, knownCardsFallback: 0 },
  };
  for (const team of [0, 1])
    await reasonMatch({
      seed: 1,
      team,
      engine,
      inference: {
        values: async (s) => {
          guan++;
          return s.actions.map((_, i) => (i === s.actions.length - 1 ? 1 : 0));
        },
      },
      play: async (opts) => {
        assert.equal(opts.mode, 'self');
        assert.equal(opts.evaluate, true);
        const game = createRound(123);
        game.round = 1;
        for (const p of [0, 1]) {
          game.turn = p;
          const chosen = await opts.tablePolicy(game, p);
          assert.ok(
            chosen === null || chosen.cards.every((c) => game.hands[p].some((x) => x.id === c.id)),
          );
        }
      },
    });
  assert.equal(guan, 2);
  assert.equal(base, 2);
});
test('a new batch takes its panel from the companion-frozen reason identity', () => {
  assert.equal(reasonPanel(identities().reason), REASON_V1_PANEL);
  assert.equal(reasonPanel(identities(REASON_V2_PANEL).reason), REASON_V2_PANEL);
  assert.equal(
    reasonPanel(identities(REASON_V2_PANEL).reason, { opponentPanel: REASON_V2_PANEL }),
    REASON_V2_PANEL,
  );
  // a launcher switched to v2 but still pointing at the v1 companion stops registration
  assert.throws(
    () => reasonPanel(identities().reason, { opponentPanel: REASON_V2_PANEL }),
    /differs from its frozen companion/,
  );
  assert.throws(() => reasonPanel({ protocol: 'clint-champion-reason-v9' }), /Unknown/);
});
test('reason worker refuses a plan whose panel and frozen reason protocol differ', async () => {
  const opponents = ['clint', 'champion', 'reason'];
  for (const [panel, protocol] of [
    [REASON_V2_PANEL, REASON_V1_PANEL],
    [REASON_V1_PANEL, REASON_V2_PANEL],
  ])
    await assert.rejects(
      evaluateReason({
        run: 'unused',
        folder: 'unused',
        plan: { opponents, opponentPanel: panel, reason: identities(protocol).reason },
      }),
      /protocol and panel differ/,
    );
  await assert.rejects(
    evaluateReason({ run: 'unused', folder: 'unused', plan: { opponents, opponentPanel: 'x' } }),
    /Not a reason panel/,
  );
});
test('direct old evaluator rejects reason instead of silently playing pure champion or self', async () => {
  await assert.rejects(
    evaluate({ run: 'unused', model: 'unused', index: 1, opponents: ['reason'] }),
    /registered suite/,
  );
});
async function publisherRoundTrip(protocol) {
  const temp = mkdtempSync(join(tmpdir(), 'guanzero-reason-'));
  try {
    const root = join(temp, 'repo'),
      folder = join(temp, 'guanzero-adp-io48/eval/development-500/model-000001');
    mkdirSync(folder, { recursive: true });
    const mixed = protocol === MIXED_PANEL,
      two = protocol === CHAMPION_REASON_PANEL;
    const { champion, reason } = identities(mixed || two ? REASON_V2_PANEL : protocol);
    const write = (p, d) => {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    };
    const gate = {
      decision: 'accept',
      challenger: { version: champion.version, sha256: champion.modelSHA256 },
    };
    write(join(root, champion.gate.evidence), gate);
    champion.gate.evidenceSHA256 = hash(Buffer.from(JSON.stringify(gate, null, 2) + '\n'));
    reason.evaluationSHA256 = hash(
      JSON.stringify(
        Object.fromEntries(Object.entries(reason).filter(([k]) => k !== 'evaluationSHA256')),
      ),
    );
    writeFileSync(join(folder, 'champion.onnx'), 'champion');
    writeFileSync(join(folder, 'reason-belief.onnx'), 'belief');
    writeFileSync(join(folder, 'model.onnx'), 'model');
    const plan = {
      id: 'model-000001',
      protocol: 'development-500-v1',
      opponentPanel: protocol,
      opponents: [...suiteOpponents({ opponentPanel: protocol })],
      modelVersion: 'model-000001',
      modelSHA256: hash('model'),
      index: 5131,
      pairs: 250,
      seedStart: 4213100000,
      seedEnd: 4213100249,
      champion,
      reason,
      ...(mixed ? { opponentPairs: { ...MIXED_PAIRS }, clint: freezeClint() } : {}),
      ...(two ? { opponentPairs: { ...CHAMPION_REASON_PAIRS } } : {}),
    };
    const savePlan = () => {
      write(join(folder, 'plan.json'), plan);
      write(join(folder, '../manifest.json'), { suites: [plan] });
    };
    savePlan();
    const reports = {};
    for (const op of plan.opponents) {
      const definition =
        op === 'reason'
          ? reason
          : op === 'champion'
            ? champion
            : mixed
              ? plan.clint
              : { id: 'clint', mode: 'rule', version: 'rules-v2' };
      const pairs = suitePairs(plan, op);
      const clusters = Array.from({ length: pairs }, (_, i) =>
        [0, 1].map((t) => ({
          seed: plan.seedStart + i,
          neuralTeam: t,
          winner: t,
          opponent: definition.mode,
        })),
      );
      const report = {
        index: plan.index,
        pairs,
        seedStart: plan.seedStart,
        seedEnd: plan.seedStart + pairs - 1,
        modelSHA256: plan.modelSHA256,
        sourceSHA256: op === 'clint' && mixed ? plan.clint.sourceSHA256 : reason.sourceSHA256,
        opponents: { [op]: definition },
        results: {
          [op]: {
            matches: pairs * 2,
            wins: pairs * 2,
            losses: 0,
            draws: 0,
            confidence95: {},
            clusters,
          },
        },
        completedAt: 'complete',
      };
      report.protocolSHA256 = reasonProtocolDigest(report);
      reports[op] = report;
      if (op !== 'reason') write(join(folder, op, 'report.json'), report);
    }
    const verify = () =>
      verifyEvaluatedSuite(
        folder,
        join(folder, 'model.onnx'),
        plan.modelSHA256,
        { run: 'guanzero-adp-io48', version: plan.modelVersion, step: 1 },
        root,
      );
    await assert.rejects(verify(), /ENOENT/);
    if (!mixed && !two) {
      plan.opponentPanel = 'clint-champion-v1';
      plan.opponents = ['clint', 'champion'];
      delete plan.reason;
      savePlan();
      assert.equal(Object.keys((await verify()).opponents).length, 2);
      plan.opponentPanel = protocol;
      plan.opponents = ['clint', 'champion', 'reason'];
      plan.reason = reason;
    }
    savePlan();
    write(join(folder, 'reason/report.json'), reports.reason);
    const verified = await verify();
    assert.equal(Object.keys(verified.opponents).length, two ? 2 : 3);
    assert.equal(verified.opponentPanel, protocol);
    assert.equal(verified.reason.budget.midgameMs, protocol === REASON_V1_PANEL ? 3000 : 50_000);
    // the panel must name the protocol its frozen reason identity was registered with
    plan.opponentPanel = protocol === REASON_V1_PANEL ? REASON_V2_PANEL : REASON_V1_PANEL;
    savePlan();
    await assert.rejects(verify(), /protocol and opponent panel differ/);
    plan.opponentPanel = protocol;
    savePlan();
    const changed = structuredClone(reports.reason);
    changed.opponents.reason.budget.solverMs = 1;
    assert.equal(validSuiteReport(changed, plan, 'reason'), false);
    write(join(folder, 'reason/report.json'), changed);
    await assert.rejects(verify(), /mismatched report/);
    write(join(folder, 'reason/report.json'), reports.reason);
    const cards = guanzeroCards(join(temp, 'guanzero-adp-io48'), Date.now());
    assert.equal(cards.length, two ? 2 : 3);
    assert.ok(cards.every((c) => c.state === 'done'));
    assert.ok(cards.some((c) => c.title.includes('danMCai-reason-v000001')));
    if (mixed) {
      assert.deepEqual(
        cards.map((c) => c.progress.text),
        ['已完成 50/50 场', '已完成 500/500 场', '已完成 50/50 场'],
      );
      plan.opponentPairs.clint = 250;
      savePlan();
      await assert.rejects(verify(), /pair counts/);
      plan.opponentPairs.clint = 25;
      savePlan();
      const old = reports.clint.opponents.clint;
      reports.clint.opponents.clint = { id: 'clint', version: 'rules-v2', mode: 'rule' };
      reports.clint.protocolSHA256 = clintProtocolDigest(reports.clint);
      write(join(folder, 'clint/report.json'), reports.clint);
      await assert.rejects(verify(), /mismatched report/);
      reports.clint.opponents.clint = old;
      reports.clint.protocolSHA256 = clintProtocolDigest(reports.clint);
      write(join(folder, 'clint/report.json'), reports.clint);
      write(join(folder, 'cancelled.json'), { cancelledAt: 'owner' });
      await assert.rejects(verify(), /cancelled/);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
test('publisher requires all three reports and exact frozen reasoning identity; legacy two remains valid', () =>
  publisherRoundTrip(REASON_V1_PANEL));
test('publisher verifies protocol v2 batches the same way and binds panel to reason protocol', () =>
  publisherRoundTrip(REASON_V2_PANEL));
test('mixed protocol requires brain-enabled Clint 50, champion 500, reason 50 and rejects cancellation', () =>
  publisherRoundTrip(MIXED_PANEL));
test('future v4 needs only champion500 and reason200, with the unchanged reason v2 policy', () =>
  publisherRoundTrip(CHAMPION_REASON_PANEL));
test('owner retirement applies only to the exact current suite and preserves both completed groups', () => {
  const plan = {
    id: 'model-000000468071',
    index: 5132,
    opponentPanel: MIXED_PANEL,
    opponents: ['clint', 'champion', 'reason'],
    modelSHA256: '1573232742934a24adca67e3ebbe0e9f66ea38d0d8e0e535ba56a3488dd52143',
  };
  const amendment = {
    schema: 'guanzero-clint-retirement-v1',
    authority: 'owner-request-2026-11-10',
    originalPlanSHA256: 'plan',
    modelSHA256: plan.modelSHA256,
    removedOpponents: ['clint'],
    retainedOpponents: ['champion', 'reason'],
    requestedAt: '2026-11-10T14:04:00Z',
    retainedReportSHA256: { champion: 'a'.repeat(64), reason: 'b'.repeat(64) },
    clintStoppedProgressSHA256: 'c'.repeat(64),
  };
  assert.deepEqual(effectiveOpponents(plan, amendment, 'plan'), ['champion', 'reason']);
  assert.throws(() => effectiveOpponents({ ...plan, index: 5133 }, amendment, 'plan'));
  assert.throws(() => effectiveOpponents(plan, amendment, 'changed-plan'));
  assert.throws(() =>
    effectiveOpponents(plan, { ...amendment, removedOpponents: ['champion'] }, 'plan'),
  );
});
test('legacy protocols cannot be downsized by adding per-opponent counts', () => {
  assert.throws(
    () =>
      suitePairs(
        { opponentPanel: REASON_V2_PANEL, pairs: 250, opponentPairs: { ...MIXED_PAIRS } },
        'reason',
      ),
    /Historical/,
  );
  assert.equal(
    reasonPanel(identities(REASON_V2_PANEL).reason, { opponentPanel: MIXED_PANEL }),
    MIXED_PANEL,
  );
});
test('cancelled incomplete suite is never restarted by the next one-shot companion', async () => {
  const run = mkdtempSync(join(tmpdir(), 'guanzero-cancel-')),
    dir = join(run, 'eval/development-500');
  try {
    mkdirSync(join(dir, 'model-000001'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ suites: [{ id: 'model-000001' }] }));
    writeFileSync(
      join(dir, 'model-000001/cancelled.json'),
      JSON.stringify({ cancelledAt: 'owner' }),
    );
    const result = await runDevelopmentSuites({ run, once: true });
    assert.equal(result.phase, 'waiting');
    assert.equal(result.suite, undefined);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
test('cancelled evaluation stays visibly stopped with its actual partial match count', () => {
  const run = mkdtempSync(join(tmpdir(), 'guanzero-stop-card-')),
    dir = join(run, 'eval/development-500'),
    folder = join(dir, 'model-000001');
  try {
    mkdirSync(join(folder, 'reason'), { recursive: true });
    const plan = {
      id: 'model-000001',
      protocol: 'development-500-v1',
      pairs: 250,
      index: 5131,
      modelVersion: 'model-000001',
      modelSHA256: 'abc',
      createdAt: '2026-11-10T01:00:00Z',
      seedStart: 4213100000,
      seedEnd: 4213100249,
      opponents: ['reason'],
      reason: { name: 'reason', version: 'v1', modelSHA256: 'def', evaluationSHA256: 'eval' },
    };
    for (const [p, v] of [
      ['manifest.json', { suites: [plan] }],
      ['model-000001/plan.json', plan],
      ['model-000001/cancelled.json', { cancelledAt: '2026-11-10T03:34:00Z' }],
      [
        'model-000001/reason/reason-progress.json',
        {
          opponent: 'reason',
          pairs: 250,
          completedPairs: 132,
          seedStart: plan.seedStart,
          modelSHA256: 'abc',
          opponentSHA256: 'def',
          evaluationSHA256: 'eval',
          metrics: { matches: 264 },
        },
      ],
    ])
      writeFileSync(join(dir, p), JSON.stringify(v));
    const [card] = guanzeroCards(run, Date.now());
    assert.equal(card.state, 'stopped');
    assert.equal(card.processAlive, null);
    assert.match(card.progress.text, /已按要求停止.*264\/500/);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

test('source fingerprint ignores comments and unrelated relative strings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reason-closure-'));
  try {
    writeFileSync(
      join(dir, 'entry.mjs'),
      `// import fake from './directory';\nimport { x } from './actual.mjs';\nconst unrelated='./directory';`,
    );
    mkdirSync(join(dir, 'directory'));
    writeFileSync(join(dir, 'actual.mjs'), 'export const x=1;');
    const files = sourceClosure(join(dir, 'entry.mjs'), dir);
    assert.deepEqual(Object.keys(files), ['actual.mjs', 'entry.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-opponent lock prevents duplicate orphan workers and recovers only dead PIDs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reason-worker-lock-')),
    file = join(dir, 'lock.json');
  try {
    const release = acquireWorkerLock(file, { opponent: 'reason' });
    assert.equal(workerAlive(file), true);
    assert.throws(() => acquireWorkerLock(file), /already running/);
    release();
    writeFileSync(file, JSON.stringify({ pid: 2147483647 }));
    assert.equal(workerAlive(file), false);
    const again = acquireWorkerLock(file);
    again();
    assert.equal(workerAlive(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unified dashboard reads actual learner progress and the training STOP without changing it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reason-dashboard-')),
    run = join(dir, 'training'),
    control = join(dir, 'control');
  try {
    mkdirSync(join(run, 'learner'), { recursive: true });
    mkdirSync(control);
    writeFileSync(
      join(run, 'window.json'),
      JSON.stringify({ startedAt: '2026-11-09T00:00:00Z', plannedEnd: '2026-11-11T15:00:00Z' }),
    );
    writeFileSync(
      join(run, 'learner/status.json'),
      JSON.stringify({
        pid: process.pid,
        step: 123,
        usedSamples: 393600,
        loss: 3,
        updatesPerSecond: 0.7,
        indexedShards: 2,
        updatedAt: 1794200000,
        device: 'cpu',
      }),
    );
    const config = {
      title: 'GuanZero',
      deadline: '2026-11-11T15:00:00Z',
      guanzeroRun: run,
      stages: [],
    };
    let result = windowSnapshot(control, config, {
      now: Date.parse('2026-11-09T01:00:00Z'),
      psText: '',
      machine: false,
    });
    assert.equal(result.now.running.length, 1);
    assert.ok(result.stages.every((stage) => Array.isArray(stage.ids)));
    assert.match(result.now.running[0].text, /123/);
    assert.equal(result.window.stop, false);
    writeFileSync(join(run, 'STOP'), 'owner');
    result = windowSnapshot(control, config, {
      now: Date.parse('2026-11-09T01:00:00Z'),
      psText: '',
      machine: false,
    });
    assert.equal(result.window.stop, true);
    assert.equal(result.stages[0].state, 'running');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed learner status is historical even if its old PID is still alive', () => {
  const run = mkdtempSync(join(tmpdir(), 'guanzero-stale-rate-'));
  try {
    mkdirSync(join(run, 'learner'), { recursive: true });
    writeFileSync(
      join(run, 'window.json'),
      JSON.stringify({
        startedAt: new Date(Date.now() - 1000).toISOString(),
        plannedEnd: new Date(Date.now() + 3600000).toISOString(),
      }),
    );
    writeFileSync(
      join(run, 'learner/status.json'),
      JSON.stringify({
        pid: process.pid,
        step: 472527,
        usedSamples: 1,
        indexedShards: 4,
        pauseSampling: false,
        updatesPerSecond: 0.95,
        updatedAt: Date.now() / 1000,
        error: 'WinError5',
      }),
    );
    const [card] = guanzeroCards(run, Date.now());
    assert.equal(card.state, 'failed');
    assert.match(card.progress.text, /最后记录（非实时）/);
    assert.match(card.results[0].rows.find((r) => r[0] === '学习速度')[1], /当前未运行/);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});
