/**
 * Window 5 (PLAN review R7): the privacy copy of the human records that H1 reads, and nothing else.
 *
 *   node strip_human.mjs --src=<checkout> [--in=<RT/inputs/human-raw>] [--out=<RT/inputs/human-research>]
 *        [--panel=<RT/inputs/s7-panel/human-panel.json>] [--check=1]
 *
 * Input: RT/inputs/human-raw/d1-snapshot-<date>/raw/round-<n>.json, each file first re-verified against
 * RT/inputs/human-raw.sha256. Output: RT/inputs/human-research/<snapshot>/raw/round-*.json with
 *   - `room` nulled, every `seats[].name` (nickname) nulled;
 *   - every `seats[].id` (browser seat label, a UUID) replaced by the fixed UUID
 *     00000000-0000-4000-8000-00000000000<seat>: the record validator requires a distinct UUID per
 *     seat, so null is not accepted (stated in protocol deviations);
 *   - records with kind = "test" dropped;
 * everything else byte-for-byte as parsed (JSON re-serialised). Every stripped record must still
 * pass web/src/collection/validate.mjs validateRecord (from --src), else exit 1. Directories 700,
 * files 600. manifest.json lists per output file its SHA-256, the ORIGINAL file's SHA-256 and whether
 * the original is registered in the window-3 S7 panel (human-panel.json files.rawRecords) -- no
 * names, rooms or seat labels. --check=1 re-verifies an existing copy (SHA and no identifying field)
 * without writing. Nothing leaves the machine.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const R = '/Users/stevensun/guandan-runtime.noindex/window5-20261111';
const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const src = resolve(option('src', `${R}/src-e`));
const input = resolve(option('in', `${R}/inputs/human-raw`));
const out = resolve(option('out', `${R}/inputs/human-research`));
const panelFile = option('panel', `${R}/inputs/s7-panel/human-panel.json`);
const check = option('check', '0') === '1';
const { validateRecord } = await import(pathToFileURL(join(src, 'web/src/collection/validate.mjs')).href);

const SEAT_ID = (p) => `00000000-0000-4000-8000-00000000000${p}`;
const registered = existsSync(panelFile)
  ? new Set(JSON.parse(readFileSync(panelFile, 'utf8')).files.rawRecords.sha256OfFiles)
  : new Set();

// the original files, verified against the registered manifest of the copy in RT/inputs
const expected = new Map();
for (const line of readFileSync(`${input}.sha256`, 'utf8').split('\n')) {
  const m = /^([0-9a-f]{64})\s+\.\/(.+)$/.exec(line.trim());
  if (m) expected.set(m[2], m[1]);
}
const snapshots = readdirSync(input).filter((d) => /^d1-snapshot-\d{8}$/.test(d)).sort();
const identifying = (record) =>
  record.room != null || record.seats.some((s, p) => s.name != null || s.id !== SEAT_ID(p));

if (check) {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const problems = [];
  for (const f of manifest.files) {
    const buf = readFileSync(join(out, f.path));
    if (sha256(buf) !== f.sha256) problems.push(`${f.path}: sha changed`);
    const record = JSON.parse(buf.toString('utf8'));
    if (identifying(record)) problems.push(`${f.path}: identifying field present`);
  }
  console.log(JSON.stringify({ check: problems.length ? 'FAIL' : 'pass', files: manifest.files.length, problems }));
  process.exit(problems.length ? 1 : 0);
}

const tmp = `${out}.tmp-${process.pid}`;
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true, mode: 0o700 });
const files = [];
let dropped = 0;
for (const snap of snapshots) {
  const dir = join(input, snap, 'raw');
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir).filter((f) => /^round-\d+\.json$/.test(f)).sort()) {
    const rel = `${snap}/raw/${f}`;
    const buf = readFileSync(join(dir, f));
    const original = sha256(buf);
    if (expected.get(rel) !== original) throw Error(`original ${rel} does not match human-raw.sha256`);
    const record = JSON.parse(buf.toString('utf8'));
    if (record.kind === 'test') {
      dropped++;
      continue;
    }
    record.room = null;
    record.seats = record.seats.map((s, p) => ({ ...s, id: SEAT_ID(p), name: null }));
    // the validator sees the record as human-endgames.mjs loadRecord does (result fields split off)
    const { result, levelsAfter, remaining, trust, ...core } = record;
    validateRecord(core);
    const text = JSON.stringify(record);
    mkdirSync(join(tmp, snap, 'raw'), { recursive: true, mode: 0o700 });
    writeFileSync(join(tmp, rel), text, { mode: 0o600 });
    files.push({ path: rel, sha256: sha256(Buffer.from(text)), originalSha256: original, registeredInPanel: registered.has(original) });
  }
}
const manifest = {
  schema: 1,
  purpose: 'window-5 H1 privacy copy (PLAN review R7); H1 reads only this directory',
  writtenAt: new Date().toISOString(),
  tool: { file: 'scripts/strip_human.mjs', sha256: sha256(readFileSync(new URL(import.meta.url))) },
  validator: { file: relative(src, join(src, 'web/src/collection/validate.mjs')), sha256: sha256(readFileSync(join(src, 'web/src/collection/validate.mjs'))) },
  rules: 'room -> null; seats[].name -> null; seats[].id -> 00000000-0000-4000-8000-00000000000<seat>; kind=test dropped; validateRecord passes',
  source: { manifest: `${input}.sha256`, sha256: sha256(readFileSync(`${input}.sha256`)) },
  rounds: files.length,
  droppedTest: dropped,
  registeredInPanel: files.filter((f) => f.registeredInPanel).length,
  trust: 'unverified_browser',
  files,
};
writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n', { mode: 0o600 });
rmSync(out, { recursive: true, force: true });
renameSync(tmp, out);
chmodSync(out, 0o700);
console.log(
  JSON.stringify({ out, rounds: files.length, droppedTest: dropped, registeredInPanel: manifest.registeredInPanel, manifestSha256: sha256(readFileSync(join(out, 'manifest.json'))) }),
);
