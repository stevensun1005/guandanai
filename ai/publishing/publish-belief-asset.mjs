/** Publish the hand-inference (belief) network of a search research bot as an immutable Release
 * asset. The catalog entry (web/src/ai/model-catalog.json `searchBots`) is written by hand and
 * reviewed; this command only checks it against the local file, seeds the build cache, and with
 * --publish creates the tag (never overwrites one) and verifies the public download's SHA-256.
 * It never commits, pushes, edits a training run or claims strength acceptance.
 *
 *   node ai/publishing/publish-belief-asset.mjs --bot=9001 --file=<belief.onnx> [--publish]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './artifacts.mjs';
import { validateCatalog } from '../../web/src/ai/model-catalog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const option = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const catalog = validateCatalog(
  JSON.parse(await readFile(join(root, 'web/src/ai/model-catalog.json'), 'utf8')),
);
const bot = catalog.searchBots?.find((b) => b.id === option('bot'));
if (!bot) throw Error('--bot=<search bot id from the catalog>');
const bytes = await readFile(resolve(option('file') ?? ''));
if (sha256(bytes) !== bot.belief.sha256 || bytes.length !== bot.belief.bytes)
  throw Error('Belief file does not match the catalog SHA-256 and size');
const cache = join(root, 'ai/publishing/cache');
await mkdir(cache, { recursive: true });
await writeFile(join(cache, bot.belief.sha256 + '.onnx'), bytes);
const [, tag, name] = bot.belief.url.match(/\/releases\/download\/([^/]+)\/([^/]+)$/);
const local = join(cache, name);
await writeFile(local, bytes);
console.log(`Prepared ${name} (${bot.belief.sha256}) for tag ${tag}; build cache seeded.`);
if (!process.argv.includes('--publish')) process.exit(0);
let exists = true;
try {
  execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' });
} catch {
  exists = false;
}
if (exists) console.log(`Release ${tag} already exists; not overwritten.`);
else
  execFileSync(
    'gh',
    [
      'release',
      'create',
      tag,
      local,
      '--title',
      `Belief network ${bot.belief.featureVersion} ${bot.belief.sha256.slice(0, 8)} (search bot ${bot.id})`,
      '--notes',
      `Hand-inference network used by the web research bot ${bot.id} (search over base ${bot.base}). ` +
        `SHA-256 ${bot.belief.sha256}. Deployment asset, not a strength acceptance.`,
    ],
    { stdio: 'inherit' },
  );
const response = await fetch(bot.belief.url, { signal: AbortSignal.timeout(120000) });
if (!response.ok) throw Error(`Download failed: ${response.status}`);
const remote = sha256(Buffer.from(await response.arrayBuffer()));
if (remote !== bot.belief.sha256) throw Error(`Public asset SHA-256 mismatch: ${remote}`);
console.log(`Verified public asset ${bot.belief.url}`);
