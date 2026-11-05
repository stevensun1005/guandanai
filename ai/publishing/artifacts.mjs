import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Downloads happen at build time; players load same-origin Pages assets. */
export async function modelBytes(root, model) {
  const cache = join(root, 'ai/publishing/cache');
  const file = model.url
    ? join(cache, model.sha256 + '.onnx')
    : join(root, 'ai/local/models/baseline', model.file);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT' || !model.url) throw error;
    const response = await fetch(model.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Error(`Model download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (sha256(bytes) !== model.sha256) throw Error(`Model SHA-256 mismatch: ${model.id}`);
  if (model.url) {
    await mkdir(cache, { recursive: true });
    await writeFile(file, bytes);
  }
  return bytes;
}
