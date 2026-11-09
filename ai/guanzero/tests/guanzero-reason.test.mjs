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
import { verifyReasonMetadata, reasonPayload, reasonContext } from '../training/reason.mjs';
import { reasonMatch, reasonProtocolDigest } from '../training/evaluate-reason.mjs';
import { evaluate } from '../training/evaluate.mjs';
import { suiteOpponents } from '../training/opponents.mjs';
import { validSuiteReport } from '../training/suite-reports.mjs';
import { verifyEvaluatedSuite } from '../../publishing/evaluated-suite.mjs';
import { guanzeroCards } from '../../research/tools/guanzero-stages.mjs';

const hash = (b) => createHash('sha256').update(b).digest('hex');
function identities() {
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
    budget: { ...SEARCH_BUDGETS.desktop },
    execution: 'web-desktop-policy-native-onnx-v1',
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
  const budget = SEARCH_BUDGETS.desktop;
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
test('direct old evaluator rejects reason instead of silently playing pure champion or self', async () => {
  await assert.rejects(
    evaluate({ run: 'unused', model: 'unused', index: 1, opponents: ['reason'] }),
    /registered suite/,
  );
});
test('publisher requires all three reports and exact frozen reasoning identity; legacy two remains valid', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'guanzero-reason-'));
  try {
    const root = join(temp, 'repo'),
      folder = join(temp, 'guanzero-adp-io48/eval/development-500/model-000001');
    mkdirSync(folder, { recursive: true });
    const { champion, reason } = identities();
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
      opponentPanel: 'clint-champion-reason-v1',
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
    plan.opponentPanel = 'clint-champion-reason-v1';
    plan.opponents = ['clint', 'champion', 'reason'];
    plan.reason = reason;
    savePlan();
    write(join(folder, 'reason/report.json'), reports.reason);
    assert.equal(Object.keys((await verify()).opponents).length, 3);
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
