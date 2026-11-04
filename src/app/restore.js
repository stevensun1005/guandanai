import { runtime } from './runtime.js';
import { beginDeal, finishDeal } from '../game/dealing.js';
import { runGives, tribWait } from '../game/tribute.js';
import { startTurn } from '../game/turns.js';
import { showStart } from '../lobby/lobby.js';
import { showResult } from '../ui/overlays.js';
import { pileRebuild } from '../ui/table-pile.js';
import { render } from '../ui/table.js';

/* ---------- boot (keeps the game across live page updates) ---------- */
export function boot(data) {
  if (data && data.G && data.G.hands && data.G.phase !== 'start') {
    runtime.game = data.G;
    runtime.game.tok++;
    runtime.selection = new Set();
    runtime.game.trickPlays = runtime.game.trickPlays || [];
    runtime.game.heapN = runtime.game.heapN || 0;
    runtime.game.seen = runtime.game.seen || [];
    runtime.game.log = runtime.game.log || [];
    if (runtime.game.phase === 'play' && runtime.game.turn === -1) {
      runtime.game.heapN += runtime.game.trickPlays.reduce((s, t) => s + t.play.cards.length, 0);
      runtime.game.trickPlays = [];
      runtime.game.trick = null;
      runtime.game.passes = 0;
      runtime.game.last = [null, null, null, null];
      runtime.game.turn = runtime.game.nextLeader ?? runtime.game.leader ?? 0;
    }
    pileRebuild();
    if (runtime.game.phase === 'shuffle' || runtime.game.phase === 'cut') {
      runtime.game.busy = false;
      beginDeal();
      return;
    }
    if (runtime.game.phase === 'deal') {
      finishDeal();
      return;
    }
    if (runtime.game.phase === 'tribute') {
      runGives();
      return;
    }
    if (runtime.game.phase === 'tribPick') {
      runtime.game.clock = null;
      tribWait();
      return;
    }
    if (runtime.game.phase === 'play') {
      startTurn();
    } else {
      if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over')
        runtime.game.reveal = 4;
      render();
      if (runtime.game.phase === 'roundEnd' || runtime.game.phase === 'over') showResult();
    }
  } else showStart();
}
