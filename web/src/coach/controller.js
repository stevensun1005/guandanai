import { runtime } from '../app/runtime.js';
import { analyze, beats, strength } from '../core/combinations.js';
import { TYPE_NAME, BASE_NAMES, makeDeck, cardText } from '../core/cards.js';
import { VERSION } from '../network/protocol.js';
import { $ } from '../ui/cards.js';
import { layoutHand, stackedControls } from '../hand/layout.js';
import { renderHand } from '../hand/view.js';
import { privateActive, oracleObservation } from '../private-table/state.mjs';
import {
  COACH_MODEL_NAME,
  coachAllowed,
  coachObservation,
  actionKey,
  relativeRating,
  rankedCoachActions,
} from './evaluation.mjs';

let enabled = false,
  worker,
  current,
  previous,
  requestId = 0,
  timer,
  topOpen = true;
const deck = makeDeck();
const pending = new Map(),
  exposures = new WeakMap();
const available = () =>
  !runtime.reviewMode &&
  (coachAllowed(runtime.network.mode, runtime.rules) || privateActive(runtime));
const sameTurn = (s, g) =>
  s?.game === g &&
  s.tok === g.tok &&
  s.count === g.log.length &&
  s.epoch === (runtime.privateEpoch || 0);
let fitting = false;
function fitCoach() {
  if (fitting) return;
  fitting = true;
  requestAnimationFrame(() => {
    const panel = $('#coachPanel'),
      suggestions = $('#coachSuggestions');
    const stacked = stackedControls();
    if (stacked && suggestions.parentElement !== $('#app')) panel.after(suggestions);
    else if (!stacked && suggestions.parentElement === $('#app')) document.body.append(suggestions);
    if (!panel.hidden) {
      layoutHand();
      const app = $('#app'),
        box = panel.getBoundingClientRect();
      let right =
        app.getBoundingClientRect().right - parseFloat(getComputedStyle(app).paddingRight);
      if (!stacked) {
        for (const button of document.querySelectorAll('#btns .btn')) {
          const b = button.getBoundingClientRect();
          if (b.width && b.height && b.left > box.left + 140) right = Math.min(right, b.left - 8);
        }
      }
      const width = `${Math.max(160, Math.floor(right - box.left))}px`;
      if (panel.style.width !== width) panel.style.width = width;
      const popup = suggestions.getBoundingClientRect();
      let ceiling = box.top,
        available = 0;
      if (!stacked && innerWidth < 800 && !suggestions.hidden) {
        const obstacles = [...document.querySelectorAll('#btns .btn, #mebar, #selectionBar')]
          .map((e) => e.getBoundingClientRect())
          .filter((r) => r.width && r.height);
        const headers = [...document.querySelectorAll('.bar button')]
          .map((e) => e.getBoundingClientRect())
          .filter((r) => r.width && r.height);
        const choices = [innerWidth - popup.width - 12, 12]
          .map((left) => {
            const intersects = (r) => r.right > left && r.left < left + popup.width;
            const bottom = Math.min(box.top, ...obstacles.filter(intersects).map((r) => r.top));
            const floor = Math.max(8, ...headers.filter(intersects).map((r) => r.bottom + 8));
            return { left, bottom, height: bottom - floor - 8 };
          })
          .sort((a, b) => b.height - a.height);
        const best = choices[0];
        suggestions.style.left = `${best.left}px`;
        suggestions.style.right = 'auto';
        ceiling = best.bottom;
        available = best.height;
      } else {
        suggestions.style.left = suggestions.style.right = '';
      }
      document.documentElement.style.setProperty(
        '--coach-popup-height',
        `${Math.max(52, available)}px`,
      );
      document.documentElement.style.setProperty(
        '--coach-popup-bottom',
        `${Math.max(8, innerHeight - ceiling + 8)}px`,
      );
    }
    fitting = false;
  });
}

