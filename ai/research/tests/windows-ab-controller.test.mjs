import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { freezeEvaluation, armSnapshot } from '../tools/run-windows-ab.mjs';
import { sha256 } from '../../danMCai/training/continuous/lib.mjs';

test('Windows A/B freezes stopped final exports once, preserves the deadline, rejects incomplete shutdown', () => {
  const root = mkdtempSync(join(tmpdir(), 'danmcai-ab-'));
  const json = (p, x) => writeFileSync(p, JSON.stringify(x));
  try {
    const arms = Object.fromEntries(['A', 'B'].map((id) => [id, join(root, id)]));
    const models = {};
    for (const [id, run] of Object.entries(arms)) {
      for (const p of ['models', 'learner']) mkdirSync(join(run, p), { recursive: true });
      const weight = join(run, 'models/final.onnx');
      writeFileSync(weight, 'synthetic-not-a-real-model-' + id);
      json(join(run, 'models/latest.json'), {
        file: 'final.onnx',
        sha256: sha256(weight),
        version: 'v001013907',
        step: 1013907,
      });
      json(join(run, 'config.json'), { parent: { latest: { step: 1013906 } }, actorMix: {} });
      json(join(run, 'status.json'), {
        stoppedAt: '2026-11-07T05:00:05Z',
        running: [],
        pid: 2147483647,
      });
      json(join(run, 'learner/status.json'), { state: 'stopped', step: 1013907, pid: 2147483647 });
      json(join(run, 'schedule.json'), { deadlineUTC: '2026-11-07T05:00:00Z' });
      models[id] = { file: null, sha256: null };
    }
    const pending = join(root, 'pending.json');
    json(pending, { models, sourceSHA256: {} });
    const settings = {
      directory: join(root, 'experiment'),
      pendingProtocol: pending,
      arms,
      evaluationHours: 12,
      evaluationSource: root,
      authorization: 'synthetic-test',
    };
    json(join(arms.B, 'learner/status.json'), { state: 'training', step: 1013907 });
    assert.throws(() => freezeEvaluation(settings), /fully stopped/);
    json(join(arms.B, 'learner/status.json'), { state: 'stopped', step: 1013907, pid: 2147483647 });
    const now = Date.parse('2026-11-07T06:00:00Z');
    const protocol = freezeEvaluation(settings, now);
    const saved = readFileSync(protocol, 'utf8');
    const plan = JSON.parse(saved);
    assert.equal(plan.evaluationDeadlineUTC, '2026-11-07T18:00:00.000Z');
    assert.equal(plan.models.A.sha256, sha256(join(arms.A, 'models/final.onnx')));
    freezeEvaluation(settings, now + 3600000);
    assert.equal(readFileSync(protocol, 'utf8'), saved);
    const snapshot = armSnapshot(arms.A, root);
    assert.equal(snapshot.phase, 'stopped');
    assert.equal(snapshot.newUpdates, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
