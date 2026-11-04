import { runtime } from '../app/runtime.js';
import { SEQS, isWild } from '../core/cards.js';
import { analyze, beats } from '../core/combinations.js';
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
    const cardKey = (c) => c.r + c.s;

    // Both copies of a card are interchangeable; suits are not.
    function choose(cards, n) {
      const out = [];
      function visit(start, picked) {
        if (picked.length === n) {
          out.push(picked);
          return;
        }
        for (let i = start; i <= cards.length - (n - picked.length); i++) {
          if (i > start && cardKey(cards[i]) === cardKey(cards[i - 1])) continue;
          visit(i + 1, picked.concat(cards[i]));
        }
      }
      visit(0, []);
      return out;
    }

    function candidates(hand, L, cur) {
      const wild = hand.filter((c) => isWild(c, L));
      const by = {};
      for (const c of hand.filter((c) => !isWild(c, L))) (by[c.r] ||= []).push(c);
      for (const group of Object.values(by))
        group.sort((a, b) => a.s.localeCompare(b.s) || a.id - b.id);
      const out = [],
        seen = new Set();
      function add(cards) {
        const faces = cards.map(cardKey).sort().join(',');
        for (const a of analyze(cards, L)) {
          if (!beats(a, cur)) continue;
          const key = a.type + ':' + a.value + ':' + faces;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ ...a, cards, wu: cards.filter((c) => isWild(c, L)).length });
        }
      }
      function groups(rank, n) {
        const result = [];
        for (let w = 0; w <= Math.min(wild.length, n); w++) {
          if (rank >= 16 && w) continue;
          for (const cards of choose(by[rank] || [], n - w)) result.push({ cards, w });
        }
        return result;
      }
      for (let rank = 2; rank <= 17; rank++) {
        if (rank === 15) continue;
        const max = rank >= 16 ? 2 : Math.min(10, (by[rank] || []).length + wild.length);
        for (let n = 1; n <= max; n++)
          for (const g of groups(rank, n)) add(g.cards.concat(wild.slice(0, g.w)));
      }
      const jokers = (by[16] || []).concat(by[17] || []);
      if (jokers.length === 4) add(jokers);
      for (let t = 2; t <= 14; t++)
        for (const triple of groups(t, 3)) {
          for (let p = 2; p <= 17; p++) {
            if (p === t || p === 15) continue;
            for (const pair of groups(p, 2))
              if (triple.w + pair.w <= wild.length) {
                add(triple.cards.concat(pair.cards, wild.slice(0, triple.w + pair.w)));
              }
          }
        }
      for (const [len, need] of SEQS)
        for (let start = 1; start + len - 1 <= 14; start++) {
          function run(offset, cards, w) {
            if (offset === len) {
              add(cards.concat(wild.slice(0, w)));
              return;
            }
            const rank = start + offset === 1 ? 14 : start + offset;
            for (const group of groups(rank, need))
              if (w + group.w <= wild.length) {
                run(offset + 1, cards.concat(group.cards), w + group.w);
              }
          }
          run(0, [], 0);
        }
      if (cur) out.push(null);
      return out;
    }

    function state(p, plays) {
      return {
        p,
        hand: runtime.game.hands[p].map((c) => c.id),
        counts: runtime.game.hands.map((h) => h.length),
        log: runtime.game.log.map((e) => ({
          p: e.p,
          cards: e.cards ? e.cards.map((c) => c.id) : null,
        })),
        level: runtime.game.L,
        selfLevel: runtime.game.levels[(p + runtime.network.off) % 2],
        opponentLevel: runtime.game.levels[(p + runtime.network.off + 1) % 2],
        canPass: !!runtime.game.trick,
        actions: plays.map((pl) => (pl ? pl.cards.map((c) => c.id) : [])),
      };
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
      const result = await request('decide', state(p, plays));
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
          (runtime.network.mode === 'solo' && !$('#overlay').hidden))
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
      candidates,
      state,
      get ready() {
        return ready;
      },
    };
  })();
}
