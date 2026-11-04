import { SUIT_CH, SUIT_ORDER, isWild, rankName, val } from '../core/cards.js';

export let $;
let CROWN;

export function cardHTML(c, L, extra = '') {
  if (c.r >= 16) {
    const big = c.r === 17;
    return `<div class="card joker ${big ? 'red' : ''} ${extra}" data-id="${c.id}"><span class="idx">${[...'JOKER'].map((ch) => `<span>${ch}</span>`).join('')}</span><span class="pip">${big ? '★' : '☆'}</span><span class="jw"><span>${big ? '大' : '小'}</span><span>王</span></span></div>`;
  }
  const red = c.s === 'H' || c.s === 'D',
    wild = isWild(c, L),
    lvl = !wild && c.r === L;
  return `<div class="card ${red ? 'red' : ''} ${wild ? 'wild' : ''} ${lvl ? 'lvl' : ''} ${extra}" data-id="${c.id}"><span class="idx"><span class="rk ${c.r === 10 ? 'ten' : ''}">${rankName(c.r)}</span><span class="su">${SUIT_CH[c.s]}</span>${wild ? '<span class="tag crown" title="百搭">' + CROWN + '</span>' : ''}</span><span class="pip">${SUIT_CH[c.s]}</span></div>`;
}

// cards in the order a combination reads; a wild card sits exactly where it stands in for a missing card
export function displayOrder(play, L) {
  const cs = play.cards.slice(),
    wilds = cs.filter((c) => isWild(c, L)),
    nat = cs.filter((c) => !isWild(c, L));
  const bySuit = (a, b) => SUIT_ORDER[a.s] - SUIT_ORDER[b.s];
  const SEQ = { straight: [5, 1], sflush: [5, 1], pairs3: [3, 2], trip2: [2, 3] }[play.type];
  if (SEQ) {
    // walk the run from its lowest rank; each step takes its own cards, and a wild fills any gap;
    // then read it high to low, left to right, the same way the hand is sorted
    const [len, need] = SEQ,
      out = [],
      left = nat.slice();
    for (let q = play.value; q < play.value + len; q++) {
      const r = q === 1 ? 14 : q;
      const here = left
        .filter((c) => c.r === r)
        .sort(bySuit)
        .slice(0, need);
      for (const c of here) left.splice(left.indexOf(c), 1);
      out.push(...here);
      for (let k = here.length; k < need && wilds.length; k++) out.push(wilds.shift());
    }
    return out.reverse().concat(left, wilds);
  }
  if (play.type === 'full') {
    // the three of a kind first (a wild joins it if it is short), then the pair (with any wild it needs)
    const trip = nat.filter((c) => val(c, L) === play.value).sort(bySuit),
      pair = nat.filter((c) => val(c, L) !== play.value).sort(bySuit);
    while (trip.length < 3 && wilds.length) trip.push(wilds.shift());
    return trip.concat(pair, wilds);
  }
  return nat.sort((a, b) => val(b, L) - val(a, L) || bySuit(a, b)).concat(wilds);
}

export function initialize() {
  /* ---------- rendering ---------- */
  $ = (s) => document.querySelector(s);
  CROWN =
    '<svg viewBox="0 0 24 20" aria-hidden="true"><path d="M2 17h20v2.4H2zM1.4 15 .8 4.6l6.3 4.7L12 1l4.9 8.3 6.3-4.7-.6 10.4z"/><circle cx="12" cy="1.6" r="1.6"/><circle cx="1" cy="4.2" r="1.3"/><circle cx="23" cy="4.2" r="1.3"/></svg>';
}
