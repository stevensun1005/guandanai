/** Static source identity, parsed as JavaScript so comments/strings cannot invent imports. */
import { parse } from 'acorn';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, relative, sep } from 'node:path';
export function sourceClosure(entry, root) {
  const files = new Map();
  root = resolve(root);
  const visit = (file) => {
    file = resolve(file);
    if (files.has(file)) return;
    if (!file.startsWith(root + sep)) throw Error('Source escaped frozen root');
    // Catalog identity is explicitly frozen in plan.reason.manifest, not the evolving JSON file.
    if (file.endsWith('.json')) return;
    const bytes = readFileSync(file);
    files.set(file, createHash('sha256').update(bytes).digest('hex'));
    const ast = parse(bytes.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of ast.body)
      if (
        ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(
          node.type,
        ) &&
        node.source?.value.startsWith('.')
      )
        visit(resolve(dirname(file), node.source.value));
  };
  visit(entry);
  return Object.fromEntries(
    [...files]
      .map(([p, h]) => [relative(root, p).replaceAll('\\', '/'), h])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
