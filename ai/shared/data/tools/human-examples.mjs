import { createHash } from 'node:crypto';
import { validateRecord } from '../../../../web/src/collection/validate.mjs';

/**
 * keepAssistedMatches: match IDs whose `assisted` flags are known not to reflect real use of the move coach (for example a
 * match where the evaluation was only switched on to test the interface). Their flagged human actions are kept and marked
 * `assistedOverride: true`; every other match still excludes assisted actions.
 */
export function humanExamples(saved, { keepAssistedMatches = new Set() } = {}) {
  const { result, levelsAfter, remaining, trust, ...raw } = saved;
  if (raw.kind !== 'game') return [];
  const keepAssisted = keepAssistedMatches.has(raw.matchId);
  const bucket = createHash('sha256')
    .update('guandan-human-v1:' + raw.matchId)
    .digest()[0];
  const split = bucket < 205 ? 'train' : bucket < 230 ? 'validation' : 'test';
  const sourceSHA256 = createHash('sha256').update(JSON.stringify(raw)).digest('hex');
  const rows = [];
  const checked = validateRecord(raw, ({ index, action, hands, trick, turn }) => {
    if (action.actor !== 'human' || (action.assisted === true && !keepAssisted)) return;
    rows.push({
      schema: 1,
      source: 'human-browser',
      trust: 'unverified_browser',
      sourceSHA256,
      appVersion: raw.appVersion,
      matchId: raw.matchId,
      round: raw.round,
      seat: turn,
      actionIndex: index,
      split,
      observation: {
        level: raw.level,
        hand: hands[turn].map((c) => c.id),
        remaining: hands.map((h) => h.length),
        match: raw.match,
        trick: trick
          ? {
              seat: trick.player,
              type: trick.play.type,
              value: trick.play.value,
              n: trick.play.n,
              cards: trick.play.cards.map((c) => c.id),
            }
          : null,
        history: raw.actions
          .slice(0, index)
          .map((a) => ({ seat: a.seat, cards: a.cards, type: a.type, value: a.value, n: a.n })),
      },
      action: { cards: action.cards, type: action.type, value: action.value, n: action.n },
      decisionMs: action.decisionMs,
      ...(action.assisted === true ? { assistedOverride: true } : {}),
    });
  });
  for (const row of rows)
    row.roundOutcome = {
      order: checked.order,
      teamPoints: (checked.result.team === row.seat % 2 ? 1 : -1) * checked.result.up,
      matchTerminal: checked.result.win || checked.result.draw,
      matchWinner: checked.result.win ? checked.result.team : null,
      matchDraw: checked.result.draw,
    };
  return rows;
}
