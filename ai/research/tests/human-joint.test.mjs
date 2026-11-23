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

test('58132 continuation locks the 08:00 cutoff, valid inactive seed block, stronger anchor and matching Adam', () => {
  const p = plan();
  const network = '1464c45f0617cd0776c861895a366d26f3c30908d4242cd15989d4911df221f2';
  const registered = Date.parse('2026-11-20T04:55:00.000Z');
  Object.assign(p, {
    id: 'human-qfilter-anchor-20261119-0800',
    initialModelSHA256: network,
    startedAtUTC: new Date(registered).toISOString(),
    trainingDeadlineUTC: '2026-11-20T13:00:00.000Z',
    deadlineUTC: '2026-11-20T16:00:00.000Z',
    humanWarmupUTC: new Date(registered).toISOString(),
    evaluationWorkers: 1,
  });
  Object.assign(p.initialConfig, {
    actors: 1,
    evaluationBlockOffset: 999,
    evaluationBlockEnd: 1000,
    fastActor: { games: 16, sessionLimit: 2 },
    parent: { startingStep: 58132 },
    continuation: {
      sha256: '05e6099f51f2bf74c36ee82a8757628f5ba26f5c58e56074319be9c520a8f517',
      shardSequenceStart: 300000,
    },
  });
  Object.assign(p.initialConfig.learner, {
    capacity: 500000,
    learningRate: 3e-6,
    anchorWeight: 0.1,
  });
  Object.assign(p.initialConfig.humanImitation, {
    choiceWeight: 0.1,
    gateTopK: 2,
    enableAfterUTC: p.startedAtUTC,
    compactFeatures: true,
  });
  p.heldout.vsParent = Array.from({ length: 500 }, (_, i) => i + 1000);
  p.evaluationModels.parent = { localFile: p.initialModel, sha256: network };
  assert.doesNotThrow(() => validateJointProtocol(p, registered + 1000));
  assert.equal(
    evaluationPlans(p, '/new', { sha256: 'final' })[0].plan.primaryOpponent,
    'parent58132',
  );
  const shifted = structuredClone(p);
  shifted.trainingDeadlineUTC = '2026-11-20T14:00:00.000Z';
  shifted.deadlineUTC = '2026-11-20T17:00:00.000Z';
  assert.throws(() => validateJointProtocol(shifted, registered + 1000), /fixed cutoff/);
  const invalidBlock = structuredClone(p);
  invalidBlock.initialConfig.evaluationBlockOffset = 1000;
  assert.throws(
    () => validateJointProtocol(invalidBlock, registered + 1000),
    /inactive internal gate/,
  );
  const weaker = structuredClone(p);
  weaker.initialConfig.learner.anchorWeight = 0.05;
  assert.throws(() => validateJointProtocol(weaker, registered + 1000), /objective/);
  const otherAdam = structuredClone(p);
  otherAdam.initialConfig.continuation.sha256 = 'changed';
  assert.throws(() => validateJointProtocol(otherAdam, registered + 1000), /checkpoint/);
});

test('reason replay uses disjoint training seeds and exactly three final-only pure argmax comparisons', () => {
  const p = plan();
  const network = '34e8717c7a2dc1d1338d2a34c10a216fa23663d1ca64269800d85073d78f4439';
  const registered = Date.parse('2026-11-23T05:25:00.000Z');
  Object.assign(p, {
    id: 'human-qfilter-reason-20261123-0700',
    startedAtUTC: new Date(registered).toISOString(),
    humanWarmupUTC: new Date(registered).toISOString(),
    trainingDeadlineUTC: '2026-11-24T12:00:00.000Z',
    deadlineUTC: '2026-11-24T15:00:00.000Z',
    initialModelSHA256: network,
    evaluationWorkers: 1,
    reasonReplay: { seeds: Array.from({ length: 2000 }, (_, i) => 3000 + i) },
    sourceSHA256: { 'ai/research/tools/human-reason-replay.mjs': 'freeze' },
  });
  const c = p.initialConfig;
  Object.assign(c, {
    actors: 1,
    fastActor: { games: 16, sessionLimit: 2 },
    actorSeedList: { perSlot: 200000 },
    evaluationBlockOffset: 999,
    evaluationBlockEnd: 1000,
    continuation: {
      sha256: '8513a95a9a9d37d648b475431b5bb8209accae1f4033900aa86ede0e8bf3181d',
      shardSequenceStart: 400000,
    },
    parent: { startingStep: 90232 },
  });
  Object.assign(c.learner, { learningRate: 3e-6, capacity: 500000 });
  Object.assign(c.humanImitation, {
    choiceWeight: 0.15,
    gateTopK: 2,
    enableAfterUTC: p.humanWarmupUTC,
    compactFeatures: true,
  });
  p.evaluationModels.parent = { localFile: p.initialModel, sha256: network };
  p.evaluationModels.guanzero = {
    sha256: '80319f31f96af8765c6f6141ed3b419d5dcde1c09032a3731b9a167b51bb0968',
    config: { history: 'guanzero-v1' },
  };
  p.heldout.vsGuanZero = Array.from({ length: 500 }, (_, i) => 1000 + i);
  assert.doesNotThrow(() => validateJointProtocol(p, registered + 1000));
  const groups = evaluationPlans(p, '/new', { sha256: 'final' });
  assert.deepEqual(
    groups.map((g) => g.name),
    ['vs029', 'vsreason', 'vsGuanZero'],
  );
  assert.ok(
    groups.every((g) => g.plan.models.challenger.sha256 === 'final' && !g.plan.finishShortcut),
  );
  assert.deepEqual(groups[2].plan.opponentPolicy, { kind: 'guanzero' });
  assert.deepEqual(groups[2].plan.tasks[0].seeds, p.heldout.vsGuanZero);
  p.reasonReplay.seeds[0] = p.heldout.vsGuanZero[0];
  assert.throws(() => validateJointProtocol(p, registered + 1000), /replay reservation/);
});
