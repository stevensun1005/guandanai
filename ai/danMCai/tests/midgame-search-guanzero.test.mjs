/**
 * --opponents=guanzero --opponent-model=<onnx> in ai/danMCai/belief/midgame-search.mjs (window 4,
 * plan section 8 item 7, B3; GuanZero is an evaluation-only opponent).
 *
 *   - protocol: the model is required, its SHA-256 recorded and checked, refused without guanzero;
 *   - parity: on the first 50 stored positions with a choice (ai/shared/fixtures/positions.json),
 *     the opponent scorer (web/src/ai/policy-inference.mjs inferPolicy, guanzero-v1 history) makes
 *     the same choice as the GuanZero evaluation harness (ai/guanzero/training/lib.mjs
 *     createInference, the session evaluate.mjs uses), with the same values; and every GuanZero
 *     decision of two played rounds is the harness's choice. B3_PARITY_OUT=<file> writes the record.
 * The model defaults to window 4's verified copy of bot-026 (guanzero-adp-io48-385979); override
 * with GZ_MODEL=<onnx>. Skipped when the model or champion 017 is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CHAMPION,
  GUANZERO_CONFIG,
  OPPONENTS,
  buildProtocol,
  createConfig,
  createGuanzeroScorer,
  playPair,
  summarize,
} from '../belief/midgame-search.mjs';
import { argmax, sha256 } from '../training/continuous/lib.mjs';

const GZ_MODEL =
  process.env.GZ_MODEL ??
  '/Users/stevensun/guandan-runtime.noindex/window4-20261110/inputs/bot-026.onnx';
const BOT_026_SHA256 = '21300c36c7c273b43274a83fa70dc62ce85be0cc84decc6dda2080548e0096b1';
const haveModel = existsSync(GZ_MODEL);
const haveChampion = existsSync(DEFAULT_CHAMPION);
const POSITIONS = new URL('../../shared/fixtures/positions.json', import.meta.url);
/** evaluate.mjs (match-rollout playMatch) choice: first maximum. */
const firstMax = (v) => Array.from(v).reduce((best, x, i) => (x > v[best] ? i : best), 0);

