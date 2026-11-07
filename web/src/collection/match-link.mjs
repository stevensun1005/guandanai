/** Between-round continuity: no hands, names, room credentials or training data. */
import { startOptions, START_DIRS } from '../lobby/start-state.mjs';
export const MATCH_KEY = 'guandan-match-continuity-v1';
const identities = new WeakMap();
export const matchExcluded = (game) => identities.get(game)?.excluded === true;
const uuid = (x) => typeof x === 'string' && /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(x);
export function readMatch(storage, now = Date.now()) {
  try {
    const v = JSON.parse(storage.getItem(MATCH_KEY) || 'null');
    if (
      !v ||
      !uuid(v.id) ||
      v.players?.length !== 4 ||
      !v.players.every(uuid) ||
      new Set(v.players).size !== 4 ||
      !Number.isSafeInteger(v.nextRound) ||
      v.nextRound < 2 ||
      v.nextRound > 200 ||
      !Number.isFinite(v.savedAt) ||
      v.savedAt > now ||
      now - v.savedAt > 30 * 86400000 ||
      typeof v.rules?.trib !== 'boolean' ||
      !['draw', 'reset', 'once'].includes(v.rules.aFail)
    )
      return null;
    const state = startOptions({ startState: v.state });
    if (
      !state.order.every(Boolean) ||
      !state.playSide ||
      JSON.stringify(state) !== JSON.stringify(v.state)
    )
      return null;
    return {
      id: v.id,
      players: v.players,
      nextRound: v.nextRound,
      state,
      rules: v.rules,
      excluded: v.excluded === true,
      savedAt: v.savedAt,
    };
  } catch {
    return null;
  }
}
export function sameMatchStart(saved, rules) {
  return (
    !!saved &&
    saved.rules.trib === !!rules.trib &&
    saved.rules.aFail === rules.aFail &&
    JSON.stringify(saved.state) === JSON.stringify(startOptions(rules))
  );
}
export function matchIdentity(game, context, resume = null) {
  if (context.practice || !['solo', 'host'].includes(context.mode)) return null;
  let identity = identities.get(game);
  if (!identity) {
    const old = game.round === 1 && sameMatchStart(resume, context.rules) ? resume : null;
    const players = old?.players || Array.from({ length: 4 }, () => crypto.randomUUID()),
      own = Math.max(0, START_DIRS.indexOf(context.direction));
    identity = {
      id: old?.id || crypto.randomUUID(),
      absolutePlayers: players,
      players: players.map((_, p) => players[(p + own) % 4]),
      base: old ? old.nextRound - 1 : 0,
      excluded: !!old?.excluded,
    };
    identities.set(game, identity);
  }
  identity.excluded ||= context.excluded === true;
  return identity;
}
export function rememberMatch(game, context, storage) {
  if (context.practice || !['solo', 'host'].includes(context.mode) || !game.result) return false;
  if (
    ![0, 1].includes(game.result.team) ||
    game.result.order?.length !== 4 ||
    new Set(game.result.order).size !== 4 ||
    game.result.order.some((p) => ![0, 1, 2, 3].includes(p))
  )
    return false;
  const identity = matchIdentity(game, context);
  try {
    if (game.result.win || game.result.draw) {
      storage.removeItem(MATCH_KEY);
      return true;
    }
    const own = Math.max(0, START_DIRS.indexOf(context.direction)),
      dir = (p) => START_DIRS[(p + own) % 4],
      side = (p) => ('SN'.includes(dir(p)) ? 'SN' : 'EW');
    const state = {
      levels: { SN: 2, EW: 2 },
      playSide: side(game.result.team),
      order: game.result.order.map(dir),
      aFails: { SN: 0, EW: 0 },
      aOut: game.aOut == null ? '' : side(game.aOut),
    };
    for (const team of [0, 1]) {
      state.levels[side(team)] = game.levels[team];
      state.aFails[side(team)] = game.aFails[team];
    }
    storage.setItem(
      MATCH_KEY,
      JSON.stringify({
        id: identity.id,
        players: identity.absolutePlayers,
        nextRound: identity.base + game.round + 1,
        state,
        rules: { trib: !!context.rules.trib, aFail: context.rules.aFail },
        excluded: identity.excluded,
        savedAt: Date.now(),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** Mark the saved match immediately, even if the page closes before this round finishes. */
export function excludeMatch(game, storage, pending = null, rules = {}) {
  const identity = identities.get(game);
  if (identity) identity.excluded = true;
  const id = identity?.id || (sameMatchStart(pending, rules) ? pending.id : null),
    saved = readMatch(storage);
  if (!id || !saved || saved.id !== id || saved.excluded) return;
  try {
    storage.setItem(MATCH_KEY, JSON.stringify({ ...saved, excluded: true }));
  } catch {
    try {
      storage.removeItem(MATCH_KEY);
    } catch {
      /* No persistent resume if the store rejects all access. */
    }
  }
}
