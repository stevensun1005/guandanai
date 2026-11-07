import { runtime } from '../app/runtime.js';
import { makeDeck, rankName, sortHand, cardText } from '../core/cards.js';
import { resetGame } from '../game/session.js';
import { analyze } from '../core/combinations.js';
import { cardHTML } from '../ui/cards.js';
import { finished, stepPosition, validatePosition } from '../rule-bot/practice-endgame.mjs';

const KEY = 'guandan-clint-endgames-v1';
let panel,
  worker,
  record,
  home,
  records = [],
  step = 0,
  playback;
const $ = (id) => panel.querySelector('#' + id);
function stop() {
  worker?.terminate();
  worker = null;
  clearInterval(playback);
  playback = null;
}
function status(message) {
  $('endStatus').textContent = message;
}
function draw() {
  if (!record) return;
  let state = record.initial;
  for (const action of (record.result?.line || []).slice(0, step))
    state = stepPosition(state, action.play);
  $('endHands').innerHTML = state.hands
    .map(
      (hand, p) =>
        `<section class="end-seat${state.turn === p && !finished(state) ? ' active' : ''}"><h3>${['南', '东', '北', '西'][p]}${state.out.includes(p) ? ' · ' + (state.out.indexOf(p) + 1) + '游' : ''}</h3><div class="end-cards">${sortHand(
          hand,
          state.L,
        )
          .map((c) => cardHTML(c, state.L))
          .join('')}</div></section>`,
    )
    .join('');
  $('endStep').max = record.result?.line.length || 0;
  $('endStep').value = step;
  $('endStepLabel').textContent =
    `${step} / ${record.result?.line.length || 0} 手 · 级牌 ${rankName(state.L)}`;
  $('endTrick').textContent = state.trick
    ? `${['南', '东', '北', '西'][state.trick.player]}出：${state.trick.play.cards.map(cardText).join(' ')} · 连续过牌 ${state.passes}`
    : '新一轮，' + ['南', '东', '北', '西'][state.turn] + '领出';
  $('endPrev').disabled = step === 0;
  $('endNext').disabled = step === (record.result?.line.length || 0);
  $('endReplay').disabled = !record.result?.complete;
  $('endExport').disabled = !record.result?.complete;
  const list = $('endLine');
  list.replaceChildren();
  (record.result?.line || []).forEach((action, index) => {
    const li = document.createElement('li'),
      button = document.createElement('button');
    button.className = 'link';
    button.textContent = `${index + 1}. ${['南', '东', '北', '西'][action.player]}：${action.play ? action.play.cards.map(cardText).join(' ') : '过牌'}`;
    button.setAttribute('aria-current', String(index + 1 === step));
    button.onclick = () => {
      clearInterval(playback);
      step = index + 1;
      draw();
    };
    li.append(button);
    list.append(li);
  });
}
function refreshRecords() {
  $('endSaved').replaceChildren(new globalThis.Option('本机已完成残局…', ''));
  records.forEach((r, i) =>
    $('endSaved').add(
      new globalThis.Option(
        `${new Date(r.time).toLocaleString()} · ${r.result.value > 0 ? '南北' : '东西'}+${Math.abs(r.result.value)}`,
        String(i),
      ),
    ),
  );
}
function start() {
  stop();
  record = null;
  step = 0;
  $('endHands').replaceChildren();
  $('endLine').replaceChildren();
  $('endStop').disabled = false;
  $('endReplay').disabled = true;
  $('endExport').disabled = true;
  $('endPrev').disabled = true;
  $('endNext').disabled = true;
  $('endStep').max = 0;
  $('endStep').value = 0;
  status('正在生成模拟残局……');
  const current = new Worker(new URL('./clint-practice-worker.mjs', import.meta.url), {
    type: 'module',
  });
  worker = current;
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    if (data.type === 'error') {
      stop();
      $('endStop').disabled = true;
      status(data.message);
      return;
    }
    record = {
      schema: 1,
      kind: 'clint-open-endgame-practice',
      assisted: true,
      time: new Date().toISOString(),
      initial: data.initial,
      prefixPlies: data.prefixPlies,
      source: data.source,
      result: data.result || null,
    };
    draw();
    if (data.type === 'position')
      status(
        `Clint 已普通续打 ${data.prefixPlies} 手。现在明牌求解中，最长 ${+$('endBudget').value / 1000} 秒……`,
      );
    else {
      stop();
      $('endStop').disabled = true;
      const result = data.result;
      status(
        result.complete
          ? `求解完成：双方均按本局升级分最优行动时，${result.value > 0 ? '南北' : '东西'}赢 ${Math.abs(result.value)} 级。${result.line.length} 手，${result.nodes.toLocaleString()} 节点，${(result.elapsedMs / 1000).toFixed(2)} 秒。`
          : `未算完：${result.reason}。不显示“最优打法”，可换一局或提高预算。`,
      );
      if (result.complete) {
        records.push(record);
        records = records.slice(-30);
        try {
          localStorage.setItem(KEY, JSON.stringify(records));
        } catch {
          status($('endStatus').textContent + ' 本机保存失败，请导出备份。');
        }
        refreshRecords();
      }
    }
  };
  current.onerror = (e) => {
    stop();
    $('endStop').disabled = true;
    status('求解失败：' + e.message);
  };
  current.postMessage({
    limit: +$('endLimit').value,
    L: +$('endLevel').value,
    maxMs: +$('endBudget').value,
  });
}
export function openEndgame(onHome) {
  home = onHome;
  resetGame();
  runtime.game.phase = 'endgamePractice';
  runtime.reviewMode = true;
  panel.hidden = false;
  document.body.classList.add('endgame-practice');
  try {
    records = JSON.parse(localStorage.getItem(KEY) || '[]')
      .filter((r) => {
        try {
          validatePosition(r.initial);
          if (
            r.kind !== 'clint-open-endgame-practice' ||
            !r.result?.complete ||
            r.result.line.length > 400
          )
            return false;
          let s = r.initial;
          for (const action of r.result.line) {
            if (action.player !== s.turn) return false;
            const pl = action.play;
            if (
              pl &&
              (new Set(pl.cards.map((c) => c.id)).size !== pl.cards.length ||
                !analyze(pl.cards, s.L).some(
                  (a) => a.type === pl.type && a.value === pl.value && a.n === pl.n,
                ))
            )
              return false;
            if (
              pl &&
              pl.cards.some((c) => {
                const original = makeDeck()[c.id];
                return !original || original.r !== c.r || original.s !== c.s;
              })
            )
              return false;
            s = stepPosition(s, pl);
          }
          return finished(s);
        } catch {
          return false;
        }
      })
      .slice(-30);
  } catch {
    records = [];
  }
  refreshRecords();
  status('选择每家最多几张牌，再点“换一局并求解”。不上传、不训练模型。');
  $('endNew').focus();
}
export function initialize() {
  panel = document.querySelector('#endgamePractice');
  $('endLevel').innerHTML = Array.from(
    { length: 13 },
    (_, i) => `<option value="${i + 2}">${rankName(i + 2)}</option>`,
  ).join('');
  $('endNew').onclick = start;
  $('endStop').onclick = () => {
    stop();
    $('endStop').disabled = true;
    status('已停止。本次未完成，不保存为最优路线。');
  };
  $('endClose').onclick = () => {
    stop();
    panel.hidden = true;
    runtime.reviewMode = false;
    document.body.classList.remove('endgame-practice');
    home();
  };
  $('endStep').oninput = () => {
    clearInterval(playback);
    step = +$('endStep').value;
    draw();
  };
  $('endPrev').onclick = () => {
    clearInterval(playback);
    step--;
    draw();
  };
  $('endNext').onclick = () => {
    clearInterval(playback);
    step++;
    draw();
  };
  $('endReplay').onclick = () => {
    clearInterval(playback);
    step = 0;
    draw();
    playback = setInterval(() => {
      if (step >= record.result.line.length) {
        clearInterval(playback);
        return;
      }
      step++;
      draw();
    }, 900);
  };
  $('endSaved').onchange = () => {
    const i = $('endSaved').value;
    if (i === '') return;
    stop();
    record = records[+i];
    step = 0;
    draw();
    status('已打开本机保存的明牌求解路线。');
    $('endStop').disabled = true;
  };
  $('endExport').onclick = () => {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'clint-endgame-practice.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
