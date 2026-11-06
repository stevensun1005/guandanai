/**
 * Rebuild one player's decisions from an exported public match record (「整场公开牌谱」 or a
 * single round's 牌谱), so they can be compared with a model.
 *
 * A public record holds actions only, never hands. A round can be replayed for a player only
 * when that player played all 27 cards: then the hand at the start of play (after tribute) is
 * exactly the cards played. Each rebuilt decision carries the same information the in-game
 * coach sees in a normal game: own hand, public history, card counts and match context.
 */
import { makeDeck, TYPE_NAME, isWild } from '../../../web/src/core/cards.js';
import { analyze, beats, strength } from '../../../web/src/core/combinations.js';
import { roundOutcome } from '../../../web/src/core/match.js';

const RANK = { J: 11, Q: 12, K: 13, A: 14 };
const SUIT = { '♠': 'S', '♥': 'H', '♣': 'C', '♦': 'D' };
const TYPE_OF = Object.fromEntries(Object.entries(TYPE_NAME).map(([key, name]) => [name, key]));
const TYPES = Object.values(TYPE_NAME).join('|');
const ROW = new RegExp(`^\\d+\\. (.+?) (领出 )?(?:过|(${TYPES}) · (.+))$`);
const RELATIVE = { 下家: 1, 对家: 2, 上家: 3 };
export const BOMB_TYPES = new Set(['bomb', 'sflush', 'jokers']);

export const rankOf = (text) => RANK[text] || Number(text);

export function parseCard(text) {
  if (text === '小王') return { s: 'J', r: 16 };
  if (text === '大王') return { s: 'J', r: 17 };
  const s = SUIT[text[0]],
    r = rankOf(text.slice(1));
  if (!s || !(r >= 2 && r <= 14)) throw Error(`Unknown card: ${text}`);
  return { s, r };
}

/** Parse every round of the exported text. Result lines are optional (single-round exports). */
export function parseMatchRecord(text) {
  const rounds = [];
  for (const block of text.replace(/\r/g, '').split(/\n(?=掼蛋 · 第 )/)) {
    const lines = block.trim().split('\n');
    const head = lines[0]?.match(/^掼蛋 · 第 (\d+) 局 · 打 (\S+)$/);
    if (!head) continue;
    const round = { no: +head[1], L: rankOf(head[2]), entries: [], order: null, result: null };
    for (const line of lines.slice(1)) {
      let m = line.match(ROW);
      if (m) {
        round.entries.push({
          name: m[1],
          lead: !!m[2],
          type: m[3] ? TYPE_OF[m[3]] : null,
          cards: m[4] ? m[4].split(' ').map(parseCard) : [],
        });
      } else if ((m = line.match(/^名次：(.+)$/))) round.order = m[1].split(' → ');
      else if ((m = line.match(/^(我方|对方)本局获胜 · 级数 (\S+) → (\S+)/)))
        round.result = { ours: m[1] === '我方', before: rankOf(m[2]), after: rankOf(m[3]) };
    }
    if (round.entries.length) rounds.push(round);
  }
  if (!rounds.length) throw Error('No rounds found in the record');
  return rounds;
}

/**
 * Seats relative to `player` (0 = player, 1 = next to play after them, 2 = partner, 3 = before
 * them), read from the first trick of a round, where four different seats act in turn order.
 */
export function seatsOf(round, player, known = {}) {
  const seats = { ...known };
  const first = [];
  for (const entry of round.entries) {
    if (first.includes(entry.name)) break;
    first.push(entry.name);
    if (first.length === 4) break;
  }
  if (first.length === 4 && first.includes(player)) {
    const base = first.indexOf(player);
    first.forEach((name, index) => (seats[name] = (index - base + 4) % 4));
  }
  for (const entry of round.entries)
    if (!(entry.name in seats))
      throw Error(`Round ${round.no}: cannot place seat of ${entry.name}`);
  if (seats[player] !== 0) throw Error(`Round ${round.no}: ${player} did not play`);
  return seats;
}

/**
 * The exporter's seat relative to the player: 「我方/对方」 and the labels 下家/对家/上家 are written
 * from the exporter's view. Given by name, or inferred from those labels, else the player.
 */
export function exporterSeat(seats, exporter) {
  if (exporter != null) {
    if (!(exporter in seats)) throw Error(`Exporter ${exporter} is not at the table`);
    return seats[exporter];
  }
  for (const [label, offset] of Object.entries(RELATIVE))
    if (label in seats) return (seats[label] - offset + 4) % 4;
  return 0;
}

const freshIds = () => {
  const deck = makeDeck(),
    used = new Set();
  return (card) => {
    const hit = deck.find((d) => d.s === card.s && d.r === card.r && !used.has(d.id));
    if (!hit) throw Error('A card appears more than twice in one round');
    used.add(hit.id);
    return hit;
  };
};

