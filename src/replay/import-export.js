import { runtime } from '../app/runtime.js';
import { TALLY_RANKS, tallyLeft, tallyPlayed } from '../ai/rule-policy.js';
import { cardText, isWild, rankName } from '../core/cards.js';
import { VERSION } from '../network/protocol.js';
import {
  curRec,
  handUnits,
  passedOn,
  recName,
  recUnits,
  testChanges,
  testCopy1,
  testList,
} from './inspector.js';
import { esc, playName, powerText, roundName, trickEnd } from './session.js';
import { recIn, recOut, testDbPut, testStore } from './storage.js';
import { $, displayOrder } from '../ui/cards.js';
import { hideOverlay, showPanel, showResult } from '../ui/overlays.js';

let TDATA;
let testBackToGame;

/* the record as text, to save, copy, and bring back in */
// for each round the hands as play began (the computer's as arranged, yours as you grouped them), then every play in
// order with the computer's arrangement just before it and your comment, the passes, how each trick ended, what was left
// and the result; at the end the same rounds as data, for 导入
export function testText(rounds = runtime.TREC.rounds) {
  const out = [
    '掼蛋测试版出牌记录',
    `保存时间：${new Date().toLocaleString()}　页面版本：${VERSION}`,
    '你和对家一方，下家和上家一方。牌后带 * 的是逢人配（红桃级牌）。[ ] 里是配好的一组一组（电脑的是它的配牌，你的是你理好的牌）。',
    '每一次轮到谁（出牌或者过）都算一手，按顺序编号。',
    '1号是你，逆时针（出牌的顺序）依次是 2号（你的下家）、3号（你的对家）、4号（你的上家）。',
    '',
  ];
  for (const r of rounds) {
    const ct = (c) => cardText(c) + (isWild(c, r.L) ? '*' : '');
    const shown = (cards, p, grouped) =>
      (grouped ? recUnits(r, p, cards) : handUnits(cards, r.L, false))
        .map((u) => (grouped ? '[' + u.cards.map(ct).join(' ') + ']' : u.cards.map(ct).join(' ')))
        .join(grouped ? ' ' : '  ');
    out.push(
      '='.repeat(48),
      `${recName(r)}　${roundName(r)}　打 ${rankName(r.L)}（${r.lvlTeam === 0 ? '我方' : '对方'}的级）　${runtime.names[r.leader]}先出　${r.at || ''}`,
    );
    for (const t of r.trib) out.push('  ' + t);
    if (r.kang) out.push('  ' + r.kang);
    out.push('', '开局手牌（进贡、还贡之后）：');
    for (const p of [0, 1, 2, 3]) {
      const mine = p === 0 && r.myGroups,
        ug = p && r.userGroups[p];
      out.push(
        `  ${runtime.names[p]}　${r.hands[p].length} 张　${
          mine
            ? `${powerText(r.myPower)}（你理的牌；电脑配牌 ${r.power[0]}）`
            : ug
              ? `电脑配牌${powerText(r.power[p])}；你改后${powerText(r.userPower[p])}（电脑按你改后的牌打）`
              : powerText(r.power[p])
        }`,
      );
      if (ug)
        out.push(
          '    电脑原来：' +
            handUnits(r.hands[p], r.L, true)
              .map((u) => '[' + u.cards.map(ct).join(' ') + ']')
              .join(' '),
          '    你改后：　' + shown(r.hands[p], p, true),
        );
      else out.push('    ' + shown(r.hands[p], p, p !== 0 || !!mine));
    }
    const ch = testChanges(r);
    if (ch.length) out.push('', '理牌改动：', ...ch.map((t) => '  ' + t));
    if (r.notes[0]) out.push(`  开局评语：${r.notes[0]}`);
    out.push('', '出牌：');
    const hands = r.hands.map((h) => h.slice());
    let last = null;
    r.log.forEach((e, i) => {
      const k = i + 1,
        no = `  ${String(k).padStart(3)}. `;
      if (!e.cards) {
        const t = passedOn(r, k);
        out.push(
          `${no}${runtime.names[e.p]} 过${t ? `（桌上是${runtime.names[t.p]}的${playName(t)}：${displayOrder(t, r.L).map(ct).join(' ')}）` : ''}`,
        );
        if (e.p !== 0) out.push(`         （当时的配牌：${shown(hands[e.p], e.p, true)}）`);
      } else {
        if (e.lead && last != null) out.push(`         —— ${trickEnd(last, e.p)}`);
        last = e.p;
        out.push(
          `${no}${runtime.names[e.p]} ${e.lead ? '领出' : '跟　'} ${playName(e)}：${displayOrder(e, r.L).map(ct).join(' ')}`,
        );
        if (e.p !== 0) out.push(`         （出牌前的配牌：${shown(hands[e.p], e.p, true)}）`);
        const ids = new Set(e.cards.map((c) => c.id));
        hands[e.p] = hands[e.p].filter((c) => !ids.has(c.id));
      }
      if (r.notes[k]) out.push(`         【评语】${r.notes[k]}`);
    });
    for (const p of [0, 1, 2, 3])
      if (hands[p].length && r.result)
        out.push(`  剩牌：${runtime.names[p]}　${shown(hands[p], 0, false)}`);
    // the card counter as the record stands: each player's played cards by rank, and what is still out
    const ks = TALLY_RANKS(r.L),
      per = tallyPlayed(r.log, r.L),
      lab = (k) =>
        k === 17 ? '大王' : k === 16 ? '小王' : k === 15 ? `级牌${rankName(r.L)}` : rankName(k);
    out.push('', '记牌器（已出的牌）：');
    for (const p of [0, 1, 2, 3])
      out.push(
        `  ${runtime.names[p]}　` +
          ks
            .filter((k) => per[p][k])
            .map((k) => `${lab(k)}×${per[p][k].length}`)
            .join(' '),
      );
    out.push('  剩余　' + ks.map((k) => `${lab(k)}×${tallyLeft(r.log, r.L, k).length}`).join(' '));
    out.push('', r.result ? '结果：' + r.result : '（这一局没打完）', '');
  }
  out.push(
    '---- 下面一行是给程序读的数据（导入用），请不要改 ----',
    TDATA + JSON.stringify(rounds.map(recOut)),
  );
  return out.join('\r\n');
}

