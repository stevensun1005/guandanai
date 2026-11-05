import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MODELS } from '../../../web/src/ai/models.mjs';
import { RESPONSE_FEATURES } from '../../../web/src/ai/response-features.mjs';

test('the published response metadata describes the actual deployed model and raw weights', () => {
  const meta = JSON.parse(
    readFileSync(new URL('../models/baseline/response.meta.json', import.meta.url)),
  );
  const hash = (file) =>
    createHash('sha256')
      .update(readFileSync(new URL('../models/baseline/' + file, import.meta.url)))
      .digest('hex');
  assert.equal(meta.modelSHA256, hash(MODELS.response.file));
  assert.equal(meta.weightsSHA256, hash('response.npz'));
  assert.equal(meta.input.shape[1], RESPONSE_FEATURES);
  assert.deepEqual(meta.architecture, [RESPONSE_FEATURES, ...MODELS.response.hidden, 1]);
  assert.equal(
    meta.dataset.splitGames.train +
      meta.dataset.splitGames.validation +
      meta.dataset.splitGames.test,
    meta.dataset.games,
  );
});
