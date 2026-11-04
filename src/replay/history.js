import { runtime } from '../app/runtime.js';
import { startTurn } from '../game/turns.js';
import { curRec } from './inspector.js';
import { practiceStore } from './storage.js';
import { practiceView } from './viewer.js';
import { $ } from '../ui/cards.js';
import { pileRebuild } from '../ui/table-pile.js';
import { render } from '../ui/table.js';

export function practiceSnap() {
  const top = runtime.TSNAP[runtime.TSNAP.length - 1];
  if (top && top.log.length === runtime.game.log.length) return; // the stop and the start of the same turn are one step
  try {
    runtime.TSNAP.push(structuredClone(runtime.game));
  } catch (_) {
    runtime.TSNAP.length = 0;
  }
}

export function syncUndo() {
  const b = $('#undoBtn');
  if (b) b.disabled = !(runtime.game && runtime.game.phase === 'play' && runtime.TSNAP.length >= 2);
  const go = $('#goBtn');
  if (go) {
    go.hidden = !(runtime.game && runtime.game.phase === 'play' && runtime.game.stepWait != null);
    if (!go.hidden) {
      const who = runtime.names[runtime.game.stepWait];
      go.textContent = `继续 · ${who}`;
      go.title = `下一步：${who}。也可以按空格继续。`;
    }
  }
}

export function practiceUndo() {
  if (
    !runtime.reviewMode ||
    !runtime.game ||
    runtime.game.phase !== 'play' ||
    runtime.TSNAP.length < 2
  )
    return;
  runtime.TSNAP.pop();
  const snap = runtime.TSNAP[runtime.TSNAP.length - 1],
    tok = runtime.game.tok;
  for (const k of Object.keys(runtime.game)) if (!(k in snap)) delete runtime.game[k];
  Object.assign(runtime.game, structuredClone(snap));
  runtime.game.tok = tok + 1; // whatever was still waiting to happen belongs to the step taken back
  const rec = curRec();
  if (rec && rec.live && rec.g === runtime.game.round) {
    rec.log = runtime.game.log;
    for (const k of Object.keys(rec.notes)) if (+k > runtime.game.log.length) delete rec.notes[k];
    rec.nv++;
    practiceStore();
  }
  runtime.selection = new Set();
  runtime.hints = [];
  runtime.hintIdx = 0;
  runtime.confirmation = null;
  pileRebuild();
  render();
  if (runtime.game.turn === 0 && runtime.game.phase === 'play') startTurn(); // back at the start of your own turn
}

// 上一步 (the look-back): the table as it stands after the latest play, with how that play was made (the view's own 上一步 goes further back)
export function practiceBack() {
  const rec = curRec();
  if (!rec) return;
  practiceView(runtime.TREC.rounds.length - 1, rec.log.length, false);
}

export function initialize() {
  runtime.TSNAP = [];
  // a computer's move is remembered by how the round had gone to that point: taking a step back and going on plays the same
  // move again (a different move of yours before it makes the position a new one, and it is thought out afresh)
}