// 生成记录交给 Claude: the latest round with its comments. In the claude.ai viewer it goes into this page's own store
// (collection "rounds", one document per round), where Claude reads it; anywhere else it is saved as a text file (on a
// computer, into the Downloads folder, where Claude can read it too)
export async function testFinish() {
  const r = curRec();
  if (!r) {
    testSay('还没有打过的局');
    return;
  }
  const n = Object.keys(r.notes).length,
    text = testText([r]);
  const db =
    window.claude && window.claude.use ? await window.claude.use('db').catch(() => null) : null;
  if (db) {
    r.done = true;
    try {
      await (runtime.dbBusy = runtime.dbBusy.then(() => testDbPut(r)));
      testSay(
        `“${recName(r)}”（${n} 条评语）已经交给 Claude。把这个名字发给 Claude，或者说“去分析”就行。`,
        recName(r),
      );
    } catch (e) {
      testSay(
        '没能交给 Claude（' + ((e && e.code) || '出错') + '），请改用“复制”，把记录贴给 Claude。',
      );
    }
    return;
  }
  const d = new Date(),
    z = (x) => String(x).padStart(2, '0');
  const name = recName(r) + '.txt';
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    testSay(
      `已保存为“${name}”（${n} 条评语），在下载文件夹里。把这个文件名发给 Claude 就行。`,
      name,
    );
  } catch (_) {
    testCopy();
  }
}

// a short message in a panel, back to the game (or the result) when closed
function testSay(t, copy) {
  showPanel(`<h2>出牌记录</h2><p>${esc(t)}</p>${copy ? `<p class="tname">${esc(copy)}</p>` : ''}
    <div class="btns">${copy ? '<button class="btn primary" id="trecName">复制名字</button>' : ''}<button class="btn${copy ? '' : ' primary'}" id="trecClose">知道了</button></div>`);
  if (copy) $('#trecName').onclick = () => testCopy1(copy);
  $('#trecClose').onclick = testBackToGame;
}

// in the claude.ai viewer the rounds handed over earlier (on this or another device) come back into the record
export async function testDbLoad() {
  const db =
    window.claude && window.claude.use ? await window.claude.use('db').catch(() => null) : null;
  if (!db) return;
  try {
    const snap = await db.collection('rounds').get(),
      have = new Set(runtime.TREC.rounds.map((r) => r.uid)),
      add = [];
    for (const d of snap.docs) {
      const o = d.data();
      if (o && o.data && !have.has(o.uid))
        try {
          add.push(recIn(o.data));
        } catch (_) {}
    }
    if (!add.length) return;
    const live = curRec() && curRec().live ? runtime.TREC.rounds.pop() : null,
      taken = new Set(runtime.TREC.rounds.map((r) => r.no));
    let no = Math.max(0, ...runtime.TREC.rounds.map((r) => r.no), ...add.map((r) => r.no));
    for (const r of add) {
      if (taken.has(r.no)) r.no = ++no;
      taken.add(r.no);
    }
    runtime.TREC.rounds = runtime.TREC.rounds.concat(add).sort((a, b) => a.no - b.no);
    if (live) {
      if (taken.has(live.no)) live.no = ++no;
      runtime.TREC.rounds.push(live);
    }
    testStore();
    testList();
  } catch (_) {}
}

