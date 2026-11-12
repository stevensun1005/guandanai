import { syncPauseMic } from '../ui/overlays.js';
import { runtime } from '../app/runtime.js';
import { Sound } from '../audio/sound.js';
import { isHost, isHumanSeat, toAbs, toLocal } from '../game/session.js';
import { broadcast } from './rooms.js';
import { $ } from '../ui/cards.js';
import { setMsg } from '../ui/table.js';

export let VC;

export function initialize() {
  /* ---------- voice: the people at an online table talk to each other as on a conference call ---------- */
  // every two people have their own audio line (the lower seat, in the host's numbering, calls the higher), so no voice
  // goes through the host. A line starts with a silent track; turning the microphone on puts the real one in its place,
  // and turning it off only silences it, so the lines stay up. Whose microphone is on goes round through the host
  // (NET.mics, host's seat numbers); who is talking is measured on each page from the sound itself.
  VC = (() => {
    const SPK =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
    document.querySelectorAll('.vc').forEach((e) => (e.innerHTML = SPK));
    let active = false,
      peers = {},
      ac = null,
      blank = null,
      mic = null,
      on = false,
      timer = 0;
    const lines = new Map(),
      meters = new Map(),
      heard = new Map(),
      talking = new Set(),
      waiting = [],
      buf = new Uint8Array(512);
    let muted = new Set(),
      locked = false;
    const me = () =>
      runtime.network.mode === 'spectator' ? runtime.network.spectatorId : toAbs(0);
    const ctx = () => {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) ac = new AC();
      }
      return ac;
    };
    const track = () =>
      mic ||
      blank ||
      (blank = ctx() ? ac.createMediaStreamDestination().stream.getAudioTracks()[0] : null);
    const here = (a) => active && !!peers[a] && (a >= 10 || isHumanSeat(toLocal(a)));
    function meter(a, stream) {
      try {
        const c = ctx(),
          an = c.createAnalyser();
        an.fftSize = 512;
        c.createMediaStreamSource(stream).connect(an);
        meters.set(a, an);
      } catch (_) {}
    }
    function drop(a) {
      const ln = lines.get(a);
      if (!ln) return;
      lines.delete(a);
      meters.delete(a);
      talking.delete(a);
      try {
        ln.call.close();
      } catch (_) {}
      if (ln.audio) {
        ln.audio.srcObject = null;
        ln.audio.remove();
      }
    }
    function wire(call, a) {
      if (lines.has(a)) drop(a);
      const ln = { call, audio: null, got: false };
      lines.set(a, ln);
      call.on('stream', (st) => {
        if (lines.get(a) !== ln) return;
        ln.got = true;
        if (!ln.audio) {
          ln.audio = document.createElement('audio');
          ln.audio.autoplay = true;
          ln.audio.setAttribute('playsinline', '');
          ln.audio.hidden = true;
          document.body.appendChild(ln.audio);
        }
        ln.audio.srcObject = st;
        ln.audio.muted = muted.has(a);
        ln.audio.play().catch(() => {});
        meter(a, st);
      });
      // the line broke while both are still at the table: the caller calls again
      const broke = () => {
        if (lines.get(a) !== ln) return;
        drop(a);
        if (me() < a)
          setTimeout(() => {
            if (here(a) && !lines.has(a)) dial(a);
          }, 3000);
      };
      call.on('close', broke);
      call.on('error', broke);
    }
    function dial(a) {
      const t = track();
      if (!t || !runtime.network.peer || !here(a)) return;
      const call = runtime.network.peer.call(peers[a], new MediaStream([t]), {
        metadata: { seat: me() },
      });
      if (!call) return;
      wire(call, a);
      // no answer in ten seconds (the other page may not have been ready): try again
      setTimeout(() => {
        const ln = lines.get(a);
        if (ln && ln.call === call && !ln.got) {
          drop(a);
          dial(a);
        }
      }, 10000);
    }
    function answer(call) {
      const a = call.metadata && call.metadata.seat,
        t = track();
      if (typeof a !== 'number' || peers[a] !== call.peer || !here(a) || !t) {
        try {
          call.close();
        } catch (_) {}
        return;
      }
      call.answer(new MediaStream([t]));
      wire(call, a);
    }
    // a call can arrive before this page has learnt who sits where: it waits until then
    function incoming(call) {
      if (active) answer(call);
      else waiting.push(call);
    }
    function start(p) {
      if (!window.Peer || !runtime.network.peer || !p) return;
      peers = p;
      for (const [seat, line] of lines) if (line.call.peer !== peers[seat]) drop(seat);
      active = Object.keys(peers).length > 1;
      if (!active) return;
      for (const c of waiting.splice(0)) answer(c);
      for (const a in peers) if (+a > me() && !lines.has(+a)) dial(+a);
      if (!timer) timer = setInterval(listen, 150);
      paint();
    }
    function stop() {
      muted.clear();
      locked = false;
      // Calls may have queued before the seat list arrived. Always discard them on reconnect,
      // even when voice never became active; their PeerJS provider is about to be destroyed.
      for (const call of waiting.splice(0)) {
        try {
          call.close();
        } catch (_) {}
      }
      if (!active && !mic) return;
      active = false;
      for (const a of [...lines.keys()]) drop(a);
      if (mic) {
        mic.stop();
        mic = null;
      }
      on = false;
      meters.clear();
      talking.clear();
      clearInterval(timer);
      timer = 0;
      Sound.duck(false);
      paint();
    }
    // someone left the table: their line goes; once nobody else is left, voice ends
    function prune() {
      if (!active) return;
      for (const a of [...lines.keys()]) if (!here(a)) drop(a);
      if (Object.keys(peers).filter((a) => +a === me() || here(+a)).length < 2) stop();
      else paint();
    }
    function swap(call, t) {
      try {
        const sd =
          call.peerConnection &&
          call.peerConnection.getSenders().find((x) => !x.track || x.track.kind === 'audio');
        if (sd) sd.replaceTrack(t);
      } catch (_) {}
    }
    async function toggle() {
      if (!active || locked) return;
      if (!mic) {
        try {
          // an iPad plays the page like a media app; to listen to the microphone it has to switch to a call
          try {
            if (navigator.audioSession) navigator.audioSession.type = 'play-and-record';
          } catch (_) {}
          const st = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
          if (!active || locked) {
            st.getTracks().forEach((t) => t.stop());
            return;
          }
          mic = st.getAudioTracks()[0];
          for (const ln of lines.values()) swap(ln.call, mic);
          meter(me(), st);
        } catch (_) {
          setMsg('麦克风没有打开，请在浏览器设置里允许这个网页使用麦克风', true);
          return;
        }
        on = true;
      } else on = !on;
      mic.enabled = on;
      Sound.duck(on);
      if (isHost()) {
        runtime.network.mics[me()] = on;
        broadcast({ t: 'mics', m: runtime.network.mics });
      } else if (runtime.network.hostConn && runtime.network.hostConn.open)
        runtime.network.hostConn.send({ t: 'mic', on });
      paint();
    }
    // a speaker shows while the sound on someone's line (or your own microphone) is loud enough, and for a moment after
    function listen() {
      const now = Date.now();
      let changed = false;
      for (const [a, an] of meters) {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / buf.length) > 0.035) heard.set(a, now);
        const t = now - (heard.get(a) || 0) < 400 && (a === me() ? on : !!runtime.network.mics[a]);
        if (t !== talking.has(a)) {
          t ? talking.add(a) : talking.delete(a);
          changed = true;
        }
      }
      if (changed) paint();
    }
    function paint() {
      syncPauseMic();
      const b = $('#micBtn');
      b.hidden = !active;
      b.classList.toggle('on', on);
      b.textContent = on ? '开麦' : '闭麦';
      b.setAttribute('aria-pressed', on);
      const watch = $('#spectatorMic');
      watch.hidden = !active || runtime.network.mode !== 'spectator';
      watch.disabled = locked;
      watch.textContent = locked ? '语音已关闭' : on ? '开麦' : '闭麦';
      watch.setAttribute('aria-pressed', String(on));
      for (let q = 0; q < 4; q++) {
        const el = $(q ? `#seat${q} .vc` : '#myVc');
        if (!el) continue;
        const a = toAbs(q);
        el.className = 'vc' + (active && isHumanSeat(q) && talking.has(a) ? ' talk' : '');
      }
    }
    // browsers hold sound back until the page is touched: every tap wakes the listening and the lines up again
    function wake() {
      if (ac && ac.state !== 'running')
        try {
          ac.resume().catch(() => {});
        } catch (_) {}
      for (const ln of lines.values())
        if (ln.audio && ln.audio.paused) ln.audio.play().catch(() => {});
    }
    function setMuted(ids) {
      muted = new Set(ids);
      for (const [a, line] of lines) if (line.audio) line.audio.muted = muted.has(a);
    }
    function lock(off) {
      locked = off;
      if (off && mic) {
        on = false;
        mic.enabled = false;
        Sound.duck(false);
      }
      paint();
    }
    return {
      start,
      stop,
      prune,
      incoming,
      toggle,
      wake,
      paint,
      setMuted,
      lock,
      info: () => ({ active, on, locked }),
    };
  })();
}
