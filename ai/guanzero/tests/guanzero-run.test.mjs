import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
function temporary() {
  // work/ is ignored by Git, so a fresh checkout (CI) does not have this parent yet.
  mkdirSync(join(root, 'ai/guanzero/runs'), { recursive: true });
  return mkdtempSync(join(root, 'ai/guanzero/runs/run-test-'));
}
test('GuanZero refuses changed frozen sources before starting any trainer', () => {
  const run = temporary();
  try {
    writeFileSync(join(run, 'config.json'), JSON.stringify({ sourceSHA256: { invalid: 'hash' } }));
    const result = spawnSync(process.execPath, ['ai/guanzero/training/run.mjs', `--run=${run}`], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sources changed/);
    assert.equal(existsSync(join(run, 'supervisor.lock')), false);
    assert.equal(existsSync(join(run, 'learner/state.pt')), false);
  } finally {
    rmSync(run, { recursive: true });
  }
});
test('GuanZero refuses a second supervisor without touching the live owner lock', () => {
  const run = temporary();
  try {
    const lock = JSON.stringify({ pid: process.pid });
    writeFileSync(join(run, 'supervisor.lock'), lock);
    const result = spawnSync(process.execPath, ['ai/guanzero/training/run.mjs', `--run=${run}`], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already owned/);
    assert.equal(readFileSync(join(run, 'supervisor.lock'), 'utf8'), lock);
  } finally {
    rmSync(run, { recursive: true });
  }
});
