/**
 * Hand-inference training data: champion-greedy self-play of single fresh rounds.
 *
 * Every seat plays the frozen champion greedily (finishing move first, a single candidate is
 * automatic, otherwise argmax of the champion's values), as in endgame/evaluate.mjs. At each turn
 * whose table total (cards left in all four hands) lies in the band, eligible turns are subsampled
 * deterministically (`every`), and one row is written: the mover's public-view features
 * (features.mjs) and, as the supervised TARGET only, how many unseen copies of each face each other
 * seat holds. The real hidden hands never enter the features.
 *
 *   node ai/danMCai/belief/generate.mjs --seeds=a..b --out=<dir> [--band=21-80] [--every=1]
 *        [--champion=<onnx>] [--workers=1] [--block=50]
 *
 * Output (resumable by seed block; a block is done once its .json exists):
 *   run.json                      frozen protocol (refuses to resume with a different one)
 *   b<start>.x.u8                 rows x FEATURES uint8 features
 *   b<start>.y.u8                 rows x 162 uint8 target (face * 3 + r - 1)
 *   b<start>.m.u32                rows x 4 uint32 (seed, ply, mover, cards on table); seeds must
 *                                 lie in [0, 2^32) so the development range (> 2^31) is stored exactly
 *   b<start>.json                 block meta (seeds, rows, decisions, elapsed)
 *   summary.json                  totals and speed when all blocks finish
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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRound, advanceRound, seededRandom } from '../../shared/simulation/simulation.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { policyState } from '../../../web/src/ai/observation.js';
import {
  FEATURES,
  FEATURE_VERSION,
  LAYOUT,
  TARGETS,
  features,
  hiddenTarget,
  publicView,
} from './features.mjs';

export const DEFAULT_CHAMPION =
  '/Users/stevensun/guandan-runtime.noindex/endgame-oracle-20261108-r2/models/champion.onnx';
export const CHAMPION_SHA256 = '462afc99ee6bcfb788871d7a8f84d4298c008d57465c62d48ca1792cdb11b3f7';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
export const onTable = (game) => game.hands.reduce((sum, hand) => sum + hand.length, 0);

/** "a..b" (inclusive; commas/underscores allowed) -> [a, b]. */
export function parseRange(text, label = 'range') {
  const match = /^([\d,_]+)(?:\.\.|-)([\d,_]+)$/.exec(String(text).trim());
  if (!match) throw Error(`Invalid ${label}: ${text}`);
  const [a, b] = [match[1], match[2]].map((s) => Number(s.replace(/[,_]/g, '')));
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a)
    throw Error(`Invalid ${label}: ${text}`);
  return [a, b];
}

/** Largest seed the uint32 shard metadata can store exactly. */
export const MAX_SEED = 2 ** 32 - 1;

/**
 * Greedy champion choice (index) over candidates, given a values(state) function. With a
 * temperature, the softmax draw is reseeded at the start of every round from (seed, round seed) by
 * playRecordedRound, so the data never depends on how seed blocks were split across workers.
 */
export function championChooser(values, { temperature = 0, seed = 0 } = {}) {
  let random = seededRandom(seed);
  const choose = async (game, plays) => {
    const player = game.turn;
    let index = plays.findIndex((play) => play && play.cards.length === game.hands[player].length);
    if (index >= 0) return index;
    if (plays.length === 1) return 0;
    const v = Array.from(await values(policyState(game, player, 0, plays)));
    if (v.length !== plays.length || !v.every(Number.isFinite))
      throw Error('Champion returned invalid action values');
    if (!(temperature > 0)) return v.indexOf(Math.max(...v));
    const max = Math.max(...v),
      w = v.map((x) => Math.exp((x - max) / temperature)),
      total = w.reduce((a, b) => a + b, 0);
    let u = random() * total;
    for (let i = 0; i < w.length; i++) if ((u -= w[i]) <= 0) return i;
    return w.length - 1;
  };
  choose.startRound = (roundSeed) => {
    random = seededRandom((Math.imul(seed | 0, 0x9e3779b1) ^ roundSeed) | 0);
  };
  return choose;
}

/**
 * Play one fresh round, calling onTurn(game, view, ply) at every eligible, subsampled turn before
 * the move is chosen. `band` is [lo, hi] cards on the table, inclusive.
 */
export async function playRecordedRound(seed, { choose, band = [21, 80], every = 1, onTurn }) {
  const game = createRound(seed);
  choose.startRound?.(seed);
  let eligible = 0;
  for (let ply = 0; ply < 1000; ply++) {
    const player = game.turn;
    const table = onTable(game);
    if (table >= band[0] && table <= band[1] && eligible++ % every === 0)
      await onTurn(game, publicView(game, player), ply);
    const plays = candidates(game.hands[player], game.L, game.trick?.play);
    if (!plays.length) throw Error('No legal actions');
    const result = advanceRound(game, plays[await choose(game, plays)]);
    if (result) return { result, plies: ply + 1 };
  }
  throw Error('Round did not terminate');
}

