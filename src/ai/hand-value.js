import { SEQS, isWild } from '../core/cards.js';

export let AIP;
export let UNIT_SCORE;
let unitCost;

function baseCost(cnt, L) {
  const pairs = [],
    trips = [];
  let c = 0;
  for (let r = 2; r <= 14; r++) {
    const k = cnt[r];
    if (!k) continue;
    const v = r === L ? 15 : r;
    if (k === 1) c += unitCost(v);
    else if (k === 2) pairs.push(v);
    else trips.push(v);
  }
  pairs.sort((a, b) => a - b);
  for (const t of trips) {
    c += unitCost(t);
    if (pairs.length && pairs[0] < AIP.tripPairMax) pairs.shift();
  }
  for (const p of pairs) c += unitCost(p);
  return c;
}

function seqCost(cnt, L, depth) {
  let best = baseCost(cnt, L);
  if (depth >= 2) return best;
  for (const [len, need] of SEQS) {
    for (let s = 1; s + len - 1 <= 14; s++) {
      let ok = true;
      for (let p = s; p < s + len; p++)
        if (cnt[p === 1 ? 14 : p] < need) {
          ok = false;
          break;
        }
      if (!ok) continue;
      for (let p = s; p < s + len; p++) cnt[p === 1 ? 14 : p] -= need;
      const v = AIP.seqUnit + seqCost(cnt, L, depth + 1);
      for (let p = s; p < s + len; p++) cnt[p === 1 ? 14 : p] += need;
      if (v < best) best = v;
    }
  }
  return best;
}

export function handCost(hand, L) {
  const cnt = new Array(15).fill(0);
  let w = 0,
    sj = 0,
    bj = 0;
  for (const c of hand) {
    if (isWild(c, L)) w++;
    else if (c.r === 16) sj++;
    else if (c.r === 17) bj++;
    else cnt[c.r]++;
  }
  let cost = 0;
  if (sj + bj === 4) cost -= AIP.fourJokers;
  else {
    if (sj) cost += AIP.smallJoker;
    if (bj) cost += AIP.bigJoker;
  }
  for (let r = 2; r <= 14; r++)
    if (cnt[r] >= 4) {
      cost -= AIP.bombBase + AIP.bombExtra * (cnt[r] - 4);
      cnt[r] = 0;
    }
  cost += seqCost(cnt, L, 0);
  return cost - AIP.wild * w;
}

