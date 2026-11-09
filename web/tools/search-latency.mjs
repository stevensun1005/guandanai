/**
 * Latency and agreement of the REAL built search worker (web/dist/assets/search-worker.mjs) in
 * headless Chrome, against the Node research bot on the same positions. Local tool, not CI.
 *
 *   npm run build && PORT=8795 node web/tools/serve.mjs &
 *   node web/tools/search-latency.mjs --belief=<belief.onnx> [--url=http://127.0.0.1:8795/]
 *        [--chrome=<path>] [--start=731960000] [--rounds=60] [--out=<json>]
 *
 * Positions: champion-017 self-play rounds (onnxruntime-node), at most one midgame (21-40 cards)
 * and one endgame (<= 20 cards) decision per round. Expected decision: midgame-search.mjs with a
 * fresh node-count-only solver (deterministic). Chrome runs: the desktop budget, then a mobile
 * proxy (the mobile budget divided by 4, standing for a device 4x slower; DevTools CPU throttling
 * does not apply to dedicated workers). Reports p50/p95/max worker ms, fallbacks, agreement with
 * Node and the worker's peak JS heap (Runtime.getHeapUsage on the worker target).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as ort from 'onnxruntime-node';
import { advanceRound, createRound } from '../../ai/shared/simulation/simulation.mjs';
import { candidates } from '../src/ai/candidates.js';
import { policyState } from '../src/ai/observation.js';
import {
  DEFAULTS,
  endgameDecision,
  searchDecision,
} from '../../ai/danMCai/belief/midgame-search.mjs';
import { createBeliefModel } from '../../ai/danMCai/belief/sampler.mjs';
import { argmax, createModelPool } from '../../ai/danMCai/training/continuous/lib.mjs';
import { createSolver } from '../../ai/danMCai/endgame/solver.mjs';
import { SEARCH_BOT_V1, SEARCH_BUDGETS, searchBand } from '../src/ai/search/constants.mjs';
import { remainingCards } from '../src/ai/search/core.mjs';
import { searchPayload } from '../src/ai/search/payload.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const eq = a.indexOf('=');
      return eq < 0 ? [a.slice(2), '1'] : [a.slice(2, eq), a.slice(eq + 1)];
    }),
);
const ROOT = resolve(new URL('../../', import.meta.url).pathname);
const URL_ = args.url ?? 'http://127.0.0.1:8795/';
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const START = Number(args.start ?? 731_960_000),
  ROUNDS = Number(args.rounds ?? 60);
const CHAMPION = join(ROOT, 'web/dist/models/bot-017.onnx');

/* 1. Positions and Node decisions. */
const pool = await createModelPool(ort, { threads: 1, limit: 1 });
const belief = await createBeliefModel(ort, resolve(args.belief), { featureVersion: 'belief-v1' });
const cfg = (solver) => ({
  ...DEFAULTS,
  worldsSource: 'belief',
  endgame: 'pimc',
  endgameWorlds: 'belief',
  champion: CHAMPION,
  values: (file, state) => pool.values(file, state),
  belief,
  solver,
});
const positions = [];
for (let seed = START; seed < START + ROUNDS; seed++) {
  const game = createRound(seed);
  const taken = new Set();
  for (let ply = 0; ply < 1000; ply++) {
    const p = game.turn,
      plays = candidates(game.hands[p], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[p].length);
    if (index < 0 && plays.length === 1) index = 0;
    const band = searchBand(remainingCards(game));
    if (index < 0 && band && !taken.has(band) && (ply + seed) % 3 === 0) {
      taken.add(band);
      const solver = createSolver({
        maxNodes: SEARCH_BOT_V1.solverMaxNodes,
        maxMs: Infinity,
        maxTable: 1e9,
      });
      const d = await (band === 'midgame' ? searchDecision : endgameDecision)(
        game,
        seed,
        cfg(solver),
      );
      positions.push({
        seed,
        ply,
        band,
        expected: d.index,
        champion: d.championIndex,
        nodeMs: Math.round(d.ms),
        payload: searchPayload(game, p, 0, seed),
      });
    }
    if (index < 0) index = argmax(await pool.values(CHAMPION, policyState(game, p, 0, plays)));
    if (advanceRound(game, plays[index])) break;
  }
}
await pool.close();
await belief.close();
process.stderr.write(`${positions.length} positions\n`);