export function testSave() {
  // the claude.ai viewer (window.claude) does not let a page hand over a file: the record is shown to copy instead
  if (window.claude) {
    testCopy();
    return;
  }
  const d = new Date(),
    z = (x) => String(x).padStart(2, '0');
  const name = `掼蛋测试记录-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.txt`;
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(
      new Blob(['﻿' + testText()], { type: 'text/plain;charset=utf-8' }),
    );
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (_) {
    testCopy();
  }
}

// the record in a box to copy from, for where a file cannot be saved (and to paste straight into a message)
export function testCopy() {
  showPanel(`<h2>出牌记录</h2><div class="trec"><textarea id="trecText" readonly></textarea></div>
    <div class="btns"><button class="btn primary" id="trecCopy">复制</button><button class="btn" id="trecClose">关闭</button></div>`);
  const t = $('#trecText');
  t.value = testText();
  t.focus();
  t.select();
  $('#trecCopy').onclick = () => {
    t.select();
    const ok = () => {
      $('#trecCopy').textContent = '已复制';
    };
    if (navigator.clipboard)
      navigator.clipboard.writeText(t.value).then(ok, () => {
        try {
          document.execCommand('copy');
          ok();
        } catch (_) {}
      });
    else {
      try {
        document.execCommand('copy');
        ok();
      } catch (_) {}
    }
  };
  $('#trecClose').onclick = testBackToGame;
}

// 导入: a saved record (the file, or its text pasted in) brings its rounds into this browser, after the ones kept here
export function testImport() {
  showPanel(`<h2>导入记录</h2><p class="muted">选一个保存的记录文件，或者把记录的全文粘贴到下面。</p>
    <input type="file" id="trecFile" accept=".txt,text/plain">
    <div class="trec"><textarea id="trecText" placeholder="把记录的全文粘贴到这里"></textarea></div>
    <p class="muted" id="trecMsg"></p>
    <div class="btns"><button class="btn primary" id="trecGo">导入</button><button class="btn" id="trecClose">关闭</button></div>`);
  $('#trecFile').onchange = (e) => {
    const f = e.target.files[0];
    if (f)
      f.text().then((t) => {
        $('#trecText').value = t;
      });
  };
  $('#trecGo').onclick = () => {
    const t = $('#trecText').value,
      i = t.lastIndexOf(TDATA);
    let list = null;
    try {
      list = JSON.parse(t.slice(i + TDATA.length).split(/\r?\n/)[0]);
    } catch (_) {}
    if (i < 0 || !Array.isArray(list)) {
      $('#trecMsg').textContent = '没找到记录的数据（文件最后一行），请用“保存记录”存的完整文件';
      return;
    }
    // a round keeps its number unless one here has it already; a replay keeps pointing at the round it replays
    const have = new Set(runtime.TREC.rounds.map((r) => r.uid)),
      taken = new Set(runtime.TREC.rounds.map((r) => r.no)),
      renum = new Map(),
      add = [];
    let k = 0,
      no = Math.max(0, ...runtime.TREC.rounds.map((r) => r.no), ...list.map((o) => o.no || 0));
    for (const o of list) {
      if (have.has(o.uid)) continue;
      try {
        const r = recIn(o);
        if (taken.has(r.no)) renum.set(r.no, (r.no = ++no));
        taken.add(r.no);
        add.push(r);
        k++;
      } catch (_) {}
    }
    for (const r of add) if (renum.has(r.replayOf)) r.replayOf = renum.get(r.replayOf);
    const live = curRec() && curRec().live ? runtime.TREC.rounds.pop() : null;
    runtime.TREC.rounds = runtime.TREC.rounds.concat(add).sort((a, b) => a.no - b.no);
    if (live) runtime.TREC.rounds.push(live);
    testStore();
    $('#tsList').dataset.k = '-';
    testList();
    $('#trecMsg').textContent = k
      ? `导入了 ${k} 局，可以在“上一步”的画面里选着看、重打`
      : '这些局已经都在了';
  };
  $('#trecClose').onclick = testBackToGame;
}

// 清空: forget the rounds kept in this browser (the one being played stays)
export function testClear() {
  showPanel(`<h2>清空记录？</h2><p class="muted">这个浏览器里保存的测试记录都会删掉（正在打的这一局留着）。要留着请先“保存记录”。</p>
    <div class="btns"><button class="btn" id="trecClose">不清空</button><button class="btn primary" id="trecGo">清空</button></div>`);
  $('#trecGo').onclick = () => {
    const r = curRec();
    runtime.TREC.rounds = r && r.live && !r.result ? [r] : [];
    testStore();
    $('#tsList').dataset.k = '-';
    testList();
    testBackToGame();
  };
  $('#trecClose').onclick = testBackToGame;
}

export function initialize() {
  TDATA = '#DATA ';
  testBackToGame = () => {
    hideOverlay();
    if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
  };
}
