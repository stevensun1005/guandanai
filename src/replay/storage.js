import { runtime } from '../app/runtime.js';
import { makeDeck } from '../core/cards.js';
import { MAX_RECORDS, readSavedRecord } from './record-schema.js';

let TKEY;
let DECK;
export let recOut;
export let recIn;
const statusListeners = new Set();
export function onRecordStorageStatus(listener) {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function practiceStore() {
  clearTimeout(runtime.storeT);
  runtime.storeT = setTimeout(() => {
    try {
      localStorage.setItem(
        TKEY,
        JSON.stringify(runtime.TREC.rounds.slice(-MAX_RECORDS).map(recOut)),
      );
      localStorage.removeItem('guandan-test-records');
      for (const listener of statusListeners) listener({ saved: true });
    } catch (_) {
      for (const listener of statusListeners) listener({ saved: false });
    }
  }, 300);
}

export function practiceLoad() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(TKEY) || localStorage.getItem('guandan-test-records') || '[]',
    );
    if (!Array.isArray(saved)) return [];
    return saved.slice(-MAX_RECORDS).flatMap((record) => {
      try {
        return [recIn(record)];
      } catch (_) {
        return [];
      }
    });
  } catch (_) {
    return [];
  }
}

export function initialize() {
  TKEY = 'guandan-practice-records';
  DECK = makeDeck();
  recOut = (r) => ({
    schemaVersion: 1,
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
  recIn = (source) => {
    const o = readSavedRecord(source);
    return {
      ...o,
      nv: 0,
      notes: o.notes,
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
    };
  };
  runtime.storeT = 0;
}
