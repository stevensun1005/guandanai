/**
 * Distillation data for a residual on top of the frozen champion 017: the belief-world midgame
 * search of midgame-search.mjs (development result, MODEL_STUDY section 70.4) labels every
 * candidate it evaluates. Engineering code only; generating data is not an acceptance result.
 *
 * Policy (ALL FOUR seats, single fresh rounds createRound(seed)): finishing move first, a single
 * candidate is automatic; otherwise, while the table holds lo..hi cards (inclusive), the seat runs
 * midgame-search.mjs searchDecision exactly (belief worlds, net-d guard, champion tie-break, world
 * seed worldSeed(deal seed, ply)); elsewhere champion greedy. The search plays on a masked copy of
 * the game (maskHidden): only the mover's own hand, the hand counts and the public log reach the
 * features, the belief network and the world sampler. The TRUE deal only continues the actual game;
 * labels are rollout means over SAMPLED worlds and never look at it.
 *
 * Rows: at every SEARCHED decision, one row per candidate the search evaluated (champion top-k plus
 * pass), in ascending candidate index (pass, when legal, is the last candidate and so the last row
 * of its decision). Candidates outside the searched set are not written.
 *   x  int8    [rows, 567]  encodeSample(policyState(masked game, mover, 0, plays), action ids)
 *   y  float32 [rows]       search value: mean rollout signed round points over the worlds,
 *                           mover-team view
 *   c  float32 [rows]       champion Q of the row's action (the residual base)
 *   w  int8    [rows]       worlds where the action beat the champion move minus worlds where it lost
 *                           (0 on the champion row)
 *   f  uint8   [rows]       bit0 = champion move (argmax Q), bit1 = move the search chose
 * Grouping (as ai/danMCai/endgame/residual-learner.py): a new decision starts at row i when
 * x[i, :513] != x[i-1, :513] or row i-1 is a pass row (x[i-1, 513:] all zero). Every block is checked
 * against this rule before it is written.
 *
 *   node ai/danMCai/belief/distill-generate.mjs --seeds=a..b --belief=<onnx> --out=<dir>
 *        [--workers=1] [--block=20] [--lo=21] [--hi=40] [--worlds=8] [--k=6] [--net=2]
 *        [--champion=<onnx>] [--allow-champion=1] [--belief-train-report=<json>]
 *        [--minutes=<m>] [--stop-file=<path>]
 *
 * Output (resumable by seed block; a block is done once its .json exists; partial blocks are
 * regenerated):
 *   run.json        frozen protocol incl. belief/champion/train-report/source SHA-256; a resume with
 *                   any difference (settings, models or source files) is refused
 *   b<start>.x.i8 .y.f32 .c.f32 .w.i8 .f.u8 .json
 *   summary.json    totals and speed of the completed blocks
 * --minutes / --stop-file are per invocation (not protocol): a worker checks them before every
 * round and abandons its unfinished block, which a later resume regenerates from its first seed.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceRound, createRound } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import { FEATURES, STATE, argmax, encodeSample, sha256 } from '../training/continuous/lib.mjs';
import { assertHeldOut, trainingSeedRanges } from './metrics.mjs';
import { MAX_SEED, blocksOf, parseRange } from './generate.mjs';
import {
  CHAMPION_SHA256,
  DEFAULTS,
  DEFAULT_CHAMPION,
  createConfig,
  maskHidden,
  searchDecision,
  sourceClosure,
} from './midgame-search.mjs';

const SELF = fileURLToPath(import.meta.url);
export const PROTOCOL_VERSION = 'belief-search-distill-v1';
export const LABELS = 'belief-search-rollout-mean';
export const BYTES_PER_ROW = FEATURES + 4 + 4 + 1 + 1;
export const FLAG_CHAMPION = 1;
export const FLAG_CHOSEN = 2;
const remaining = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/**
 * Rows of one searched decision. `trueGame` is the position before the move (seat to move =
 * trueGame.turn); `d` is searchDecision's result for it. Only the masked game is read here.
 */
