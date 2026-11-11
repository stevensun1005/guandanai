/**
 * Window-5 dashboard parse test (PLAN review R6/C11): every card of RT/dashboard.json parses with the
 * window-dashboard.mjs it is served by, and the `train` kind reads learner.py's own log format
 * (learner/log.jsonl: {"t": ..., "event": "train", "step": N, ...}), so L1 needs no new `learner` kind.
 *
 *   node --test dashboard-parse.test.mjs   (env DASH_TOOL=<checkout>/ai/research/tools/window-dashboard.mjs)
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const R = '/Users/stevensun/guandan-runtime.noindex/window5-20261111';
const tool = process.env.DASH_TOOL || `${R}/dash-src/ai/research/tools/window-dashboard.mjs`;
const { snapshot } = await import(pathToFileURL(tool).href);
const config = JSON.parse(readFileSync(`${R}/dashboard.json`, 'utf8'));

test('every card parses on the real run directory', () => {
  const snap = snapshot(R, config, { psText: '', machine: false });
  assert.equal(snap.stages.length, config.stages.length);
  for (const s of snap.stages) assert.ok(!s.error, `${s.key}: ${s.error}`);
  const keys = new Set(config.stages.map((s) => s.key));
  for (const k of ['W5-0', 'W5-0b', 'V2a', 'C2', 'C2-0', 'C2-1', 'L1', 'L1-feed', 'L1-mse', 'L1-mse-final', 'H1', 'G1', 'D5', 'M5', 'ACC5', 'DEV-1', 'T-close', 'T-writeup', 'T-smoke', 'T-smoke-e2', 'T-build', 'T-review', 'T-docs', 'T-window5-plan', 'T-dashboard8771'])
    assert.ok(keys.has(k), `card ${k}`);
});

test('train kind reads learner.py log.jsonl steps (L1) and the V2a train.log', () => {
  const run = mkdtempSync(join(tmpdir(), 'w5-dash-'));
  const now = Date.parse('2026-11-11T07:00:00Z');
  const at = (m) => new Date(now - m * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(
    join(run, 'stages.log'),
    [`${at(200)} queue start pid 1`, `${at(190)} START V2a x`, `${at(150)} END V2a rc=0`, `${at(140)} START L1 x`, `${at(139)} NOTE L1 017h: extrasMode public-belief-history`, `${at(139)} START C2-0 x`].join('\n') + '\n',
  );
  mkdirSync(join(run, 'L1/run/learner'), { recursive: true });
  writeFileSync(
    join(run, 'L1/run/learner/log.jsonl'),
    [{ t: 1, event: 'start', step: 0 }, { t: 2, event: 'train', step: 100, lossEMA: 2.1 }, { t: 3, event: 'train', step: 1200, lossEMA: 2.0 }]
      .map((r) => JSON.stringify(r).replace(/":/g, '": ')) // python json.dumps separators
      .join('\n') + '\n',
  );
  mkdirSync(join(run, 'V2a'), { recursive: true });
  writeFileSync(join(run, 'V2a/train.log'), '{"phase": "ready", "step": 0}\n{"step": 1000, "seconds": 60}\n');
  mkdirSync(join(run, 'C2/slot-0/blocks'), { recursive: true });
  writeFileSync(join(run, 'C2/slot-0/run.json'), JSON.stringify({ rounds: 10000, deadline: now + 3600000 }));
  writeFileSync(join(run, 'C2/slot-0/blocks/b000000.done.json'), JSON.stringify({ block: 0, rounds: 100, rowsWritten: 5700 }));
  const snap = snapshot(run, config, { now, psText: `node learner.py --run=${run}/L1/run`, machine: false });
  const by = Object.fromEntries(snap.stages.map((s) => [s.key, s]));
  for (const s of snap.stages) assert.ok(!s.error, `${s.key}: ${s.error}`);
  assert.equal(by.L1.state, 'running');
  assert.match(by.L1.progress.text, /1,200/);
  assert.ok(Math.abs(by.L1.progress.fraction - 1200 / 5000) < 1e-9);
  assert.equal(by.V2a.state, 'done');
  assert.equal(by['L1-feed'].state, 'running');
  assert.match(by['C2-0'].progress.text, /100/);
});
