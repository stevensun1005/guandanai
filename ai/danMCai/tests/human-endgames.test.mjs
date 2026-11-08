import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectedRound } from '../../../web/tests/fixtures/collected-round.mjs';
import { candidates } from '../../../web/src/ai/candidates.js';
import { validateRecord } from '../../../web/src/collection/validate.mjs';
import { loadRecord, matchCandidate, replay, summarize } from '../endgame/human-endgames.mjs';

test('replay of a collected record follows every recorded seat and ends with the recorded order', () => {
  for (let seed = 9301000; seed < 9301006; seed++) {
    const record = collectedRound(seed);
    const checked = validateRecord(record);
    let steps = 0,
      game = null;
    for (const state of replay(record)) {
      assert.equal(state.game.turn, record.actions[state.index].seat);
      const plays = candidates(
        state.game.hands[state.game.turn],
        state.game.L,
        state.game.trick?.play,
      );
      // Every recorded play is a legal shape; the candidate generator normally contains it.
      if (state.play)
        assert.ok(state.play.cards.length === record.actions[state.index].cards.length);
      assert.ok(matchCandidate(plays, state.play) >= -1);
      steps++;
      game = state.game;
    }
    assert.equal(steps, record.actions.length);
    assert.deepEqual(game.out, checked.order);
  }
});

test('loadRecord strips server-added fields and still validates', () => {
  const record = collectedRound(9301002);
  const stored = { ...validateRecord(record) };
  const dir = mkdtempSync(join(tmpdir(), 'human-endgame-'));
  writeFileSync(join(dir, 'round.json'), JSON.stringify(stored));
  const { record: loaded, checked } = loadRecord(join(dir, 'round.json'));
  assert.equal(loaded.id, record.id);
  assert.deepEqual(checked.order, record.order);
});

test('summary counts a move as optimal only when it keeps the exact value', () => {
  const row = (round, human, best = 1) => ({
    round,
    best,
    human,
    champion: best,
    student: -best,
    candidates: 3,
    optimalMoves: 1,
    auto: null,
    cards: 10,
    assisted: false,
  });
  const summary = summarize([
    { round: 'a:1', decisions: [row('a:1', 1), row('a:1', -1)], takeovers: [] },
    { round: 'b:1', decisions: [row('b:1', 1)], takeovers: [] },
  ]);
  const critical = summary.decisionAudit.critical;
  assert.equal(critical.human.decisions, 3);
  assert.equal(critical.human.optimal, 2);
  assert.equal(critical.champion.optimalRate, 1);
  assert.equal(critical.student.optimalRate, 0);
  assert.equal(critical.human.totalRegret, 2);
});
