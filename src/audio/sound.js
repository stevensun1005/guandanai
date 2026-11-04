import { $ } from '../ui/cards.js';

export let Sound;

export function syncAudioBtns() {
  $('#sfxBtn').setAttribute('aria-pressed', Sound.prefs.sfx);
}

export function initialize() {
  /* ---------- sound: everything is synthesised with Web Audio, no files ---------- */
  Sound = (() => {
    const prefs = { sfx: true };
    try {
      Object.assign(prefs, JSON.parse(localStorage.getItem('guandan-audio') || '{}'));
    } catch (_) {}
    const save = () => {
      try {
        localStorage.setItem('guandan-audio', JSON.stringify(prefs));
      } catch (_) {}
    };
    let ctx = null,
      sfxBus,
      noise,
      room,
      now = 0;

    function unlock() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        // on an iPad the silent switch / silent mode would otherwise mute the page: play like a media app
        try {
          if (navigator.audioSession) navigator.audioSession.type = 'playback';
        } catch (_) {}
        ctx = new AC();
        const master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
        sfxBus = ctx.createGain();
        sfxBus.gain.value = 1;
        sfxBus.connect(master);
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        // a small room, so knocks sound like they happen on a real table rather than inside the speaker
        const len = Math.floor(ctx.sampleRate * 0.3),
          ir = ctx.createBuffer(2, len, ctx.sampleRate);
        for (let ch = 0; ch < 2; ch++) {
          const r = ir.getChannelData(ch);
          let lp = 0;
          for (let i = 0; i < len; i++) {
            lp += (Math.random() * 2 - 1 - lp) * 0.35;
            r[i] = lp * Math.exp(-i / (ctx.sampleRate * 0.055));
          }
        }
        room = ctx.createConvolver();
        room.buffer = ir;
        const roomWet = ctx.createGain();
        roomWet.gain.value = 0.22;
        room.connect(roomWet);
        roomWet.connect(sfxBus);
      }
      // still silent (not yet allowed, or interrupted when the iPad switched apps or locked): ask again, and play a
      // one-sample silent sound inside this tap, which is what lets Safari start the audio
      if (ctx.state !== 'running') {
        try {
          const r = ctx.resume();
          if (r && r.catch) r.catch(() => {});
        } catch (_) {}
        try {
          const b = ctx.createBufferSource();
          b.buffer = ctx.createBuffer(1, 1, 22050);
          b.connect(ctx.destination);
          b.start(0);
        } catch (_) {}
      }
    }
    const ready = () => ctx && ctx.state === 'running';

    function tone(f, t, dur, { type = 'sine', gain = 0.2, attack = 0.005, dest = sfxBus } = {}) {
      const o = ctx.createOscillator(),
        g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      g.connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
      return o;
    }
    function burst(t, dur, { freq = 2000, q = 1, type = 'bandpass', gain = 0.3 } = {}) {
      const s = ctx.createBufferSource(),
        f = ctx.createBiquadFilter(),
        g = ctx.createGain();
      s.buffer = noise;
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f);
      f.connect(g);
      g.connect(sfxBus);
      s.start(t, Math.random() * 0.5);
      s.stop(t + dur + 0.02);
      return f;
    }
    // knuckle on a wooden table top: a few ms of noise rings the board's resonances, plus a low body thump and the knuckle's click
    function knock(t, v, tune) {
      const out = ctx.createGain();
      out.gain.value = 1;
      out.connect(sfxBus);
      out.connect(room);
      const src = ctx.createBufferSource(),
        env = ctx.createGain();
      src.buffer = noise;
      env.gain.setValueAtTime(v, t);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.004);
      src.connect(env);
      for (const [f, q, g] of [
        [185, 22, 9],
        [410, 26, 6],
        [860, 30, 3.2],
        [1580, 26, 1.6],
        [2900, 16, 0.6],
      ]) {
        const bp = ctx.createBiquadFilter(),
          gg = ctx.createGain();
        bp.type = 'bandpass';
        bp.frequency.value = f * tune;
        bp.Q.value = q;
        gg.gain.value = g;
        env.connect(bp);
        bp.connect(gg);
        gg.connect(out);
      }
      const hp = ctx.createBiquadFilter(),
        cg = ctx.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 3200;
      cg.gain.value = 0.22;
      env.connect(hp);
      hp.connect(cg);
      cg.connect(out);
      const o = ctx.createOscillator(),
        og = ctx.createGain();
      o.frequency.setValueAtTime(140 * tune, t);
      o.frequency.exponentialRampToValueAtTime(65, t + 0.05);
      og.gain.setValueAtTime(0, t);
      og.gain.linearRampToValueAtTime(v * 0.35, t + 0.002);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(og);
      og.connect(out);
      o.start(t);
      o.stop(t + 0.1);
      src.start(t, Math.random() * 0.5);
      src.stop(t + 0.012);
    }
    // zither-like pluck: triangle body plus a quieter octave that dies faster
    function pluck(f, t, dur, gain, dest) {
      tone(f, t, dur, { type: 'triangle', gain, dest });
      tone(f * 2, t, dur * 0.45, { gain: gain * 0.4, dest });
    }
    const fx = {
      deal() {
        burst(now, 0.03, { freq: 4500, type: 'highpass', gain: 0.07 });
      },
      shuffle() {
        for (let i = 0; i < 10; i++)
          burst(now + i * 0.045, 0.05, { freq: 3200, type: 'highpass', gain: 0.09 });
      },
      select() {
        tone(1150, now, 0.05, { type: 'triangle', gain: 0.035 });
      },
      play() {
        burst(now, 0.09, { freq: 1700, q: 0.8, gain: 0.38 });
        tone(170, now, 0.08, { gain: 0.16 });
      },
      // two quick knocks on the table
      pass() {
        knock(now, 0.85, 1);
        knock(now + 0.13, 0.7, 1.03);
      },
      bomb(big) {
        const f = burst(now, big ? 1.2 : 0.75, { freq: 1400, type: 'lowpass', gain: 0.7 });
        f.frequency.exponentialRampToValueAtTime(70, now + 0.6);
        const o = tone(120, now, big ? 1.1 : 0.65, { gain: 0.5 });
        o.frequency.exponentialRampToValueAtTime(36, now + 0.55);
        if (big) [0, 0.12, 0.24].forEach((d) => burst(now + d, 0.25, { freq: 900, gain: 0.3 }));
      },
      turn() {
        tone(988, now, 0.3, { gain: 0.05 });
        tone(1319, now + 0.09, 0.4, { gain: 0.045 });
      },
      tick() {
        tone(1500, now, 0.05, { type: 'square', gain: 0.025 });
      },
      // a long riffle: the brrrrr of two halves zipping together, a dense run of paper snaps that swells and fades
      riffleLong() {
        for (let i = 0; i < 44; i++) {
          const t = now + i * 0.013 + Math.random() * 0.004;
          burst(t, 0.014, {
            freq: 2400 + Math.random() * 2200,
            q: 1.4,
            type: 'bandpass',
            gain: 0.16 * (0.45 + 0.55 * Math.sin((Math.PI * i) / 44)),
          });
        }
      },
      // a single card flicked off the deck
      flick() {
        burst(now, 0.028, {
          freq: 2800 + Math.random() * 1800,
          q: 1.3,
          type: 'bandpass',
          gain: 0.13,
        });
        burst(now + 0.004, 0.012, { freq: 6000, type: 'highpass', gain: 0.05 });
      },
      // a block of cards slapped down on the felt
      cardSlap() {
        burst(now, 0.07, { freq: 1100, q: 0.7, gain: 0.42 });
        tone(150, now, 0.08, { gain: 0.2, attack: 0.002 });
        burst(now, 0.02, { freq: 4200, type: 'highpass', gain: 0.08 });
      },
      // a fast riffle: a run of crisp little card snaps
      riffle() {
        for (let i = 0; i < 14; i++)
          burst(now + i * 0.028 + Math.random() * 0.008, 0.022, {
            freq: 3800 + Math.random() * 1500,
            type: 'highpass',
            gain: 0.09,
          });
      },
      // air moving as the cards sweep: band-passed noise gliding up
      // sobbing: three short whimpers sliding down
      sob() {
        for (const [d, f] of [
          [0, 620],
          [0.32, 580],
          [0.66, 520],
        ]) {
          const o = tone(f, now + d, 0.26, { type: 'triangle', gain: 0.06, attack: 0.02 });
          o.frequency.exponentialRampToValueAtTime(f * 0.72, now + d + 0.24);
        }
      },
      whoosh() {
        const f = burst(now, 0.42, { freq: 500, q: 1.2, type: 'bandpass', gain: 0.22 });
        f.frequency.exponentialRampToValueAtTime(2600, now + 0.35);
      },
      error() {
        tone(150, now, 0.16, { type: 'square', gain: 0.035 });
      },
      win() {
        [587, 659, 740, 880, 988, 1175].forEach((f, i) =>
          pluck(f, now + i * 0.09, 1.1, 0.12, sfxBus),
        );
      },
      lose() {
        [880, 740, 659, 587, 494].forEach((f, i) => pluck(f, now + i * 0.14, 1.1, 0.1, sfxBus));
      },
      // first out: a quick rising run that lands on a held major chord
      fanfare() {
        [523, 659, 784, 1047].forEach((f, i) => pluck(f, now + i * 0.08, 0.5, 0.13, sfxBus));
        for (const f of [523, 659, 784, 1047])
          tone(f, now + 0.34, 1.3, { type: 'triangle', gain: 0.06, attack: 0.02 });
        for (let i = 0; i < 6; i++)
          burst(now + 0.34 + i * 0.07, 0.06, { freq: 5200, type: 'highpass', gain: 0.05 });
      },
      // the match is won: a rising call that lands on a long bright chord over crashing cymbals
      victory() {
        const N = [
          [392, 0, 0.18],
          [523, 0.18, 0.18],
          [659, 0.36, 0.18],
          [784, 0.54, 0.36],
          [659, 0.9, 0.18],
          [784, 1.08, 1.6],
        ];
        for (const [f, d, len] of N) {
          pluck(f, now + d, len + 0.3, 0.13, sfxBus);
          tone(f / 2, now + d, len + 0.2, { type: 'triangle', gain: 0.05 });
        }
        for (const f of [523, 659, 784, 1047])
          tone(f, now + 1.08, 2.4, { type: 'triangle', gain: 0.055, attack: 0.03 });
        for (const d of [0, 0.54, 1.08])
          burst(now + d, 0.9, { freq: 6000, type: 'highpass', gain: 0.12 });
      },
      // a firework bursting far off: a dull thud and a scatter of crackles
      pop() {
        burst(now, 0.4, { freq: 420, type: 'lowpass', gain: 0.32 });
        for (let i = 0; i < 6; i++)
          burst(now + 0.12 + Math.random() * 0.45, 0.03, {
            freq: 5200,
            type: 'highpass',
            gain: 0.05,
          });
      },
      // resisting the tribute: a struck gong
      gong() {
        for (const [f, g, d] of [
          [110, 0.3, 2.6],
          [222, 0.12, 1.9],
          [302, 0.08, 1.5],
          [466, 0.05, 1.1],
          [690, 0.03, 0.8],
        ])
          tone(f, now, d, { gain: g, attack: 0.004 });
        burst(now, 0.25, { freq: 500, q: 0.6, gain: 0.3 });
      },
      // second / third out: a small two-note bell
      ding() {
        tone(1175, now, 0.6, { gain: 0.07 });
        tone(1568, now + 0.1, 0.8, { gain: 0.05 });
      },
      // last place: the sad trombone, wah wah wah wahhh
      sad() {
        const notes = [
          [392, 0.0, 0.32],
          [370, 0.36, 0.32],
          [349, 0.72, 0.32],
          [330, 1.08, 1.1],
        ];
        for (const [f, d, len] of notes) {
          const o = ctx.createOscillator(),
            lp = ctx.createBiquadFilter(),
            g = ctx.createGain(),
            t = now + d;
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(f, t);
          lp.type = 'lowpass';
          lp.frequency.value = 900;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.09, t + 0.04);
          g.gain.setValueAtTime(0.09, t + len - 0.08);
          g.gain.linearRampToValueAtTime(0, t + len);
          if (len > 0.5) {
            const lfo = ctx.createOscillator(),
              lg = ctx.createGain();
            lfo.frequency.value = 6;
            lg.gain.value = 7;
            lfo.connect(lg);
            lg.connect(o.frequency);
            lfo.start(t + 0.2);
            lfo.stop(t + len);
          }
          o.connect(lp);
          lp.connect(g);
          g.connect(sfxBus);
          o.start(t);
          o.stop(t + len + 0.05);
        }
      },
    };
    function play(name, arg) {
      if (!prefs.sfx || !ready()) return;
      now = ctx.currentTime;
      fx[name](arg);
    }

    // (there is no background music: the voice chat's duck() stays as a call that does nothing)
    function duck() {}
    function toggle(kind) {
      prefs[kind] = !prefs[kind];
      save();
      unlock();
      return prefs[kind];
    }
    const wake = () => {
      if (ctx && ctx.state !== 'running')
        try {
          const r = ctx.resume();
          if (r && r.catch) r.catch(() => {});
        } catch (_) {}
    };
    return { unlock, wake, play, toggle, duck, prefs };
  })();
}
