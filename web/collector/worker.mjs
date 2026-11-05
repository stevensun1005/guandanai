import { validateRecord, MAX_RECORD_BYTES } from '../src/collection/validate.mjs';

const json = (data, status = 200, headers = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
async function limitedJSON(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_RECORD_BYTES)
    throw Error('body_too_large');
  const reader = request.body?.getReader();
  if (!reader) throw Error('missing_body');
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_RECORD_BYTES) {
      await reader.cancel();
      throw Error('body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
const digest = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
async function equalSecret(actual, expected) {
  if (!expected || !actual) return false;
  const a = await digest(actual),
    b = await digest(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url),
      origin = request.headers.get('Origin');
    const allowed = (env.ALLOWED_ORIGINS || 'https://stevensun1005.github.io').split(',');
    const cors =
      origin && allowed.includes(origin)
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
        : {};
    if (url.pathname === '/health') return json({ ok: true, schema: 1 }, 200, cors);
    if (url.pathname === '/admin/export') {
      if (
        request.method !== 'GET' ||
        !(await equalSecret(
          request.headers.get('Authorization'),
          `Bearer ${env.EXPORT_TOKEN || ''}`,
        )) ||
        !env.EXPORT_TOKEN
      )
        return json({ error: 'unauthorized' }, 401);
      const after = Number(url.searchParams.get('after') || 0),
        includeTests = url.searchParams.get('includeTests') === '1';
      if (!Number.isSafeInteger(after) || after < 0) return json({ error: 'invalid_cursor' }, 400);
      const rows = await env.DB.prepare(
        `SELECT seq,payload FROM rounds WHERE seq>? ${includeTests ? '' : "AND kind='game'"} ORDER BY seq LIMIT 100`,
      )
        .bind(after)
        .all();
      return json({
        records: rows.results.map((row) => ({ seq: row.seq, record: JSON.parse(row.payload) })),
        cursor: rows.results.at(-1)?.seq || after,
        more: rows.results.length === 100,
      });
    }
    if (url.pathname !== '/rounds') return json({ error: 'not_found' }, 404, cors);
    if (!origin || !allowed.includes(origin)) return json({ error: 'origin_not_allowed' }, 403);
    if (request.method === 'OPTIONS')
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);
    if (!request.headers.get('Content-Type')?.startsWith('application/json'))
      return json({ error: 'json_required' }, 415, cors);
    if (env.RATE_LIMITER) {
      const key = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
      if (!(await env.RATE_LIMITER.limit({ key })).success)
        return json({ error: 'rate_limited' }, 429, cors);
    }
    let raw, record;
    try {
      raw = await limitedJSON(request);
      record = validateRecord(raw);
    } catch (error) {
      return json(
        { error: error.message === 'body_too_large' ? 'body_too_large' : 'invalid_round' },
        error.message === 'body_too_large' ? 413 : 400,
        cors,
      );
    }
    const sha = await digest(JSON.stringify(raw));
    try {
      const existing = await env.DB.prepare('SELECT sha256 FROM rounds WHERE id=?')
        .bind(record.id)
        .first();
      if (existing)
        return existing.sha256 === sha
          ? json({ id: record.id, stored: true, duplicate: true }, 200, cors)
          : json({ error: 'record_conflict' }, 409, cors);
      await env.DB.prepare(
        'INSERT INTO rounds (id,match_id,round_no,kind,sha256,human_actions,payload) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
      )
        .bind(
          record.id,
          record.matchId,
          record.round,
          record.kind,
          sha,
          record.actions.filter((a) => a.actor === 'human').length,
          JSON.stringify(record),
        )
        .run();
      const saved = await env.DB.prepare('SELECT sha256 FROM rounds WHERE id=?')
        .bind(record.id)
        .first();
      if (saved?.sha256 !== sha) return json({ error: 'record_conflict' }, 409, cors);
      return json({ id: record.id, stored: true }, 201, cors);
    } catch {
      return json({ error: 'storage_unavailable' }, 503, cors);
    }
  },
};