/* 2. Headless Chrome over the DevTools protocol. */
const profile = mkdtempSync(join(tmpdir(), 'search-latency-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
let version;
for (let i = 0; i < 100 && !version; i++) {
  await new Promise((r) => setTimeout(r, 200));
  version = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((r) => r.json())
    .catch(() => null);
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const waiting = new Map(),
  workerSessions = new Set();
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && waiting.has(msg.id)) {
    const { resolve: ok, reject } = waiting.get(msg.id);
    waiting.delete(msg.id);
    msg.error ? reject(Error(JSON.stringify(msg.error))) : ok(msg.result);
  } else if (msg.method === 'Target.attachedToTarget' && msg.params.targetInfo.type === 'worker') {
    workerSessions.add(msg.params.sessionId);
    void send('Runtime.runIfWaitingForDebugger', {}, msg.params.sessionId).catch(() => {});
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((ok, reject) => {
    const id = ++nextId;
    waiting.set(id, { resolve: ok, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: page } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, page);
await send(
  'Target.setAutoAttach',
  { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
  page,
);
await send('Page.navigate', { url: URL_ + '?bench=search' }, page);
await new Promise((r) => setTimeout(r, 4000));
const evaluate = async (expression) => {
  const out = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    page,
  );
  if (out.exceptionDetails) throw Error(JSON.stringify(out.exceptionDetails).slice(0, 500));
  return out.result.value;
};
await evaluate(`window.__bench = {
  start(budget) {
    const html = document.documentElement.outerHTML;
    const v = (html.match(/search-worker\\.mjs\\?v=([\\w]+)/) || html.match(/app\\.js\\?v=([\\w]+)/) || [])[1] || 'bench';
    this.worker?.terminate();
    this.worker = new Worker(new URL('./assets/search-worker.mjs?v=' + v, document.baseURI), { type: 'module' });
    this.id = 0;
    this.call = (message) => new Promise((ok, fail) => {
      const id = ++this.id;
      const listener = ({ data }) => { if (data.id !== id) return; this.worker.removeEventListener('message', listener); data.error ? fail(Error(data.error)) : ok(data.result); };
      this.worker.addEventListener('message', listener);
      this.worker.postMessage({ id, ...message });
    });
    const t0 = performance.now();
    return this.call({ type: 'init', bot: '9001', budget }).then(() => performance.now() - t0);
  },
  async search(payload) {
    const t0 = performance.now();
    const result = await this.call({ type: 'search', payload });
    return { ...result, wallMs: performance.now() - t0 };
  },
};`);

async function heap() {
  let used = 0;
  for (const s of workerSessions) {
    const h = await send('Runtime.getHeapUsage', {}, s).catch(() => null);
    if (h) used = Math.max(used, h.usedSize);
  }
  return used;
}
async function runArm(name, budget, throttle) {
  await send('Emulation.setCPUThrottlingRate', { rate: throttle }, page);
  workerSessions.clear();
  const initMs = await evaluate(`window.__bench.start(${JSON.stringify(budget)})`);
  const workerThrottle = [];
  for (const s of workerSessions)
    workerThrottle.push(
      await send('Emulation.setCPUThrottlingRate', { rate: throttle }, s)
        .then(() => 'applied')
        .catch((e) => 'not supported: ' + e.message.slice(0, 80)),
    );
  const rows = [];
  let peak = 0;
  for (const pos of positions) {
    const r = await evaluate(`window.__bench.search(${JSON.stringify(pos.payload)})`);
    peak = Math.max(peak, await heap());
    rows.push({
      seed: pos.seed,
      band: pos.band,
      expected: pos.expected,
      nodeMs: pos.nodeMs,
      ok: !!r.ok,
      reason: r.reason || null,
      index: r.ok ? r.index : null,
      ms: Math.round(r.ms ?? r.wallMs),
      wallMs: Math.round(r.wallMs),
    });
  }
  await send('Emulation.setCPUThrottlingRate', { rate: 1 }, page);
  return {
    name,
    budget,
    throttle,
    initMs: Math.round(initMs),
    workerThrottle,
    peakHeapMB: Math.round(peak / 2 ** 20),
    rows,
  };
}
const quantile = (values, q) => {
  const s = values.slice().sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};
function summarize(arm) {
  const by = (band) => {
    const rows = band ? arm.rows.filter((r) => r.band === band) : arm.rows;
    const wall = rows.map((r) => r.wallMs);
    return {
      decisions: rows.length,
      fallbacks: rows.filter((r) => !r.ok).length,
      fallbackRate: rows.length ? rows.filter((r) => !r.ok).length / rows.length : null,
      sameAsNode: rows.filter((r) => r.ok && r.index === r.expected).length,
      completedDifferentFromNode: rows.filter((r) => r.ok && r.index !== r.expected).length,
      wallMs: { p50: quantile(wall, 0.5), p95: quantile(wall, 0.95), max: Math.max(...wall) },
    };
  };
  const { rows, ...rest } = arm;
  return { ...rest, midgame: by('midgame'), endgame: by('endgame'), all: by(null) };
}
const arms = [];
try {
  arms.push(await runArm('desktop', SEARCH_BUDGETS.desktop, 1));
  // DevTools CPU throttling does not reach dedicated workers ("only supported for pages"), so a
  // device 4x slower is approximated by the mobile budget divided by 4 on this machine.
  const m = SEARCH_BUDGETS.mobile;
  arms.push(
    await runArm(
      'mobile-proxy-quarter-budget',
      { ...m, midgameMs: m.midgameMs / 4, endgameMs: m.endgameMs / 4, solverMs: m.solverMs / 4 },
      1,
    ),
  );
} finally {
  ws.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await exited;
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome may still be flushing its temporary profile. */
  }
}
const result = {
  purpose:
    'latency and agreement of the built search worker in headless Chrome vs the Node research bot; development seeds; not a strength result',
  generatedAt: new Date().toISOString(),
  chrome: version.Browser,
  url: URL_,
  seeds: [START, START + ROUNDS - 1],
  positions: positions.length,
  machine: 'shared research Mac under load (window-2 workers running); times are upper-biased',
  arms: arms.map(summarize),
};
console.log(JSON.stringify(result, null, 2));
if (args.out)
  writeFileSync(
    resolve(args.out),
    JSON.stringify({ ...result, rows: arms.map((a) => a.rows) }, null, 2) + '\n',
  );
process.exit(0);
