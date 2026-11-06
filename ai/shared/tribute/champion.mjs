import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** New batches use a verified promotion, never a largest-step or latest-export guess. */
export function resolveChampion(root, catalog) {
  const model = catalog.models.find((m) => m.id === catalog.selection?.danMCaiChampions?.[0]);
  const proof = model?.source?.champion;
  if (!proof || model.config?.history) throw Error('No verified danMCai champion');
  for (const path of [proof.manifest, proof.evidence])
    if (
      typeof path !== 'string' ||
      !path.startsWith('ai/research/evaluation/') ||
      path.includes('..') ||
      path.includes('\\')
    )
      throw Error('Invalid champion evidence path');
  const manifest = JSON.parse(readFileSync(join(root, proof.manifest)));
  const bytes = readFileSync(join(root, proof.evidence)),
    gate = JSON.parse(bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (
    manifest.sha256 !== model.sha256 ||
    manifest.version !== model.source.version ||
    digest !== proof.evidenceSHA256 ||
    gate.status !== 'complete' ||
    gate.decision !== 'accept' ||
    gate.test?.decision !== 'accept' ||
    gate.challenger?.sha256 !== model.sha256 ||
    gate.challenger.version !== model.source.version
  )
    throw Error('Champion promotion evidence mismatch');
  return model;
}
