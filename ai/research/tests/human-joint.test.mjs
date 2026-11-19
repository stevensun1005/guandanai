import test from 'node:test';
import assert from 'node:assert/strict';
import { validateJointProtocol, evaluationPlans } from '../tools/run-human-joint.mjs';
import { windowPlan } from '../../danMCai/training/continuous/windows-window.mjs';
const start = Date.parse('2030-01-01T00:00:00Z');
function plan() {
  return {
    id: 'human-joint-029-20261115',
    humanTrainingAuthorized: true,
    webDeploymentAuthorized: false,
    restartExtendsDeadline: false,
    startedAtUTC: new Date(start).toISOString(),
    trainingDeadlineUTC: new Date(start + 4 * 3600000).toISOString(),
    deadlineUTC: new Date(start + 7 * 3600000).toISOString(),
    initialModel: '/029.onnx',
    initialModelSHA256: '4f5d8ef453f9627d73130ffccf320b49fff0a77dbed1bf390032a5e66f849768',
    sourceRoot: '/frozen',
    sourceCommit: 'frozen',
    sourceSHA256: {},
    python: 'python',
    initialConfig: {
      initial: '/029.onnx',
      learner: { targetMatchWeight: 0, anchorWeight: 0.1, learningRate: 1e-6 },
      actorMix: { self: 0.5, league: 0.5, rule: 0 },
      researchNoGate: true,
      humanImitation: {
        choiceWeight: 0.2,
        candidateAnchorWeight: 0.1,
        everyUpdates: 8,
        batchDecisions: 4,
        maxPasses: 40,
      },
    },
    heldout: {
      vs029: Array.from({ length: 500 }, (_, i) => i),
      vsreason: Array.from({ length: 500 }, (_, i) => i + 500),
    },
    evaluationTemplate: { plannedRounds: 1000, plannedPairs: 500 },
    evaluationModels: {
      raw029: { sha256: 'raw' },
      old017: { sha256: 'old' },
      belief: { sha256: 'belief' },
    },
  };
}

test('joint registration freezes objective, independent blocks and4h+3h nonrenewable bounds', () => {
  const p = plan();
  assert.doesNotThrow(() => validateJointProtocol(p, start + 1000));
  for (const mutate of [
    (q) => (q.initialConfig.actorMix.rule = 0.1),
    (q) => (q.initialConfig.learner.targetMatchWeight = 0.2),
    (q) => (q.webDeploymentAuthorized = true),
    (q) => (q.initialConfig.humanImitation.choiceWeight = 2),
    (q) => (q.deadlineUTC = new Date(start + 8 * 3600000).toISOString()),
    (q) => (q.heldout.vsreason[0] = 0),
  ]) {
    const q = plan();
    mutate(q);
    assert.throws(() => validateJointProtocol(q, start + 1000));
  }
  assert.throws(() => validateJointProtocol(p, start + 4 * 3600000));
});

test('automatic evaluation fixes final-only model and common-opponent covariance without a new clock', () => {
  const p = plan();
  const groups = evaluationPlans(p, '/new-run', { sha256: 'final' });
  assert.deepEqual(
    groups.map((g) => g.name),
    ['vs029', 'vsreason', '029vsreason'],
  );
  assert.equal(groups[0].plan.models.challenger.sha256, 'final');
  assert.equal(groups[1].plan.models.reason.sha256, 'old');
  assert.equal(groups[2].plan.models.challenger.sha256, 'raw');
  assert.equal(groups[2].plan.models.belief.sha256, 'belief');
  assert.deepEqual(groups[1].plan.tasks[0].seeds, groups[2].plan.tasks[0].seeds);
  assert.deepEqual(groups[0].plan.opponentPolicy, { kind: 'raw' });
  assert.equal(groups[1].plan.opponentPolicy, undefined);
  const reg = {
    startUTC: p.trainingDeadlineUTC,
    deadlineUTC: p.deadlineUTC,
    durationHours: 3,
    restartExtendsDeadline: false,
  };
  const recovered = windowPlan(reg, 3, start + 5 * 3600000);
  assert.equal(recovered.remainingHours, 2);
  assert.equal(recovered.schedule.deadlineUTC, p.deadlineUTC);
});

