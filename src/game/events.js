import { runtime } from '../app/runtime.js';
import { BASE_NAMES } from '../core/cards.js';
import { readPlay, canPass, isReturnCard } from '../core/validation.js';
import { doCut, doShuffle, startRound } from './dealing.js';
import { doPlay } from './round.js';
import { toAbs, toLocal } from './session.js';
import { owesReturn, retWait, returnNow, tribWait } from './tribute.js';
import { beginPlay } from './turns.js';
import { startNextIfReady } from '../input/controls.js';
import { broadcast } from '../network/rooms.js';
import { VC } from '../network/voice.js';
import { $ } from '../ui/cards.js';
import { playerLeft, setPaused, showResult } from '../ui/overlays.js';
import { render } from '../ui/table.js';

/* ---------- events: every move goes through the host, which applies it and passes it on ---------- */
export function playEvt(p, pl) {
  return pl
    ? {
        k: 'play',
        p: toAbs(p),
        ids: pl.cards.map((c) => c.id),
        type: pl.type,
        value: pl.value,
        n: pl.n,
      }
    : { k: 'pass', p: toAbs(p) };
}

// solo and host: apply now (and, as host, send it on); a friend's page sends its move to the host and
// waits for it to come back, so every table applies the same moves in the same order
export function act(e) {
  if (runtime.network.mode === 'guest') {
    if (runtime.network.hostConn && runtime.network.hostConn.open) {
      runtime.network.pending = ['play', 'pass', 'return', 'tribute'].includes(e.k);
      runtime.network.pendingAt = Date.now();
      runtime.network.hostConn.send({ t: 'act', e });
    }
    return;
  }
  if (applyEvt(e) && runtime.network.mode === 'host') broadcast({ t: 'evt', e });
}

// apply one event if this table has reached the point where it fits; false means "not yet", so a friend's page
// keeps it queued until its own animations and pauses catch up with the host's
function applyEvt(e) {
  const p = e.p != null ? toLocal(e.p) : null;
  switch (e.k) {
    case 'round':
      if (!e.reset && !['roundEnd', 'start'].includes(runtime.game.phase)) return false;
      startRound(e);
      return true;
    case 'shuffle':
      if (runtime.game.phase !== 'shuffle' || runtime.game.busy) return false;
      doShuffle();
      return true;
    case 'cut':
      if (runtime.game.phase !== 'cut' || runtime.game.busy) return false;
      doCut();
      return true;
    case 'return': {
      if (runtime.game.phase !== 'return' && runtime.game.phase !== 'prep') return false;
      if (!owesReturn(p) || !runtime.game.hands[p].some((c) => c.id === e.id)) return true;
      if (
        !isReturnCard(
          runtime.game.hands[p].find((c) => c.id === e.id),
          runtime.game.L,
          runtime.game.hands[p],
        )
      )
        return false;
      runtime.game.fresh = runtime.game.fresh.filter((id) => id !== e.id);
      if (p === 0) {
        runtime.selection = new Set();
        runtime.network.pending = false;
      }
      if (runtime.game.phase === 'prep') {
        returnNow(p, e.id);
        return true;
      }
      runtime.game.retPick[p] = e.id;
      retWait();
      return true;
    }
    case 'tribute': {
      if (runtime.game.phase !== 'tribPick') return false;
      if (
        !runtime.game.tribGivers.includes(p) ||
        runtime.game.tribPick[p] != null ||
        !runtime.game.hands[p].some((c) => c.id === e.id)
      )
        return true;
      runtime.game.tribPick[p] = e.id;
      if (p === 0) {
        runtime.selection = new Set();
        runtime.network.pending = false;
      }
      tribWait();
      return true;
    }
    case 'ready':
      if (runtime.game.phase !== 'prep') return false;
      if (!runtime.game.ready.includes(p)) runtime.game.ready.push(p);
      if ([...runtime.network.humans].every((h) => runtime.game.ready.includes(h))) beginPlay();
      else render();
      return true;
    case 'begin':
      if (runtime.game.phase !== 'prep') return false;
      beginPlay();
      return true;
    case 'next': {
      if (runtime.game.phase !== 'roundEnd' && runtime.game.phase !== 'over') return false;
      const nr = runtime.game.nextReady || (runtime.game.nextReady = []);
      if (!nr.includes(p)) nr.push(p);
      if (!$('#overlay').hidden && $('#panel').dataset.kind === 'result') showResult();
      // after this event has gone out to everyone, so the new round follows it
      setTimeout(startNextIfReady, 0);
      return true;
    }
    case 'pause':
      // only the player who paused can resume, and a game already paused is not paused again by someone else
      if (runtime.game.paused && runtime.game.pausedBy !== p) return true;
      setPaused(!!e.on, p);
      return true;
    case 'humans':
      setHumans(e.list.map(toLocal), e.names);
      if (e.left) playerLeft(e.left, e.how);
      setTimeout(startNextIfReady, 0);
      return true;
    case 'play':
    case 'pass': {
      if (runtime.game.phase !== 'play' || runtime.game.turn !== p) return false;
      // your own move came back: you are no longer waiting on it (it may have ended the round, with no next turn to clear this)
      if (p === 0) runtime.network.pending = false;
      if (e.k === 'pass') {
        if (!canPass(runtime.game.trick)) return false;
        doPlay(p, null);
        return true;
      }
      const play = readPlay(runtime.game.hands[p], e, runtime.game.trick?.play, runtime.game.L);
      if (!play) return false;
      doPlay(p, play);
      return true;
    }
  }
  return true;
}

// who is a person (local seats) and what their seats are called
export function setHumans(list, names) {
  runtime.network.humans = new Set(list);
  runtime.names = BASE_NAMES.slice();
  if (names)
    for (const a in names) {
      const l = toLocal(+a);
      if (l !== 0 && runtime.network.humans.has(l)) runtime.names[l] = names[a];
    }
  for (let q = 1; q < 4; q++) $('#seat' + q + ' .name').textContent = runtime.names[q];
  VC.prune();
  if (runtime.game && runtime.game.paused && !runtime.network.humans.has(runtime.game.pausedBy))
    setPaused(false);
  if (runtime.game) render();
}

export function initialize() {
  // a friend's page applies the host's events in order, each as soon as it fits
  setInterval(() => {
    if (runtime.network.mode !== 'guest') return;
    for (let i = 0; i < 20 && runtime.network.inbox.length; i++) {
      if (!applyEvt(runtime.network.inbox[0])) break;
      runtime.network.inbox.shift();
    }
  }, 60);
}
