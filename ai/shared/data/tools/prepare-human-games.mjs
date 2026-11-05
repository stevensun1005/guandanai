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
const files = (await readdir(input)).filter((f) => /^round-\d+\.json$/.test(f)).sort();
const seen = new Set(),
  splits = { train: 0, validation: 0, test: 0 };
let humanActions = 0;
await mkdir(dirname(output), { recursive: true });
const temporary = output + `.${process.pid}.tmp`;
await writeFile(temporary, '', { flag: 'wx' });
for (const file of files) {
  const round = JSON.parse(await readFile(join(input, file), 'utf8'));
  if (seen.has(round.id)) continue;
  seen.add(round.id);
  const rows = humanExamples(round);
  if (rows.length)
    await appendFile(temporary, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  humanActions += rows.length;
  for (const row of rows) splits[row.split]++;
}
await rename(temporary, output);
console.log(
  JSON.stringify({
    rounds: seen.size,
    humanActions,
    splits,
    output,
    classification:
      'Prepared unverified human imitation data; no model training or strength acceptance',
  }),
);
