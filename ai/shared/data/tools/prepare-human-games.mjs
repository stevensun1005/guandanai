import { readdir, readFile, mkdir, writeFile, appendFile, rename } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanExamples } from './human-examples.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const input = resolve(root, option('input', 'ai/shared/data/human-games/raw'));
const output = resolve(
  root,
  option('output', 'ai/shared/data/human-games/prepared/examples.jsonl'),
);
// --keep-assisted=<matchId>[,<matchId>...]: matches whose assisted flags came from interface testing, not real use of the
// move coach; a prefix of at least 8 characters names a match too. Their flagged human actions are kept (assistedOverride).
const keepPrefixes = option('keep-assisted', '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (keepPrefixes.some((p) => p.length < 8))
  throw Error('--keep-assisted needs at least 8 characters of each match ID');
const keepAssistedMatches = new Set();
const files = (await readdir(input)).filter((f) => /^round-\d+\.json$/.test(f)).sort();
const seen = new Set(),
  splits = { train: 0, validation: 0, test: 0 };
let humanActions = 0,
  keptAssisted = 0;
await mkdir(dirname(output), { recursive: true });
const temporary = output + `.${process.pid}.tmp`;
await writeFile(temporary, '', { flag: 'wx' });
for (const file of files) {
  const round = JSON.parse(await readFile(join(input, file), 'utf8'));
  if (seen.has(round.id)) continue;
  seen.add(round.id);
  if (keepPrefixes.some((p) => round.matchId?.toLowerCase().startsWith(p)))
    keepAssistedMatches.add(round.matchId);
  const rows = humanExamples(round, { keepAssistedMatches });
  if (rows.length)
    await appendFile(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  humanActions += rows.length;
  keptAssisted += rows.filter((row) => row.assistedOverride).length;
  for (const row of rows) splits[row.split]++;
}
await rename(temporary, output);
console.log(
  JSON.stringify({
    rounds: seen.size,
    humanActions,
    splits,
    ...(keepPrefixes.length ? { keptAssisted, keepAssistedMatches: [...keepAssistedMatches] } : {}),
    output,
    classification:
      'Prepared unverified human imitation data; no model training or strength acceptance',
  }),
);
