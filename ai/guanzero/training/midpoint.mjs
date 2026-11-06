/** Freeze one named checkpoint at the midpoint, then evaluate the registered opponents. */
import { copyFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addSuite, runDevelopmentSuites } from './development-suite.mjs';
import { option, paths, readJSON, writeJSON } from './lib.mjs';

export async function freezeMidpoint(run, championRoot, seedIndex) {
  const p = paths(run);
  const directory = join(p.eval, 'development-500');
  const pinned = join(p.eval, 'midpoint-snapshot');
  mkdirSync(pinned, { recursive: true });
  mkdirSync(directory, { recursive: true });
  const pattern = /^model-\d+\.onnx$/;
  const saved = readdirSync(pinned).filter((f) => pattern.test(f));
  if (saved.length > 1) throw Error('Multiple midpoint checkpoints');
  const file = saved[0] || readJSON(join(p.models, 'latest.json')).file;
  if (!pattern.test(file)) throw Error('Unsafe checkpoint name');
  if (!saved.length) {
    const temporary = join(pinned, 'copy.tmp');
    copyFileSync(join(p.models, file), temporary);
    renameSync(temporary, join(pinned, file));
  }
  const manifest = readJSON(join(directory, 'manifest.json'), {
    protocol: 'development-500-v1',
    seedIndexBase: seedIndex,
    suites: [],
  });
  const version = file.slice(0, -5);
  await addSuite(run, manifest, { id: version, model: join(pinned, file), version, championRoot });
  return version;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = option('run');
  const championRoot = option('champion-root');
  const version = await freezeMidpoint(run, championRoot, Number(option('seed-index')));
  await runDevelopmentSuites({ run, once: true, championRoot });
  writeJSON(join(paths(run).eval, 'midpoint-complete.json'), {
    version,
    completedAt: new Date().toISOString(),
  });
}
