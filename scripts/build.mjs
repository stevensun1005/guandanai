import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = async name => (await readFile(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n');
let html = await read('src/game.html');
const css = await read('src/layout.css'), bridge = await read('src/table-bot.js');
const version = createHash('sha256').update(html + css + bridge + await read('src/ai/encoding.mjs') + await read('src/ai/worker.mjs'))
  .update(await readFile(path.join(root,'ai/policy.onnx'))).digest('hex').slice(0, 10);
html = html.replace('<link rel="stylesheet" href="layout.css">', `<style>\n${css}\n</style>`)
  .replace('<script src="table-bot.js"></script>', `<script>\n${bridge}\n</script>`)
  .replace("const VERSION='dev';", `const VERSION='${version}';`)
  .replace('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', './assets/vendor/peerjs.min.js');
const split = html.indexOf('<div id="app">');
if (split < 0) throw new Error('Game root missing');
html = `<!doctype html>\n<html lang="zh-CN"><head>\n<style>html,body{margin:0}[hidden]{display:none!important}</style>\n${html.slice(0,split)}\n</head><body>\n${html.slice(split)}\n</body></html>\n`;
for (const dir of ['dist/assets/vendor', 'dist/models']) await mkdir(path.join(root,dir), {recursive:true});
await writeFile(path.join(root,'dist/index.html'), html);
const copies = {
  'src/ai/worker.mjs':'dist/assets/ai-worker.mjs',
  'src/ai/encoding.mjs':'dist/assets/encoding.mjs',
  'ai/policy.onnx':'dist/models/policy.onnx',
  'node_modules/peerjs/dist/peerjs.min.js':'dist/assets/vendor/peerjs.min.js',
  'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs':'dist/assets/vendor/ort.wasm.min.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs':'dist/assets/vendor/ort-wasm-simd-threaded.mjs',
  'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm':'dist/assets/vendor/ort-wasm-simd-threaded.wasm',
  'third_party/ONNXRUNTIME-LICENSE.txt':'dist/assets/vendor/ONNXRUNTIME-LICENSE.txt',
  'node_modules/peerjs/LICENSE':'dist/assets/vendor/PEERJS-LICENSE.txt',
};
for (const [from,to] of Object.entries(copies)) await copyFile(path.join(root,from),path.join(root,to));
await writeFile(path.join(root,'dist/.nojekyll'), '');
console.log(`Built dist/ · version ${version} · browser AI, no inference server`);
