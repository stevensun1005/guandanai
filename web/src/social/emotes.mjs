/**
 * Preset table emotes. Players can only send these entries, never free text: a message carries
 * just the id (and, for gifts, the receiving seat), so nothing typed by another player is ever
 * shown or inserted into the page.
 *
 * kinds:
 *   gift   - thrown at another seat (cappuccino, flower, bomb) with a flight and landing effect
 *   emoji  - played beside the sender (sunglasses, crying) with an effect
 *   phrase - a quick phrase bubble, read aloud by the browser's speech synthesis
 */
const entry = (id, kind, text, label) => Object.freeze({ id, kind, text, label });

export const EMOTES = Object.freeze([
  entry('g01', 'gift', '☕', '卡布奇诺'),
  entry('g02', 'gift', '🌹', '鲜花'),
  entry('g03', 'gift', '💣', '炸弹'),
  entry('e01', 'emoji', '😎', '墨镜'),
  entry('e02', 'emoji', '😭', '哭'),
  ...[
    '快点吧，我等的花儿都谢了',
    '给阿姨倒一杯卡布奇诺',
    '你的牌打得也太好了',
    '和你合作真是太愉快了',
    '不要走，决战到天亮',
    '大家好，很高兴见到各位',
    '不好意思，刚才网络卡了',
    '队友，靠你了！',
    '这一炸漂亮！',
    '别炸，留着！',
    '稳住，我们能赢',
    '再来一局！',
  ].map((text, i) => entry(`p${String(i + 1).padStart(2, '0')}`, 'phrase', text, text)),
]);

const byId = new Map(EMOTES.map((item) => [item.id, item]));

/** The preset entry for an id, or null for anything else (unknown ids, non-strings). */
export const emoteById = (id) => (typeof id === 'string' && byId.get(id)) || null;

/** Gifts need another seat as the receiver; every other kind must not name one. */
export function validTarget(item, from, to) {
  if (!item) return false;
  if (item.kind !== 'gift') return to === undefined || to === null;
  return Number.isInteger(to) && to >= 0 && to <= 3 && to !== from;
}

/** Minimum gap between two emotes from the same seat. */
export const EMOTE_COOLDOWN_MS = 2500;

/** Per-seat rate limit: returns true and records the time when a seat may send now. */
export function createEmoteLimiter(cooldown = EMOTE_COOLDOWN_MS, now = () => Date.now()) {
  const last = new Map();
  return (seat) => {
    const t = now();
    if (last.has(seat) && t - last.get(seat) < cooldown) return false;
    last.set(seat, t);
    return true;
  };
}

/**
 * A computer seat that receives a gift answers with one of these, aimed back at the sender for
 * gifts: a cappuccino or a flower is returned or met with sunglasses, a bomb is returned or cried at.
 */
export const BOT_REPLIES = Object.freeze({
  g01: Object.freeze(['g01', 'e01']),
  g02: Object.freeze(['g02', 'e01']),
  g03: Object.freeze(['g03', 'e02']),
});

export function botReply(giftId, random = Math.random) {
  const options = BOT_REPLIES[giftId];
  return options ? options[Math.floor(random() * options.length) % options.length] : null;
}
