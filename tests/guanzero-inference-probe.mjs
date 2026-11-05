// Live protocol, mixed model versions, and complete-game action parity probe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInference } from '../scripts/guanzero/lib.mjs';
import { playMatch } from '../scripts/lib/match-rollout.mjs';
const [run, portText] = process.argv.slice(2),
  port = Number(portText);
const positions = JSON.parse(readFileSync(new URL('./fixtures/positions.json', import.meta.url)));
let maxError = 0,
  actionMismatches = 0,
  decisions = 0;
const clients = await Promise.all(Array.from({ length: 8 }, () => createInference({ port })));
const cpu = await Promise.all(Array.from({ length: 8 }, () => createInference()));
try {
  await Promise.all(
    clients.map(async (client, i) => {
      const file = join(run, 'models', `model-${String(i % 2).padStart(12, '0')}.onnx`);
      await client.load(file);
      await cpu[i].load(file);
      for (const state of positions.slice(i * 8, i * 8 + 8)) {
        const [a, b] = await Promise.all([client.values(state), cpu[i].values(state)]);
        for (let j = 0; j < a.length; j++) maxError = Math.max(maxError, Math.abs(a[j] - b[j]));
        const argmax = (v) => v.reduce((best, x, j) => (x > v[best] ? j : best), 0);
        actionMismatches += Number(argmax(a) !== argmax(b));
      }
    }),
  );
  const matches = await Promise.all(
    Array.from({ length: 4 }, async (_, i) => {
      const file = join(run, 'models', 'model-000000000000.onnx');
      await clients[i].load(file);
      await cpu[i].load(file);
      const cpuActions = [],
        gpuActions = [];
      const baseline = await playMatch({
        seed: 2981000000 + i,
        team: 0,
        mode: 'self',
        decide: async (state) => {
          const v = await cpu[i].values(state),
            index = v.reduce((best, x, j) => (x > v[best] ? j : best), 0);
          cpuActions.push(index);
          return { index };
        },
      });
      const candidate = await playMatch({
        seed: 2981000000 + i,
        team: 0,
        mode: 'self',
        decide: async (state) => {
          const v = await clients[i].values(state),
            index = v.reduce((best, x, j) => (x > v[best] ? j : best), 0);
          gpuActions.push(index);
          decisions++;
          return { index };
        },
      });
      assert.deepEqual(gpuActions, cpuActions);
      assert.deepEqual(candidate.history, baseline.history);
      return candidate;
    }),
  );
  console.log(JSON.stringify({ matches: matches.length, decisions, maxError, actionMismatches }));
} finally {
  await Promise.all([...clients, ...cpu].map((c) => c.close()));
}