export function initialize() {
  /* ---------- hand evaluation: roughly how many turns of control the hand still needs ---------- */
  // Parameters used by hand arrangement and rule-based hints.
  AIP = {
    // hand evaluation: a single, pair or three counts 1 turn, less for big cards; runs, bombs and wild cards
    ucTop: 0.25,
    ucA: 0.5,
    ucQK: 0.75,
    tripPairMax: 14,
    seqUnit: 0.9,
    fourJokers: 1.5,
    smallJoker: 0.3,
    bigJoker: 0.2,
    bombBase: 0.4,
    bombExtra: 0.1,
    wild: 0.9,
    // following: when to beat an opponent's cards
    urgentWin: 7,
    urgentOpp: 5,
    followFree: 0.35,
    followMaybe: 1.2,
    followMaybeProb: 0.3,
    saveJokerCurBelow: 13,
    saveJokerHand: 8,
    saveJokerProb: 0.6,
    topFree: 1,
    // when to bomb
    bombWinLeft: 7,
    bombRest: 2,
    bombOverBomb: 12,
    bombBigVal: 14,
    bombBigProb: 0.25,
    safeBombRest: 3,
    // what counts as a play that wins the lead back; arranging the hand: what each play (not bombs) costs on top of its score
    ctrlSingle: 14,
    ctrlPair: 13,
    ctrlTrip: 12,
    ctrlSeq: 9,
    armHand: 0.3,
    armNodes: 400,
    // early and middle game: how often a play that would win the lead back is kept, or a fit left to your partner
    saveCtrlProb: 0,
    midLeaveProb: 0.2,
    // 牌力 tiers (0-100, the hand as dealt): 1 aims to put both opponents last, 2 to go out first, 3 for second or third,
    // 4 not to end up both last; the weaker tiers leave more to the partner
    tier1: 85,
    tier2: 55,
    tier3: 20,
    leaveWeak: 0.5,
    // no bomb when the partner, still to play, can most likely beat it (the unseen cards dealt at random this many times)
    mateBeatProb: 0.8,
    mateSamples: 40,
    // a small card is 10 or below
    smallMax: 10,
    // an opponent's bomb, bombed back or not by how many bombs you hold (straight flushes and the four jokers count), how
    // many levels your smallest one that beats it is above theirs (one level: the smallest bomb there is that beats it),
    // and how many cards they have left. One bomb: bomb when they hold this many or fewer; not when your partner is yet to
    // play and yours is this many levels above or more. Two bombs: bomb when yours is within this many levels; not when it
    // is further above and they hold this many or more. Three or more: always, with the smallest that beats it
    bbOneLeft: 7,
    bbOneFar: 10,
    bbTwoNear: 6,
    bbTwoFarMin: 18,
    // late game, no bomb that leaves a small single to get rid of while an opponent still holds more than this many cards
    lateBombOppMax: 10,
    // top your partner's small single or pair with an ace or the level card when the next opponent holds this many or fewer
    topMateNextMax: 7,
    // each of those rules on (1) or off (0), to test them one at a time: keep big singles early, the smallest pair with a three,
    // bomb back, no hurry to bomb late, leave the joker to the partner, top the partner's small card, hand the partner a play
    // they may go out on, no three-with-a-pair or straight led to an opponent with five cards
    rKeepBig: 1,
    rSmallPair: 1,
    rBombBack: 1,
    rLateBomb: 1,
    rMateJoker: 1,
    rTopMate: 1,
    rFeed: 1,
    rNoFive: 1,
  };
  UNIT_SCORE = {
    single1: {
      2: -0.94,
      3: -0.8,
      4: -0.66,
      5: -0.55,
      6: -0.44,
      7: -0.36,
      8: -0.28,
      9: -0.18,
      10: -0.11,
      11: -0.03,
      12: 0.08,
      13: 0.18,
      14: 0.25,
      15: 0.39,
      16: 0.55,
      17: 0.77,
    },
    pair2: {
      2: -0.66,
      3: -0.61,
      4: -0.52,
      5: -0.46,
      6: -0.41,
      7: -0.34,
      8: -0.26,
      9: -0.2,
      10: -0.12,
      11: -0.01,
      12: 0.08,
      13: 0.2,
      14: 0.32,
      15: 0.48,
      16: 0.61,
      17: 0.69,
    },
    triple3: {
      2: 0,
      3: -0.05,
      4: 0.1,
      5: 0.1,
      6: 0.08,
      7: 0.13,
      8: 0.18,
      9: 0.2,
      10: 0.29,
      11: 0.32,
      12: 0.27,
      13: 0.37,
      14: 0.32,
      15: 0.18,
    },
    full5: {
      2: -0.65,
      3: -0.48,
      4: -0.36,
      5: -0.24,
      6: -0.16,
      7: -0.09,
      8: -0.01,
      9: 0.07,
      10: 0.14,
      11: 0.2,
      12: 0.25,
      13: 0.39,
      14: 0.45,
      15: 0.52,
    },
    straight5: {
      1: -0.46,
      2: -0.3,
      3: -0.18,
      4: -0.08,
      5: 0.03,
      6: 0.12,
      7: 0.2,
      8: 0.26,
      9: 0.38,
      10: 0.59,
    },
    pairs36: {
      1: -0.16,
      2: -0.07,
      3: -0.05,
      4: 0.01,
      5: -0.01,
      6: 0.05,
      7: 0.08,
      8: 0.08,
      9: 0.15,
      10: 0.18,
      11: 0.25,
      12: 0.28,
    },
    trip26: {
      1: 0.26,
      2: 0.32,
      3: 0.34,
      4: 0.29,
      5: 0.3,
      6: 0.29,
      7: 0.32,
      8: 0.25,
      9: 0.25,
      10: 0.22,
      11: 0.23,
      12: 0.18,
      13: 0.13,
    },
    bomb4: {
      2: 1.54,
      3: 1.55,
      4: 1.55,
      5: 1.56,
      6: 1.55,
      7: 1.57,
      8: 1.57,
      9: 1.58,
      10: 1.59,
      11: 1.6,
      12: 1.62,
      13: 1.63,
      14: 1.6,
      15: 1.61,
    },
    bomb5: {
      2: 1.64,
      3: 1.66,
      4: 1.68,
      5: 1.7,
      6: 1.7,
      7: 1.7,
      8: 1.71,
      9: 1.73,
      10: 1.72,
      11: 1.73,
      12: 1.72,
      13: 1.73,
      14: 1.69,
      15: 1.74,
    },
    bomb6: {
      2: 1.91,
      3: 1.91,
      4: 1.91,
      5: 1.92,
      6: 1.93,
      7: 1.93,
      8: 1.95,
      9: 1.95,
      10: 1.96,
      11: 1.98,
      12: 1.98,
      13: 1.99,
      14: 1.97,
      15: 1.97,
    },
    bomb7: {
      2: 1.98,
      3: 2,
      4: 2,
      5: 1.96,
      6: 2,
      7: 2,
      8: 2,
      9: 1.94,
      10: 2,
      11: 1.94,
      12: 2,
      13: 2,
      14: 2,
    },
    bomb8: { 2: 2, 3: 2, 4: 2, 5: 2, 9: 2, 11: 2 },
    sflush5: {
      1: 1.8,
      2: 1.82,
      3: 1.85,
      4: 1.83,
      5: 1.85,
      6: 1.85,
      7: 1.87,
      8: 1.88,
      9: 1.91,
      10: 1.94,
    },
    jokers4: { 99: 2 },
  };
  unitCost = (v) => (v >= 15 ? AIP.ucTop : v >= 14 ? AIP.ucA : v >= 12 ? AIP.ucQK : 1);
}
