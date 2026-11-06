import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics, intervals, evaluate } from '../training/evaluate.mjs';
test('GuanZero swapped-seat metrics use each model team and each round outcome', () => {
  const pair = [
    {
      neuralTeam: 0,
      winner: 0,
      history: [
        { team: 0, up: 3 },
        { team: 1, up: 1 },
      ],
    },
    { neuralTeam: 1, winner: null, history: [{ team: 1, up: 2 }] },
  ];
  const m = metrics([pair]);
  assert.equal(m.wins, 1);
  assert.equal(m.draws, 1);
  assert.equal(m.roundWinRate, 2 / 3);
  assert.equal(m.averageUpgradePoints, 4 / 3);
  assert.equal(m.matchScore, 0.75);
  assert.equal(intervals([pair]), null);
  const c = intervals([pair, pair], 100);
  assert.deepEqual(c.averageUpgradePoints, [4 / 3, 4 / 3]);
});

import { DEFAULT_OPPONENTS, opponentDefinition } from '../training/opponents.mjs';
import { RULE_OPPONENT_VERSION } from '../../shared/simulation/rule-baseline.mjs';
test('GuanZero includes Clint without relabelling the historical original rule baseline', () => {
  assert.deepEqual(DEFAULT_OPPONENTS, ['random', 'clint', 'champion']);
  assert.equal(opponentDefinition('clint').mode, 'rule');
  assert.equal(opponentDefinition('clint').ruleVersion, RULE_OPPONENT_VERSION);
  assert.equal(opponentDefinition('rule').ruleVersion, 'original');
  assert.notEqual(opponentDefinition('clint').name, opponentDefinition('rule').name);
});
test('misspelled or duplicate evaluation opponents fail before touching a run', async () => {
  const args = { run: 'unused-run', model: 'unused.onnx', index: 0 };
  await assert.rejects(evaluate({ ...args, opponents: ['clnit'] }), /Unknown GuanZero/);
  await assert.rejects(evaluate({ ...args, opponents: ['clint', 'clint'] }), /distinct/);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supplementBlock } from '../training/supplement-evaluations.mjs';
test('supplement refuses to overwrite a mismatched Clint report or the original results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'guanzero-clint-'));
  try {
    const folder = join(root, 'eval/block-0002');
    mkdirSync(join(folder, 'clint'), { recursive: true });
    const base = JSON.stringify({
      index: 2,
      pairs: 100,
      seedStart: 3700200000,
      seedEnd: 3700200099,
      modelSHA256: 'original',
      results: { rule: { wins: 0 } },
    });
    writeFileSync(join(folder, 'report.json'), base);
    writeFileSync(join(folder, 'clint/report.json'), JSON.stringify({ modelSHA256: 'different' }));
    await assert.rejects(supplementBlock(root, 'block-0002'), /mismatched/);
    assert.equal(readFileSync(join(folder, 'report.json'), 'utf8'), base);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('valid Clint requests validate the supplementary report path before creating files', async () => {
  await assert.rejects(
    evaluate({
      run: 'unused-run',
      model: 'unused.onnx',
      index: 0,
      opponents: ['clint'],
      subdirectory: '../escape',
    }),
    /Invalid evaluation subdirectory/,
  );
});

import { resumeClusters } from '../training/evaluate.mjs';
import { championDefinition } from '../training/champion.mjs';
import { validSuiteReport, suiteRows } from '../training/suite-reports.mjs';
import { SUITE_PAIRS, SUITE_SEED_INDEX } from '../training/development-suite.mjs';
import { evalSeed, sha256 } from '../training/lib.mjs';
test('500-match suites use 250 swapped pairs in a separate development seed block', () => {
  assert.equal(SUITE_PAIRS * 2, 500);
  assert.equal(evalSeed(SUITE_SEED_INDEX, SUITE_PAIRS), 4200000000);
  assert.equal(opponentDefinition('champion').mode, 'snapshot');
  const champion = championDefinition();
  assert.equal(champion.modelSHA256.length, 64);
  assert.ok(champion.gate.gate > 0);
  assert.match(champion.name, /^danMCai-v\d+$/);
});
test('champion resolution rejects unaccepted or substituted highest-step exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'guanzero-champion-'));
  try {
    mkdirSync(join(root, 'web/src/ai'), { recursive: true });
    mkdirSync(join(root, 'evidence'), { recursive: true });
    const gate = { decision: 'reject', challenger: { version: 'v999', sha256: 'a'.repeat(64) } };
    writeFileSync(join(root, 'evidence/gate.json'), JSON.stringify(gate));
    writeFileSync(
      join(root, 'evidence/champion.json'),
      JSON.stringify({ version: 'v999', sha256: 'a'.repeat(64), history: [{ gate: 9 }] }),
    );
    const model = {
      id: '009',
      sha256: 'a'.repeat(64),
      config: { stateFeatures: 513, actionFeatures: 54 },
      source: {
        version: 'v999',
        champion: {
          gate: 9,
          evidence: 'evidence/gate.json',
          evidenceSHA256: sha256(join(root, 'evidence/gate.json')),
        },
      },
    };
    writeFileSync(
      join(root, 'web/src/ai/model-catalog.json'),
      JSON.stringify({
        defaultId: '009',
        selection: { danMCaiChampions: ['009'] },
        models: [model],
      }),
    );
    assert.throws(() => championDefinition(root), /gate or history mismatch/);
  } finally {
    rmSync(root, { recursive: true });
  }
});
test('resume accepts only identical fingerprints and complete swapped-seat seed pairs', () => {
  const report = { protocolSHA256: 'x', pairs: 250, modelSHA256: 'm', seedStart: 4200000000 };
  const cluster = [
    { seed: 4200000000, neuralTeam: 0 },
    { seed: 4200000000, neuralTeam: 1 },
  ];
  const progress = { ...report, opponent: 'champion', completedPairs: 1, clusters: [cluster] };
  assert.deepEqual(resumeClusters(progress, report, 'champion'), [cluster]);
  assert.throws(
    () => resumeClusters({ ...progress, protocolSHA256: 'changed' }, report, 'champion'),
    /Mismatched/,
  );
  assert.throws(
    () => resumeClusters({ ...progress, clusters: [[cluster[0], cluster[0]]] }, report, 'champion'),
    /swapped-seat/,
  );
});
test('suite dashboard separates partial 500 targets from final results and rejects stale model/champion data', () => {
  const plan = {
    id: 'model-123',
    protocol: 'development-500-v1',
    modelVersion: 'model-123',
    index: 5000,
    pairs: 250,
    seedStart: 4200000000,
    seedEnd: 4200000249,
    modelSHA256: 'a'.repeat(64),
    opponents: ['champion'],
    champion: { name: 'danMCai-v000293055', version: 'v000293055', modelSHA256: 'b'.repeat(64) },
  };
  const progress = {
    opponent: 'champion',
    pairs: 250,
    seedStart: plan.seedStart,
    modelSHA256: plan.modelSHA256,
    opponentSHA256: plan.champion.modelSHA256,
    completedPairs: 1,
    metrics: { matches: 2, wins: 0, losses: 2, draws: 0, matchWinRate: 0 },
  };
  const files = new Map([
    ['manifest.json', { suites: [plan] }],
    ['model-123/plan.json', plan],
    ['model-123/champion/champion-progress.json', progress],
  ]);
  const read = (file) => files.get(file.replaceAll('\\', '/').split('development-500/')[1]);
  let row = suiteRows('test-eval', read)[0];
  assert.equal(row.matches, 2);
  assert.equal(row.plannedMatches, 500);
  assert.equal(row.status, 'running');
  assert.equal(row.confidence95, undefined);
  files.set('model-123/champion/champion-progress.json', { ...progress, opponentSHA256: 'wrong' });
  assert.equal(suiteRows('test-eval', read)[0].status, 'queued');
  const result = {
    matches: 500,
    wins: 10,
    losses: 480,
    draws: 10,
    clusters: Array.from({ length: 250 }, (_, i) =>
      [0, 1].map((t) => ({ seed: plan.seedStart + i, neuralTeam: t })),
    ),
  };
  const report = {
    ...plan,
    completedAt: 'done',
    opponents: { champion: plan.champion },
    results: { champion: result },
  };
  assert.equal(validSuiteReport(report, plan, 'champion'), true);
  assert.equal(validSuiteReport({ ...report, pairs: 100 }, plan, 'champion'), false);
  assert.equal(validSuiteReport({ ...report, modelSHA256: 'wrong' }, plan, 'champion'), false);
  assert.equal(
    validSuiteReport(
      { ...report, results: { champion: { ...result, wins: 500 } } },
      plan,
      'champion',
    ),
    false,
  );
});
