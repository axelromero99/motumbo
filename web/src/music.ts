// Procedural background music via WebAudio — zero assets. A lookahead
// scheduler (setInterval ~100ms) plants disposable oscillators + envelopes up
// to 0.3s ahead, same technique as audio.ts tone(). Layers are GainNodes that
// crossfade with the match state: bass always on, hats when the floor starts
// crumbling, arpeggio at medium tension, ostinato (double-time pulse) when the
// round gets desperate or it's a final duel. Math.random here is audio-only
// and never feeds the sim, so determinism is untouched.
//
// Node graph:
//   bass/hats/arp/ost gains -> mix -> lowpass (countdown) -> duck -> vol -> destination

export interface MusicState {
  level: number;
  aliveCount: number;
  playerCount: number;
  crumbleRatio: number;
  countdown: boolean;
  roundOver: boolean;
}

type Step = number | null;

interface Theme {
  bpm: number;
  /** Root as MIDI note, bass register. */
  root: number;
  /** Scale as semitone offsets from root (one octave). */
  scale: number[];
  bassWave: OscillatorType;
  arpWave: OscillatorType;
  /** 16 sixteenth-steps of semitone offsets from root; null = rest. */
  bassPat: Step[];
  /** 16 sixteenth-steps of scale-degree indices (wrap = +octave); null = rest. */
  arpPat: Step[];
  /** Probability of a hat per sixteenth, 0..1. */
  hatDensity: number;
  /** Extra tom percussion (jungle flavour). */
  perc?: boolean;
  /** Longer, softer notes + sustained pad. */
  dreamy?: boolean;
}

const PENT_MIN = [0, 3, 5, 7, 10];
const PENT_MAJ = [0, 2, 4, 7, 9];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const HARM_MIN = [0, 2, 3, 5, 7, 8, 11];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const NAT_MIN = [0, 2, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];

// One theme per level, aligned with LEVEL_NAMES in sim.ts:
// CLÁSICA, ANILLO, PUENTES, RULETA, PIRÁMIDE, HERRADURA, PASARELA, TARIMAS.
export const MUSIC_THEMES: Theme[] = [
  {
    // CLÁSICA — neón relajado, pentatónica menor floja.
    bpm: 100, root: 33, scale: PENT_MIN, bassWave: 'triangle', arpWave: 'sine',
    bassPat: [0, null, null, null, null, null, 7, null, 0, null, null, 10, null, null, 7, null],
    arpPat: [0, null, 2, null, 4, null, null, 3, null, 2, null, null, 5, null, 4, null],
    hatDensity: 0.3,
  },
  {
    // ANILLO — órbita dórica, arpegio que gira y vuelve.
    bpm: 108, root: 38, scale: DORIAN, bassWave: 'sine', arpWave: 'triangle',
    bassPat: [0, null, null, 0, null, null, 10, null, 0, null, null, 0, null, 7, null, null],
    arpPat: [0, 2, 4, 6, 7, 6, 4, 2, 0, 2, 4, 6, 7, 6, 4, 2],
    hatDensity: 0.4,
  },
  {
    // PUENTES — pentatónica mayor saltarina, aire de islas.
    bpm: 112, root: 43, scale: PENT_MAJ, bassWave: 'triangle', arpWave: 'square',
    bassPat: [0, null, 0, null, null, null, 7, null, 0, null, 4, null, null, null, 7, null],
    arpPat: [0, null, 1, 2, null, 4, null, 2, 5, null, 4, null, 2, 4, 1, null],
    hatDensity: 0.45,
  },
  {
    // RULETA — menor armónica tensa, bajo serrucho insistente.
    bpm: 128, root: 40, scale: HARM_MIN, bassWave: 'sawtooth', arpWave: 'sawtooth',
    bassPat: [0, null, null, 0, null, 0, null, null, 0, null, null, 0, null, 0, 8, null],
    arpPat: [0, null, 4, null, 6, null, 4, null, 0, null, 4, null, 7, null, 6, null],
    hatDensity: 0.6,
  },
  {
    // PIRÁMIDE — selva: sincopado, toms y lluvia de hats.
    bpm: 118, root: 36, scale: PENT_MIN, bassWave: 'triangle', arpWave: 'triangle',
    bassPat: [0, null, null, 0, null, null, 5, null, null, 0, null, null, 3, null, 5, null],
    arpPat: [0, 2, null, 3, null, 0, null, 2, null, 4, null, 3, 2, null, 0, null],
    hatDensity: 0.85,
    perc: true,
  },
  {
    // HERRADURA — desierto frigio, drone hipnótico con la b2.
    bpm: 96, root: 40, scale: PHRYGIAN, bassWave: 'sawtooth', arpWave: 'sine',
    bassPat: [0, null, null, null, 1, null, null, null, 0, null, null, null, null, null, 1, null],
    arpPat: [0, null, null, 1, null, null, 4, null, null, 3, null, null, 1, null, null, null],
    hatDensity: 0.25,
  },
  {
    // PASARELA — industrial: pulso mecánico en corcheas, menor natural.
    bpm: 126, root: 33, scale: NAT_MIN, bassWave: 'square', arpWave: 'square',
    bassPat: [0, null, 0, null, 0, null, 0, null, 0, null, 0, null, 10, null, 7, null],
    arpPat: [0, 0, 7, 0, 0, 7, 0, 0, 4, 0, 0, 7, 0, 0, 2, 0],
    hatDensity: 0.7,
  },
  {
    // TARIMAS — acuático dreamy: lidio lento, notas largas y pad.
    bpm: 92, root: 41, scale: LYDIAN, bassWave: 'sine', arpWave: 'sine',
    bassPat: [0, null, null, null, null, null, null, null, 7, null, null, null, null, null, 4, null],
    arpPat: [0, null, 2, null, 4, null, 6, null, null, null, 4, null, 2, null, null, null],
    hatDensity: 0.2,
    dreamy: true,
  },
];

