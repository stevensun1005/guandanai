import { runtime } from '../app/runtime.js';
import { makeDeck } from '../core/cards.js';
import { testText } from './import-export.js';
import { curRec, recName } from './inspector.js';

let TKEY;
let DECK;
export let recOut;
export let recIn;

// every turn has its number, a 过 as much as a play; records kept before then numbered the plays alone
function notesIn(o) {
  if (o.nk === 'all' || !o.notes) return o.notes || {};
  const m = {};
  let c = 0;
  if (o.notes[0] != null) m[0] = o.notes[0];
  o.log.forEach((e, i) => {
    if (e.c && o.notes[++c] != null) m[i + 1] = o.notes[c];
  });
  return m;
}

export function testStore() {
  clearTimeout(runtime.storeT);
  runtime.storeT = setTimeout(() => {
    try {
      localStorage.setItem(TKEY, JSON.stringify(runtime.TREC.rounds.slice(-200).map(recOut)));
    } catch (_) {}
  }, 300);
  testDbSoon();
}

function testDbSoon() {
  if (!window.claude || !window.claude.use) return;
  clearTimeout(runtime.dbT);
  runtime.dbT = setTimeout(() => {
    const r = curRec();
    if (r) runtime.dbBusy = runtime.dbBusy.then(() => testDbPut(r)).catch(() => {});
  }, 4000);
}

export async function testDbPut(r) {
  const db = await window.claude.use('db').catch(() => null);
  if (!db) return false;
  await db
    .collection('rounds')
    .doc(r.uid)
    .set({
      uid: r.uid,
      no: r.no,
      name: recName(r),
      at: r.at || '',
      result: r.result || '',
      done: !!r.done,
      notes: Object.keys(r.notes).length,
      saved: new Date().toLocaleString(),
      text: testText([r]),
      data: recOut(r),
    });
  return true;
}

export function testLoad() {
  try {
    return JSON.parse(localStorage.getItem(TKEY) || '[]').map(recIn);
  } catch (_) {
    return [];
  }
}

export function initialize() {
  TKEY = 'guandan-test-records';
  DECK = makeDeck();
  recOut = (r) => ({
    uid: r.uid,
    no: r.no,
    at: r.at,
    L: r.L,
    lvlTeam: r.lvlTeam,
    levels: r.levels,
    leader: r.leader,
    hands: r.hands.map((h) => h.map((c) => c.id)),
    power: r.power,
    myGroups: r.myGroups,
    myPower: r.myPower,
    userGroups: r.userGroups,
    userPower: r.userPower,
    rawGroups: r.rawGroups,
    done: !!r.done,
    name: r.name,
    trib: r.trib,
    kang: r.kang,
    result: r.result,
    notes: r.notes,
    nk: 'all',
    replayOf: r.replayOf,
    log: r.log.map((e) => ({
      p: e.p,
      c: e.cards ? e.cards.map((c) => c.id) : null,
      lead: e.lead,
      type: e.type,
      value: e.value,
      n: e.n,
    })),
  });
  recIn = (o) => ({
    ...o,
    nv: 0,
    notes: notesIn(o),
    nk: 'all',
    userGroups: o.userGroups || {},
    userPower: o.userPower || {},
    hands: o.hands.map((h) => h.map((id) => DECK[id])),
    log: o.log.map((e) => ({
      p: e.p,
      cards: e.c ? e.c.map((id) => DECK[id]) : null,
      lead: e.lead,
      type: e.type,
      value: e.value,
      n: e.n,
    })),
  });
  runtime.storeT = 0;
  runtime.dbT = 0;
  runtime.dbBusy = Promise.resolve();
}
