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
  /**
   * Sixteenth-steps of semitone offsets from root; null = rest. The pattern
   * length defines the bar: 16 = 4/4, 12 = 3/4 (waltz).
   */
  bassPat: Step[];
  /** Sixteenth-steps of scale-degree indices (wrap = +octave); null = rest. */
  arpPat: Step[];
  /** Probability of a hat per sixteenth, 0..1. */
  hatDensity: number;
  /** Extra tom percussion (jungle flavour). */
  perc?: boolean;
  /** Longer, softer notes + sustained pad. */
  dreamy?: boolean;
  /** Shuffle: even sixteenths stretched, odd ones shortened (~2:1). */
  swing?: boolean;
  /** Bandpassed-noise snare on the backbeats (steps 4 and 12). */
  snare?: boolean;
}

const PENT_MIN = [0, 3, 5, 7, 10];
const PENT_MAJ = [0, 2, 4, 7, 9];
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const HARM_MIN = [0, 2, 3, 5, 7, 8, 11];
const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
const NAT_MIN = [0, 2, 3, 5, 7, 8, 10];
const LYDIAN = [0, 2, 4, 6, 7, 9, 11];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const BLUES = [0, 3, 5, 6, 7, 10];

// One theme per level, aligned with the 20 entries of LEVEL_NAMES in sim.ts.
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
  {
    // CRUZ — marcha frigia tensa: pulso marcial con caja y la b2 clavada.
    bpm: 116, root: 38, scale: PHRYGIAN, bassWave: 'square', arpWave: 'square',
    bassPat: [0, null, null, 0, 0, null, null, null, 0, null, null, 0, 1, null, 0, null],
    arpPat: [0, null, null, null, 4, null, null, null, 0, null, 0, null, 5, null, 4, null],
    hatDensity: 0.5,
    snare: true,
  },
  {
    // ASPAS — space-disco: bajo en octavas que gira y arpegio en barrido.
    bpm: 122, root: 36, scale: DORIAN, bassWave: 'sawtooth', arpWave: 'sawtooth',
    bassPat: [0, null, 12, null, 0, null, 12, null, 0, null, 12, null, 0, 10, 12, null],
    arpPat: [0, 2, 4, 6, 7, null, 4, null, 0, 2, 4, 6, 9, null, 7, null],
    hatDensity: 0.8,
  },
  {
    // GEMELAS — vals a 3/4 (compás de 12 pasos): un-pá-pá con frase espejada.
    bpm: 138, root: 45, scale: MAJOR, bassWave: 'triangle', arpWave: 'sine',
    bassPat: [0, null, null, null, 7, null, null, null, 4, null, null, null],
    arpPat: [0, null, 2, 4, null, 7, null, 4, 2, null, 0, null],
    hatDensity: 0.15,
  },
  {
    // PANAL — swing juguetón: bajo que camina y shuffle en las semicorcheas.
    bpm: 102, root: 43, scale: PENT_MAJ, bassWave: 'triangle', arpWave: 'triangle',
    bassPat: [0, null, null, null, 4, null, 7, null, 9, null, 7, null, 4, null, 0, null],
    arpPat: [0, null, 1, null, 2, null, 4, null, 3, null, 2, null, 4, null, 1, null],
    hatDensity: 0.55,
    swing: true,
  },
  {
    // DIANA — chiptune arcade: cuadradas a 150bpm y arpegio en ráfaga.
    bpm: 150, root: 45, scale: MAJOR, bassWave: 'square', arpWave: 'square',
    bassPat: [0, null, 0, null, 7, null, 0, null, 5, null, 0, null, 7, null, 12, null],
    arpPat: [0, 2, 4, 7, 4, 2, 0, null, 1, 3, 5, 7, 5, 3, 1, null],
    hatDensity: 0.6,
  },
  {
    // VOLCÁN — retumbe grave: subgrave frigio, toms como magma, casi sin melodía.
    bpm: 86, root: 31, scale: PHRYGIAN, bassWave: 'sine', arpWave: 'sawtooth',
    bassPat: [0, null, null, null, null, null, 0, null, 1, null, null, null, null, 0, null, null],
    arpPat: [null, null, null, null, 0, null, null, null, null, null, null, null, 1, null, null, null],
    hatDensity: 0.3,
    perc: true,
  },
  {
    // ZIGURAT — pentatónica mística: dron que sube a la quinta + pad flotante.
    bpm: 84, root: 38, scale: PENT_MIN, bassWave: 'sine', arpWave: 'triangle',
    bassPat: [0, null, null, null, null, null, null, null, 7, null, null, null, null, null, null, null],
    arpPat: [0, null, null, 3, null, null, 1, null, null, 4, null, null, 2, null, null, null],
    hatDensity: 0.18,
    dreamy: true,
  },
  {
    // TORRES — coral gótico: menor armónica a 66bpm, voces largas tipo órgano.
    bpm: 66, root: 36, scale: HARM_MIN, bassWave: 'sine', arpWave: 'sine',
    bassPat: [0, null, null, null, null, null, null, null, 8, null, null, null, 7, null, null, null],
    arpPat: [0, null, null, null, 2, null, null, null, 4, null, null, null, 6, null, null, null],
    hatDensity: 0.06,
    dreamy: true,
  },
  {
    // RULETA DOBLE — synthwave: sierras a 132bpm, bajo galopante en corcheas.
    bpm: 132, root: 33, scale: NAT_MIN, bassWave: 'sawtooth', arpWave: 'sawtooth',
    bassPat: [0, 0, null, 0, 0, null, 0, 0, null, 0, 0, null, 8, null, 10, null],
    arpPat: [0, null, 2, null, 4, null, 7, null, 6, null, 4, null, 2, null, 4, null],
    hatDensity: 0.7,
  },
  {
    // FÁBRICA — industrial: martilleo de corcheas frigias con caja metálica.
    bpm: 124, root: 33, scale: PHRYGIAN, bassWave: 'square', arpWave: 'square',
    bassPat: [0, null, 0, null, 0, null, 1, null, 0, null, 0, null, 0, null, 1, null],
    arpPat: [0, 0, null, null, 0, 0, null, null, 0, 0, null, null, 7, null, 5, null],
    hatDensity: 0.75,
    snare: true,
  },
  {
    // MARTILLO — blues pesado: riff en escala blues con shuffle arrastrado.
    bpm: 76, root: 33, scale: BLUES, bassWave: 'sawtooth', arpWave: 'triangle',
    bassPat: [0, null, 0, null, 3, null, 5, null, 6, null, 5, null, 3, null, 0, null],
    arpPat: [null, null, null, null, 4, null, 3, null, null, null, null, null, 2, null, 1, null],
    hatDensity: 0.4,
    swing: true,
  },
  {
    // CALLES — funk urbano: bajo sincopado con octavas y stabs a contratiempo.
    bpm: 106, root: 38, scale: DORIAN, bassWave: 'sawtooth', arpWave: 'square',
    bassPat: [0, null, null, 12, null, null, 0, null, 10, null, 0, null, null, 12, null, null],
    arpPat: [null, null, 4, null, null, null, 4, 6, null, null, 4, null, null, 2, null, null],
    hatDensity: 0.75,
    snare: true,
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
      const th = MUSIC_THEMES[this.levelIdx];
      const bpm = th.bpm + (this.duel ? DUEL_BPM_BOOST : 0);
      const dur = 60 / bpm / 4; // sixteenth notes
      // Shuffle: even sixteenths stretched, odd ones squeezed (~2:1 swing).
      this.nextStep += th.swing ? dur * (this.step % 2 === 0 ? 1.34 : 0.66) : dur;
      // Pattern length defines the bar (16 = 4/4, 12 = 3/4).
      this.step = (this.step + 1) % th.bassPat.length;
    }
  }

  private scheduleStep(i: number, t: number): void {
    if (!this.layers) return;
    const th = MUSIC_THEMES[this.levelIdx];
    const stepDur = 60 / th.bpm / 4;
    // Level switches mid-bar can leave `i` past a shorter pattern; wrap it.
    const steps = th.bassPat.length;

    // Bass — the backbone, always audible.
    const b = th.bassPat[i % steps];
    if (b !== null) {
      const dur = stepDur * (th.dreamy ? 5 : 2.6);
      this.note(this.layers.bass, th.root + b, t, dur, th.bassWave, BASS_VOL[th.bassWave]);
    }

    // Dreamy pad: long soft fifth+octave once per bar, rides the bass layer.
    if (th.dreamy && i % steps === 0) {
      const barDur = stepDur * steps;
      this.note(this.layers.bass, th.root + 19, t, barDur, 'sine', 0.02);
      this.note(this.layers.bass, th.root + 24, t, barDur, 'sine', 0.016);
    }

    // Arpeggio — melodic tension layer, two octaves above the bass.
    const a = th.arpPat[i % th.arpPat.length];
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

    // Snare on the backbeats (steps 4 and 12 in 4/4) — martial/industrial themes.
    if (th.snare && i % 8 === 4) this.snare(t);

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

  /** Bandpassed noise burst — backbeat snare. Rides the hats layer. */
  private snare(t: number): void {
    if (!this.ctx || !this.noiseBuffer || !this.layers) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.8;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.045, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    src.connect(bp);
    bp.connect(gain);
    gain.connect(this.layers.hats);
    src.start(t);
    src.stop(t + 0.13);
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
