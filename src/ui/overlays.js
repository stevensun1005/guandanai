import { runtime } from '../app/runtime.js';
import { rankName } from '../core/cards.js';
import { act } from '../game/events.js';
import { toAbs } from '../game/session.js';
import { placeActionBtns } from '../hand/layout.js';
import { askNext } from '../input/controls.js';
import { broadcast } from '../network/rooms.js';
import { practiceFinish, practiceSave } from '../replay/import-export.js';
import { practiceView } from '../replay/viewer.js';
import { $ } from './cards.js';

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
    <div class="btns">${runtime.reviewMode ? '<button class="btn" id="replayBtn">回放</button><button class="btn" id="doneBtn">导出本局复盘</button>' : ''}${nextBtnHtml()}</div>`,
    true,
  );
  $('#panel').dataset.kind = 'result';
  if (runtime.reviewMode) {
    $('#replayBtn').onclick = () => practiceView(runtime.TREC.rounds.length - 1, 0, true);
    $('#doneBtn').onclick = practiceFinish;
  }
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

export function showRules() {
  showPanel(`<h2>掼蛋规则速览</h2>
  <ul>
    <li>四人两队，你和对家一队。两副牌共 108 张，每人 27 张，轮流按逆时针出牌。</li>
    <li>牌的大小：大王（红色 JOKER）&gt; 小王（黑色 JOKER）&gt; 级牌 &gt; A &gt; K … &gt; 2。本局打几，几就是级牌。</li>
    <li>红心级牌是百搭（标一个皇冠），可以当除大小王外的任意牌用。</li>
    <li>牌型：单张、对子、三张、三带二、顺子（5 张）、连对（3 对）、钢板（2 个连续三张）。顺子里 A 可作 1，不能带王。</li>
    <li>炸弹从小到大：4 张 &lt; 5 张 &lt; 同花顺 &lt; 6 张 &lt; 7 张 … &lt; 四个王（天王炸）。炸弹可以压任何非炸弹牌型。</li>
    <li>头游一方升级：队友二游升 3 级，三游升 2 级，末游升 1 级。打到 A 并且队友不是末游，赢下整场。</li>
    <li>${runtime.rules.trib ? '从第二局起进贡：末游把最大的牌给头游，头游还一张 10 或以下的非百搭牌；没有符合条件的低牌时还最小的非百搭牌。双下则两人都进贡。要进贡的一方合起来有两张大王（一人两张，或双下时两人各一张）就可以抗贡：这一局不进贡、不还贡，由头游先出。' : '本场不进贡：每局由上一局的头游先出。'}</li>
    <li>${runtime.rules.aFail === 'keep' ? '打 A 不限次数，一直打到打过为止。' : `每一方打 A 有三次机会，三次都没打过${runtime.rules.aFail === 'draw' ? '，本场算平局' : '，这一方从 2 重新打'}。`}</li>
    <li>出完牌后若其他人都不要，由队友接风出牌。</li>
    <li>“手持”模式下手牌像握在手里一样分两排或三排展开成弧形（按钮上写的是点一下会变成的排数）。平铺模式也可以在一排、两排、三排之间切换，同样大小的牌不会被分到两排。理牌方式按钮每点一下，依次换成“横式”、“竖式”、“手持”，按钮上写的是现在用的方式。“竖式”按牌的大小从左到右排，同样点数的牌从下往上按红心、黑桃、方块、梅花叠成一列，一眼就能看出每个点数有几张。按住没选中的牌滑过几张，是连选这些牌；从选中的牌上按住拖动，是把选中的牌一起挪到别处（也可以拖进左边的成组区）。平铺模式也一样。“复原”恢复成按大小排好的样子。</li>
    <li>每局开始先洗牌、切牌：上一局头游的上家洗牌，头游切牌（第一局随机）。轮到你时点“洗牌”或“切牌”。</li>
    <li>发完牌先进贡（最大的牌有几种花色时，自己选进贡哪一张，限时 30 秒），有抗贡也在这时亮出；然后有 90 秒理牌时间（理好了点“理牌结束”），理完再还贡（限时 20 秒）。每次出牌限时 60 秒，最后 5 秒倒计时会闪烁，超时由电脑代你出牌。</li>
  </ul>
  <p class="muted">点选牌，双击任意一张牌直接出牌，“提示”会依次给出能出的牌，“过”是这一轮不要。</p>
  <div class="btns"><button class="btn primary" id="closeBtn">知道了</button></div>`);
  $('#closeBtn').onclick = () => {
    hideOverlay();
    if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  };
  $('#closeBtn').focus();
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
  $('#goOnBtn').onclick = () => {
    hideOverlay();
    if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  };
  $('#leaveBtn').onclick = askQuit;
}

export function initialize() {
  // with friends at the table: who has pressed the button and who everyone is waiting for
  nextDone = (p) => (runtime.game.nextReady || []).includes(p);
}