test('overnight filter keeps the owner09:00Toronto deadline and delayed imitation fixed', () => {
  const p = plan();
  p.id = 'human-qfilter-overnight-20261115';
  p.startedAtUTC = '2026-11-16T04:00:00.000Z';
  p.trainingDeadlineUTC = '2026-11-16T14:00:00.000Z';
  p.deadlineUTC = '2026-11-16T17:00:00.000Z';
  p.humanWarmupUTC = '2026-11-16T08:00:00.000Z';
  p.initialConfig.learner.learningRate = 3e-6;
  p.initialConfig.learner.anchorWeight = 0.05;
  p.initialConfig.actors = 2;
  p.initialConfig.fastActor = { games: 16, sessionLimit: 3 };
  Object.assign(p.initialConfig.humanImitation, {
    choiceWeight: 0.1,
    gateTopK: 2,
    enableAfterUTC: p.humanWarmupUTC,
  });
  const now = Date.parse(p.startedAtUTC) + 1000;
  assert.doesNotThrow(() => validateJointProtocol(p, now));
  for (const change of [
    (q) => (q.trainingDeadlineUTC = '2026-11-16T15:00:00.000Z'),
    (q) => (q.initialConfig.humanImitation.gateTopK = 3),
    (q) => (q.initialConfig.humanImitation.enableAfterUTC = q.startedAtUTC),
  ]) {
    const q = structuredClone(p);
    change(q);
    assert.throws(() => validateJointProtocol(q, now));
  }
});

test('continued window binds matching checkpoint, memory footprint, original029 comparison and07Toronto cutoff', () => {
  const p = plan();
  p.id = 'human-qfilter-continue-20261116';
  Object.assign(p, {
    startedAtUTC: '2026-11-17T04:00:00.000Z',
    trainingDeadlineUTC: '2026-11-17T12:00:00.000Z',
    deadlineUTC: '2026-11-17T15:00:00.000Z',
    humanWarmupUTC: '2026-11-17T00:00:00.000Z',
    evaluationWorkers: 1,
    initialModelSHA256: '9e6b98aa1ab6693247903d9d06aab34d435e96ab5e0d0535a6b603061d30bf03',
  });
  Object.assign(p.initialConfig, {
    actors: 1,
    fastActor: { games: 16, sessionLimit: 2 },
    parent: { startingStep: 21833 },
    continuation: {
      sha256: '815cf52f9aa7319a3d8d1b9e21bc879fd1cb46fa872394f259cd286f6f93c516',
      shardSequenceStart: 100000,
    },
  });
  Object.assign(p.initialConfig.learner, {
    capacity: 500000,
    learningRate: 3e-6,
    anchorWeight: 0.05,
  });
  Object.assign(p.initialConfig.humanImitation, {
    choiceWeight: 0.1,
    gateTopK: 2,
    enableAfterUTC: p.humanWarmupUTC,
    compactFeatures: true,
  });
  const now = Date.parse(p.startedAtUTC) + 1000;
  assert.doesNotThrow(() => validateJointProtocol(p, now));
  for (const mutate of [
    (q) => (q.initialConfig.continuation.sha256 = 'bad'),
    (q) => (q.initialConfig.parent.startingStep = 0),
    (q) => (q.trainingDeadlineUTC = '2026-11-17T13:00:00.000Z'),
    (q) => (q.initialConfig.actors = 2),
    (q) => (q.initialConfig.continuation.shardSequenceStart = 0),
  ]) {
    const q = structuredClone(p);
    mutate(q);
    assert.throws(() => validateJointProtocol(q, now));
  }
  assert.ok(evaluationPlans(p, '/new', { sha256: 'final' }).every((g) => g.plan.workers === 1));
});

test('new continuation evaluates the final model against its exact training parent on a separate block', () => {
  const p = plan();
  p.evaluationModels.parent = { sha256: 'parent50424' };
  p.heldout.vsParent = Array.from({ length: 500 }, (_, i) => 1000 + i);
  const [{ name, plan: parent }, , reason, control] = evaluationPlans(p, '/new', {
    sha256: 'final',
  });
  assert.equal(name, 'vsParent');
  assert.equal(parent.models.challenger.sha256, 'final');
  assert.equal(parent.models.reason.sha256, 'parent50424');
  assert.deepEqual(parent.opponentPolicy, { kind: 'raw' });
  assert.deepEqual(parent.tasks[0].seeds, p.heldout.vsParent);
  assert.deepEqual(reason.plan.tasks[0].seeds, control.plan.tasks[0].seeds);
});
