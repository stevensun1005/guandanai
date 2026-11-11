/**
 * Search actor --history=1 (window 5 plan section 8 item 1; ai/danMCai/training/continuous/
 * search-actor.mjs), on one deal:
 *   - x, y and e are identical to --history=0 (the played log must also be identical; with
 *     --endgame=none the round is deterministic, with --endgame=pimc the solver budget is
 *     wall-clock, so that comparison is made only when both runs played the same log);
 *   - every h row equals GuanZero's history() recomputed from the round log at that ply;
 *   - band codes are consistent with the cards in hands vs lo / hi / endgameHi, and the meta cards
 *     byte equals 108 minus the cards played before that ply;
 *   - y on band-searched and endgame rows (in fact on every row) equals the mover team's signed
 *     whole-round points (plan C6);
 *   - 3 rows match the independent ai/guanzero/training/history_reference.py;
 *   - the shard json says schema 2, historyFeatures 1080, metaFeatures 3 and done.json lists the
 *     SHA-256 of the h and m sidecars; --history=0 leaves the schema-1 file set unchanged.
 * Seeds: window-3 S1 seeds 4291000000+ (already used; parity only, no evidence).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CHAMPION } from '../belief/midgame-search.mjs';
import { history } from '../../guanzero/training/history.mjs';
import {
  BAND,
  HISTORY_FEATURES,
  META_FEATURES,
  EXTRAS,
  buildActorProtocol,
  createActorConfig,
  runBlock,
} from '../training/continuous/search-actor.mjs';
import { FEATURES, TARGETS, sha256 } from '../training/continuous/lib.mjs';

const BELIEF_V1 = '/Users/stevensun/guandan-runtime.noindex/window1-20261109/H/model/belief.onnx';
const SEED = 4_291_000_020;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ACTOR = fileURLToPath(new URL('../training/continuous/search-actor.mjs', import.meta.url));
const REFERENCE = fileURLToPath(
  new URL('../../guanzero/training/history_reference.py', import.meta.url),
);
const haveModels = existsSync(DEFAULT_CHAMPION) && existsSync(BELIEF_V1);
const skip = !haveModels && 'champion 017 or belief v1 missing';
const SHARD = 'b000000-000000000';
const idsLog = (log) => log.map((e) => ({ p: e.p, cards: e.cards?.map((c) => c.id) ?? null }));
const playedLog = (log) => JSON.stringify(idsLog(log));

async function actorConfig(extra = {}) {
  const ort = await import('onnxruntime-node');
  const protocol = buildActorProtocol({
    start: String(SEED),
    rounds: '1',
    belief: BELIEF_V1,
    rows: 'all',
    ...extra,
  });
  return createActorConfig(protocol, ort);
}

/** Plays the deal as a one-round block in `dir`; returns the record, the round and the files. */
async function playBlock(dir, extra) {
  const cfg = await actorConfig(extra);
  try {
    const run = { ...cfg, start: SEED, rounds: 1, blockRounds: 1 };
    const rounds = [];
    const record = await runBlock(
      dir,
      run,
      cfg,
      0,
      () => false,
      (r) => rounds.push(r),
    );
    assert.equal(rounds.length, 1);
    const block = join(dir, 'blocks', 'b000000');
    const read = (ext) => readFileSync(join(block, `${SHARD}.${ext}`));
    const files = readdirSync(block).sort();
    return {
      cfg,
      block,
      record,
      round: rounds[0],
      files,
      json: JSON.parse(read('json').toString('utf8')),
      x: read('x.i8'),
      y: read('y.f32'),
      e: read('e.f32'),
      h: files.includes(`${SHARD}.h.i8`) ? read('h.i8') : null,
      m: files.includes(`${SHARD}.m.u8`) ? read('m.u8') : null,
    };
  } finally {
    await cfg.close();
  }
}

function findPython() {
  const roots = [REPO];
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  if (common.status === 0) roots.push(dirname(common.stdout.trim()));
  const candidates = [
    process.env.DANMCAI_PYTHON,
    ...roots.map((root) => join(root, 'ai/danMCai/environment/mac/bin/python')),
    'python3',
  ].filter(Boolean);
  for (const python of candidates) {
    const probe = spawnSync(python, ['-c', 'import json'], { timeout: 30_000 });
    if (probe.status === 0) return python;
  }
  return null;
}

