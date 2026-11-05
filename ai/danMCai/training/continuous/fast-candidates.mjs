/**
 * Cached candidate generation with output identical to src/ai/candidates.js.
 *
 * candidates(hand, L, cur) filters each reading with beats(reading, cur) before de-duplicating,
 * in a generation order that does not depend on cur. So the follow list equals the lead list
 * (cur = null) filtered by beats, in the same order, plus a trailing pass. The lead list only
 * changes when the hand or the level changes, so one hand can serve many follow decisions.
 */
import { candidates } from '../../../../web/src/ai/candidates.js';
import { beats } from '../../../../web/src/core/combinations.js';

const handKey = (hand) =>
  hand
    .map((card) => card.id)
    .sort((a, b) => a - b)
    .join(',');

export function createCandidateCache({ limit = 4096 } = {}) {
  const leads = new Map();
  const stats = { hits: 0, misses: 0 };
  function lead(hand, L) {
    const key = `${L}|${handKey(hand)}`;
    let list = leads.get(key);
    if (list) {
      stats.hits++;
      // Refresh recency so the hands still in play survive eviction.
      leads.delete(key);
      leads.set(key, list);
    } else {
      stats.misses++;
      list = candidates(hand, L, null);
      leads.set(key, list);
      if (leads.size > limit) leads.delete(leads.keys().next().value);
    }
    return list;
  }
  return {
    stats,
    candidates(hand, L, cur) {
      const list = lead(hand, L);
      if (!cur) return list.slice();
      const out = list.filter((play) => beats(play, cur));
      out.push(null);
      return out;
    },
  };
}