export function decisionRows(trueGame, d) {
  const player = trueGame.turn;
  const masked = maskHidden(trueGame, player);
  const state = policyState(masked, player, 0, d.plays);
  const c = d.roots.indexOf(d.championIndex);
  if (c < 0 || !d.roots.includes(d.index))
    throw Error('Champion and chosen moves must be searched');
  const order = d.roots.slice().sort((a, b) => a - b);
  return order.map((action) => {
    const r = d.roots.indexOf(action);
    let net = 0;
    for (const o of d.outcome) net += Math.sign(o[r] - o[c]);
    return {
      action,
      x: encodeSample(state, state.actions[action]),
      y: d.means[r],
      c: d.base[action],
      w: net,
      f: (action === d.championIndex ? FLAG_CHAMPION : 0) | (action === d.index ? FLAG_CHOSEN : 0),
    };
  });
}

/**
 * One fresh round: seats of `searchTeams` search in the band, everyone else (and every seat
 * outside the band) plays champion greedy. `onDecision(rows, info)` is called per searched decision.
 * Returns the round result from team 0's view plus counts.
 */
export async function playDistillRound(seed, cfg, { searchTeams = [0, 1], onDecision } = {}) {
  const game = createRound(seed);
  const stats = { decisions: 0, rows: 0, differs: 0, searchMs: 0 };
  for (let ply = 0; ply < 1000; ply++) {
    if (ply !== game.log.length) throw Error('Ply must equal the public log length');
    const player = game.turn;
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index < 0 && plays.length === 1) index = 0;
    if (index < 0) {
      const cards = remaining(game);
      if (searchTeams.includes(player % 2) && cards >= cfg.lo && cards <= cfg.hi) {
        const d = await searchDecision(game, seed, cfg);
        const rows = decisionRows(game, d);
        index = d.index;
        stats.decisions++;
        stats.rows += rows.length;
        stats.differs += Number(d.index !== d.championIndex);
        stats.searchMs += d.ms;
        await onDecision?.(rows, { seed, ply, player, cards, decision: d });
      } else index = argmax(await cfg.values(cfg.champion, policyState(game, player, 0, plays)));
    }
    const result = advanceRound(game, plays[index]);
    if (result) {
      const points = result.winner === 0 ? result.points : -result.points;
      return { seed, points, order: result.order, plies: ply + 1, ...stats };
    }
  }
  throw Error('Round did not terminate');
}

/** Row starts under the residual-learner grouping rule (see the module comment). */
export function decisionStarts(x) {
  const rows = x.length / FEATURES;
  const starts = [];
  for (let i = 0; i < rows; i++) {
    if (i === 0) {
      starts.push(0);
      continue;
    }
    const a = (i - 1) * FEATURES,
      b = i * FEATURES;
    let changed = false;
    for (let j = 0; j < STATE && !changed; j++) changed = x[a + j] !== x[b + j];
    let previousPass = true;
    for (let j = STATE; j < FEATURES && previousPass; j++) previousPass = x[a + j] === 0;
    if (changed || previousPass) starts.push(i);
  }
  return starts;
}

