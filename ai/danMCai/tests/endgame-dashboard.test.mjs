import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE } from '../endgame/dashboard.mjs';

test('endgame dashboard page script parses (a syntax error leaves the page stuck on 读取中)', () => {
  const scripts = [...PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Function(scripts[0]));
});
