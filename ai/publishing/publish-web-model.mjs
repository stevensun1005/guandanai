/** Freeze one complete export, publish an immutable Release asset, then register its number.
 * This command never commits, pushes, edits a training run, or claims strength acceptance.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { validateCatalog } from '../../web/src/ai/model-catalog.mjs';
import { sha256 } from './artifacts.mjs';
import { verifyEvaluatedSuite } from './evaluated-suite.mjs';
import * as ort from 'onnxruntime-node';

const root = fileURLToPath(new URL('../../', import.meta.url));
const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith('--' + name + '='))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback;
const publish = process.argv.includes('--publish');
const registry = join(root, 'web/src/ai/model-catalog.json');
const originalRegistry = await readFile(registry, 'utf8');
const catalog = validateCatalog(JSON.parse(originalRegistry));
const run = resolve(root, option('run', 'ai/danMCai/runs/gpu-main'));
let source, input;
if (option('model')) {
  input = resolve(option('model'));
  source = {
    run: option('source', 'external'),
    version: option('version', basename(input)),
    status: 'experimental-not-heldout-accepted',
  };
} else {
  const latest = JSON.parse(await readFile(join(run, 'models/latest.json'), 'utf8'));
  if (!/^[\w-]+\.onnx$/.test(latest.file)) throw Error('Invalid exported model path');
  input = join(run, 'models', latest.file);
  source = {
    run: basename(run),
    version: latest.version,
    step: latest.step,
    exportedAt: latest.publishedAt,
    expectedSHA256: latest.sha256,
    status: 'experimental-not-heldout-accepted',
  };
}
if (option('step') !== undefined) {
  const step = Number(option('step'));
  if (!Number.isSafeInteger(step) || step < 0) throw Error('Invalid training step');
  source.step = step;
}
const bytes = await readFile(input),
  digest = sha256(bytes);
if (source.expectedSHA256 && digest !== source.expectedSHA256)
  throw Error('Export changed or corrupted; retry with a complete export');
const suite = option('evaluated-suite');
const developmentEvaluation =
  source.run === 'guanzero-adp-io48' || suite
    ? await verifyEvaluatedSuite(suite, input, digest, source, root)
    : null;
if (catalog.models.some((model) => model.sha256 === digest)) {
  console.log('This exact model is already registered; no duplicate release.');
  process.exit(0);
}
const id = String(Math.max(...catalog.models.map((model) => Number(model.id))) + 1).padStart(
  3,
  '0',
);
const file = `bot-${id}.onnx`,
  tag = `web-model-${id}`;
const folder = join(root, 'ai/publishing/cache');
await mkdir(folder, { recursive: true });
await writeFile(join(folder, file), bytes);
await writeFile(join(folder, digest + '.onnx'), bytes);
const config = option('config')
  ? JSON.parse(await readFile(resolve(option('config')), 'utf8'))
  : { stateFeatures: 513, actionFeatures: 54 };
if (
  developmentEvaluation &&
  (config.stateFeatures !== 513 || config.actionFeatures !== 54 || config.history !== 'guanzero-v1')
)
  throw Error('Invalid GuanZero evaluation encoding');
const model = {
  id,
  file,
  sha256: digest,
  bytes: bytes.length,
  url: `https://github.com/stevensun1005/guandanai/releases/download/${tag}/${file}`,
  config,
  source: { ...source, registeredAt: new Date().toISOString() },
};
catalog.models.push(model);
// A new archive is not a new champion. The menu policy owns the default pointer.
catalog.defaultId = catalog.selection?.danMCaiChampions[0] || id;
validateCatalog(catalog);
const session = await ort.InferenceSession.create(bytes, {
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
});
try {
  for (const count of [1, 3, 129]) {
    const inputs = {
      state: new ort.Tensor('float32', new Float32Array(513), [1, 513]),
      actions: new ort.Tensor('float32', new Float32Array(count * 54), [count, 54]),
    };
    if (config.extraFeatures)
      inputs.extras = new ort.Tensor('float32', new Float32Array(count * config.extraFeatures), [
        count,
        config.extraFeatures,
      ]);
    if (config.history)
      inputs.history = new ort.Tensor('float32', new Float32Array(1080), [1, 5, 216]);
    let outputs;
    try {
      outputs = await session.run(inputs);
      if (outputs.values?.data.length !== count || !outputs.values.data.every(Number.isFinite))
        throw Error('Incompatible model outputs');
      if (
        config.rerankCandidates &&
        (outputs.policy_logits?.data.length !== count ||
          !outputs.policy_logits.data.every(Number.isFinite))
      )
        throw Error('Missing policy logits');
    } finally {
      Object.values(inputs).forEach((tensor) => tensor.dispose());
      if (outputs) Object.values(outputs).forEach((tensor) => tensor.dispose());
    }
  }
} finally {
  await session.release();
}
const notes = join(folder, `${tag}.md`);
await writeFile(
  notes,
  `# Browser model ${id}\n\nExperimental training snapshot; owner-authorized periodic deployment. Not independent strength acceptance.\n\nSHA-256: ${digest}\n\nSource:\n\n\`\`\`json\n${JSON.stringify(source, null, 2)}\n\`\`\`\n`,
);
if (!publish) {
  console.log(
    JSON.stringify(
      { prepared: model, next: 'Repeat with --publish after reviewing the frozen model' },
      null,
      2,
    ),
  );
  process.exit(0);
}
const gh = (args) => execFileSync('gh', args, { cwd: root, stdio: 'pipe' }).toString();
// Never overwrite an existing numbered release. A collision means another publisher won.
let existing = null;
try {
  existing = gh(['release', 'view', tag, '--json', 'tagName']);
} catch (error) {
  if (
    !String(error.stderr).includes('release not found') &&
    !String(error.stderr).includes('Not Found')
  )
    throw error;
}
if (existing) throw Error(`Release ${tag} already exists; reconcile the catalog before retrying`);
gh([
  'release',
  'create',
  tag,
  join(folder, file),
  '--target',
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  '--title',
  `Browser model ${id}`,
  '--notes-file',
  notes,
  '--prerelease',
  '--latest=false',
]);
// Verify the public attachment before changing the default pointer.
const response = await fetch(model.url, { signal: AbortSignal.timeout(120000) });
if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== digest)
  throw Error('Public Release download verification failed; catalog was not changed');
if ((await readFile(registry, 'utf8')) !== originalRegistry)
  throw Error('Catalog changed during upload; reconcile without overwriting it');
await writeFile(registry, JSON.stringify(catalog, null, 2) + '\n');
const artifacts = join(root, 'ai/research/evaluation/model-artifacts.json');
const index = JSON.parse(await readFile(artifacts, 'utf8'));
index.webModels = {
  catalog: 'web/src/ai/model-catalog.json',
  defaultId: catalog.defaultId,
  models: catalog.models.map(({ id, sha256, url, source }) => ({
    id,
    sha256,
    ...(url ? { download: url } : {}),
    source,
  })),
};
await writeFile(artifacts, JSON.stringify(index, null, 2) + '\n');
const evidence = {
  observedAt: new Date().toISOString(),
  defaultId: catalog.defaultId,
  model,
  classification: 'Owner-authorized browser deployment; not independent performance acceptance',
  strengthEvaluation: null,
  ...(developmentEvaluation && { developmentEvaluation }),
  encodingSHA256: sha256(
    (await readFile(join(root, 'web/src/ai/encoding.mjs'))).toString().replace(/\r\n/g, '\n'),
  ),
};
await writeFile(
  join(root, `ai/research/evaluation/web-model-${id}.json`),
  JSON.stringify(evidence, null, 2) + '\n',
);
const report = join(root, 'ai/research/MODEL_STUDY.md');
await writeFile(
  report,
  (await readFile(report, 'utf8')) +
    `\n### 网页模型 ${source.version}（归档 ${id}） · ${source.registeredAt || model.source.registeredAt}\n\n归档完整导出 \`${source.run}/${source.version}\`，SHA-256 为 \`${digest}\`。网页默认编号为 **${catalog.defaultId}**；启用冠军菜单时，归档新检查点不会自动替换冠军。本发布未新增独立评测比赛，不代表棋力验收或胜率提高。既有开发评测仍按第 11 节保留。[发布证据](evaluation/web-model-${id}.json)。\n`,
);
console.log(
  JSON.stringify(
    {
      registered: id,
      sha256: digest,
      release: tag,
      next: 'Run tests, browser smoke, commit only release files, and push main',
    },
    null,
    2,
  ),
);