/** Play the rounds of `seeds` and pack their rows; `shouldStop()` abandons the block (null). */
export async function generateBlock(seeds, cfg, { shouldStop = () => false } = {}) {
  const rows = [];
  const rounds = [];
  const t0 = performance.now();
  for (const seed of seeds) {
    if (shouldStop()) return null;
    const round = await playDistillRound(seed, cfg, {
      onDecision: (decisionRows) => void rows.push(...decisionRows),
    });
    rounds.push(round);
  }
  const n = rows.length;
  const block = {
    rows: n,
    x: new Int8Array(n * FEATURES),
    y: new Float32Array(n),
    c: new Float32Array(n),
    w: new Int8Array(n),
    f: new Uint8Array(n),
  };
  rows.forEach((row, i) => {
    block.x.set(row.x, i * FEATURES);
    block.y[i] = row.y;
    block.c[i] = row.c;
    block.w[i] = row.w;
    block.f[i] = row.f;
  });
  const sum = (key) => rounds.reduce((s, r) => s + r[key], 0);
  block.stats = {
    rounds: rounds.length,
    decisions: sum('decisions'),
    rows: n,
    plies: sum('plies'),
    chosenDiffersFromChampion: sum('differs'),
    searchSeconds: sum('searchMs') / 1000,
    elapsedSeconds: (performance.now() - t0) / 1000,
    perRound: rounds.map((r) => [r.seed, r.decisions, r.rows, r.points]),
    perRoundFields: ['seed', 'decisions', 'rows', 'team0SignedPoints'],
  };
  const starts = decisionStarts(block.x);
  if (starts.length !== block.stats.decisions)
    throw Error(
      `Grouping rule finds ${starts.length} decisions, generator ${block.stats.decisions}`,
    );
  return block;
}

