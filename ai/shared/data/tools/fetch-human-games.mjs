import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../../../web/src/collection/config.json' with { type: 'json' };

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const option = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || fallback;
const includeTests = process.argv.includes('--include-tests');
const output = resolve(
  root,
  option(
    'output',
    includeTests
      ? 'ai/local/workspace/collection/export-validation'
      : 'ai/shared/data/human-games/raw',
  ),
);
const endpoint = new URL(option('endpoint', config.endpoint));
if (endpoint.protocol !== 'https:') throw Error('HTTPS export endpoint required');
endpoint.pathname = '/admin/export';
endpoint.search = '';
if (includeTests) endpoint.searchParams.set('includeTests', '1');
const token =
  process.env.GUANDAN_EXPORT_TOKEN ||
  (
    await readFile(
      resolve(root, option('token-file', 'ai/local/workspace/collection/export-token.txt')),
      'utf8',
    )
  ).trim();
if (!token) throw Error('Missing private export token');
await mkdir(output, { recursive: true });
const cursorFile = join(output, 'cursor.json');
let cursor = 0;
try {
  cursor = JSON.parse(await readFile(cursorFile, 'utf8')).cursor || 0;
} catch {}
let downloaded = 0;
while (true) {
  endpoint.searchParams.set('after', cursor);
  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`Export failed: ${response.status}`);
  const page = await response.json();
  for (const { seq, record } of page.records) {
    if (!Number.isSafeInteger(seq) || seq <= cursor || (!includeTests && record.kind !== 'game'))
      throw Error('Invalid export page');
    const file = join(output, `round-${String(seq).padStart(12, '0')}.json`),
      text = JSON.stringify(record) + '\n';
    try {
      await writeFile(file, text, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST' || (await readFile(file, 'utf8')) !== text) throw error;
    }
    cursor = seq;
    downloaded++;
  }
  await writeFile(cursorFile, JSON.stringify({ cursor }) + '\n');
  if (!page.more) break;
}
console.log(JSON.stringify({ downloaded, cursor, output }));
