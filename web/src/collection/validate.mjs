import { makeDeck } from '../core/cards.js';
import { analyze, beats } from '../core/combinations.js';
import { roundOutcome } from '../core/match.js';

export const MAX_RECORD_BYTES = 98304;
const fail = (message) => {
  throw Error(message);
};
const seat = (p) => Number.isInteger(p) && p >= 0 && p < 4;
const integer = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const uuid = (s) => typeof s === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s);
const model = (m) =>
  m &&
  (m.id === 'clint-rule'
    ? m.sha256 === null
    : /^\d{3,}$/.test(m.id) && /^[a-f0-9]{64}$/.test(m.sha256)) &&
  typeof m.version === 'string' &&
  /^[\w.-]{1,80}$/.test(m.version);
const fields = (object, allowed) =>
  object && !Array.isArray(object) && Object.keys(object).every((k) => allowed.includes(k));
function hands(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((h) => !Array.isArray(h) || h.length !== 27) ||
    value.flat().some((id) => !integer(id, 0, 107)) ||
    new Set(value.flat()).size !== 108
  )
    fail('invalid_hands');
  return value.map((h) => h.slice());
}

/** Reconstruct the entire round. Structural validity is not proof of genuine human play. */
export function validateRecord(record, onAction = () => {}) {
  if (
    !fields(record, [
      'schema',
      'kind',
      'encoding',
      'id',
      'matchId',
      'round',
      'appVersion',
      'startedAt',
      'endedAt',
      'level',
      'match',
      'rules',
      'dealtHands',
      'hands',
      'leader',
      'humanMask',
      'seats',
      'tribute',
      'actions',
      'order',
    ])
  )
    fail('unknown_record_fields');
  if (
    record.schema !== 1 ||
    !['game', 'test'].includes(record.kind) ||
    record.encoding !== 'physical-108-v1' ||
    !uuid(record.matchId) ||
    !integer(record.round, 1, 200) ||
    record.id !== `${record.matchId}:${record.round}`
  )
    fail('invalid_identity');
  if (
    !/^[a-f0-9]{10}$/.test(record.appVersion) ||
    !integer(record.level, 2, 14) ||
    !seat(record.leader) ||
    !integer(record.humanMask, 0, 15) ||
    [0, 1, 2, 3].filter((p) => record.humanMask & (1 << p)).length < 2
  )
    fail('invalid_context');
  const start = Date.parse(record.startedAt),
    end = Date.parse(record.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 7 * 86400000)
    fail('invalid_time');
  if (
    !fields(record.rules, ['trib', 'aFail']) ||
    typeof record.rules.trib !== 'boolean' ||
    !['draw', 'reset', 'keep', 'once'].includes(record.rules.aFail)
  )
    fail('invalid_rules');
  const match = record.match;
  if (
    !fields(match, ['levels', 'lvlTeam', 'L', 'aFails', 'aOut']) ||
    !Array.isArray(match.levels) ||
    match.levels.length !== 2 ||
    match.levels.some((l) => !integer(l, 2, 14)) ||
    !integer(match.lvlTeam, 0, 1) ||
    match.L !== record.level ||
    match.levels[match.lvlTeam] !== record.level ||
    !Array.isArray(match.aFails) ||
    match.aFails.length !== 2 ||
    match.aFails.some((n) => !integer(n, 0, 3)) ||
    !(match.aOut === null || integer(match.aOut, 0, 1))
  )
    fail('invalid_match');
  if (
    !Array.isArray(record.seats) ||
    record.seats.length !== 4 ||
    new Set(record.seats.map((s) => s?.id)).size !== 4 ||
    record.seats.some(
      (s, p) =>
        !fields(s, ['id', 'human', 'bot']) ||
        !uuid(s.id) ||
        s.human !== !!(record.humanMask & (1 << p)) ||
        !fields(s.bot, ['id', 'sha256', 'version']) ||
        !model(s.bot),
    )
  )
    fail('invalid_seats');
  const dealt = hands(record.dealtHands),
    initial = hands(record.hands);
  if (
    !Array.isArray(record.tribute) ||
    record.tribute.length > 2 ||
    (!record.rules.trib && record.tribute.length)
  )
    fail('invalid_tribute');
  // All tribute cards move first, then all returns: simultaneous exchanges can cross.
  const move = (from, to, id) => {
    const i = dealt[from].indexOf(id);
    if (i < 0) fail('foreign_tribute');
    dealt[from].splice(i, 1);
    dealt[to].push(id);
  };
  for (const t of record.tribute) {
    if (
      !fields(t, ['from', 'to', 'card', 'returnCard']) ||
      !seat(t.from) ||
      !seat(t.to) ||
      t.from === t.to ||
      !integer(t.card, 0, 107) ||
      !integer(t.returnCard, 0, 107)
    )
      fail('invalid_tribute');
    move(t.from, t.to, t.card);
  }
  for (const t of record.tribute) move(t.to, t.from, t.returnCard);
  if (
    dealt.some(
      (h, p) =>
        h
          .slice()
          .sort((a, b) => a - b)
          .join() !==
        initial[p]
          .slice()
          .sort((a, b) => a - b)
          .join(),
    )
  )
    fail('tribute_hands_mismatch');
  if (!Array.isArray(record.actions) || !record.actions.length || record.actions.length > 600)
    fail('invalid_actions');
  const deck = makeDeck(),
    held = initial.map((h) => h.map((id) => deck[id])),
    out = [];
  let turn = record.leader,
    trick = null,
    passes = 0,
    complete = false,
    lastElapsed = 0;
  const active = (p) => held[p].length > 0;
  const next = (p) => {
    for (let n = 1; n <= 4; n++) if (active((p + n) % 4)) return (p + n) % 4;
    fail('no_active_seat');
  };
  for (let index = 0; index < record.actions.length; index++) {
    const a = record.actions[index];
    if (
      !fields(a, [
        'seat',
        'cards',
        'type',
        'value',
        'n',
        'actor',
        'humanMask',
        'model',
        'decisionMs',
        'elapsedMs',
      ]) ||
      complete ||
      a.seat !== turn ||
      !['human', 'bot', 'timeout'].includes(a.actor) ||
      !integer(a.humanMask, 0, 15) ||
      !integer(a.elapsedMs, lastElapsed, 7 * 86400000) ||
      !(a.decisionMs === null || integer(a.decisionMs, 0, 120000))
    )
      fail('invalid_action');
    lastElapsed = a.elapsedMs;
    const human = !!(a.humanMask & (1 << a.seat));
    if (
      (a.actor === 'bot' && human) ||
      (a.actor !== 'bot' && !human) ||
      (a.actor === 'human'
        ? a.model !== null
        : !fields(a.model, ['id', 'sha256', 'version']) || !model(a.model))
    )
      fail('invalid_actor');
    let play = null;
    if (a.cards !== null) {
      if (
        !Array.isArray(a.cards) ||
        !a.cards.length ||
        a.cards.length > 10 ||
        new Set(a.cards).size !== a.cards.length ||
        a.cards.some((id) => !integer(id, 0, 107))
      )
        fail('invalid_cards');
      const cards = a.cards.map((id) => held[turn].find((c) => c.id === id));
      if (cards.some((c) => !c)) fail('foreign_card');
      const shape = analyze(cards, record.level).find(
        (s) => s.type === a.type && s.value === a.value && s.n === a.n && beats(s, trick?.play),
      );
      if (!shape) fail('illegal_play');
      play = { ...shape, cards };
    } else if (!trick) fail('illegal_pass');
    onAction({ record, index, action: a, hands: held, trick, turn });
    if (play) {
      const gone = new Set(a.cards);
      held[turn] = held[turn].filter((c) => !gone.has(c.id));
      if (!active(turn)) out.push(turn);
      trick = { player: turn, play };
      passes = 0;
    } else passes++;
    if ((!active(0) && !active(2)) || (!active(1) && !active(3))) {
      const last = out.at(-1);
      for (let k = 1; k <= 4; k++) {
        const p = (last + k) % 4;
        if (!out.includes(p)) out.push(p);
      }
      complete = true;
      continue;
    }
    const winner = trick.player,
      others = [0, 1, 2, 3].filter((p) => p !== winner && active(p)).length;
    if (passes >= others) {
      turn = active(winner) ? winner : active((winner + 2) % 4) ? (winner + 2) % 4 : next(winner);
      trick = null;
      passes = 0;
    } else turn = next(turn);
  }
  if (!complete || !Array.isArray(record.order) || record.order.join() !== out.join())
    fail('incomplete_or_wrong_result');
  const outcome = roundOutcome(record.match, out, record.rules.aFail);
  return {
    ...record,
    result: outcome.result,
    levelsAfter: outcome.levels,
    remaining: held.map((h) => h.map((c) => c.id)),
    trust: 'unverified_browser',
  };
}
