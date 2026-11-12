import { runtime } from '../app/runtime.js';
import { analyze, beats } from '../core/combinations.js';
import { candidates } from './candidates.js';
import { policyState } from './observation.js';
import { prepareTableDecision } from './table-policy.mjs';
import { botModel, botModelId, CLINT_RULE_ID, searchBot } from './model-catalog.mjs';
import { sharedSearchClient } from './search/client.js';
import { searchPayload } from './search/payload.mjs';
import { searchBand } from './search/constants.mjs';
import { decideClintRule, ruleObservation, RULES_ONLY } from '../rule-bot/runtime.mjs';
import { playMs } from '../core/table-timing.mjs';
import { FALLBACK_RETRY_MS, clintBrainMs, hardLeft } from './turn-timing.mjs';
import { act, playEvt } from '../game/events.js';
import { isHost, isHumanSeat } from '../game/session.js';
import { showError } from '../input/controls.js';
import { VERSION } from '../network/protocol.js';
import { $ } from '../ui/cards.js';
import { hideOverlay, showPanel } from '../ui/overlays.js';
import { setMsg } from '../ui/table.js';
import { privateSeat, markPrivateTable, oracleObservation } from '../private-table/state.mjs';

export let TableBot;

export function initialize() {
  /* The policy uses this seat's hand, public plays and public remaining counts. */
  TableBot = (() => {
    let ready = false,
      initialization = null,
      generation = 0;
    const clintFallbacks = { timeout: 0, error: 0 };
    /** Computer moves' time from the turn start to the decision, by seat kind (?test=1 checks). */
    const moveMs = { reason: [], clint: [], neural: [] };
    function recordMove(p, ms) {
      const id = seatModel(p);
      const list = moveMs[searchBot(id) ? 'reason' : id === CLINT_RULE_ID ? 'clint' : 'neural'];
      list.push(Math.round(ms));
      if (list.length > 500) list.shift();
    }
    let worker = null,
      requestId = 0;
    const pending = new Map();

    function stopWorker(error) {
      worker?.terminate();
      worker = null;
      ready = false;
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    }
    /** One AI-worker request; past `timeout` the worker is replaced and every request fails. */
    function request(type, state, timeout = type === 'init' ? 60000 : 15000) {
      return new Promise((resolve, reject) => {
        if (!worker) {
          const url = new URL('./assets/ai-worker.mjs', document.baseURI);
          url.searchParams.set('v', VERSION);
          worker = new Worker(url, { type: 'module' });
          worker.onmessage = ({ data }) => {
            const item = pending.get(data.id);
            if (!item) return;
            pending.delete(data.id);
            clearTimeout(item.timer);
            if (data.error) item.reject(new Error(data.error));
            else item.resolve(data.result);
          };
          worker.onerror = () => stopWorker(new Error('AI worker failed'));
        }
        const id = ++requestId;
        const timer = setTimeout(() => stopWorker(new Error('AI timeout')), timeout);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, type, state });
      });
    }
    /** `promise`, or an 'AI timeout' rejection after `ms` (the promise itself keeps running). */
    function within(promise, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('AI timeout')), Math.max(0, ms));
        promise.then(
          (value) => (clearTimeout(timer), resolve(value)),
          (error) => (clearTimeout(timer), reject(error)),
        );
      });
    }
    function state(p, plays) {
      return policyState(runtime.game, p, runtime.network.off, plays);
    }

    /*
     * Belief-search research bot: a separate worker (shared with the move coach, table jobs
     * first); any failure plays champion 017 instead.
     */
    let searchClient = null,
      prefetched = null,
      turnStart = null;
    const searchSeeds = new WeakMap();
    const seatModel = (p) => botModelId(runtime.botModels?.[(p + runtime.network.off) % 4]);
    const turnKey = (game, p) => `${game.tok}|${game.log.length}|${p}`;
    /**
     * When seat p's current turn started on this host (performance.now() clock): recorded by
     * prefetch() as the turn's clock is created, so the thinking pause and any first-load wait
     * count against the 50 s reasoning limit (owner rule 2026-11-09, turn-timing.mjs). Without a
     * record (a restored host) the turn's game clock gives the elapsed time.
     */
    function turnStartedAt(p, clock) {
      const game = runtime.game;
      if (turnStart?.game === game && turnStart.key === turnKey(game, p)) return turnStart.at;
      const elapsed =
        clock && Number.isFinite(clock.total - clock.left) ? clock.total - clock.left : 0;
      return performance.now() - Math.max(0, elapsed);
    }
    function searchRequest(p, startedAt = turnStartedAt(p)) {
      const game = runtime.game;
      const bot = searchBot(seatModel(p));
      if (!bot || game.turn !== p || privateSeat(runtime, p)) return null;
      const cards = game.hands.reduce((sum, hand) => sum + hand.length, 0);
      if (!searchBand(cards)) return null;
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      if (plays.length === 1 || plays.some((play) => play?.cards.length === game.hands[p].length))
        return null;
      const key = turnKey(game, p);
      if (prefetched?.game === game && prefetched.key === key) return prefetched.promise;
      if (!searchSeeds.has(game))
        searchSeeds.set(game, crypto.getRandomValues(new Uint32Array(1))[0]);
      searchClient ||= sharedSearchClient(VERSION);
      const payload = searchPayload(game, p, runtime.network.off, searchSeeds.get(game));
      const promise = searchClient.decide(bot.id, payload, {
        startedAt,
        turnMs: playMs(runtime.rules),
      });
      prefetched = { game, key, promise };
      return promise;
    }
    /** The searched play, or undefined when the reply does not match this table exactly. */
    function searchedPlay(result, plays, p) {
      const game = runtime.game;
      if (!result?.ok || !Number.isInteger(result.index) || result.index >= plays.length)
        return undefined;
      const play = plays[result.index];
      const ids = (list) =>
        list
          .slice()
          .sort((a, b) => a - b)
          .join(',');
      if (!play) return game.trick && !result.ids.length && !result.shape ? null : undefined;
      if (
        ids(play.cards.map((card) => card.id)) !== ids(result.ids) ||
        play.type !== result.shape?.type ||
        play.value !== result.shape.value ||
        play.n !== result.shape.n ||
        !play.cards.every((card) => game.hands[p].includes(card)) ||
        !beats(play, game.trick?.play)
      )
        return undefined;
      return play;
    }

    async function check() {
      if (ready) return;
      if (!initialization)
        initialization = (async () => {
          try {
            if (!/^https?:$/.test(location.protocol))
              throw new Error('Open the published game URL');
            await request('init');
            ready = true;
          } catch (error) {
            stopWorker(error);
            throw error;
          } finally {
            initialization = null;
          }
        })();
      return initialization;
    }

    async function decide(p, { timeout = false, startedAt = turnStartedAt(p) } = {}) {
      const game = runtime.game,
        tok = runtime.game.tok,
        count = runtime.game.log.length;
      const current = () =>
        runtime.game === game && runtime.game.tok === tok && runtime.game.log.length === count;
      const selected = botModelId(runtime.botModels?.[(p + runtime.network.off) % 4]);
      if (!timeout && selected === CLINT_RULE_ID && !privateSeat(runtime, p))
        return clintDecide(game, p, startedAt, current);
      if (privateSeat(runtime, p)) {
        await check();
        if (!current()) return null;
        markPrivateTable(runtime);
        const result = await request('oracle', oracleObservation(game, p));
        if (!current()) return null;
        const index = result.values.indexOf(Math.max(...result.values));
        const ids = result.actions[index];
        if (!ids?.length) {
          if (!game.trick) throw Error('invalid-oracle-pass');
          return null;
        }
        const cards = ids.map((id) => game.hands[p].find((card) => card.id === id));
        const expected = result.shapes[index];
        const shape =
          cards.every(Boolean) &&
          analyze(cards, game.L).find(
            (s) =>
              s.type === expected?.type &&
              s.value === expected.value &&
              s.n === expected.n &&
              beats(s, game.trick?.play),
          );
        if (!shape) throw Error('invalid-oracle-action');
        return { ...shape, cards };
      }
      if (selected === CLINT_RULE_ID) {
        // a human seat's timeout autoplay with Clint's timeout rule
        await check();
        if (!current()) return null;
        const observation = ruleObservation(game, p);
        observation.fixed = p === 0 ? (game.fixed || []).map((ids) => ids.slice()) : [];
        const result = await request('rule-timeout', observation);
        if (!current()) return null;
        const play = rulePlay(game, p, result);
        if (play === undefined) throw Error('invalid-rule-action');
        return play;
      }
      const model = botModel(selected);
      const prepared = prepareTableDecision(game, p, runtime.network.off, model.config);
      const { plays, state: input } = prepared;
      if (prepared.index != null) return plays[prepared.index];
      const moveRemaining = () =>
        timeout ? 15000 : Math.max(0, startedAt + playMs(runtime.rules) - performance.now());
      let search = null;
      try {
        // a human seat's timeout autoplay plays the champion at once: no extra wait after its clock
        search = timeout ? null : searchRequest(p, startedAt);
      } catch {
        search = null; // an unexpected payload problem plays the champion move
      }
      input.modelId = model.id;
      // Champion 017's move is computed on the AI worker while the search runs (a separate
      // worker), so a fallback at the 50 s mark is played at once; a searched move never waits
      // for the AI worker.
      let champion = null;
      if (search) {
        champion = check().then(() => request('decide', input));
        champion.catch(() => {});
        const result = await search;
        if (!current()) return null;
        const play = searchedPlay(result, plays, p);
        if (play !== undefined) return play;
        if (result?.ok)
          searchClient.stats.fallbacks.mismatch = (searchClient.stats.fallbacks.mismatch || 0) + 1;
      } else {
        await within(check(), moveRemaining());
        if (!current()) return null;
      }
      let result;
      try {
        result = await within(
          champion || request('decide', input, Math.min(15000, moveRemaining())),
          moveRemaining(),
        );
      } catch (error) {
        if (!champion) throw error;
        // the early request failed (a replaced worker): ask once more, still before 60 s
        if (!current()) return null;
        result = await request('decide', input, Math.min(FALLBACK_RETRY_MS, moveRemaining()));
      }
      if (!current()) return null;
      if (!Number.isInteger(result.index) || result.index < 0 || result.index >= plays.length)
        throw new Error('invalid-action');
      const pl = plays[result.index];
      if (
        pl &&
        (!pl.cards.every((c) => runtime.game.hands[p].includes(c)) ||
          !beats(pl, runtime.game.trick && runtime.game.trick.play))
      )
        throw new Error('stale-action');
      return pl;
    }

    /** The rule worker's reply as a play of seat p; undefined when it does not fit the table. */
    function rulePlay(game, p, result) {
      if (!result) return game.trick ? null : undefined;
      const cards = (result.cards || []).map((id) => game.hands[p].find((card) => card.id === id));
      if (
        !cards.length ||
        cards.some((c) => !c) ||
        new Set(cards).size !== cards.length ||
        !analyze(cards, game.L).some(
          (shape) =>
            shape.type === result.type && shape.value === result.value && shape.n === result.n,
        ) ||
        !beats(result, game.trick?.play)
      )
        return undefined;
      return { ...result, cards };
    }
    /**
     * A Clint seat's move: the rules, then the 残局大脑 for at most 30 s and never past the turn's
     * 50 s mark (owner rule 2026-11-09, turn-timing.mjs). A rule worker that is not loaded or still
     * busy at 52 s is replaced; then, as after a worker error or an unusable reply, the rules-only
     * move is computed here on the page (well under 20 ms) and played: never the failure panel.
     * Not sticky: the next move asks the worker for the brain again.
     */
    async function clintDecide(game, p, startedAt, current) {
      const observation = ruleObservation(game, p);
      try {
        await within(check(), hardLeft(startedAt, performance.now(), playMs(runtime.rules)));
        if (!current()) return null;
        const result = await request(
          'rule',
          {
            ...observation,
            brainMs: clintBrainMs(performance.now() - startedAt, playMs(runtime.rules)),
          },
          Math.max(1000, hardLeft(startedAt, performance.now(), playMs(runtime.rules))),
        );
        if (!current()) return null;
        const play = rulePlay(game, p, result);
        if (play !== undefined) return play;
        throw new Error('invalid-rule-action');
      } catch (error) {
        if (!current()) return null;
        clintFallbacks[/timeout/i.test(error.message) ? 'timeout' : 'error']++;
      }
      const play = rulePlay(game, p, decideClintRule(observation, RULES_ONLY));
      if (play === undefined) throw Error('invalid-rule-action');
      return play;
    }

    async function playTurn(clock) {
      const game = runtime.game,
        tok = runtime.game.tok,
        turn = runtime.game.turn,
        count = runtime.game.log.length,
        request = ++generation;
      const current = () =>
        runtime.game === game &&
        runtime.game.tok === tok &&
        runtime.game.turn === turn &&
        runtime.game.phase === 'play' &&
        runtime.game.log.length === count &&
        isHost() &&
        generation === request;
      let pl;
      const autoplay = clock.think == null && isHumanSeat(clock.who),
        startedAt = turnStartedAt(clock.who, clock);
      try {
        pl = await decide(clock.who, { timeout: autoplay, startedAt });
        if (current() && !autoplay) recordMove(clock.who, performance.now() - startedAt);
      } catch (error) {
        if (!current()) return;
        stopWorker(error);
        showError(error.message || 'Table resources unavailable');
        showPanel(
          '<h2>牌桌准备失败</h2><p class="muted">部分游戏资源未能加载，请检查网络后重试。</p><div class="btns"><button class="btn primary" id="retryTableBtn">重试</button><button class="btn" id="leaveTableBtn">返回大厅</button></div>',
        );
        $('#retryTableBtn').onclick = () => {
          hideOverlay();
          turnStart = null; // a retry is a fresh attempt: its time counts from the clock again
          if (current()) void playTurn(clock);
        };
        $('#leaveTableBtn').onclick = () => location.reload();
        return;
      }
      if (!current()) return;
      // Keep an in-flight reply pending while pause/replay panels are visible.
      while (
        current() &&
        (runtime.game.paused ||
          runtime.replayView.open ||
          runtime.replayView.edit ||
          (runtime.network.mode === 'solo' && (!$('#overlay').hidden || $('#rulesDialog').open)))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!current()) return;
      if (clock.who === 0) {
        runtime.selection = new Set();
        setMsg(pl ? '时间到，已自动出牌' : '时间到，自动过');
      }
      act({ ...playEvt(clock.who, pl), automatic: true });
    }

    function init() {
      void check().catch(() => {});
      const bot = [0, 1, 2, 3]
        .filter((p) => !isHumanSeat(p))
        .map(seatModel)
        .find((id) => searchBot(id));
      if (bot && /^https?:$/.test(location.protocol)) {
        searchClient ||= sharedSearchClient(VERSION);
        searchClient.warm(bot);
      }
    }
    /**
     * A computer seat's turn starts (its clock was just created): record the start, from which
     * the 50 s reasoning limit counts, and start a research-bot search during the think delay;
     * decide() reuses the same request. Never for a human seat: its timeout autoplay plays
     * champion 017 without searching, and a prefetch would occupy the serial search worker on
     * every human turn.
     */
    function prefetch(p) {
      try {
        if (!isHost() || runtime.game.phase !== 'play' || isHumanSeat(p)) return;
        const game = runtime.game;
        turnStart = { game, key: turnKey(game, p), at: performance.now() };
        void searchRequest(p, turnStart.at);
      } catch {
        /* decide() rebuilds the request and falls back to the champion. */
      }
    }
    return {
      init,
      check,
      decide,
      prefetch,
      playTurn,
      get searchStats() {
        return searchClient?.stats || null;
      },
      /** Per kind: milliseconds from each computer turn's start to its decision. */
      get moveTimes() {
        return Object.fromEntries(
          Object.entries(moveMs).map(([kind, list]) => [kind, list.slice()]),
        );
      },
      /** Clint seats that played the rules-only move after a brain overrun or worker failure. */
      get clintFallbacks() {
        return { ...clintFallbacks };
      },
      cancelTurn() {
        generation++;
      },
      candidates,
      state,
      get ready() {
        return ready;
      },
    };
  })();
}
