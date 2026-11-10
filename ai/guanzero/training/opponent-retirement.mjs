/** One owner-authorized amendment; original plan and report identities stay unchanged. */
import assert from 'node:assert/strict';
import { MIXED_PANEL, suiteOpponents } from './opponents.mjs';
export function effectiveOpponents(plan, retirement = null, planSHA256 = null) {
  if (!retirement) return suiteOpponents(plan);
  assert.equal(retirement.schema, 'guanzero-clint-retirement-v1');
  assert.equal(retirement.authority, 'owner-request-2026-11-10');
  assert.equal(plan.id, 'model-000000468071');
  assert.equal(plan.index, 5132);
  assert.equal(
    plan.modelSHA256,
    '1573232742934a24adca67e3ebbe0e9f66ea38d0d8e0e535ba56a3488dd52143',
  );
  assert.equal(plan.opponentPanel, MIXED_PANEL);
  assert.deepEqual(plan.opponents, ['clint', 'champion', 'reason']);
  assert.equal(retirement.originalPlanSHA256, planSHA256);
  assert.equal(retirement.modelSHA256, plan.modelSHA256);
  assert.deepEqual(retirement.removedOpponents, ['clint']);
  assert.deepEqual(retirement.retainedOpponents, ['champion', 'reason']);
  assert.ok(Number.isFinite(Date.parse(retirement.requestedAt)));
  for (const op of retirement.retainedOpponents)
    assert.match(retirement.retainedReportSHA256[op], /^[a-f0-9]{64}$/);
  assert.match(retirement.clintStoppedProgressSHA256, /^[a-f0-9]{64}$/);
  return retirement.retainedOpponents;
}