/** Generate one seed block into rows (in memory). */
export async function generateBlock(seeds, { choose, band, every }) {
  const xs = [],
    ys = [],
    ms = [];
  let plies = 0;
  for (const seed of seeds) {
    const round = await playRecordedRound(seed, {
      choose,
      band,
      every,
      onTurn(game, view, ply) {
        xs.push(features(view));
        ys.push(hiddenTarget(game, view.p));
        ms.push([seed, ply, view.p, onTable(game)]);
      },
    });
    plies += round.plies;
  }
  const rows = xs.length,
    x = new Uint8Array(rows * FEATURES),
    y = new Uint8Array(rows * TARGETS),
    m = new Uint32Array(rows * 4);
  for (let i = 0; i < rows; i++) {
    if (!(ms[i][0] >= 0 && ms[i][0] <= MAX_SEED)) throw Error('Seed outside the uint32 meta range');
    x.set(xs[i], i * FEATURES);
    y.set(ys[i], i * TARGETS);
    m.set(ms[i], i * 4);
  }
  return { rows, x, y, m, plies };
}

function atomicWrite(file, data) {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

export function writeBlock(dir, start, end, block, extra = {}) {
  const name = join(dir, `b${start}`);
  atomicWrite(`${name}.x.u8`, block.x);
  atomicWrite(`${name}.y.u8`, block.y);
  atomicWrite(`${name}.m.u32`, Buffer.from(block.m.buffer, block.m.byteOffset, block.m.byteLength));
  const meta = {
    featureVersion: FEATURE_VERSION,
    features: FEATURES,
    targets: TARGETS,
    seeds: [start, end],
    rows: block.rows,
    plies: block.plies,
    ...extra,
  };
  atomicWrite(`${name}.json`, JSON.stringify(meta));
  return meta;
}

export function blocksOf([a, b], size) {
  const out = [];
  for (let s = a; s <= b; s += size) out.push([s, Math.min(b, s + size - 1)]);
  return out;
}

async function worker() {
  const ort = await import('onnxruntime-node');
  const { createModelPool } = await import('../training/continuous/lib.mjs');
  const out = option('out'),
    run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
  const part = Number(option('part')),
    parts = Number(option('parts'));
  const pool = await createModelPool(ort, { threads: 1, limit: 1 });
  const choose = championChooser((state) => pool.values(run.champion, state), {
    temperature: run.temperature,
  });
  const blocks = blocksOf(run.seeds, run.block);
  for (let i = part; i < blocks.length; i += parts) {
    const [start, end] = blocks[i];
    if (existsSync(join(out, `b${start}.json`))) continue;
    const t0 = Date.now();
    const seeds = Array.from({ length: end - start + 1 }, (_, k) => start + k);
    const block = await generateBlock(seeds, { choose, band: run.band, every: run.every });
    writeBlock(out, start, end, block, { elapsedMs: Date.now() - t0, part });
  }
  await pool.close();
}

async function main() {
  const { sha256 } = await import('../training/continuous/lib.mjs');
  const out = resolve(option('out'));
  mkdirSync(out, { recursive: true });
  const champion = resolve(option('champion', DEFAULT_CHAMPION));
  const championSHA256 = sha256(champion);
  const protocol = {
    featureVersion: FEATURE_VERSION,
    features: FEATURES,
    targets: TARGETS,
    layout: LAYOUT,
    seeds: parseRange(option('seeds'), 'seeds'),
    band: parseRange(option('band', '21-80'), 'band'),
    every: Number(option('every', 1)),
    block: Number(option('block', 50)),
    temperature: Number(option('temperature', 0)),
    champion,
    championSHA256,
    policy:
      'champion for all four seats (finishing move first, single candidate automatic); greedy at temperature 0, else softmax reseeded per round',
    metaFormat: 'm.u32: seed, ply, mover, cards on table',
  };
  if (!(protocol.every >= 1) || !(protocol.block >= 1)) throw Error('Invalid --every or --block');
  if (protocol.seeds[0] < 0 || protocol.seeds[1] > MAX_SEED)
    throw Error('Seeds must lie in [0, 2^32) for the uint32 shard metadata');
  const runFile = join(out, 'run.json');
  if (existsSync(runFile)) {
    const old = JSON.parse(readFileSync(runFile, 'utf8'));
    const { startedAt: _ignored, ...frozen } = old;
    if (JSON.stringify(frozen) !== JSON.stringify(protocol))
      throw Error('Existing run.json has a different protocol; use a new --out');
  } else
    writeFileSync(runFile, JSON.stringify({ ...protocol, startedAt: new Date().toISOString() }));
  const workers = Number(option('workers', 1));
  const self = fileURLToPath(import.meta.url);
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
              self,
              '--worker',
              `--part=${part}`,
              `--parts=${workers}`,
              `--out=${out}`,
            ],
            { stdio: 'inherit' },
          );
          child.on('exit', (code) =>
            code === 0 ? done() : fail(Error(`worker ${part} exit ${code}`)),
          );
        }),
    ),
  );
  const metas = readdirSync(out)
    .filter((f) => /^b\d+\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')));
  const rows = metas.reduce((n, m) => n + m.rows, 0),
    busyMs = metas.reduce((n, m) => n + (m.elapsedMs || 0), 0);
  const summary = {
    ...protocol,
    blocks: metas.length,
    rounds: metas.reduce((n, m) => n + m.seeds[1] - m.seeds[0] + 1, 0),
    rows,
    plies: metas.reduce((n, m) => n + m.plies, 0),
    workers,
    wallSeconds: (Date.now() - t0) / 1000,
    rowsPerSecondPerProcess: busyMs ? rows / (busyMs / 1000) : null,
    note: 'rowsPerSecondPerProcess uses each block elapsed time of this invocation and earlier resumed blocks',
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (process.argv.includes('--worker') ? worker() : main()).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
