import { runtime } from '../app/runtime.js';
import { beats } from '../core/combinations.js';
import { candidates } from './candidates.js';
import { decisionContext, policyState } from './observation.js';
import { endgameRequest } from './endgame.js';
import { MODELS } from './models.mjs';
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
      const plays = candidates(
        runtime.game.hands[p],
        runtime.game.L,
        runtime.game.trick && runtime.game.trick.play,
      );
      const finish = plays.find((pl) => pl && pl.cards.length === runtime.game.hands[p].length);
      if (finish) return finish;
      if (plays.length === 1) return plays[0];
      const style = runtime.botStyles?.[(p + runtime.network.off) % 4] || 'balanced';
      const input = state(p, plays);
      input.profile = style;
      if (style !== 'balanced') input.context = decisionContext(runtime.game, p);
      if (style !== 'balanced' || MODELS.policy.extraFeatures === 53) {
        input.actionShapes = plays.map(
          (play) => play && { type: play.type, value: play.value, n: play.n, wu: play.wu },
        );
      }
      if (MODELS.policy.extraFeatures === 53) {
        const trick = runtime.game.trick;
        input.trick = trick && {
          player: trick.player,
          play: { type: trick.play.type, value: trick.play.value, n: trick.play.n },
        };
      }
      input.endgame = endgameRequest(runtime.game, p, plays);
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
