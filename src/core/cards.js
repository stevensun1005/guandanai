/* ---------- cards ---------- */
export const SUITS = ['S', 'H', 'C', 'D'];

export const SUIT_CH = { S: '♠', H: '♥', C: '♣', D: '♦' };

export const SUIT_ORDER = { S: 0, H: 1, C: 2, D: 3, J: 4 };

const RN = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

export const rankName = (r) => RN[r] || String(r);

export const BASE_NAMES = ['你', '下家', '对家', '上家'];

export const PLACE = ['头游', '二游', '三游', '末游'];

export const TYPE_NAME = {
  single: '单张',
  pair: '对子',
  triple: '三张',
  full: '三带二',
  straight: '顺子',
  pairs3: '连对',
  trip2: '钢板',
  bomb: '炸弹',
  sflush: '同花顺',
  jokers: '天王炸',
};

export const SEQS = [
  [5, 1],
  [3, 2],
  [2, 3],
];

const SEQ_TYPE = { '5,1': 'straight', '3,2': 'pairs3', '2,3': 'trip2' };

export const isWild = (c, L) => c.s === 'H' && c.r === L;

export const val = (c, L) => (c.r >= 16 ? c.r : c.r === L ? 15 : c.r);

export const cardText = (c) =>
  c.r === 16 ? '小王' : c.r === 17 ? '大王' : SUIT_CH[c.s] + rankName(c.r);

export const cmpCards = (a, b, L) =>
  val(b, L) - val(a, L) ||
  isWild(b, L) - isWild(a, L) ||
  SUIT_ORDER[a.s] - SUIT_ORDER[b.s] ||
  a.id - b.id;

export function makeDeck() {
  const d = [];
  let id = 0;
  for (let k = 0; k < 2; k++) {
    for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ id: id++, s, r });
    d.push({ id: id++, s: 'J', r: 16 });
    d.push({ id: id++, s: 'J', r: 17 });
  }
  return d;
}

export function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function sortHand(h, L) {
  h.sort((a, b) => cmpCards(a, b, L));
  return h;
}
