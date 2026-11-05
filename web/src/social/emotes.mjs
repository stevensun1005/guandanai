/**
 * Preset table emotes. Players can only send these entries, never free text: a message carries
 * just the id, so nothing typed by another player is ever shown or inserted into the page.
 */
const emoji = (id, text, label) => Object.freeze({ id, kind: 'emoji', text, label });
const phrase = (id, text) => Object.freeze({ id, kind: 'phrase', text, label: text });

export const EMOTES = Object.freeze([
  emoji('e01', '😀', '开心'),
  emoji('e02', '😂', '笑哭'),
  emoji('e03', '😎', '得意'),
  emoji('e04', '🤔', '思考'),
  emoji('e05', '😱', '震惊'),
  emoji('e06', '😭', '大哭'),
  emoji('e07', '😡', '生气'),
  emoji('e08', '😴', '睡着了'),
  emoji('e09', '👍', '点赞'),
  emoji('e10', '👏', '鼓掌'),
  emoji('e11', '🙏', '拜托'),
  emoji('e12', '💪', '加油'),
  emoji('e13', '☕', '卡布奇诺'),
  emoji('e14', '🌹', '送花'),
  emoji('e15', '💣', '炸弹'),
  emoji('e16', '🎉', '庆祝'),
  phrase('p01', '快点吧，我等的花儿都谢了'),
  phrase('p02', '给阿姨倒一杯卡布奇诺'),
  phrase('p03', '你的牌打得也太好了'),
  phrase('p04', '和你合作真是太愉快了'),
  phrase('p05', '不要走，决战到天亮'),
  phrase('p06', '大家好，很高兴见到各位'),
  phrase('p07', '不好意思，刚才网络卡了'),
  phrase('p08', '队友，靠你了！'),
  phrase('p09', '这一炸漂亮！'),
  phrase('p10', '别炸，留着！'),
  phrase('p11', '稳住，我们能赢'),
  phrase('p12', '再来一局！'),
]);

const byId = new Map(EMOTES.map((entry) => [entry.id, entry]));

/** The preset entry for an id, or null for anything else (unknown ids, non-strings). */
export const emoteById = (id) => (typeof id === 'string' && byId.get(id)) || null;

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
