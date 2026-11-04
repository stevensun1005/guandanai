import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
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
for (const file of await sourceFiles('src')) {
  hash.update(file);
  hash.update(
    /\.(js|mjs|css|html)$/.test(file) ? await read(file) : await readFile(path.join(root, file)),
  );
}
const version = hash
  .update(await readFile(path.join(root, 'ai/policy.onnx')))
  .digest('hex')
  .slice(0, 10);
const html = (await read('src/index.html')).replaceAll('__APP_VERSION__', version);
for (const dir of ['dist/assets/vendor', 'dist/models'])
  await mkdir(path.join(root, dir), { recursive: true });
await writeFile(path.join(root, 'dist/index.html'), html);
await build({
  entryPoints: [path.join(root, 'src/app.js')],
  outdir: path.join(root, 'dist/assets'),
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
  'src/ai/worker.mjs': 'dist/assets/ai-worker.mjs',
  'src/ai/encoding.mjs': 'dist/assets/encoding.mjs',
  'ai/policy.onnx': 'dist/models/policy.onnx',
  'node_modules/peerjs/dist/peerjs.min.js': 'dist/assets/vendor/peerjs.min.js',
  'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs': 'dist/assets/vendor/ort.wasm.min.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs':
    'dist/assets/vendor/ort-wasm-simd-threaded.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm':
    'dist/assets/vendor/ort-wasm-simd-threaded.wasm',
  'third_party/ONNXRUNTIME-LICENSE.txt': 'dist/assets/vendor/ONNXRUNTIME-LICENSE.txt',
  'node_modules/peerjs/LICENSE': 'dist/assets/vendor/PEERJS-LICENSE.txt',
};
for (const [from, to] of Object.entries(copies))
  await copyFile(path.join(root, from), path.join(root, to));
await writeFile(path.join(root, 'dist/.nojekyll'), '');
console.log(`Built dist/ · version ${version} · browser AI, no inference server`);
