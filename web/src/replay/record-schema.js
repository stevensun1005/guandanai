import { makeDeck } from '../core/cards.js';
import { analyze } from '../core/combinations.js';

export const RECORD_MARKER = '#DATA ';
export const MAX_RECORDS = 200;
const MAX_TEXT = 8 * 1024 * 1024;
const deck = makeDeck();
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const text = (value, max = 1000) => (typeof value === 'string' ? value.slice(0, max) : '');
const score = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0);

function groups(value, held) {
  if (!Array.isArray(value)) return null;
  const used = new Set();
  const result = [];
  for (const group of value.slice(0, 27)) {
    if (!Array.isArray(group)) return null;
    const clean = group.filter((id) => held.has(id) && !used.has(id) && (used.add(id), true));
    if (clean.length) result.push(clean);
  }
  for (const id of held) if (!used.has(id)) result.push([id]);
  return result;
}

/** Normalize the portable format without trusting foreign object properties. */
export function readSavedRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('记录格式不正确');
  if (input.schemaVersion != null && input.schemaVersion !== 1) throw Error('记录版本暂不支持');
  if (!integer(input.L, 2, 14) || !integer(input.no, 1, 1000000000))
    throw Error('记录局数或级牌不正确');
  if (!Array.isArray(input.hands) || input.hands.length !== 4) throw Error('记录需要四家手牌');
  const seen = new Set();
  const hands = input.hands.map((hand) => {
    if (!Array.isArray(hand) || hand.length > 27) throw Error('手牌格式不正确');
    for (const id of hand) {
      if (!integer(id, 0, 107) || seen.has(id)) throw Error('手牌含重复或无效的实体牌');
      seen.add(id);
    }
    return hand.slice();
  });
  if (!Array.isArray(input.log) || input.log.length > 2000) throw Error('出牌记录格式不正确');
  const holding = hands.map((hand) => new Set(hand));
  const log = input.log.map((entry) => {
    if (!entry || !integer(entry.p, 0, 3)) throw Error('出牌座位不正确');
    if (entry.c == null) return { p: entry.p, c: null };
    if (
      !Array.isArray(entry.c) ||
      !entry.c.length ||
      entry.c.length > 10 ||
      new Set(entry.c).size !== entry.c.length ||
      entry.c.some((id) => !holding[entry.p].has(id))
    )
      throw Error('出牌不属于该座位的手牌');
    const cards = entry.c.map((id) => deck[id]);
    const shape = analyze(cards, input.L).find(
      (reading) => reading.type === entry.type && reading.value === entry.value,
    );
    if (!shape) throw Error('记录中的牌型不正确');
    for (const id of entry.c) holding[entry.p].delete(id);
    return {
      p: entry.p,
      c: entry.c.slice(),
      lead: !!entry.lead,
      type: shape.type,
      value: shape.value,
      n: cards.length,
    };
  });
  let notes = input.notes && typeof input.notes === 'object' ? input.notes : {};
  if (input.nk !== 'all') {
    const converted = {};
    let played = 0;
    if (notes[0] != null) converted[0] = notes[0];
    log.forEach((entry, index) => {
      if (entry.c && notes[++played] != null) converted[index + 1] = notes[played];
    });
    notes = converted;
  }
  const cleanNotes = {};
  for (const [key, value] of Object.entries(notes))
    if (/^\d+$/.test(key) && integer(Number(key), 0, log.length) && typeof value === 'string')
      cleanNotes[key] = value.slice(0, 5000);
  let fingerprint = 0;
  for (const id of hands.flat()) fingerprint = (Math.imul(fingerprint, 31) + id) | 0;
  const userGroups = {},
    userPower = {};
  for (let seat = 0; seat < 4; seat++) {
    const group = groups(input.userGroups?.[seat], new Set(hands[seat]));
    if (group) userGroups[seat] = group;
    if (Number.isFinite(input.userPower?.[seat])) userPower[seat] = score(input.userPower[seat]);
  }
  return {
    schemaVersion: 1,
    uid: text(input.uid, 120) || `legacy-${input.no}-${input.L}-${fingerprint}`,
    no: input.no,
    at: text(input.at, 100),
    L: input.L,
    lvlTeam: input.lvlTeam === 1 ? 1 : 0,
    levels: Array.from({ length: 2 }, (_, index) =>
      integer(input.levels?.[index], 2, 14) ? input.levels[index] : input.L,
    ),
    leader: integer(input.leader, 0, 3) ? input.leader : 0,
    hands,
    power: Array.from({ length: 4 }, (_, seat) => score(input.power?.[seat])),
    myGroups: groups(input.myGroups, new Set(hands[0])),
    myPower: score(input.myPower),
    userGroups,
    userPower,
    rawGroups: Array.from(
      { length: 4 },
      (_, seat) =>
        groups(input.rawGroups?.[seat], new Set(hands[seat])) || hands[seat].map((id) => [id]),
    ),
    done: !!input.done,
    name: text(input.name, 120),
    trib: Array.isArray(input.trib) ? input.trib.slice(0, 20).map((line) => text(line, 300)) : [],
    kang: text(input.kang, 300),
    result: text(input.result, 1500),
    notes: cleanNotes,
    nk: 'all',
    replayOf: integer(input.replayOf, 1, 1000000000) ? input.replayOf : null,
    log,
  };
}

export function parseRecordText(source) {
  if (
    typeof source !== 'string' ||
    source.length > MAX_TEXT ||
    new TextEncoder().encode(source).length > MAX_TEXT
  )
    throw Error('记录文件过大，最多支持 8 MB');
  const index = source.lastIndexOf(RECORD_MARKER);
  if (index < 0) throw Error('没找到文件最后的记录数据，请使用完整导出文件');
  let input;
  try {
    input = JSON.parse(source.slice(index + RECORD_MARKER.length).split(/\r?\n/)[0]);
  } catch (_) {
    throw Error('记录数据不是有效的 JSON');
  }
  if (!Array.isArray(input) || input.length > MAX_RECORDS) throw Error('一次最多导入 200 局记录');
  const records = [];
  let rejected = 0;
  for (const item of input) {
    try {
      records.push(readSavedRecord(item));
    } catch (_) {
      rejected++;
    }
  }
  return { records, rejected };
}
