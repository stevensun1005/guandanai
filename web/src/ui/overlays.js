import { runtime } from '../app/runtime.js';
import { rankName } from '../core/cards.js';
import { act } from '../game/events.js';
import { toAbs } from '../game/session.js';
import { placeActionBtns } from '../hand/layout.js';
import { askNext } from '../input/controls.js';
import { broadcast } from '../network/rooms.js';
import { forgetSeat } from '../network/rejoin-storage.js';
import { practiceFinish, practiceSave } from '../replay/import-export.js';
import { practiceView } from '../replay/viewer.js';
import { $ } from './cards.js';
import { showPublicHistory } from './history-dialog.js';

let nextDone;

/* ---------- overlays ---------- */
// dock: the round result sits low and see-through around the edges, so the last cards on the table stay in view
export function showPanel(html, dock) {
  $('#panel').innerHTML = html;
  $('#panel').dataset.kind = '';
  $('#overlay').classList.toggle('dock', !!dock);
  $('#overlay').hidden = false;
}

export function hideOverlay() {
  $('#overlay').hidden = true;
}

export function showResult() {
  const r = runtime.game.result;
  const ours = r.team === 0;
  const upText = ['', '单下，升 1 级', '对手二人分列二、三游，升 2 级', '双下对手，升 3 级'][r.up];
  const side = (t) => (t === 0 ? '我方' : '对方'),
    next = rankName(runtime.game.levels[runtime.game.lvlTeam]);
  let head, body;
  if (r.draw) {
    head = '三次打 A 未过，本场平局';
    body = `<p>${side(r.aTeam)}打 A 三次都没有打过。</p><p class="muted">共打了 ${runtime.game.round} 局。</p>`;
  } else if (r.win) {
    head = ours ? '我方打过 A，赢下整场' : '对方打过 A，本场告负';
    body = `<p class="muted">共打了 ${runtime.game.round} 局。</p>`;
  } else if (r.reset && r.aTeam === r.team) {
    head = `${side(r.team)}三次没打过 A`;
    body = `<p>按规则从 2 重新打。下一局打 <b>${next}</b>，${dblText(r)}</p>`;
  } else {
    head = ours
      ? `我方升级：${rankName(r.before)} → ${rankName(r.after)}`
      : `对方升级：${rankName(r.before)} → ${rankName(r.after)}`;
    body = `<p>${upText}。下一局打 <b>${next}</b>，${dblText(r)}</p>`;
    if (r.before === 14 && r.after === 14)
      body = `<p>${side(r.team)}在 A 级，但队友是末游，没能打过 A。下一局继续打 A，${dblText(r)}</p>`;
    if (r.reset) body += `<p>${side(r.aTeam)}三次没打过 A，从 2 重新打。</p>`;
    else if (r.aTry)
      body += `<p>${side(r.aTeam)}打 A 第 ${r.aTry} 次没过，还剩 ${3 - r.aTry} 次机会。</p>`;
  }
  showPanel(
    `<h2>${head}</h2>${body}
    ${waitHtml()}
    ${runtime.reviewMode ? '<p class="muted">点桌上的任意一手牌，回到当时所有人的牌，可以接着写评语；写完了点“导出本局复盘”。</p>' : ''}
    <div class="btns">${runtime.reviewMode ? '<button class="btn" id="replayBtn">回放</button><button class="btn" id="doneBtn">导出本局复盘</button>' : '<button class="btn" id="resultHistoryBtn">整场战况</button>'}${nextBtnHtml()}</div>`,
    true,
  );
  $('#panel').dataset.kind = 'result';
  if (runtime.reviewMode) {
    $('#replayBtn').onclick = () => practiceView(runtime.TREC.rounds.length - 1, 0, true);
    $('#doneBtn').onclick = practiceFinish;
  } else $('#resultHistoryBtn').onclick = () => showPublicHistory(true, $('#resultHistoryBtn'));
  const nb = $('#nextBtn');
  if (nb) {
    nb.onclick = askNext;
    placeActionBtns();
    if (!nb.disabled) nb.focus();
  }
}

function waitHtml() {
  if (runtime.network.humans.size < 2) return '';
  const done = [...runtime.network.humans].filter(nextDone),
    wait = [...runtime.network.humans].filter((h) => !nextDone(h));
  return `<p class="wait">${done.length ? `已按：${done.map((h) => runtime.names[h]).join('、')}<br>` : ''}${wait.length ? `等待 ${wait.map((h) => runtime.names[h]).join('、')} 按“${runtime.game.phase === 'over' ? '再来一场' : '下一局'}”` : ''}</p>`;
}

function nextBtnHtml() {
  const label = runtime.game.phase === 'over' ? '再来<br>一场' : '下一局';
  return nextDone(0)
    ? `<button class="btn primary round" id="nextBtn" disabled>等待<br>他人</button>`
    : `<button class="btn primary round" id="nextBtn">${label}</button>`;
}

