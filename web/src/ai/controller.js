import { runtime } from '../app/runtime.js';
import { analyze, beats } from '../core/combinations.js';
import { candidates } from './candidates.js';
import { policyState } from './observation.js';
import { prepareTableDecision } from './table-policy.mjs';
import { botModel, botModelId, CLINT_RULE_ID, searchBot } from './model-catalog.mjs';
import { sharedSearchClient } from './search/client.js';
import { searchPayload } from './search/payload.mjs';
import { searchBand } from './search/constants.mjs';
import { ruleObservation } from '../rule-bot/runtime.mjs';
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
    function request(type, state) {
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
        const timer = setTimeout(
          () => stopWorker(new Error('AI timeout')),
          type === 'init' ? 60000 : 15000,
        );
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, type, state });
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
      prefetched = null;
    const searchSeeds = new WeakMap();
    const seatModel = (p) => botModelId(runtime.botModels?.[(p + runtime.network.off) % 4]);
    function searchRequest(p) {
      const game = runtime.game;
      const bot = searchBot(seatModel(p));
      if (!bot || game.turn !== p || privateSeat(runtime, p)) return null;
      const cards = game.hands.reduce((sum, hand) => sum + hand.length, 0);
      if (!searchBand(cards)) return null;
      const plays = candidates(game.hands[p], game.L, game.trick?.play);
      if (plays.length === 1 || plays.some((play) => play?.cards.length === game.hands[p].length))
        return null;
      const key = `${game.tok}|${game.log.length}|${p}`;
      if (prefetched?.game === game && prefetched.key === key) return prefetched.promise;
      if (!searchSeeds.has(game))
        searchSeeds.set(game, crypto.getRandomValues(new Uint32Array(1))[0]);
      searchClient ||= sharedSearchClient(VERSION);
      const payload = searchPayload(game, p, runtime.network.off, searchSeeds.get(game));
      const promise = searchClient.decide(bot.id, payload);
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

    async function decide(p, { timeout = false } = {}) {
      const game = runtime.game,
        tok = runtime.game.tok,
        count = runtime.game.log.length;
      const current = () =>
        runtime.game === game && runtime.game.tok === tok && runtime.game.log.length === count;
      await check();
      if (!current()) return null;
      if (privateSeat(runtime, p)) {
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
      const selected = botModelId(runtime.botModels?.[(p + runtime.network.off) % 4]);
      if (selected === CLINT_RULE_ID) {
        const observation = ruleObservation(game, p);
        if (timeout)
          observation.fixed = p === 0 ? (game.fixed || []).map((ids) => ids.slice()) : [];
        const result = await request(timeout ? 'rule-timeout' : 'rule', observation);
        if (!current()) return null;
        if (!result) {
          if (!game.trick) throw Error('invalid-rule-pass');
          return null;
        }
        const cards = result.cards.map((id) => game.hands[p].find((card) => card.id === id));
        if (
          cards.some((c) => !c) ||
          new Set(cards).size !== cards.length ||
          !analyze(cards, game.L).some(
            (shape) =>
              shape.type === result.type && shape.value === result.value && shape.n === result.n,
          ) ||
          !beats(result, game.trick?.play)
        )
          throw Error('invalid-rule-action');
        return { ...result, cards };
      }
      const model = botModel(selected);
      const prepared = prepareTableDecision(game, p, runtime.network.off, model.config);
      const { plays, state: input } = prepared;
      if (prepared.index != null) return plays[prepared.index];
      let search = null;
      try {
        // a human seat's timeout autoplay plays the champion at once: no extra wait after its clock
        search = timeout ? null : searchRequest(p);
      } catch {
        search = null; // an unexpected payload problem plays the champion move
      }
      if (search) {
        const result = await search;
        if (!current()) return null;
        const play = searchedPlay(result, plays, p);
        if (play !== undefined) return play;
        if (result?.ok)
          searchClient.stats.fallbacks.mismatch = (searchClient.stats.fallbacks.mismatch || 0) + 1;
      }
      input.modelId = model.id;
      const result = await request('decide', input);
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
      try {
        pl = await decide(clock.who, { timeout: clock.think == null && isHumanSeat(clock.who) });
      } catch (error) {
        if (!current()) return;
        stopWorker(error);
        showError(error.message || 'Table resources unavailable');
        showPanel(
          '<h2>牌桌准备失败</h2><p class="muted">部分游戏资源未能加载，请检查网络后重试。</p><div class="btns"><button class="btn primary" id="retryTableBtn">重试</button><button class="btn" id="leaveTableBtn">返回大厅</button></div>',
        );
        $('#retryTableBtn').onclick = () => {
          hideOverlay();
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
     * Start a research-bot search during a computer seat's think delay; decide() reuses the same
     * request. Never for a human seat: its timeout autoplay plays champion 017 without searching,
     * and a prefetch would occupy the serial search worker on every human turn.
     */
    function prefetch(p) {
      try {
        if (isHost() && runtime.game.phase === 'play' && !isHumanSeat(p)) void searchRequest(p);
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