function atomicWrite(file, data) {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const SUFFIXES = { x: 'x.i8', y: 'y.f32', c: 'c.f32', w: 'w.i8', f: 'f.u8' };
const TYPES = { x: Int8Array, y: Float32Array, c: Float32Array, w: Int8Array, f: Uint8Array };

/** Write a block; the .json manifest is renamed into place last. */
export function writeBlock(dir, [start, end], block, extra = {}) {
  const name = join(dir, `b${start}`);
  for (const [key, suffix] of Object.entries(SUFFIXES))
    atomicWrite(`${name}.${suffix}`, bytes(block[key]));
  const meta = {
    schema: 1,
    labels: LABELS,
    protocolVersion: PROTOCOL_VERSION,
    features: FEATURES,
    seeds: [start, end],
    rows: block.rows,
    files: {
      x: `int8 [rows, ${FEATURES}] encodeSample(policyState(masked game), action)`,
      y: 'float32 [rows] mean rollout signed round points over the worlds, mover-team view',
      c: 'float32 [rows] champion Q of the action',
      w: 'int8 [rows] worlds beating minus worlds losing to the champion move',
      f: 'uint8 [rows] bit0 champion move, bit1 chosen move',
    },
    stats: block.stats,
    ...extra,
  };
  atomicWrite(`${name}.json`, JSON.stringify(meta));
  return meta;
}

/** Read a block written by writeBlock (sizes checked against the manifest). */
export function readBlock(dir, start) {
  const name = join(dir, `b${start}`);
  const meta = JSON.parse(readFileSync(`${name}.json`, 'utf8'));
  const block = { meta, rows: meta.rows };
  for (const [key, suffix] of Object.entries(SUFFIXES)) {
    const buffer = readFileSync(`${name}.${suffix}`);
    const Type = TYPES[key];
    const copy = new Uint8Array(buffer).buffer;
    block[key] = new Type(copy, 0, buffer.length / Type.BYTES_PER_ELEMENT);
    const want = meta.rows * (key === 'x' ? FEATURES : 1);
    if (block[key].length !== want)
      throw Error(`${name}.${suffix}: ${block[key].length} != ${want}`);
  }
  return block;
}

/** Validated frozen protocol (throws on a wrong champion or a belief/seed overlap). */
export function buildDistillProtocol(args) {
  const num = (key) => Number(args[key] ?? DEFAULTS[key]);
  if (!args.seeds) throw Error('--seeds=a..b');
  if (!args.belief) throw Error('--belief=<onnx> is required');
  const protocol = {
    purpose:
      'distillation data: belief-world midgame net-d search labels for a champion residual; ' +
      'engineering data generation, not an acceptance result',
    protocolVersion: PROTOCOL_VERSION,
    labels: LABELS,
    features: FEATURES,
    seeds: parseRange(args.seeds, 'seeds'),
    block: Number(args.block ?? 20),
    mode: 'search',
    worldsSource: 'belief',
    lo: num('lo'),
    hi: num('hi'),
    worlds: num('worlds'),
    k: num('k'),
    net: num('net'),
    tieBreak: DEFAULTS.tieBreak,
    endgame: 'none',
    searchTeams: [0, 1],
    policy:
      'all four seats: finishing move first, single candidate automatic; lo..hi cards: ' +
      'midgame-search.mjs searchDecision (belief worlds, net-d, champion tie-break); else champion greedy',
    worldSeedRule:
      '(dealSeed*1009 + ply*7919)>>>0, ply = public log length; same worlds per candidate',
    rowOrder: 'searched candidates of a decision in ascending candidate index (pass last)',
    champion: resolve(args.champion ?? DEFAULT_CHAMPION),
    belief: resolve(args.belief),
  };
  for (const key of ['block', 'lo', 'hi', 'worlds', 'k', 'net'])
    if (!Number.isInteger(protocol[key]) || protocol[key] < 0) throw Error(`--${key}`);
  if (protocol.block < 1 || protocol.worlds < 1 || protocol.k < 1)
    throw Error('--block/--worlds/--k');
  if (protocol.worlds > 127) throw Error('--worlds must fit the int8 win/loss column');
  if (protocol.lo > protocol.hi) throw Error('--lo must not exceed --hi');
  if (protocol.seeds[0] < 0 || protocol.seeds[1] > MAX_SEED)
    throw Error('Seeds must lie in [0, 2^32)');
  protocol.championSHA256 = sha256(protocol.champion);
  if (protocol.championSHA256 !== CHAMPION_SHA256 && args['allow-champion'] !== '1')
    throw Error(`Champion SHA-256 ${protocol.championSHA256} is not the frozen 017 copy`);
  protocol.beliefSHA256 = sha256(protocol.belief);
  const reportFile = resolve(
    args['belief-train-report'] ?? join(dirname(protocol.belief), 'train-report.json'),
  );
  if (!existsSync(reportFile)) throw Error(`No belief train report at ${reportFile}`);
  const ranges = trainingSeedRanges(JSON.parse(readFileSync(reportFile, 'utf8')));
  assertHeldOut(protocol.seeds, ranges);
  protocol.beliefTrainingSeeds = ranges;
  protocol.beliefTrainReport = reportFile;
  protocol.beliefTrainReportSHA256 = sha256(reportFile);
  protocol.sources = sourceClosure(SELF);
  return protocol;
}

/** Create run.json, or check that an existing one holds exactly the same protocol. */
export function prepareRun(out, args) {
  const protocol = buildDistillProtocol(args);
  const runFile = join(out, 'run.json');
  mkdirSync(out, { recursive: true });
  if (existsSync(runFile)) {
    const { startedAt: _ignored, ...frozen } = JSON.parse(readFileSync(runFile, 'utf8'));
    if (JSON.stringify(frozen) !== JSON.stringify(protocol)) {
      const differing = Object.keys({ ...frozen, ...protocol }).filter(
        (key) => JSON.stringify(frozen[key]) !== JSON.stringify(protocol[key]),
      );
      throw Error(`${out} holds a different protocol (${differing.join(', ')}); use a new --out`);
    }
  } else
    writeFileSync(
      runFile,
      JSON.stringify({ ...protocol, startedAt: new Date().toISOString() }, null, 2),
    );
  return protocol;
}

const parseArgs = (argv) =>
  Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const eq = a.indexOf('=');
        return eq < 0 ? [a.slice(2), '1'] : [a.slice(2, eq), a.slice(eq + 1)];
      }),
  );

