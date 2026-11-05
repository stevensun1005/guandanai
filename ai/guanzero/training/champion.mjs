/** Resolve a real accepted champion; never substitute the largest export step. */
import { dirname, join, resolve, sep } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { modelBytes } from '../../publishing/artifacts.mjs';
import { ROOT, readJSON, sha256 } from './lib.mjs';
export function championDefinition(root = ROOT) {
  const catalog = readJSON(join(root, 'web/src/ai/model-catalog.json'));
  const id = catalog.selection?.danMCaiChampions?.[0];
  const model = catalog.models.find((m) => m.id === id);
  if (!model || catalog.defaultId !== id || !model.source?.champion)
    throw Error('Missing accepted danMCai champion');
  const evidence = resolve(root, model.source.champion.evidence);
  if (!evidence.startsWith(resolve(root) + sep)) throw Error('Invalid champion evidence path');
  const gate = readJSON(evidence),
    state = readJSON(join(dirname(evidence), 'champion.json'));
  if (
    sha256(evidence) !== model.source.champion.evidenceSHA256 ||
    gate.decision !== 'accept' ||
    gate.challenger?.sha256 !== model.sha256 ||
    gate.challenger?.version !== model.source.version ||
    state.sha256 !== model.sha256 ||
    state.version !== model.source.version ||
    state.history?.at(-1)?.gate !== model.source.champion.gate
  )
    throw Error('danMCai champion gate or history mismatch');
  if (JSON.stringify(model.config) !== JSON.stringify({ stateFeatures: 513, actionFeatures: 54 }))
    throw Error('Unsupported champion encoding');
  return {
    id: 'champion',
    name: 'danMCai-' + model.source.version,
    mode: 'snapshot',
    version: model.source.version,
    modelSHA256: model.sha256,
    archiveId: id,
    gate: model.source.champion,
    policy: 'greedy-network-only-no-web-styles-or-endgame',
    artifact: model,
  };
}
export async function freezeChampion(folder, definition = championDefinition(), root = ROOT) {
  const { artifact, ...metadata } = definition;
  const file = join(folder, 'champion.onnx');
  if (existsSync(file)) {
    if (sha256(file) !== metadata.modelSHA256) throw Error('Existing champion snapshot mismatch');
  } else writeFileSync(file, await modelBytes(root, artifact), { flag: 'wx' });
  return { file, metadata };
}