function dblText(r) {
  const o = r.order;
  if (!runtime.rules.trib) return `本场不进贡，由${runtime.names[o[0]]}先出。`;
  return o[1] % 2 === o[0] % 2
    ? `${runtime.names[o[2]]}和${runtime.names[o[3]]}双下，两人都要进贡。`
    : `末游${runtime.names[o[3]]}要向头游进贡。`;
}

// leaving the table, after a confirmation; the others are told and can carry on with the computer in that seat
// pausing: the turn clocks, the computer players' thinking and the sorting minute all stop until the player who
// paused resumes (G.pausedBy, a local seat); the others can only wait or leave the game
export function setPaused(on, by) {
  runtime.game.paused = on;
  runtime.game.pausedBy = on ? by : null;
  syncPauseBtn();
  if (on) {
    const mine = by === 0;
    showPanel(`<h2>暂停中</h2><p class="muted">${mine ? '你暂停了游戏，大家休息一下。' : `${runtime.names[by]}暂停了游戏，只有暂停的人能继续。你可以等一等，也可以退出游戏。`}</p>
      <div class="btns">${mine ? '<button class="btn primary" id="resumeBtn">继续游戏</button>' : '<button class="btn" id="pauseQuit">退出游戏</button>'}</div>`);
    $('#panel').dataset.kind = 'pause';
    if (mine) {
      $('#resumeBtn').onclick = () => act({ k: 'pause', on: false, p: toAbs(0) });
      $('#resumeBtn').focus();
    } else $('#pauseQuit').onclick = askQuit;
  } else if (!$('#overlay').hidden && $('#panel').dataset.kind === 'pause') {
    hideOverlay();
    if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  }
}

// 暂停 / 继续: while someone else has paused, the button only says so and cannot be pressed
export function syncPauseBtn() {
  const b = $('#pauseBtn'),
    other = !!runtime.game && !!runtime.game.paused && runtime.game.pausedBy !== 0;
  b.textContent = runtime.game && runtime.game.paused ? (other ? '暂停中' : '继续') : '暂停';
  b.classList.toggle('on', !!runtime.game && !!runtime.game.paused);
  b.disabled = other;
}

export function askQuit() {
  const why =
    runtime.network.mode === 'host'
      ? '你是房主，退出后其他玩家可以选择和电脑继续打。'
      : runtime.network.mode === 'guest'
        ? '你的座位会交给电脑接着打。'
        : runtime.reviewMode
          ? '出牌记录不会保存，要留着请先点“保存记录”。'
          : '这一场的级数和牌都不会保存。';
  showPanel(`<h2>退出游戏？</h2><p class="muted">${why}</p>
  <div class="btns"><button class="btn" id="stayBtn">${runtime.game && runtime.game.paused ? '返回' : '继续打'}</button>${runtime.reviewMode ? '<button class="btn" id="quitSave">保存记录</button>' : ''}<button class="btn primary" id="quitYes">退出</button></div>`);
  if (runtime.reviewMode) $('#quitSave').onclick = practiceSave;
  $('#stayBtn').onclick = () => {
    hideOverlay();
    if (runtime.game.paused) setPaused(true, runtime.game.pausedBy);
    else if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  };
  $('#quitYes').onclick = quitGame;
  $('#stayBtn').focus();
}

function quitGame() {
  forgetSeat();
  try {
    if (runtime.network.mode === 'host') broadcast({ t: 'bye' });
    if (
      runtime.network.mode === 'guest' &&
      runtime.network.hostConn &&
      runtime.network.hostConn.open
    )
      runtime.network.hostConn.send({ t: 'bye' });
  } catch (_) {}
  // a moment for the goodbye to go out, then back to the lobby
  setTimeout(() => location.reload(), runtime.network.mode === 'solo' ? 0 : 400);
}

// someone else left: the computer has their seat, and everyone still here can play on or leave too
export function playerLeft(name, how) {
  showPanel(
    `<h2>${name} ${how === 'drop' ? '掉线了' : '退出了游戏'}</h2><p class="muted">${name}的座位由电脑接着打。</p>
  <div class="btns"><button class="btn primary" id="goOnBtn">继续打</button><button class="btn" id="leaveBtn">退出游戏</button></div>`,
    true,
  );
  $('#panel').dataset.kind = 'left';
  $('#goOnBtn').onclick = () => {
    hideOverlay();
    if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  };
  $('#leaveBtn').onclick = askQuit;
}

export function playerReturned() {
  if ($('#panel').dataset.kind !== 'left') return;
  hideOverlay();
  if (['roundEnd', 'over'].includes(runtime.game.phase)) showResult();
}

export function initialize() {
  // with friends at the table: who has pressed the button and who everyone is waiting for
  nextDone = (p) => (runtime.game.nextReady || []).includes(p);
}
