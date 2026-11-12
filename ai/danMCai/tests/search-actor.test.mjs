/**
 * Search actor (ai/danMCai/training/continuous/search-actor.mjs, window 4 plan section 8 item 6):
 *   - with exploration off, one deal's four seats decide exactly as midgame-search's playRound with
 *     --mode=search --opponents=search on the same (seed, ply) worlds (whole played log with
 *     --endgame=none; points/order with --endgame=pimc, whose solver budget is wall-clock);
 *   - a row equals the trainer's fast actor row (fast-actor.mjs, extrasMode public-belief) at the
 *     same above-40 decision: int8 features, 215 extras, whole-round targets;
 *   - blocks: one trainer shard per finished block, SHA-256 per file, nothing left on a stop inside
 *     a block; the CLI writes run.json and manifest.json.
 * Seeds: window-3 S1 seeds 4291000000+ (already used; parity only, no evidence).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRound, advanceRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { decisionContext, policyState } from '../../../web/src/ai/observation.js';
import { encodePolicyExtras } from '../../../web/src/ai/policy-features.mjs';
import { publicView } from '../belief/features.mjs';
import { beliefMarginals, createBeliefModel } from '../belief/sampler.mjs';
import { DEFAULT_CHAMPION, maskHidden, playRound } from '../belief/midgame-search.mjs';
import {
  EXTRAS,
  buildActorProtocol,
  createActorConfig,
  decisionRow,
  labelRound,
  manifestOf,
  playActorRound,
  runBlock,
} from '../training/continuous/search-actor.mjs';
import { FEATURES, TARGETS, encodeSample, sha256 } from '../training/continuous/lib.mjs';

// Small reads come from Node's shared Buffer pool: copy exactly this file's bytes (byteOffset
// may be non-zero), not the whole pool.
const fileBytes = (path) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

const BELIEF_V1 = '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx';
const SEED = 4_291_000_000;
const ACTOR = fileURLToPath(new URL('../training/continuous/search-actor.mjs', import.meta.url));
const haveModels = existsSync(DEFAULT_CHAMPION) && existsSync(BELIEF_V1);
const skip = !haveModels && 'champion 017 or belief v1 missing';
const playedLog = (log) => log.map((e) => ({ p: e.p, ids: e.cards?.map((c) => c.id) ?? null }));

async function actorConfig(extra = {}) {
  const ort = await import('onnxruntime-node');
  const protocol = buildActorProtocol({
    start: String(SEED),
    rounds: '4',
    belief: BELIEF_V1,
    ...extra,
  });
  return createActorConfig(protocol, ort);
}

test('protocol: deployed defaults, validation, refused evaluation options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-actor-protocol-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'champion bytes');
    const belief = join(dir, 'belief.onnx');
    writeFileSync(belief, 'belief bytes');
    const base = {
      start: '4290200000',
      rounds: '300',
      champion,
      'allow-champion': '1',
      belief,
      'belief-train-report': 'none',
    };
    const p = buildActorProtocol(base);
    assert.equal(p.mode, 'search');
    assert.equal(p.opponents, 'search');
    assert.equal(p.worldsSource, 'belief');
    assert.equal(p.endgame, 'pimc');
    assert.equal(p.endgameWorlds, 'belief');
    assert.equal(p.endgameHi, 20);
    assert.deepEqual([p.lo, p.hi, p.worlds, p.k, p.net], [21, 40, 8, 6, 2]);
    assert.deepEqual(p.exploration, { type: 'softmax', temperature: 0.02 });
    assert.equal(p.policy, 'search');
    assert.equal(p.rows, 'above');
    assert.equal(p.blockRounds, 100);
    assert.equal(p.extraFeatures, 215);
    assert.equal(p.actorModel, p.champion);
    assert.equal(p.actorModelSHA256, sha256(champion));
    assert.deepEqual(buildActorProtocol({ ...base, temperature: '0' }).exploration, {
      type: 'greedy',
      temperature: 0,
    });
    assert.throws(() => buildActorProtocol({ ...base, belief: undefined }), /--belief/);
    assert.throws(() => buildActorProtocol({ ...base, policy: 'x' }), /--policy/);
    assert.throws(() => buildActorProtocol({ ...base, rows: 'x' }), /--rows/);
    assert.throws(() => buildActorProtocol({ ...base, policy: 'raw', rows: 'all' }), /--rows=all/);
    assert.throws(() => buildActorProtocol({ ...base, 'worlds-source': 'uniform' }), /belief/);
    assert.throws(() => buildActorProtocol({ ...base, rounds: '0' }), /--rounds/);
    assert.throws(() => buildActorProtocol({ ...base, start: String(2 ** 32 - 5) }), /2\^32/);
    for (const key of ['mode', 'opponents', 'focal-raw-model', 'pairs', 'held-out'])
      assert.throws(() => buildActorProtocol({ ...base, [key]: '1' }), /not a search-actor/);
    assert.throws(
      () => buildActorProtocol({ ...base, champion, 'allow-champion': undefined }),
      /not the frozen 017/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('whole-round label: signed round points per row team, sign, round 0 of 1', () => {
  const rows = [
    { features: new Int8Array(FEATURES), team: 0, round: 1 },
    { features: new Int8Array(FEATURES), team: 1, round: 1 },
  ];
  const labelled = labelRound(rows, { winner: 1, points: 2, order: [1, 0, 3, 2] });
  assert.deepEqual(labelled[0].targets, [-2, -1, 0, 1]);
  assert.deepEqual(labelled[1].targets, [2, 1, 0, 1]);
  assert.equal(TARGETS, 4);
});

test(
  'exploration off: all four seats decide as midgame-search --mode=search --opponents=search',
  { skip, timeout: 600_000 },
  async () => {
    for (const endgame of ['none', 'pimc']) {
      const cfg = await actorConfig({ temperature: '0', endgame });
      try {
        assert.equal(cfg.mode, 'search');
        assert.equal(cfg.opponents, 'search');
        const seed = SEED + (endgame === 'none' ? 0 : 1);
        const mine = await playActorRound(seed, cfg);
        const theirs = await playRound(seed, 0, { ...cfg, keepLog: true });
        const at = `seed ${seed} endgame ${endgame}`;
        const points = mine.result.winner === 0 ? mine.result.points : -mine.result.points;
        assert.equal(points, theirs.points, `${at} points`);
        assert.deepEqual(mine.result.order, theirs.order, `${at} order`);
        const both = (key) => theirs[key] + theirs.opp[key];
        const plies = (key) => [...theirs[key], ...theirs.opp[key]].sort((a, b) => a - b);
        if (endgame === 'none') {
          assert.deepEqual(playedLog(mine.log), playedLog(theirs.log), `${at} played log`);
          assert.equal(mine.plies, theirs.plies);
          for (const key of ['bandDecisions', 'searched', 'differs'])
            assert.equal(mine.stats[key], both(key), `${at} ${key}`);
          assert.deepEqual(mine.stats.differPlies, plies('differPlies'), `${at} differPlies`);
          assert.equal(mine.stats.endgameSearched, 0);
        } else assert.ok(mine.stats.endgameSearched > 0, `${at} endgame searched`);
        assert.ok(mine.stats.searched > 0, `${at} band searched`);
        assert.equal(mine.stats.explored, 0);
        assert.equal(mine.rows.length, mine.stats.aboveDecisions);
        assert.equal(mine.labelled.length, mine.rows.length);
        for (const row of mine.labelled) {
          const sign = row.targets[0] > 0 ? 1 : -1;
          assert.ok([1, 2, 3].includes(Math.abs(row.targets[0])));
          assert.deepEqual(row.targets.slice(1), [sign, 0, 1]);
          assert.equal(row.extras.length, EXTRAS);
        }
      } finally {
        await cfg.close();
      }
    }
  },
);

/** fast-actor.mjs viewOf (not exported there): the mover's public view from a policy state. */
const viewOf = (state) => ({
  p: state.p,
  hand: state.hand,
  counts: state.counts,
  level: state.level,
  log: state.context.log.map((e) =>
    e.cards?.length
      ? { p: e.p, cards: e.cards.map((card) => card.id), type: e.type, value: e.value, n: e.n }
      : { p: e.p, cards: null },
  ),
});

