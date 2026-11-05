import { runtime } from '../app/runtime.js';
import { analyze, beats } from '../core/combinations.js';
import { candidates } from './candidates.js';
import { policyState } from './observation.js';
import { prepareTableDecision } from './table-policy.mjs';
import { botModel, botModelId, CLINT_RULE_ID } from './model-catalog.mjs';
import { ruleObservation } from '../rule-bot/runtime.mjs';
import { act, playEvt } from '../game/events.js';
import { isHost } from '../game/session.js';
import { showError } from '../input/controls.js';
import { VERSION } from '../network/protocol.js';
import { $ } from '../ui/cards.js';
import { hideOverlay, showPanel } from '../ui/overlays.js';
import { setMsg } from '../ui/table.js';

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

    async function decide(p) {
      const game = runtime.game,
        tok = runtime.game.tok,
        count = runtime.game.log.length;
      const current = () =>
        runtime.game === game && runtime.game.tok === tok && runtime.game.log.length === count;
      await check();
      if (!current()) return null;
      const selected = botModelId(runtime.botModels?.[(p + runtime.network.off) % 4]);
      if (selected === CLINT_RULE_ID) {
        const result = await request('rule', ruleObservation(game, p));
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
        pl = await decide(clock.who);
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
      act(playEvt(clock.who, pl));
    }

    function init() {
      void check().catch(() => {});
    }
    return {
      init,
      check,
      decide,
      playTurn,
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
