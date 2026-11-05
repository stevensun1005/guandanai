/** Add Clint to reports from a frozen legacy trainer without changing its sources. */
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './evaluate.mjs';
import { paths, readJSON, writeJSON, option, sha256 } from './lib.mjs';

export async function supplementBlock(run, name) {
  if (!/^block-\d+$/.test(name)) throw Error('Invalid evaluation block');
  const folder = join(paths(run).eval, name),
    base = readJSON(join(folder, 'report.json'));
  if (!base || base.results?.clint) return null;
  const output = join(folder, 'clint/report.json');
  if (existsSync(output)) {
    const previous = readJSON(output);
    if (
      previous.completedAt &&
      previous.modelSHA256 === base.modelSHA256 &&
      previous.seedStart === base.seedStart &&
      previous.seedEnd === base.seedEnd &&
      previous.pairs === base.pairs
    )
      return null;
    throw Error('Incomplete or mismatched Clint supplement; preserving existing evidence');
  }
  const model = join(folder, 'model.onnx');
  if (sha256(model) !== base.modelSHA256) throw Error('Frozen evaluation model SHA mismatch');
  return evaluate({
    run,
    model,
    index: base.index,
    pairs: base.pairs,
    opponents: ['clint'],
    subdirectory: 'clint',
  });
}

export async function runSupplements({
  run,
  fromBlock = 0,
  guardianState = null,
  once = false,
  pollMs = 30000,
}) {
  const p = paths(run),
    lock = join(p.eval, '.clint-supplement.lock'),
    status = join(p.eval, 'clint-supplement-status.json');
  if (existsSync(lock)) {
    const previous = JSON.parse(readFileSync(lock, 'utf8'));
    let alive = true;
    try {
      process.kill(previous.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }
    if (alive) throw Error('A Clint evaluation companion is already running');
    unlinkSync(lock);
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
  });
  process.on('SIGINT', () => {
    stopping = true;
  });
  const state = { pid: process.pid, fromBlock, phase: 'waiting', completedBlocks: [] };
  const save = () => writeJSON(status, { ...state, updatedAt: new Date().toISOString() });
  try {
    while (!stopping) {
      for (const name of readdirSync(p.eval)
        .filter((n) => /^block-\d+$/.test(n) && Number(n.slice(6)) >= fromBlock)
        .sort()) {
        if (!existsSync(join(p.eval, name, 'report.json'))) continue;
        state.phase = 'evaluating';
        state.block = name;
        save();
        const report = await supplementBlock(run, name);
        if (report)
          state.completedBlocks.push({
            block: name,
            matches: report.results.clint.matches,
            modelSHA256: report.modelSHA256,
          });
      }
      const guardian = guardianState ? readJSON(guardianState, {}) : {};
      state.phase = guardian.phase === 'complete' ? 'complete' : 'waiting';
      save();
      if (once || state.phase === 'complete') return state;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    state.phase = 'stopped';
    save();
    return state;
  } catch (error) {
    state.phase = 'error';
    state.error = String(error.message || error);
    save();
    throw error;
  } finally {
    unlinkSync(lock);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSupplements({
    run: option('run', 'ai/guanzero/runs/guanzero-adp'),
    fromBlock: Number(option('from-block', '0')),
    guardianState: option('guardian-state'),
    once: process.argv.includes('--once'),
  });
}
