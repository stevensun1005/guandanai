import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { isMain, spawnNice, windowsPriority } from '../endgame/platform.mjs';
import { freezeInit, SOURCES } from '../endgame/run.mjs';
import { sha256 } from '../training/continuous/lib.mjs';

test('entry check matches the running script as a file URL (also Windows-style paths)', () => {
  assert.equal(isMain(pathToFileURL(process.argv[1]).href), true);
  assert.equal(isMain(import.meta.url + '#other'), false);
});

test('nice levels map to Windows priority classes', () => {
  const { priority } = constants;
  assert.equal(windowsPriority(0), priority.PRIORITY_NORMAL);
  assert.equal(windowsPriority(5), priority.PRIORITY_BELOW_NORMAL);
  assert.equal(windowsPriority(10), priority.PRIORITY_LOW);
});

test('Windows spawning starts the command directly, without nice', async () => {
  const child = spawnNice(0, process.execPath, ['-e', 'process.exit(7)'], {}, 'win32');
  const code = await new Promise((done) => child.on('exit', done));
  assert.equal(code, 7);
});

test('init checkpoint is frozen only when preregistered and SHA-matching', () => {
  const dir = mkdtempSync(join(tmpdir(), 'endgame-init-'));
  const checkpoint = join(dir, 'checkpoint.pt');
  writeFileSync(checkpoint, 'weights');
  const run = join(dir, 'run');
  const config = (init) => ({ learner: init ? { init } : {} });
  // Neither protocol nor path: nothing inherited.
  const plain = config();
  freezeInit(plain, run, undefined);
  assert.equal(plain.learner.init, undefined);
  assert.throws(() => freezeInit(config(), run, checkpoint), /learner.init.sha256/);
  assert.throws(() => freezeInit(config({ sha256: sha256(checkpoint) }), run), /--init-checkpoint/);
  assert.throws(() => freezeInit(config({ sha256: '0'.repeat(64) }), run, checkpoint), /mismatch/);
  const good = config({ sha256: sha256(checkpoint), sourceRun: 'r2' });
  freezeInit(good, run, checkpoint);
  assert.equal(good.learner.init.file, 'learner/init.pt');
  assert.equal(good.learner.init.sourceRun, 'r2');
  assert.equal(readFileSync(join(run, 'learner', 'init.pt'), 'utf8'), 'weights');
});

test('platform helper is part of the frozen source list', () => {
  assert.ok(SOURCES.includes('ai/danMCai/endgame/platform.mjs'));
});
