import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

const root = fileURLToPath(new URL('../src/', import.meta.url));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}
const modules = files(root).filter((f) => /\.m?js$/.test(f));
const browser = new Set([
  'window',
  'document',
  'navigator',
  'location',
  'localStorage',
  'indexedDB',
  'requestAnimationFrame',
  'getComputedStyle',
  'matchMedia',
  'screen',
  'innerWidth',
  'innerHeight',
  'addEventListener',
  'removeEventListener',
  'ResizeObserver',
  'MediaStream',
  'Peer',
  'Worker',
  'self',
  '__BUILD_VERSION__',
  '__MODEL_VERSION__',
]);
const standard = new Set(Object.getOwnPropertyNames(globalThis));

test('feature modules declare their dependencies instead of relying on legacy globals', () => {
  assert(modules.length >= 30);
  for (const file of modules) {
    const tree = parse(readFileSync(file, 'utf8'), {
      ecmaVersion: 'latest',
      sourceType: 'module',
      ranges: true,
    });
    const scope = analyze(tree, {
      ecmaVersion: 2024,
      sourceType: 'module',
      ignoreEval: true,
      optimistic: true,
    });
    const missing = [...new Set(scope.globalScope.through.map((r) => r.identifier.name))].filter(
      (n) => !browser.has(n) && !standard.has(n),
    );
    assert.deepEqual(missing, [], path.relative(root, file));
  }
});

test('core rules stay independent from session, DOM and UI modules', () => {
  for (const file of modules.filter((f) => f.startsWith(path.join(root, 'core') + path.sep))) {
    const tree = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of tree.body.filter((n) => n.type === 'ImportDeclaration'))
      assert(node.source.value.startsWith('./'), file);
    assert(!/\b(?:document|window|runtime)\b/.test(readFileSync(file, 'utf8')), file);
  }
});