test('protocol: --history is off by default, 0|1 only, uint8 round index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'search-actor-history-protocol-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'champion bytes');
    const belief = join(dir, 'belief.onnx');
    writeFileSync(belief, 'belief bytes');
    const base = {
      start: '4290400000',
      rounds: '300',
      champion,
      'allow-champion': '1',
      belief,
      'belief-train-report': 'none',
    };
    const off = buildActorProtocol(base);
    for (const key of ['history', 'historyFeatures', 'metaFeatures', 'historyEncoding'])
      assert.equal(off[key], undefined, key);
    assert.deepEqual(buildActorProtocol({ ...base, history: '0' }), off);
    const on = buildActorProtocol({ ...base, rows: 'all', history: '1' });
    assert.equal(on.history, 1);
    assert.equal(on.historyFeatures, HISTORY_FEATURES);
    assert.equal(on.metaFeatures, META_FEATURES);
    assert.match(on.historyEncoding, /history\.mjs/);
    assert.equal(HISTORY_FEATURES, 1080);
    assert.equal(META_FEATURES, 3);
    assert.throws(() => buildActorProtocol({ ...base, history: '2' }), /--history/);
    assert.throws(
      () => buildActorProtocol({ ...base, history: '1', 'block-rounds': '300' }),
      /block-rounds/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'one deal: x/y/e as --history=0, h = history() at the ply, bands, whole-round y, reference',
  { skip, timeout: 900_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-actor-history-'));
    try {
      // 1. Identity with --history=0 on the deterministic path (--endgame=none).
      const none1 = await playBlock(join(dir, 'none-1'), { endgame: 'none', history: '1' });
      const none0 = await playBlock(join(dir, 'none-0'), { endgame: 'none' });
      assert.equal(playedLog(none1.round.log), playedLog(none0.round.log), 'endgame none log');
      for (const ext of ['x', 'y', 'e']) assert.ok(none1[ext].equals(none0[ext]), `none ${ext}`);
      assert.deepEqual(none0.files, [
        `${SHARD}.e.f32`,
        `${SHARD}.json`,
        `${SHARD}.x.i8`,
        `${SHARD}.y.f32`,
      ]);
      assert.equal(none0.json.schema, 1);
      for (const key of ['historyFeatures', 'metaFeatures'])
        assert.equal(none0.json[key], undefined);
      assert.equal(none0.record.schema, undefined);
      assert.equal(none0.record.rowsByBand, undefined);

      // 2. The full C2 configuration: --endgame=pimc, --rows=all, --history=1, exploration 0.02.
      const pimc1 = await playBlock(join(dir, 'pimc-1'), { history: '1' });
      const pimc0 = await playBlock(join(dir, 'pimc-0'), {});
      const sameLog = playedLog(pimc1.round.log) === playedLog(pimc0.round.log);
      if (sameLog)
        for (const ext of ['x', 'y', 'e']) assert.ok(pimc1[ext].equals(pimc0[ext]), `pimc ${ext}`);
      else
        console.log(
          '# pimc runs played different logs (wall-clock solver budget); x/y/e equality checked on --endgame=none only',
        );

      const checked = { [BAND.above]: 0, [BAND.band]: 0, [BAND.endgame]: 0 };
      const samples = [];
      for (const { label, run } of [
        { label: 'none', run: none1 },
        { label: 'pimc', run: pimc1 },
      ]) {
        const { round, cfg, block, json, record, files, x, y, e, h, m } = run;
        const n = round.rows.length;
        assert.ok(n > 0);
        assert.deepEqual(files, [
          `${SHARD}.e.f32`,
          `${SHARD}.h.i8`,
          `${SHARD}.json`,
          `${SHARD}.m.u8`,
          `${SHARD}.x.i8`,
          `${SHARD}.y.f32`,
        ]);
        for (const file of files) assert.equal(record.files[file], sha256(join(block, file)), file);
        assert.equal(json.schema, 2);
        assert.equal(json.historyFeatures, HISTORY_FEATURES);
        assert.equal(json.metaFeatures, META_FEATURES);
        assert.equal(json.extraFeatures, EXTRAS);
        assert.equal(json.rows, n);
        assert.equal(record.schema, 2);
        assert.equal(x.length, n * FEATURES);
        assert.equal(y.length, n * TARGETS * 4);
        assert.equal(e.length, n * EXTRAS * 4);
        assert.equal(h.length, n * HISTORY_FEATURES);
        assert.equal(m.length, n * META_FEATURES);
        const hRows = new Int8Array(h.buffer, h.byteOffset, h.length);
        const yRows = new Float32Array(y.buffer.slice(y.byteOffset, y.byteOffset + y.length));
        const log = idsLog(round.log);
        const { winner, points } = round.result;
        assert.ok([1, 2, 3].includes(points));
        const byBand = [0, 0, 0];
        for (let i = 0; i < n; i++) {
          const row = round.rows[i];
          const at = `${label} row ${i} ply ${row.ply}`;
          // h: history() of the public log before the action, recomputed independently.
          const expected = history({ log: log.slice(0, row.ply) });
          const got = hRows.subarray(i * HISTORY_FEATURES, (i + 1) * HISTORY_FEATURES);
          assert.deepEqual(Array.from(got), Array.from(expected), `${at} history`);
          assert.ok(
            got.every((v) => v >= -1 && v <= 2),
            `${at} history range`,
          );
          // m: [round index in block, band, cards in hands].
          const [roundIndex, band, cards] = m.subarray(i * META_FEATURES, (i + 1) * META_FEATURES);
          assert.equal(roundIndex, 0, at);
          const played = log
            .slice(0, row.ply)
            .reduce((s, entry) => s + (entry.cards?.length ?? 0), 0);
          assert.equal(cards, 108 - played, `${at} cards`);
          if (cards > cfg.hi) assert.equal(band, BAND.above, `${at} band above`);
          else if (cfg.endgame === 'pimc' && cards <= cfg.endgameHi)
            assert.equal(band, BAND.endgame, `${at} band endgame`);
          else {
            assert.ok(cards >= cfg.lo && cards <= cfg.hi, `${at} in the band`);
            assert.equal(band, BAND.band, `${at} band search`);
          }
          byBand[band]++;
          // y: the mover team's signed whole-round points (C6), then sign, round 0 of 1.
          const mover = log[row.ply].p;
          assert.equal(round.log[row.ply].p, mover);
          const signed = (mover % 2 === winner ? 1 : -1) * points;
          assert.deepEqual(
            Array.from(yRows.subarray(i * TARGETS, (i + 1) * TARGETS)),
            [signed, Math.sign(signed), 0, 1],
            `${at} y`,
          );
          checked[band]++;
        }
        assert.deepEqual(record.rowsByBand, byBand, `${label} rowsByBand`);
        if (label === 'pimc') {
          assert.ok(byBand[BAND.band] > 0, 'band-searched rows');
          assert.ok(byBand[BAND.endgame] > 0, 'endgame rows');
          // Three rows (one per band) for the independent Python reference.
          for (const band of [BAND.above, BAND.band, BAND.endgame]) {
            const i = round.rows.findIndex((r) => r.band === band);
            samples.push({
              log: log.slice(0, round.rows[i].ply),
              h: Array.from(hRows.subarray(i * HISTORY_FEATURES, (i + 1) * HISTORY_FEATURES)),
            });
          }
        } else assert.equal(byBand[BAND.endgame], 0, 'no endgame rows with --endgame=none');
      }
      assert.ok(checked[BAND.band] > 0 && checked[BAND.endgame] > 0);

      // 3. Three rows against history_reference.py (stdlib only).
      const python = findPython();
      if (!python) {
        console.log('# no python found; history_reference.py comparison skipped');
        return;
      }
      const input = join(dir, 'reference-input.json');
      writeFileSync(input, JSON.stringify(samples.map((s) => ({ log: s.log }))));
      const script =
        'import json, sys; sys.path.insert(0, sys.argv[1]); ' +
        'from history_reference import history; ' +
        'print(json.dumps([history(s) for s in json.load(open(sys.argv[2]))]))';
      const out = execFileSync(python, ['-I', '-c', script, dirname(REFERENCE), input], {
        encoding: 'utf8',
      });
      const reference = JSON.parse(out);
      assert.equal(reference.length, 3);
      reference.forEach((row, i) => assert.deepEqual(row, samples[i].h, `reference row ${i}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'CLI: --history=1 run.json and manifest.json (schema 2, rows per band)',
  { skip, timeout: 300_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'search-actor-history-cli-'));
    try {
      const out = join(dir, 'run');
      const printed = JSON.parse(
        execFileSync(
          process.execPath,
          [
            ACTOR,
            `--out=${out}`,
            `--start=${SEED + 1}`,
            '--rounds=1',
            '--block-rounds=1',
            '--policy=raw',
            '--history=1',
            `--belief=${BELIEF_V1}`,
            '--minutes=5',
            `--stop-file=${join(dir, 'STOP')}`,
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ),
      );
      assert.equal(printed.schema, 2);
      assert.equal(printed.historyFeatures, HISTORY_FEATURES);
      assert.equal(printed.finishedRounds, 1);
      assert.equal(printed.rowsByBand[0], printed.rowsTotal);
      assert.deepEqual(printed.rowsByBand.slice(1), [0, 0]);
      const run = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'));
      assert.equal(run.history, 1);
      assert.ok(run.sources['ai/guanzero/training/history.mjs']);
      assert.ok(run.sources['web/src/ai/encoding.mjs']);
      const done = JSON.parse(readFileSync(join(out, 'blocks', 'b000000.done.json'), 'utf8'));
      for (const ext of ['h.i8', 'm.u8'])
        assert.equal(
          done.files[`${SHARD}.${ext}`],
          sha256(join(out, 'blocks', 'b000000', `${SHARD}.${ext}`)),
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
