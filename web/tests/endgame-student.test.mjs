import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { studentDecision } from '../src/ai/search/student.mjs';
import { createRound } from '../../ai/shared/simulation/simulation.mjs';
import { searchPayload, restoreGame } from '../src/ai/search/payload.mjs';
import { validateCatalog, searchBotManifest } from '../src/ai/model-catalog.mjs';
import catalog from '../src/ai/model-catalog.json' with { type: 'json' };
test('trained tail hybrid switches at32 and never reads hidden hand identities', async () => {
  const game = createRound(1),
    score = (s) => s.actions.map((_, i) => i);
  let studentCalls = 0;
  const student = (s) => {
    studentCalls++;
    return score(s).map((x) => -x);
  };
  const masked = restoreGame(searchPayload(game, game.turn, 0, 1));
  assert.equal((await studentDecision(masked, score, student)).kind, 'champion');
  assert.equal(studentCalls, 0);
  // Controlled public-count fixture; hidden cards throw if accessed.
  const p = game.turn;
  game.hands[p] = game.hands[p].slice(0, 4);
  for (let i = 0; i < 4; i++)
    if (i !== p) game.hands[i] = game.hands[i].slice(0, i === (p + 1) % 4 ? 26 : 1);
  // 4+26+1+1=32
  const tail = restoreGame(searchPayload(game, p, 0, 1));
  const r = await studentDecision(tail, score, student);
  assert.equal(r.kind, 'endgame-student');
  assert.equal(studentCalls, 1);
  assert.equal(r.index, 0);
  assert.equal(r.values.length, r.plays.length);
});
test('trained student manifest binds both weights and rejects mixed untested search', () => {
  const c = structuredClone(catalog),
    base = c.models.find((m) => m.id === '029');
  const m = structuredClone(base);
  m.id = '8900';
  m.file = 'bot-8900.onnx';
  m.sha256 = 'a'.repeat(64);
  delete m.source.champion;
  c.models.push(m);
  const bot = {
    id: '9900',
    kind: 'endgame-student',
    base: '029',
    student: { id: m.id, sha256: m.sha256 },
    threshold: 32,
    version: 'v000061013-tail-e00064000',
    sha256: 'b'.repeat(64),
  };
  c.searchBots.push(bot);
  c.selection.defaultChoice = bot.id;
  assert.doesNotThrow(() => validateCatalog(c));
  assert.equal(searchBotManifest(bot, base).student.sha256, m.sha256);
  for (const extra of [
    { threshold: 33 },
    { student: { id: m.id, sha256: 'c'.repeat(64) } },
    { belief: {} },
    { search: {} },
  ]) {
    const bad = structuredClone(c);
    Object.assign(bad.searchBots.at(-1), extra);
    assert.throws(() => validateCatalog(bad), /student/);
  }
});