test('guanzero option: model required, SHA-256 recorded and checked, refused elsewhere', () => {
  assert.deepEqual(OPPONENTS, ['champion', 'search', 'guanzero']);
  assert.deepEqual(GUANZERO_CONFIG, {
    stateFeatures: 513,
    actionFeatures: 54,
    history: 'guanzero-v1',
  });
  const dir = mkdtempSync(join(tmpdir(), 'midgame-guanzero-'));
  try {
    const champion = join(dir, 'champion.onnx');
    writeFileSync(champion, 'champion bytes');
    const model = join(dir, 'bot.onnx');
    writeFileSync(model, 'guanzero bytes');
    const base = { start: '200', pairs: '10', champion, 'allow-champion': '1', mode: 'champion' };
    assert.throws(
      () => buildProtocol({ ...base, opponents: 'guanzero' }),
      /needs --opponent-model/,
    );
    const p = buildProtocol({ ...base, opponents: 'guanzero', 'opponent-model': model });
    assert.equal(p.opponents, 'guanzero');
    assert.equal(p.opponentModelSHA256, sha256(model));
    assert.deepEqual(p.opponentConfig, GUANZERO_CONFIG);
    assert.match(p.opponentsRule, /evaluation-only/);
    assert.match(p.purpose, /GuanZero export/);
    assert.equal(
      buildProtocol({
        ...base,
        opponents: 'guanzero',
        'opponent-model': model,
        'opponent-sha256': sha256(model),
      }).opponentModelSHA256,
      sha256(model),
    );
    assert.throws(
      () =>
        buildProtocol({
          ...base,
          opponents: 'guanzero',
          'opponent-model': model,
          'opponent-sha256': '0'.repeat(64),
        }),
      /is not --opponent-sha256/,
    );
    for (const opponents of ['champion', 'search'])
      assert.throws(
        () => buildProtocol({ ...base, opponents, 'opponent-model': model }),
        /only used with --opponents=guanzero/,
      );
    // Default runs carry no opponent-model fields.
    const plain = buildProtocol(base);
    assert.ok(!('opponentModel' in plain) && !('opponentModelSHA256' in plain));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'parity: 50 stored positions and two played rounds, choices identical to the evaluation harness',
  {
    skip: !(haveModel && haveChampion) && 'GuanZero model or champion 017 missing',
    timeout: 600_000,
  },
  async () => {
    const ort = await import('onnxruntime-node');
    const { createInference } = await import('../../guanzero/training/lib.mjs');
    const modelSHA256 = sha256(GZ_MODEL);
    if (!process.env.GZ_MODEL) assert.equal(modelSHA256, BOT_026_SHA256);
    const scorer = await createGuanzeroScorer(ort, GZ_MODEL);
    const harness = await createInference();
    await harness.load(GZ_MODEL);
    const record = { positions: [], rounds: [] };
    try {
      const positions = JSON.parse(readFileSync(POSITIONS, 'utf8'))
        .map((state, index) => ({ state, index }))
        .filter(({ state }) => state.actions.length > 1)
        .slice(0, 50);
      assert.equal(positions.length, 50);
      let maxAbs = 0;
      for (const { state, index } of positions) {
        const mine = await scorer.values(state);
        const theirs = await harness.values(state);
        assert.equal(mine.length, theirs.length);
        let diff = 0;
        for (let i = 0; i < mine.length; i++) diff = Math.max(diff, Math.abs(mine[i] - theirs[i]));
        maxAbs = Math.max(maxAbs, diff);
        assert.equal(argmax(mine), firstMax(theirs), `position ${index}`);
        record.positions.push({
          fixtureIndex: index,
          candidates: mine.length,
          choice: argmax(mine),
          harnessChoice: firstMax(theirs),
          maxAbsValueDifference: diff,
        });
      }
      assert.ok(maxAbs <= 1e-6, `values differ by ${maxAbs}`);
      record.maxAbsValueDifference = maxAbs;
      // In play: every GuanZero decision of one deal pair (champion focal team) is the harness's.
      const protocol = buildProtocol({
        start: '4291000000',
        pairs: '1',
        mode: 'champion',
        opponents: 'guanzero',
        'opponent-model': GZ_MODEL,
      });
      const cfg = await createConfig(protocol, ort);
      const real = cfg.opponentNet;
      let checked = 0;
      cfg.opponentNet = {
        async values(state) {
          const mine = await real.values(state);
          assert.equal(argmax(mine), firstMax(await harness.values(state)), 'in-game decision');
          checked++;
          return mine;
        },
      };
      try {
        const pair = await playPair(4_291_000_000, cfg);
        for (const side of ['a', 'b']) {
          const opp = pair[side].opp;
          assert.ok(opp.gzDecisions > 0);
          assert.ok(opp.gzFinishingDeclined <= opp.gzFinishingAvailable);
          assert.ok(!('searched' in opp), 'no search counters for GuanZero seats');
          record.rounds.push({ seed: pair.seed, side, points: pair[side].points, ...opp });
        }
        assert.equal(checked, pair.a.opp.gzDecisions + pair.b.opp.gzDecisions);
        const summary = summarize([pair]);
        assert.equal(summary.opponents.gzDecisions, checked);
        record.inGameDecisionsChecked = checked;
      } finally {
        await cfg.close(); // closes the real scorer (createConfig's closure)
      }
      if (process.env.B3_PARITY_OUT)
        writeFileSync(
          process.env.B3_PARITY_OUT,
          JSON.stringify(
            {
              test: 'B3 GuanZero opponent parity: midgame-search createGuanzeroScorer (web inferPolicy, guanzero-v1) vs ai/guanzero/training/lib.mjs createInference (evaluate.mjs session)',
              pass: true,
              model: GZ_MODEL,
              modelSHA256,
              fixture:
                'ai/shared/fixtures/positions.json (first 50 positions with more than one candidate)',
              positionsCompared: record.positions.length,
              choicesIdentical: record.positions.filter((p) => p.choice === p.harnessChoice).length,
              maxAbsValueDifference: record.maxAbsValueDifference,
              inGameDecisionsChecked: record.inGameDecisionsChecked,
              inGameSeed: 4_291_000_000,
              inGameSeedNote: 'window-3 S1 parity seed (already used; parity only, no evidence)',
              positions: record.positions,
              rounds: record.rounds,
              writtenAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
    } finally {
      await scorer.close();
      await harness.close();
    }
  },
);