const LOOKAHEAD = 0.3; // seconds scheduled ahead of currentTime
const TICK_INTERVAL = 100; // ms between scheduler wakeups
const DUEL_BPM_BOOST = 8;
const DUCK_LEVEL = 0.22;

// Pre-mixed per-wave bass volumes (saw/square carry far more harmonics).
const BASS_VOL: Record<string, number> = { sine: 0.16, triangle: 0.12, square: 0.045, sawtooth: 0.045 };
const ARP_VOL: Record<string, number> = { sine: 0.045, triangle: 0.04, square: 0.024, sawtooth: 0.022 };

function midiHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** Scale-degree index -> semitone offset, wrapping into upper octaves. */
function degSemi(scale: number[], deg: number): number {
  const n = scale.length;
  return scale[deg % n] + 12 * Math.floor(deg / n);
}

export class MusicEngine {
  private ctx: AudioContext | null = null;
  private volGain: GainNode | null = null;
  private duckGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private mix: GainNode | null = null;
  private layers: { bass: GainNode; hats: GainNode; arp: GainNode; ost: GainNode } | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private timer: number | null = null;

  private volume = 0.85;
  private levelIdx = 0;
  private duel = false;
  private step = 0;
  private nextStep = 0;
  private wasCountdown = false;
  private wasRoundOver = false;
  // Cached layer targets so setState (called every frame) only touches the
  // audio graph on actual transitions.
  private layerTargets = { hats: -1, arp: -1, ost: -1 };

