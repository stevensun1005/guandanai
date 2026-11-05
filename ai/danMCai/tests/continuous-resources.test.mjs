import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryAction, memoryAvailability } from '../training/continuous/resources.mjs';

test('macOS headroom includes inactive pages so cached data does not starve samplers', () => {
  const readVM = () => `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free: 4375.
Pages inactive: 858762.
Pages wired down: 181776.
Pages occupied by compressor: 142429.
`;
  const memory = memoryAvailability({
    platform: 'darwin',
    rawFreeBytes: 4375 * 16384,
    totalBytes: 32 * 1024 ** 3,
    readVM,
  });
  assert(memory.rawFreeBytes < 4 * 1024 ** 3);
  assert(memory.availableBytes > 5 * 1024 ** 3);
  assert.equal(memory.measurement, 'vm_stat free + inactive');
  assert.equal(
    memoryAction({ freeBytes: memory.availableBytes, running: ['actor-0'], now: 50000 }),
    null,
  );
  assert.deepEqual(
    memoryAction({
      freeBytes: memory.availableBytes,
      running: [],
      paused: ['actor-0'],
      now: 50000,
    }),
    { type: 'resume', actor: 'actor-0' },
  );
});

test('unreadable or invalid Mac counters conservatively retain raw free memory; other systems do not invoke vm_stat', () => {
  const base = { platform: 'darwin', rawFreeBytes: 1024, totalBytes: 32 * 1024 ** 3 };
  for (const readVM of [
    () => {
      throw Error('denied');
    },
    () => 'bad output',
    () => 'page size of 16384 bytes\nPages free: 999999999999.\nPages inactive: 1.',
  ]) {
    const memory = memoryAvailability({ ...base, readVM });
    assert.equal(memory.availableBytes, 1024);
    assert(memory.measurementError);
  }
  assert.equal(
    memoryAvailability({
      ...base,
      platform: 'win32',
      readVM: () => {
        throw Error('must not run');
      },
    }).measurementError,
    undefined,
  );
});

test('samplers shed load below the reserve and resume with hysteresis after exiting', () => {
  const base = {
    running: ['actor-0', 'actor-1'],
    paused: [],
    now: 50000,
    lastActionAt: 0,
    reserveGB: 4,
    resumeGB: 5,
  };
  const decide = (freeGB, extra = {}) =>
    memoryAction({ ...base, freeBytes: freeGB * 1024 ** 3, ...extra });
  assert.deepEqual(decide(3), { type: 'pause', actor: 'actor-1' });
  assert.equal(decide(4.5), null);
  assert.equal(decide(3, { lastActionAt: 40000 }), null);
  assert.deepEqual(decide(3, { paused: ['actor-1'] }), { type: 'pause', actor: 'actor-0' });
  assert.equal(
    decide(6, { paused: ['actor-1'] }),
    null,
    'do not duplicate an actor still flushing',
  );
  assert.deepEqual(decide(6, { running: ['actor-0'], paused: ['actor-1'] }), {
    type: 'resume',
    actor: 'actor-1',
  });
});