/** The strongest legal reading of the played cards with the recorded type (as the table UI). */
export function readPlay(cards, level, type, current) {
  const options = analyze(cards, level)
    .filter((shape) => (!type || shape.type === type) && beats(shape, current))
    .sort((a, b) => strength(b) - strength(a));
  if (!options.length) throw Error('Unreadable play');
  return { ...options[0], cards };
}

/** One key per rank/shape plan, the same grouping the coach uses for its Top 5. */
export function planKey(shape, cards, level) {
  if (!cards.length) return 'pass';
  const ranks = cards.map((card) => (isWild(card, level) ? 'wild' : card.r)).sort();
  return `${shape?.type}|${shape?.value}|${ranks.join(',')}`;
}

/**
 * Rebuild the player's decisions across the whole record. Yields one object per decision with
 * a `game` the coach observation code accepts (player at seat 0), the actual cards and reading.
 */
export function replayDecisions(rounds, player, { exporter = null } = {}) {
  const decisions = [],
    skipped = [],
    warnings = [];
  let known = {},
    state = null;
  for (const round of rounds) {
    const seats = (known = seatsOf(round, player, known));
    const ownTeam = exporterSeat(seats, exporter) % 2; // the exporter's team, player's numbering
    const winner = round.result ? (round.result.ours ? ownTeam : 1 - ownTeam) : null;
    // Each round is played at the level of the previous round's winners.
    if (!state) {
      const levels = [2, 2];
      let lvlTeam = 0;
      if (round.result && round.result.before !== round.L) {
        lvlTeam = 1 - winner;
        levels[winner] = round.result.before;
      } else if (round.result) lvlTeam = winner;
      levels[lvlTeam] = round.L;
      if (round.L !== 2 || !round.result)
        warnings.push(`Round ${round.no}: starting levels inferred`);
      state = { levels, lvlTeam, aFails: [0, 0], prevOut: null };
    }
    if (state.levels[state.lvlTeam] !== round.L) {
      warnings.push(`Round ${round.no}: level ${round.L} did not follow from the record`);
      state.levels[state.lvlTeam] = round.L;
    }
    if (round.result && state.levels[winner] !== round.result.before) {
      warnings.push(`Round ${round.no}: winner level corrected from the record`);
      state.levels[winner] = round.result.before;
    }
    const take = freshIds();
    const entries = round.entries.map((entry) => ({
      ...entry,
      seat: seats[entry.name],
      cards: entry.cards.map(take),
    }));
    const mine = entries.filter((entry) => entry.seat === 0).flatMap((entry) => entry.cards);
    const usable = mine.length === 27;
    if (!usable) skipped.push({ round: round.no, played: mine.length });
    let hand = mine.slice(),
      trick = null;
    const counts = [27, 27, 27, 27],
      log = [];
    entries.forEach((entry, index) => {
      if (entry.lead) trick = null;
      const reading = entry.cards.length
        ? readPlay(entry.cards, round.L, entry.type, trick?.play)
        : null;
      if (entry.seat === 0 && usable)
        decisions.push({
          round: round.no,
          step: index + 1,
          lead: !trick,
          handSize: hand.length,
          trickCards: trick ? trick.play.cards : null,
          trickSeat: trick ? trick.player : null,
          actual: entry.cards,
          reading,
          game: {
            hands: counts.map((n, seat) => (seat === 0 ? hand.slice() : Array(n).fill(null))),
            log: log.slice(),
            L: round.L,
            levels: state.levels.slice(),
            trick,
            aFails: state.aFails.slice(),
            lvlTeam: state.lvlTeam,
            round: round.no,
            prevOut: state.prevOut?.slice() || null,
          },
        });
      if (reading) {
        log.push({
          p: entry.seat,
          cards: entry.cards,
          lead: !trick,
          type: reading.type,
          value: reading.value,
          n: reading.n,
        });
        trick = { player: entry.seat, play: reading };
        counts[entry.seat] -= entry.cards.length;
        if (counts[entry.seat] < 0) throw Error(`Round ${round.no}: a seat played more than 27`);
        if (entry.seat === 0) {
          const ids = new Set(entry.cards.map((card) => card.id));
          hand = hand.filter((card) => !ids.has(card.id));
        }
      } else log.push({ p: entry.seat, cards: null });
    });
    // Match progression as the table scores it; the record's levels win if they disagree.
    if (round.order && round.result) {
      const order = round.order.map((name) => seats[name]);
      const outcome = roundOutcome({ ...state, L: round.L }, order);
      state = {
        levels: outcome.levels,
        lvlTeam: outcome.lvlTeam,
        aFails: outcome.aFails,
        prevOut: order,
      };
      if (outcome.lvlTeam !== winner) warnings.push(`Round ${round.no}: winner differs`);
      if (state.levels[winner] !== round.result.after) {
        warnings.push(`Round ${round.no}: level after the round taken from the record`);
        state.levels[winner] = round.result.after;
      }
    } else if (round !== rounds.at(-1)) {
      warnings.push(`Round ${round.no}: no result line, later levels may be off`);
    }
  }
  return { decisions, skipped, warnings };
}