  /** Call once after the user-gesture audio unlock. */
  attach(ctx: AudioContext, destination: AudioNode): void {
    if (this.ctx) return;
    this.ctx = ctx;

    this.volGain = ctx.createGain();
    this.volGain.gain.value = this.volume;
    this.volGain.connect(destination);

    this.duckGain = ctx.createGain();
    this.duckGain.connect(this.volGain);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 16000;
    this.filter.Q.value = 0.7;
    this.filter.connect(this.duckGain);

    this.mix = ctx.createGain();
    this.mix.gain.value = 1;
    this.mix.connect(this.filter);

    const layer = (v: number): GainNode => {
      const g = ctx.createGain();
      g.gain.value = v;
      g.connect(this.mix!);
      return g;
    };
    this.layers = { bass: layer(1), hats: layer(0), arp: layer(0), ost: layer(0) };

    const len = Math.floor(ctx.sampleRate * 0.5);
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.step = 0;
    this.nextStep = ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.schedule(), TICK_INTERVAL);
  }

  /** Called every frame; cheap — only touches nodes on state transitions. */
  setState(s: MusicState): void {
    if (!this.ctx || !this.layers) return;
    this.levelIdx = ((s.level | 0) % MUSIC_THEMES.length + MUSIC_THEMES.length) % MUSIC_THEMES.length;
    this.duel = s.aliveCount === 2 && s.playerCount > 2;

    const hats = s.roundOver || s.countdown ? 0 : s.crumbleRatio > 0.05 ? 1 : 0;
    const arp =
      s.roundOver || s.countdown ? 0 : s.crumbleRatio > 0.15 || s.aliveCount < s.playerCount ? 1 : 0;
    const ost = s.roundOver || s.countdown ? 0 : s.crumbleRatio > 0.5 || this.duel ? 1 : 0;
    this.applyLayer('hats', hats);
    this.applyLayer('arp', arp);
    this.applyLayer('ost', ost);

    if (s.countdown !== this.wasCountdown && this.filter) {
      this.wasCountdown = s.countdown;
      const t = this.ctx.currentTime;
      this.filter.frequency.cancelScheduledValues(t);
      if (s.countdown) {
        // Muffled, underwater — then a sweep open when the round breaks loose.
        this.filter.frequency.setTargetAtTime(260, t, 0.08);
      } else {
        this.filter.frequency.setTargetAtTime(16000, t, 0.3);
      }
    }

    if (s.roundOver !== this.wasRoundOver) {
      this.wasRoundOver = s.roundOver;
      if (s.roundOver) {
        this.cadence();
        this.duck(1400);
      }
    }
  }

  /** Momentarily lower the music (big hits, falls, round end). */
  duck(ms: number): void {
    if (!this.ctx || !this.duckGain) return;
    const t = this.ctx.currentTime;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(DUCK_LEVEL, t + 0.06);
    g.setValueAtTime(DUCK_LEVEL, t + Math.max(0, ms) / 1000);
    g.linearRampToValueAtTime(1, t + Math.max(0, ms) / 1000 + 0.45);
  }

  /** Music bus volume, 0..1. Safe before attach (applied on attach). */
  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.ctx && this.volGain) {
      this.volGain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05);
    }
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (this.volGain) this.volGain.disconnect();
    this.ctx = null;
    this.volGain = null;
    this.duckGain = null;
    this.filter = null;
    this.mix = null;
    this.layers = null;
    this.noiseBuffer = null;
    this.layerTargets = { hats: -1, arp: -1, ost: -1 };
    this.wasCountdown = false;
    this.wasRoundOver = false;
  }

  // -----------------------------------------------------------------------
  // Scheduler
  // -----------------------------------------------------------------------

  private schedule(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Re-anchor after a tab pause so we don't burst-schedule a backlog.
    if (this.nextStep < now - 0.05) this.nextStep = now + 0.02;
    const horizon = now + LOOKAHEAD;
    while (this.nextStep < horizon) {
      this.scheduleStep(this.step, this.nextStep);
      const bpm = MUSIC_THEMES[this.levelIdx].bpm + (this.duel ? DUEL_BPM_BOOST : 0);
      this.nextStep += 60 / bpm / 4; // sixteenth notes
      this.step = (this.step + 1) % 16;
    }
  }

  private scheduleStep(i: number, t: number): void {
    if (!this.layers) return;
    const th = MUSIC_THEMES[this.levelIdx];
    const stepDur = 60 / th.bpm / 4;

    // Bass — the backbone, always audible.
    const b = th.bassPat[i];
    if (b !== null) {
      const dur = stepDur * (th.dreamy ? 5 : 2.6);
      this.note(this.layers.bass, th.root + b, t, dur, th.bassWave, BASS_VOL[th.bassWave]);
    }

    // Dreamy pad: long soft fifth+octave once per bar, rides the bass layer.
    if (th.dreamy && i === 0) {
      const barDur = stepDur * 16;
      this.note(this.layers.bass, th.root + 19, t, barDur, 'sine', 0.02);
      this.note(this.layers.bass, th.root + 24, t, barDur, 'sine', 0.016);
    }

    // Arpeggio — melodic tension layer, two octaves above the bass.
    const a = th.arpPat[i];
    if (a !== null) {
      const jump = Math.random() < 0.1 ? 12 : 0; // audio-only randomness
      const semi = degSemi(th.scale, a) + jump;
      const dur = stepDur * (th.dreamy ? 3.5 : 1.4);
      this.note(this.layers.arp, th.root + 24 + semi, t, dur, th.arpWave, ARP_VOL[th.arpWave]);
    }

    // Hats — filtered noise ticks, denser on strong sixteenths.
    const prob = th.hatDensity * (i % 2 === 0 ? 1 : 0.55);
    if (Math.random() < prob) {
      const open = i % 8 === 6 && Math.random() < 0.3;
      this.hat(t, open);
    }

    // Jungle toms.
    if (th.perc && (i === 3 || i === 6 || i === 10 || i === 13) && Math.random() < 0.7) {
      this.tom(t, i % 2 === 0 ? 170 : 220);
    }

    // Ostinato — driving double-time pulse alternating octave/fifth-up.
    const ostSemi = i % 2 === 0 ? 12 : 19;
    this.note(this.layers.ost, th.root + 24 + ostSemi, t, stepDur * 0.8, 'triangle', 0.035);
  }

  /** Disposable oscillator with a soft attack + exponential decay. */
  private note(dest: GainNode, midi: number, t: number, dur: number, type: OscillatorType, vol: number): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = midiHz(midi);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private hat(t: number, open: boolean): void {
    if (!this.ctx || !this.noiseBuffer || !this.layers) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const gain = this.ctx.createGain();
    const vol = (0.012 + Math.random() * 0.012) * (open ? 1.4 : 1);
    const dur = open ? 0.2 : 0.04;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(this.layers.hats);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private tom(t: number, f0: number): void {
    if (!this.ctx || !this.layers) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(f0 * 0.5, t + 0.16);
    gain.gain.setValueAtTime(0.05, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain);
    gain.connect(this.layers.hats);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /** Soft resolving roll on the tonic triad when the round ends. */
  private cadence(): void {
    if (!this.ctx || !this.layers) return;
    const th = MUSIC_THEMES[this.levelIdx];
    const degrees = [0, 2, 4, th.scale.length]; // triad + octave
    const t0 = this.ctx.currentTime + 0.05;
    degrees.forEach((d, k) => {
      this.note(this.layers!.bass, th.root + 24 + degSemi(th.scale, d), t0 + k * 0.07, 1.3, 'triangle', 0.04);
    });
    this.note(this.layers.bass, th.root, t0, 1.5, th.bassWave, BASS_VOL[th.bassWave] * 0.8);
  }

  private applyLayer(name: 'hats' | 'arp' | 'ost', target: number): void {
    if (!this.ctx || !this.layers) return;
    if (this.layerTargets[name] === target) return;
    this.layerTargets[name] = target;
    // Slower release than attack keeps transitions unnoticeable.
    this.layers[name].gain.setTargetAtTime(target, this.ctx.currentTime, target > 0 ? 0.4 : 0.7);
  }
}
