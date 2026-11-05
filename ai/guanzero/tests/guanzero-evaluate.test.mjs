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
  assert.deepEqual(DEFAULT_OPPONENTS, ['random', 'rule', 'p0', 'clint']);
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
