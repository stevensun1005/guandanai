/** Helpers for sampling machines that join a run through a shared folder. Not part of a run's frozen sources. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/** Same convention as supervisor.mjs: UTF-8 text with CRLF normalized to LF. */
export function localSourceHashes(files, root = REPO_ROOT) {
  return Object.fromEntries(
    files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(join(root, file), 'utf8').replaceAll('\r\n', '\n'))
        .digest('hex'),
    ]),
  );
}

/** Files whose local content differs from the run's frozen sources (empty when they match). */
export function sourceMismatches(config, root = REPO_ROOT) {
  const frozen = config.sourceSHA256 || {};
  const files = Object.keys(frozen);
  if (!files.length) return ['config.json has no sourceSHA256'];
  const local = localSourceHashes(
    files.filter((file) => existsSync(join(root, file))),
    root,
  );
  return files.filter((file) => local[file] !== frozen[file]);
}

/** Totals over every actor-<slot>.json in the run, local and remote alike. */
export function actorTotals(actorsDirectory) {
  const totals = { matches: 0, decisions: 0, rows: 0, slots: [] };
  if (!existsSync(actorsDirectory)) return totals;
  for (const name of readdirSync(actorsDirectory)) {
    const match = /^actor-(\d+)\.json$/.exec(name);
    if (!match) continue;
    let status;
    try {
      status = JSON.parse(readFileSync(join(actorsDirectory, name), 'utf8'));
    } catch {
      continue; // a status file being replaced over the network is picked up on the next read
    }
    for (const key of ['matches', 'decisions', 'rows']) totals[key] += status[key] || 0;
    totals.slots.push(Number(match[1]));
  }
  totals.slots.sort((a, b) => a - b);
  return totals;
}

/** Parse "8-15" or "8,9,12" into a sorted list of distinct slot numbers. */
export function parseSlots(text) {
  const slots = new Set();
  for (const part of String(text).split(',')) {
    const range = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!range) throw Error(`Invalid slot list: ${text}`);
    const first = Number(range[1]),
      last = Number(range[2] ?? range[1]);
    if (last < first) throw Error(`Invalid slot range: ${part}`);
    for (let slot = first; slot <= last; slot++) slots.add(slot);
  }
  return [...slots].sort((a, b) => a - b);
}
