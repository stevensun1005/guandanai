/** Compatibility fixtures only: existing public endings plus the historical opening seed1. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { BOT_MODELS, SEARCH_BOTS } from '../../web/src/ai/model-catalog.mjs';
import { createRound } from '../shared/simulation/simulation.mjs';
import { searchPayload, restoreGame } from '../../web/src/ai/search/payload.mjs';
import { studentDecision } from '../../web/src/ai/search/student.mjs';
import { createModelPool } from '../danMCai/training/continuous/lib.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const bot = SEARCH_BOTS.filter((b) => b.kind === 'endgame-student').at(-1);
if (!bot) throw Error('No candidate endgame bot');
const model = (id) => join(root, 'web/dist/models', BOT_MODELS.find((m) => m.id === id).file);
const pool = await createModelPool(ort, { threads: 1, limit: 2 });
const opening = createRound(1);
const payloads = [searchPayload(opening, opening.turn, 0, 1)];
for (const name of ['endgame-positions.json', 'endgame-expanded-positions.json'])
  for (const { state: s } of JSON.parse(readFileSync(join(root, 'ai/shared/fixtures', name)))) {
    const t = s.endgame?.trick;
    const last = t && s.log.findLast((e) => e.p === t.player && e.cards?.length);
    payloads.push({
      p: s.p,
      offset: 0,
      seed: 1,
      turn: s.p,
      L: s.level,
      levels: s.p % 2 ? [s.opponentLevel, s.selfLevel] : [s.selfLevel, s.opponentLevel],
      hand: s.hand,
      counts: s.counts,
      log: s.log,
      passes: s.endgame?.passes || 0,
      out: s.counts.map((n, i) => (n === 0 ? i : -1)).filter((i) => i >= 0),
      trick: t ? { player: t.player, ...t.play, cards: last.cards } : null,
      exchanges: { trib: [], kang: null },
    });
  }
try {
  const fixtures = [];
  for (const payload of payloads) {
    const r = await studentDecision(
      restoreGame(payload),
      (s) => pool.values(model(bot.base), s),
      (s) => pool.values(model(bot.student.id), s),
    );
    const play = r.plays[r.index];
    fixtures.push({
      payload,
      index: r.index,
      values: r.values,
      kind: r.kind,
      ids: play ? play.cards.map((c) => c.id) : [],
    });
  }
  const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
  writeFileSync(
    resolve(out),
    JSON.stringify({ bot: bot.id, studentSHA256: bot.student.sha256, fixtures }, null, 2) + '\n',
  );
} finally {
  await pool.close();
}
