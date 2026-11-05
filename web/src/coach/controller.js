import { runtime } from '../app/runtime.js';
import { analyze, beats, strength } from '../core/combinations.js';
import { TYPE_NAME } from '../core/cards.js';
import { VERSION } from '../network/protocol.js';
import { $ } from '../ui/cards.js';
import { layoutHand } from '../hand/layout.js';
import {
  COACH_MODEL_NAME,
  coachAllowed,
  coachObservation,
  actionKey,
  relativeRating,
} from './evaluation.mjs';

let enabled = false,
  worker,
  current,
  previous,
  requestId = 0,
  timer;
const pending = new Map(),
  exposures = new WeakMap();
const available = () => !runtime.reviewMode && coachAllowed(runtime.network.mode, runtime.rules);
const sameTurn = (s, g) => s?.game === g && s.tok === g.tok && s.count === g.log.length;
let fitting = false;
function fitCoach() {
  if (fitting) return;
  fitting = true;
  requestAnimationFrame(() => {
    const panel = $('#coachPanel');
    if (!panel.hidden) {
      layoutHand();
      const app = $('#app'),
        box = panel.getBoundingClientRect();
      let right =
        app.getBoundingClientRect().right - parseFloat(getComputedStyle(app).paddingRight);
      for (const button of document.querySelectorAll('#btns .btn')) {
        const b = button.getBoundingClientRect();
        if (b.width && b.height && b.left > box.left + 140) right = Math.min(right, b.left - 8);
      }
      const width = `${Math.max(160, Math.floor(right - box.left))}px`;
      if (panel.style.width !== width) panel.style.width = width;
    }
    fitting = false;
  });
}

function stopWorker() {
  clearTimeout(timer);
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(Error('Coach stopped'));
  }
  pending.clear();
}
async function request(state) {
  if (!worker) {
    const url = new URL('./assets/ai-worker.mjs', document.baseURI);
    url.searchParams.set('v', VERSION);
    worker = new Worker(url, { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.error) p.reject(Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      stopWorker();
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject, timer: setTimeout(stopWorker, 60000) });
    worker.postMessage({ id, type: 'coach', state });
  });
}
function startSnapshot(game) {
  const s = {
    game,
    tok: game.tok,
    count: game.log.length,
    observation: coachObservation(game, runtime.network.off),
    scores: new Map(),
  };
  current = s;
  clearTimeout(timer);
  // Wait for the selection gesture; there is only one full candidate evaluation per local turn.
  timer = setTimeout(() => {
    if (!enabled || !available() || (current !== s && previous?.snapshot !== s)) return;
    void request(s.observation)
      .then((r) => {
        s.values = r.values;
        r.actions.forEach((ids, i) => s.scores.set(actionKey(ids), r.values[i]));
      })
      .catch(() => {
        s.error = true;
      })
      .finally(renderCoach);
  }, 150);
  return s;
}
function selection(game) {
  const cards = game.hands[0].filter((c) => runtime.selection.has(c.id));
  if (!cards.length) return game.trick ? { ids: [], label: '过牌' } : null;
  const shape = analyze(cards, game.L)
    .filter((s) => beats(s, game.trick?.play))
    .sort((a, b) => strength(b) - strength(a))[0];
  return shape ? { ids: cards.map((c) => c.id), label: TYPE_NAME[shape.type] } : { invalid: true };
}
function grade(s, action) {
  if (s.error) return '评价暂不可用，请重试';
  if (!s.values) return '冠军模型评价中…';
  const key = actionKey(action.ids);
  if (!s.scores.has(key)) {
    // Physical duplicates share a tensor key. A legal omitted candidate gets its own network call.
    if (!s.extraPending) {
      s.extraPending = true;
      void request({ ...s.observation, onlyAction: action.ids })
        .then((r) => {
          s.scores.set(key, r.values[0]);
          s.values.push(r.values[0]);
        })
        .catch(() => {
          s.error = true;
        })
        .finally(() => {
          s.extraPending = false;
          renderCoach();
        });
    }
    return '冠军模型评价中…';
  }
  const score = relativeRating(s.values, s.scores.get(key));
  return `合理性 ${score.percent}%${score.flat ? ' · 候选无明显分差' : ''}`;
}

/** True only when a percentage preview was actually displayed before this move. */
export function coachAssisted() {
  return sameTurn(exposures.get(runtime.game), runtime.game);
}
export function rememberCoachMove(player, play, automatic) {
  const game = runtime.game;
  if (player !== 0 || automatic || !enabled || !available()) return;
  const s = sameTurn(current, game) ? current : startSnapshot(game);
  previous = {
    snapshot: s,
    action: {
      ids: play?.cards.map((c) => c.id) || [],
      label: play ? TYPE_NAME[play.type] : '过牌',
    },
  };
}

export function renderCoach() {
  const game = runtime.game,
    permitted = available();
  const toggle = $('#coachToggle'),
    panel = $('#coachPanel');
  toggle.hidden = !permitted;
  toggle.setAttribute('aria-pressed', String(enabled));
  toggle.textContent = enabled ? '出牌评价：开' : '出牌评价：关';
  const visible = enabled && permitted && game && ['play', 'roundEnd', 'over'].includes(game.phase);
  panel.hidden = !visible;
  if (!visible) {
    stopWorker();
    current = previous = null;
    return;
  }
  if (previous && (previous.snapshot.game !== game || previous.snapshot.tok !== game.tok))
    previous = null;
  const myTurn = game.phase === 'play' && game.turn === 0 && runtime.network.humans.has(0);
  let preview = '轮到你时预评';
  if (myTurn) {
    const s = sameTurn(current, game) ? current : startSnapshot(game),
      action = selection(game);
    preview = action?.invalid
      ? '当前选牌不能出，不评分'
      : action
        ? `${action.label} · ${grade(s, action)}`
        : '选牌查看合理性';
    if (preview.includes('合理性 ') && s.values && !s.error && !action?.invalid)
      exposures.set(game, { game, tok: game.tok, count: game.log.length });
  }
  $('#coachPreview').textContent = preview;
  $('#coachLast').textContent = previous
    ? `上一手 ${previous.action.label} · ${grade(previous.snapshot, previous.action)}`
    : '出牌后保留上一手评价';
  $('#coachRetry').hidden = !(current?.error || previous?.snapshot.error);
  fitCoach();
}
function setEnabled(value) {
  enabled = !!value;
  try {
    localStorage.setItem('guandan-coach-v1', String(enabled));
  } catch {}
  if (!enabled) {
    stopWorker();
    current = previous = null;
  }
  renderCoach();
}
export function initialize() {
  try {
    enabled = localStorage.getItem('guandan-coach-v1') === 'true';
  } catch {}
  $('#coachModel').textContent = `${COACH_MODEL_NAME} · 相对分，非胜率`;
  $('#coachToggle').onclick = () => {
    if (available()) setEnabled(!enabled);
  };
  $('#coachClose').onclick = () => setEnabled(false);
  $('#coachRetry').onclick = () => {
    stopWorker();
    current = previous = null;
    renderCoach();
  };
  new ResizeObserver(fitCoach).observe($('#coachPanel'));
  addEventListener('resize', fitCoach);
}