// A rating below the fold, clipped inside a scroller or covered by a result is not a shown preview.
function visibleRating(element, rect = element.getBoundingClientRect()) {
  if (!element.isConnected || getComputedStyle(element).visibility !== 'visible') return false;
  let left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right),
    top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent),
      bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
  }
  if (left >= right || top >= bottom) return false;
  return element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
}
function markDisplayedRatings() {
  const game = runtime.game;
  if (
    !enabled ||
    !available() ||
    !sameTurn(current, game) ||
    game.turn !== 0 ||
    !current.values ||
    current.error
  )
    return;
  const old = exposures.get(game);
  if (
    old &&
    old.tok === game.tok &&
    old.count === game.log.length &&
    old.epoch === (runtime.privateEpoch || 0)
  )
    return;
  const preview = $('#coachPreview'),
    match = preview.textContent.match(/合理性 (\d+%)/);
  let shown = false;
  if (match && preview.firstChild?.nodeType === window.Node.TEXT_NODE) {
    const range = document.createRange(),
      offset = match.index + '合理性 '.length;
    range.setStart(preview.firstChild, offset);
    range.setEnd(preview.firstChild, offset + match[1].length);
    shown = visibleRating(preview, range.getBoundingClientRect());
  }
  if (!shown && !$('#coachSuggestions').hidden)
    shown = [...document.querySelectorAll('#coachTop5 .coach-choice-heading b')].some((e) =>
      visibleRating(e),
    );
  if (shown)
    exposures.set(game, {
      game,
      tok: game.tok,
      count: game.log.length,
      epoch: runtime.privateEpoch || 0,
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
    epoch: runtime.privateEpoch || 0,
    observation: coachObservation(game),
    scores: new Map(),
  };
  if (privateActive(runtime)) s.observation.oracle = oracleObservation(game);
  current = s;
  clearTimeout(timer);
  // Wait for the selection gesture; there is only one full candidate evaluation per local turn.
  timer = setTimeout(() => {
    if (!enabled || !available() || (current !== s && previous?.snapshot !== s)) return;
    void request(s.observation)
      .then((r) => {
        s.values = r.values;
        s.actions = r.actions;
        s.search = r.search;
        r.actions.forEach((ids, i) => s.scores.set(actionKey(ids), r.values[i]));
        // Private-table rollouts return the moves they assumed; show them so a ranking can be checked.
        s.lines = new Map((r.lines || []).map((line, i) => [actionKey(r.actions[i]), line]));
        s.ranked = rankedCoachActions(s.actions, s.values, game.L, 5, s.observation.trick?.play);
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
          if (r.lines?.[0]) s.lines?.set(key, r.lines[0]);
          s.values.push(r.values[0]);
          s.actions.push(r.actions[0]);
          if (s.search) {
            s.search.evaluated = s.actions.length;
          }
          s.ranked = rankedCoachActions(
            s.actions,
            s.values,
            s.observation.level,
            5,
            s.observation.trick?.play,
          );
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
  markDisplayedRatings();
  return sameTurn(exposures.get(runtime.game), runtime.game);
}
/** Restore only a previously displayed preview on the unchanged saved decision. */
export function restoreCoachExposure(game, shown) {
  if (shown)
    exposures.set(game, {
      game,
      tok: game.tok,
      count: game.log.length,
      epoch: runtime.privateEpoch || 0,
    });
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
  document.body.classList.toggle('has-coach', !!visible);
  document.body.classList.toggle('has-coach-top', !!visible && topOpen);
  $('#coachSuggestions').hidden = !visible || !topOpen;
  $('#coachTopToggle').setAttribute('aria-expanded', String(topOpen));
  $('#coachTopToggle').textContent = topOpen ? '收起 Top 5' : '展开 Top 5';
  $('#coachModel').textContent =
    `${COACH_MODEL_NAME}${privateActive(runtime) ? ' · 明牌推演' : ''} · 相对分，非胜率`;
  if (!visible) {
    stopWorker();
    current = previous = null;
    $('#coachTop5').replaceChildren();
    return;
  }
  if (current && current.epoch !== (runtime.privateEpoch || 0)) {
    stopWorker();
    current = previous = null;
  }
  if (
    previous &&
    (previous.snapshot.game !== game ||
      previous.snapshot.tok !== game.tok ||
      previous.snapshot.epoch !== (runtime.privateEpoch || 0))
  )
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
  }
  renderTop5(myTurn ? current : null, game);
  $('#coachPreview').textContent = preview;
  markDisplayedRatings();
  $('#coachLast').textContent = previous
    ? `上一手 ${previous.action.label} · ${grade(previous.snapshot, previous.action)}`
    : '出牌后保留上一手评价';
  $('#coachRetry').hidden = !(current?.error || previous?.snapshot.error);
  fitCoach();
}
function renderTop5(s, game) {
  const list = $('#coachTop5');
  const status = $('#coachTopStatus');
  if (!s?.values || s.error) {
    list.replaceChildren();
    status.textContent = s?.error
      ? '评价不可用，可重试'
      : s
        ? '正在比较合法出法…'
        : '轮到你时显示推荐';
    return;
  }
  const top = s.ranked;
  status.textContent = s.search
    ? s.search.mode === 'round'
      ? `明牌推演至本局结束 · ${s.search.evaluated} 种出法 · 每种模拟 ${s.search.minRollouts}${s.search.minRollouts * s.search.evaluated === s.search.fullRollouts ? '' : '+'} 次`
      : `明牌推演 ${s.search.horizon} 步 · 已评估 ${s.search.evaluated} 种出法`
    : `已比较 ${s.actions.length} 个候选 · 点击选牌，不会自动打出`;
  list.replaceChildren(
    ...top.map((row, index) => {
      const item = document.createElement('li'),
        button = document.createElement('button');
      button.type = 'button';
      button.className = 'coach-choice';
      button.classList.toggle('selected', actionKey(row.ids) === actionKey([...runtime.selection]));
      const heading = document.createElement('span');
      heading.className = 'coach-choice-heading';
      const name = document.createElement('strong');
      name.textContent = `${index + 1}. ${row.ids.length ? TYPE_NAME[row.shape?.type] || '出牌' : '过牌'}`;
      const score = document.createElement('b');
      score.textContent = `${relativeRating(s.values, row.value).percent}%`;
      if (index > 0) {
        // The percentage is rescaled within this turn; the raw gap shows whether it really matters.
        const gap = document.createElement('small');
        gap.className = 'coach-gap';
        gap.textContent = `差 ${(row.value - top[0].value).toFixed(2)}`;
        gap.title = '与第一名的平均结果差（单位约等于本局升级分），越接近 0 差别越小';
        score.append(' ', gap);
      }
      heading.append(name, score);
      button.append(heading);
      const cards = document.createElement('span');
      cards.className = 'coach-choice-cards';
      for (const id of row.ids) {
        const card = deck[id],
          chip = document.createElement('span');
        chip.className = 'coach-card';
        chip.classList.toggle('red', card.s === 'H' || card.s === 'D' || card.r === 17);
        chip.textContent = cardText(card);
        cards.append(chip);
      }
      if (!row.ids.length) cards.textContent = '本轮不跟牌';
      button.append(cards);
      const line = s.lines?.get(actionKey(row.ids));
      if (line?.length) {
        const steps = document.createElement('span');
        steps.className = 'coach-line';
        const shown = line
          .slice(0, 4)
          .map(
            (step) =>
              `${BASE_NAMES[step.p]} ${step.cards?.length ? step.cards.map((id) => cardText(deck[id])).join('') : '过'}`,
          );
        steps.textContent = `推演前 ${shown.length} 手：${shown.join(' → ')}${line.length > 4 ? ' …' : ''}`;
        button.append(steps);
      }
      button.onclick = () => {
        if (!enabled || !available() || !sameTurn(s, runtime.game) || runtime.game.turn !== 0)
          return;
        runtime.selection = new Set(row.ids);
        renderHand();
      };
      item.append(button);
      return item;
    }),
  );
}
export const coachIsEnabled = () => enabled;
export function setCoachEnabled(value) {
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
    if (available()) setCoachEnabled(!enabled);
  };
  $('#coachClose').onclick = () => setCoachEnabled(false);
  $('#coachTopToggle').onclick = () => {
    topOpen = !topOpen;
    if (topOpen && innerWidth < 1400) $('#privateHands').open = false;
    renderCoach();
  };
  $('#coachSuggestionsClose').onclick = () => {
    topOpen = false;
    renderCoach();
  };
  document.addEventListener('coach-collapse-suggestions', () => {
    topOpen = false;
    renderCoach();
  });
  $('#coachRetry').onclick = () => {
    stopWorker();
    current = previous = null;
    renderCoach();
  };
  new ResizeObserver(fitCoach).observe($('#coachPanel'));
  addEventListener('resize', fitCoach);
  document.addEventListener('scroll', markDisplayedRatings, true);
}