test(
  'row layout equals the fast actor row at above-40 decisions',
  { skip: !existsSync(BELIEF_V1) && 'belief v1 missing' },
  async () => {
    const ort = await import('onnxruntime-node');
    const belief = await createBeliefModel(ort, BELIEF_V1);
    try {
      const game = createRound(SEED + 2);
      let compared = 0;
      for (let ply = 0; ply < 60; ply++) {
        const p = game.turn;
        const plays = candidates(game.hands[p], game.L, game.trick?.play);
        const cards = game.hands.reduce((s, h) => s + h.length, 0);
        if (plays.length > 1 && cards > 40) {
          // The fast rollout's state (fast-rollout.mjs) and the fast actor's 215 extras.
          const state = policyState(game, p, 0, plays);
          state.context = decisionContext(game, p);
          state.trick = state.context.trick;
          state.actionShapes = plays.map((x) => x && { type: x.type, value: x.value, n: x.n });
          const theirMarginals = await beliefMarginals(belief, viewOf(state));
          const masked = maskHidden(game, p);
          const marginals = await beliefMarginals(belief, publicView(masked, p));
          assert.deepEqual(Array.from(marginals), Array.from(theirMarginals), `ply ${ply}`);
          for (const index of new Set([0, plays.length - 1, Math.floor(plays.length / 2)])) {
            const extras = new Float32Array(EXTRAS);
            extras.set(encodePolicyExtras(state, index));
            extras.set(theirMarginals, 53);
            const row = decisionRow(masked, p, plays, index, marginals);
            assert.deepEqual(row.features, encodeSample(state, state.actions[index]));
            assert.deepEqual(row.extras, extras);
            assert.equal(row.features.length, FEATURES);
            assert.equal(row.team, p % 2);
            compared++;
          }
        }
        // Advance with a fixed, model-free rule: the first non-pass candidate.
        if (advanceRound(game, plays.find(Boolean) ?? null)) break;
      }
      assert.ok(compared >= 20, `compared ${compared} rows`);
    } finally {
      await belief.close();
    }
  },
);

