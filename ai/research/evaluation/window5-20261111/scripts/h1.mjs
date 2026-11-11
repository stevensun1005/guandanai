/**
 * Window 5, H1 (PLAN section 4; window 4's h1.mjs reading ONLY the stripped privacy copy
 * RT/inputs/human-research made by strip_human.mjs, review R7): belief v1 and v2a log loss per unseen copy on the 1,458 unassisted
 * human positions vs the uniform baseline. DESCRIPTIVE ONLY; aggregates only (no nickname, room,
 * record id, match id, file name or raw row is written).
 *
 * Reuses the S7 scorer (ai/danMCai/belief/panel-scorer.mjs, = window-3 S7/scorer.mjs minus its
 * Desktop-fallback defaults; every input is passed explicitly here): scorePanel() replays the
 * private records exactly as S7 did and gives, per unassisted real decision, the belief network's
 * log likelihood of the true hidden hands on the mover's public view and the uniform baseline's
 * (row.belief = {copies, ll, llUniform}); the blocks below are S7's beliefBlock (same bands, same
 * round-cluster bootstrap: clusterBootstrap, 2,000 draws, seed 20261110). Added: the paired
 * difference v2a minus v1 per copy on the same positions (round-cluster bootstrap).
 *
 *   node h1.mjs --scorer=<panel-scorer.mjs> --champion=<017 onnx> --raw=<dir>,<dir>
 *     --belief=v1=<onnx>[,v2a=<onnx>] --out=<json> [--reference-out=<json>] [--manifest=<human-research/manifest.json>]
 *     [--deadline=<ISO>] [--stop-file=<a>,<b>] [--expect=1458]
 * --out gets the full report; its top level also carries the dashboard 'metrics' shape for the
 * primary lane (v2a when given, else v1); --reference-out gets v1 in that shape.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const scorerFile = resolve(option('scorer'));
const S = await import(pathToFileURL(scorerFile).href);
const champion = resolve(option('champion'));
const raw = option('raw', '').split(',').filter(Boolean);
const lanes = option('belief', '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    const i = s.indexOf('=');
    return { label: s.slice(0, i), path: resolve(s.slice(i + 1)) };
  });
const out = resolve(option('out'));
const refOut = option('reference-out', null);
const manifestFile = option('manifest', null);
const deadline = option('deadline', null) ? Date.parse(option('deadline')) : null;
const stopFiles = option('stop-file', '').split(',').filter(Boolean);
const expect = Number(option('expect', 1458));
if (!lanes.length || !raw.length) throw Error('--belief and --raw are required');

const band = (total) =>
  total > 80 ? '>80' : total > 60 ? '61-80' : total > 40 ? '41-60' : total > 20 ? '21-40' : '<=20';
const BANDS = ['>80', '61-80', '41-60', '21-40', '<=20'];
const beliefBlock = (rows) => {
  const copies = rows.reduce((s, r) => s + r.copies, 0);
  const ll = rows.reduce((s, r) => s + r.ll, 0),
    lu = rows.reduce((s, r) => s + r.llUniform, 0);
  return {
    positions: rows.length,
    copies,
    beliefLogLossPerCopy: copies ? -ll / copies : null,
    uniformLogLossPerCopy: copies ? -lu / copies : null,
    differenceBeliefMinusUniform: copies ? (lu - ll) / copies : null,
    ci95: S.clusterBootstrap(rows, ['copies', 'll', 'llUniform'], (t) =>
      t.copies ? (t.llUniform - t.ll) / t.copies : NaN,
    ),
  };
};
const pairedBlock = (rows) => {
  const copies = rows.reduce((s, r) => s + r.copies, 0);
  const a = rows.reduce((s, r) => s + r.llA, 0),
    b = rows.reduce((s, r) => s + r.llB, 0);
  return {
    positions: rows.length,
    copies,
    v2aMinusV1LogLossPerCopy: copies ? (a - b) / copies : null,
    ci95: S.clusterBootstrap(rows, ['copies', 'llA', 'llB'], (t) =>
      t.copies ? (t.llA - t.llB) / t.copies : NaN,
    ),
  };
};

const started = Date.now();
const result = {
  stage: 'H1',
  window: 'window5-20261111',
  input: 'RT/inputs/human-research (room, nicknames and seat labels removed; strip_human.mjs manifest)',
  kind: 'descriptive only, not a gate, not acceptance, not a win rate',
  generatedAt: null,
  privacy:
    'aggregates only; no nickname, room, record id, match id, file name or raw row; positions not listed',
  scorer: { file: scorerFile, sha256: sha256(scorerFile), use: 'scorePanel() belief rows (S7 belief section)' },
  what:
    'log loss per unseen copy of the belief network on the mover public view at the unassisted human real decisions (truth = the recorded hands) vs the uniform baseline; difference < 0 = better than uniform; round-cluster bootstrap 2,000 draws',
  selfPlayReference: { v1: 0.793, uniform: 0.976, note: 'champion self-play validation of v1 (window 1)' },
  window3Reference: { v1: 0.9363, uniform: 1.0305, positions: 1458, note: 'window-3 S7 panel.json belief.all' },
  trainingRangeNote:
    'v1 trained on 21-80 cards, v2a on 21-80 plus 41-108 (single level-2 rounds without tribute, champion self-play); human rounds include other levels, tribute and > 80 cards',
  lanes: {},
};
const rowsBy = {};
let records = null;
for (const lane of lanes) {
  const t0 = Date.now();
  const scored = await S.scorePanel({
    raw,
    belief: lane.path,
    models: [{ label: '017', path: champion }],
    solverRows: null,
    s7aRows: null,
    deadline,
    stopFiles,
  });
  const rows = scored.decisions.map((r) => ({
    pos: r.pos,
    cluster: r.cluster,
    total: r.total,
    ...r.belief,
  }));
  rowsBy[lane.label] = rows;
  if (!records) {
    // the stripped copies registered in the window-3 S7 panel (by their ORIGINAL file's SHA-256)
    const registered =
      manifestFile && existsSync(manifestFile)
        ? new Set(JSON.parse(readFileSync(manifestFile, 'utf8')).files.filter((f) => f.registeredInPanel).map((f) => f.sha256))
        : null;
    records = {
      rounds: scored.sources.length,
      registeredInPanel: registered ? scored.sources.filter((s) => registered.has(s.sha256)).length : null,
      trust: 'unverified_browser',
    };
  }
  result.lanes[lane.label] = {
    model: scored.beliefInfo,
    seconds: (Date.now() - t0) / 1000,
    all: beliefBlock(rows),
    trainingBand21to80: beliefBlock(rows.filter((r) => r.total >= 21 && r.total <= 80)),
    byBand: Object.fromEntries(BANDS.map((b) => [b, beliefBlock(rows.filter((r) => band(r.total) === b))])),
  };
}
result.records = records;
const counts = Object.fromEntries(Object.entries(rowsBy).map(([k, v]) => [k, v.length]));
result.positions = { expected: expect, scored: counts, allEqualExpected: Object.values(counts).every((n) => n === expect) };
if (rowsBy.v1 && rowsBy.v2a) {
  const a = new Map(rowsBy.v1.map((r) => [r.pos, r]));
  const paired = [];
  for (const r of rowsBy.v2a) {
    const x = a.get(r.pos);
    if (!x || x.copies !== r.copies || x.total !== r.total) throw Error('v1 and v2a positions differ');
    paired.push({ cluster: r.cluster, total: r.total, copies: r.copies, llA: x.ll, llB: r.ll });
  }
  result.pairedV2aMinusV1 = {
    note: 'v2a log loss minus v1 log loss per copy on the same positions (< 0 = v2a better); round-cluster bootstrap',
    all: pairedBlock(paired),
    trainingBand21to80: pairedBlock(paired.filter((r) => r.total >= 21 && r.total <= 80)),
    byBand: Object.fromEntries(BANDS.map((b) => [b, pairedBlock(paired.filter((r) => band(r.total) === b))])),
  };
}
// dashboard 'metrics' shape (window-dashboard.mjs): primary lane at the top level
const shape = (label) => {
  const L = result.lanes[label];
  return {
    lane: label,
    beliefSHA256: L.model.sha256,
    beliefModel: { logLossPerCopy: L.all.beliefLogLossPerCopy },
    uniform: { logLossPerCopy: L.all.uniformLogLossPerCopy },
    logLikelihoodGainPerCopy: {
      mean: -L.all.differenceBeliefMinusUniform,
      ci95: L.all.ci95 ? [-L.all.ci95[1], -L.all.ci95[0]] : null,
      n: records.rounds,
      interval: 'uniform minus belief log loss per copy; round-cluster bootstrap over the recorded rounds',
    },
    byTableCards: Object.fromEntries(
      BANDS.filter((b) => L.byBand[b].positions).map((b) => [
        b,
        {
          decisions: L.byBand[b].positions,
          beliefLogLossPerCopy: L.byBand[b].beliefLogLossPerCopy,
          uniformLogLossPerCopy: L.byBand[b].uniformLogLossPerCopy,
        },
      ]),
    ),
  };
};
const primary = result.lanes.v2a ? 'v2a' : lanes[0].label;
Object.assign(result, shape(primary));
result.timing = { seconds: (Date.now() - started) / 1000 };
result.generatedAt = new Date().toISOString();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 2) + '\n');
if (refOut && result.lanes.v1) writeFileSync(resolve(refOut), JSON.stringify(shape('v1'), null, 2) + '\n');
const f = (x) => (x == null ? '-' : Number(x).toFixed(4));
console.log(
  Object.entries(result.lanes)
    .map(
      ([k, L]) =>
        `${k} ${f(L.all.beliefLogLossPerCopy)} vs uniform ${f(L.all.uniformLogLossPerCopy)} (diff ${f(L.all.differenceBeliefMinusUniform)} [${(L.all.ci95 || []).map(f).join(', ')}], ${L.all.positions} positions)`,
    )
    .join(' | ') +
    (result.pairedV2aMinusV1
      ? ` | v2a-v1 ${f(result.pairedV2aMinusV1.all.v2aMinusV1LogLossPerCopy)} [${(result.pairedV2aMinusV1.all.ci95 || []).map(f).join(', ')}]; 41-60 ${f(result.pairedV2aMinusV1.byBand['41-60'].v2aMinusV1LogLossPerCopy)}`
      : ''),
);
process.exit(result.positions.allEqualExpected ? 0 : 1);
