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
import { createRound } from '../../shared/simulation/simulation.mjs';
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
import { SearchBudgetError } from '../../../web/src/ai/search/core.mjs';
import { SolverBudget } from '../../danMCai/endgame/solver.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { reasonMatch, reasonProtocolDigest, evaluateReason } from '../training/evaluate-reason.mjs';
import { evaluate } from '../training/evaluate.mjs';
import { reasonPanel } from '../training/development-suite.mjs';
import { suiteOpponents, REASON_V1_PANEL, REASON_V2_PANEL } from '../training/opponents.mjs';
import { validSuiteReport } from '../training/suite-reports.mjs';
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
    const { champion, reason } = identities(protocol);
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
      opponents: ['clint', 'champion', 'reason'],
      modelVersion: 'model-000001',
      modelSHA256: hash('model'),
      index: 5131,
      pairs: 250,
      seedStart: 4213100000,
      seedEnd: 4213100249,
      champion,
      reason,
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
            : { id: 'clint', mode: 'rule', version: 'rules-v2' };
      const clusters = Array.from({ length: 250 }, (_, i) =>
        [0, 1].map((t) => ({
          seed: plan.seedStart + i,
          neuralTeam: t,
          winner: t,
          opponent: definition.mode,
        })),
      );
      const report = {
        index: plan.index,
        pairs: 250,
        seedStart: plan.seedStart,
        seedEnd: plan.seedEnd,
        modelSHA256: plan.modelSHA256,
        sourceSHA256: reason.sourceSHA256,
        opponents: { [op]: definition },
        results: {
          [op]: { matches: 500, wins: 500, losses: 0, draws: 0, confidence95: {}, clusters },
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
    plan.opponentPanel = 'clint-champion-v1';
    plan.opponents = ['clint', 'champion'];
    delete plan.reason;
    savePlan();
    assert.equal(Object.keys((await verify()).opponents).length, 2);
    plan.opponentPanel = protocol;
    plan.opponents = ['clint', 'champion', 'reason'];
    plan.reason = reason;
    savePlan();
    write(join(folder, 'reason/report.json'), reports.reason);
    const verified = await verify();
    assert.equal(Object.keys(verified.opponents).length, 3);
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
    assert.equal(cards.length, 3);
    assert.ok(cards.every((c) => c.state === 'done'));
    assert.ok(cards.some((c) => c.title.includes('danMCai-reason-v000001')));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
test('publisher requires all three reports and exact frozen reasoning identity; legacy two remains valid', () =>
  publisherRoundTrip(REASON_V1_PANEL));
test('publisher verifies protocol v2 batches the same way and binds panel to reason protocol', () =>
  publisherRoundTrip(REASON_V2_PANEL));

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
