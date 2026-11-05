import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MODELS } from '../src/ai/models.mjs';
import { BOT_MODELS } from '../src/ai/model-catalog.mjs';
import { modelBytes } from '../../ai/publishing/artifacts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = async (name) => (await readFile(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n');
async function sourceFiles(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(name)));
    else files.push(name);
  }
  return files;
}
const hash = createHash('sha256');
for (const file of await sourceFiles('web/src')) {
  hash.update(file);
  hash.update(
    /\.(js|mjs|css|html)$/.test(file) ? await read(file) : await readFile(path.join(root, file)),
  );
}
const modelVersions = {};
for (const [key, model] of Object.entries(MODELS)) {
  const bytes = await readFile(path.join(root, 'ai/local/models/baseline', model.file));
  modelVersions[key] = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  hash.update(key).update(bytes);
}
const botBytes = new Map();
for (const model of BOT_MODELS) {
  const bytes = await modelBytes(root, model);
  botBytes.set(model.file, bytes);
  modelVersions['bot:' + model.id] = model.sha256.slice(0, 16);
  hash.update(model.id).update(bytes);
}
const version = hash.digest('hex').slice(0, 10);
const html = (await read('web/src/index.html')).replaceAll('__APP_VERSION__', version);
for (const dir of ['web/dist/assets/vendor', 'web/dist/models'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'web/dist/index.html'), html);
await build({
  entryPoints: [path.join(root, 'web/src/app.js')],
  outdir: path.join(root, 'web/dist/assets'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: 'external',
  charset: 'utf8',
  legalComments: 'inline',
  define: { __BUILD_VERSION__: JSON.stringify(version) },
  loader: { '.jpg': 'file', '.png': 'file', '.svg': 'file' },
  assetNames: 'images/[name]-[hash]',
});
const copies = {
  'web/src/ai/encoding.mjs': 'web/dist/assets/encoding.mjs',
  'node_modules/peerjs/dist/peerjs.min.js': 'web/dist/assets/vendor/peerjs.min.js',
  'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs': 'web/dist/assets/vendor/ort.wasm.min.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs':
    'web/dist/assets/vendor/ort-wasm-simd-threaded.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm':
    'web/dist/assets/vendor/ort-wasm-simd-threaded.wasm',
  'web/vendor/licenses/ONNXRUNTIME-LICENSE.txt': 'web/dist/assets/vendor/ONNXRUNTIME-LICENSE.txt',
  'node_modules/peerjs/LICENSE': 'web/dist/assets/vendor/PEERJS-LICENSE.txt',
};
await build({
  entryPoints: [path.join(root, 'web/src/ai/worker.mjs')],
  outfile: path.join(root, 'web/dist/assets/ai-worker.mjs'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: 'external',
  charset: 'utf8',
  external: ['./vendor/*'],
  define: { __MODEL_VERSIONS__: JSON.stringify(modelVersions) },
});
for (const model of Object.values(MODELS))
  copies['ai/local/models/baseline/' + model.file] = 'web/dist/models/' + model.file;
for (const [from, to] of Object.entries(copies))
  await copyFile(path.join(root, from), path.join(root, to));
for (const [file, bytes] of botBytes)
  await writeFile(path.join(root, 'web/dist/models', file), bytes);
await writeFile(
  path.join(root, 'web/dist/models/catalog.json'),
  JSON.stringify({ models: BOT_MODELS }, null, 2),
);
await writeFile(path.join(root, 'web/dist/.nojekyll'), '');
console.log(`Built web/dist/ · version ${version} · browser AI, no inference server`);