async function worker(args) {
  const ort = await import('onnxruntime-node');
  const out = resolve(args.out);
  const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const part = Number(args.part),
    parts = Number(args.parts);
  const deadline = Number(args.deadline ?? Infinity);
  const stopFile = args['stop-file'] || null;
  const shouldStop = () => Date.now() >= deadline || (stopFile && existsSync(stopFile));
  const cfg = await createConfig(run, ort);
  const blocks = blocksOf(run.seeds, run.block);
  try {
    for (let i = part; i < blocks.length; i += parts) {
      const [start, end] = blocks[i];
      if (existsSync(join(out, `b${start}.json`))) continue;
      const seeds = Array.from({ length: end - start + 1 }, (_, k) => start + k);
      const block = await generateBlock(seeds, cfg, { shouldStop });
      if (!block) {
        process.stderr.write(`[w${part}] stop/deadline: block b${start} abandoned\n`);
        break;
      }
      writeBlock(out, [start, end], block, {
        part,
        settings: Object.fromEntries(
          ['lo', 'hi', 'worlds', 'k', 'net', 'tieBreak', 'worldsSource', 'searchTeams'].map((k) => [
            k,
            run[k],
          ]),
        ),
        beliefSHA256: run.beliefSHA256,
        championSHA256: run.championSHA256,
        sources: run.sources,
        writtenAt: new Date().toISOString(),
      });
      process.stderr.write(
        `[w${part}] b${start}: ${block.stats.rounds} rounds, ${block.stats.decisions} decisions, ` +
          `${block.rows} rows, ${block.stats.elapsedSeconds.toFixed(1)} s, ` +
          `rss ${Math.round(process.memoryUsage().rss / 2 ** 20)} MB\n`,
      );
    }
  } finally {
    await cfg.close();
  }
}

/** Totals over the completed blocks of a run directory. */
export function summarizeRun(out) {
  const metas = readdirSync(out)
    .filter((f) => /^b\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')));
  const sum = (key) => metas.reduce((s, m) => s + m.stats[key], 0);
  const rounds = sum('rounds'),
    busy = sum('elapsedSeconds');
  return {
    blocks: metas.length,
    rounds,
    decisions: sum('decisions'),
    rows: sum('rows'),
    chosenDiffersFromChampion: sum('chosenDiffersFromChampion'),
    decisionsPerRound: rounds ? sum('decisions') / rounds : null,
    rowsPerRound: rounds ? sum('rows') / rounds : null,
    bytesPerRow: BYTES_PER_ROW,
    roundsPerSecondPerWorker: busy ? rounds / busy : null,
    secondsPerRoundPerWorker: rounds ? busy / rounds : null,
    note: 'per-worker speed from block elapsed times (this and earlier invocations)',
  };
}

async function main(args) {
  if (!args.out) throw Error('--out=<dir>');
  const out = resolve(args.out);
  const protocol = prepareRun(out, args);
  const workers = Number(args.workers ?? 1);
  if (!Number.isInteger(workers) || workers < 1) throw Error('--workers');
  const deadline = args.minutes ? Date.now() + Number(args.minutes) * 60_000 : Infinity;
  const t0 = Date.now();
  await Promise.all(
    Array.from(
      { length: workers },
      (_, part) =>
        new Promise((done, fail) => {
          const child = spawn(
            'nice',
            [
              '-n',
              '10',
              process.execPath,
              '--no-warnings',
              SELF,
              '--worker',
              `--part=${part}`,
              `--parts=${workers}`,
              `--out=${out}`,
              `--deadline=${deadline}`,
              ...(args['stop-file'] ? [`--stop-file=${resolve(args['stop-file'])}`] : []),
            ],
            { stdio: 'inherit' },
          );
          child.on('exit', (code) =>
            code === 0 ? done() : fail(Error(`worker ${part} exit ${code}`)),
          );
        }),
    ),
  );
  const totalBlocks = blocksOf(protocol.seeds, protocol.block).length;
  const summary = {
    seeds: protocol.seeds,
    totalBlocks,
    ...summarizeRun(out),
    workers,
    wallSeconds: (Date.now() - t0) / 1000,
    beliefSHA256: protocol.beliefSHA256,
    championSHA256: protocol.championSHA256,
    finishedAt: new Date().toISOString(),
  };
  summary.complete = summary.blocks === totalBlocks;
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) {
  const args = parseArgs(process.argv.slice(2));
  (args.worker ? worker(args) : main(args)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