test(
  'blocks: one trainer shard per finished block, file SHA-256, deterministic, stop discards',
  { skip, timeout: 300_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-actor-block-'));
    const cfg = await actorConfig({ policy: 'raw' });
    try {
      const run = { ...cfg, start: SEED + 3, rounds: 3, blockRounds: 2 };
      const record = await runBlock(dir, run, cfg, 0, () => false);
      assert.deepEqual(record.seeds, [SEED + 3, SEED + 4]);
      assert.equal(record.rounds, 2);
      const block = join(dir, 'blocks', 'b000000');
      const files = readdirSync(block).sort();
      assert.deepEqual(files, [
        'b000000-000000000.e.f32',
        'b000000-000000000.json',
        'b000000-000000000.x.i8',
        'b000000-000000000.y.f32',
      ]);
      for (const file of files) assert.equal(record.files[file], sha256(join(block, file)));
      const manifest = JSON.parse(readFileSync(join(block, 'b000000-000000000.json'), 'utf8'));
      assert.equal(manifest.rows, record.rowsWritten);
      assert.equal(manifest.features, FEATURES);
      assert.equal(manifest.extraFeatures, 215);
      assert.equal(manifest.matches, 2);
      assert.equal(manifest.extrasMode, 'public-belief');
      assert.deepEqual(manifest.targets, [
        'roundPoints',
        'matchResult',
        'roundIndex',
        'matchRounds',
      ]);
      // Byte layout: the first round's rows come first and equal a replay of that round.
      const again = await playActorRound(SEED + 3, cfg);
      const x = new Int8Array(fileBytes(join(block, 'b000000-000000000.x.i8')));
      const y = new Float32Array(fileBytes(join(block, 'b000000-000000000.y.f32')));
      const e = new Float32Array(fileBytes(join(block, 'b000000-000000000.e.f32')));
      assert.equal(x.length, manifest.rows * FEATURES);
      assert.equal(e.length, manifest.rows * EXTRAS);
      again.labelled.forEach((row, i) => {
        assert.deepEqual(x.subarray(i * FEATURES, (i + 1) * FEATURES), row.features);
        assert.deepEqual(Array.from(y.subarray(i * 4, i * 4 + 4)), row.targets);
        assert.deepEqual(e.subarray(i * EXTRAS, (i + 1) * EXTRAS), row.extras);
      });
      assert.ok(again.stats.explored >= 0 && again.stats.searched === 0, 'raw policy: no search');
      // A stop after the first round of a block leaves nothing of that block.
      const other = join(dir, 'stopped');
      let calls = 0;
      assert.equal(await runBlock(other, run, cfg, 0, () => calls++ > 0), null);
      assert.equal(calls, 2);
      assert.deepEqual(readdirSync(join(other, 'blocks')), []);
      assert.deepEqual(readdirSync(join(dir, 'blocks')).sort(), ['b000000', 'b000000.done.json']);
      // The last block holds the remaining round only.
      const last = await runBlock(dir, run, cfg, 1, () => false);
      assert.deepEqual(last.seeds, [SEED + 5, SEED + 5]);
      const m = manifestOf(dir, { ...run, championSHA256: cfg.championSHA256 });
      assert.equal(m.finishedBlocks, 2);
      assert.equal(m.finishedRounds, 3);
      assert.equal(m.rowsTotal, record.rowsWritten + last.rowsWritten);
    } finally {
      await cfg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'CLI: run.json, worker blocks, manifest.json; a second start refuses the same --out',
  { skip, timeout: 300_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-actor-cli-'));
    try {
      const out = join(dir, 'run');
      const args = [
        ACTOR,
        `--out=${out}`,
        `--start=${SEED + 6}`,
        '--rounds=2',
        '--block-rounds=1',
        '--workers=1',
        '--policy=raw',
        `--belief=${BELIEF_V1}`,
        '--minutes=5',
        `--stop-file=${join(dir, 'STOP')}`,
      ];
      const printed = JSON.parse(
        execFileSync(process.execPath, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      );
      assert.equal(printed.finishedBlocks, 2);
      assert.equal(printed.finishedRounds, 2);
      assert.deepEqual(printed.workerFailures, []);
      const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
      assert.equal(run.policy, 'raw');
      assert.ok(run.sources['ai/danMCai/training/continuous/search-actor.mjs']);
      assert.ok(run.sources['ai/danMCai/belief/midgame-search.mjs']);
      const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
      assert.equal(manifest.blocks.length, 2);
      assert.ok(manifest.throughputPerWorker.roundsPerHour > 0);
      assert.throws(() => execFileSync(process.execPath, args, { stdio: 'ignore' }));
      // A STOP file before the start: workers finish nothing and say why.
      writeFileSync(join(dir, 'STOP'), '');
      const out2 = join(dir, 'run2');
      const stopped = JSON.parse(
        execFileSync(
          process.execPath,
          args.map((a) => (a.startsWith('--out=') ? `--out=${out2}` : a)),
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      );
      assert.equal(stopped.finishedBlocks, 0);
      assert.ok(stopped.workerReasons.every((r) => r.reason === 'stop file'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
