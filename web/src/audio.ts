// Synthesized SFX via WebAudio — zero assets, everything is oscillators,
// noise buffers and envelopes. Volumes are pre-mixed per effect.
// Graph: sfx bus -> master gain -> compressor -> destination. The music
// engine attaches to the master gain via `context`/`musicDestination`.

export class AudioEngine {
  onUnlock: (() => void) | null = null;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private sfxVolume = 1;

  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Where the music engine should connect its own bus. */
  get musicDestination(): AudioNode | null {
    return this.master;
  }

  /** Must be called from a user gesture to satisfy autoplay policies. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = 1;
      this.sfx = this.ctx.createGain();
      this.sfx.gain.value = this.sfxVolume * 0.5;
      this.sfx.connect(this.master);
      this.master.connect(comp);
      comp.connect(this.ctx.destination);

      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.onUnlock?.();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Master volume for everything (music included). 0..1 */
  setMasterVolume(v: number): void {
    if (this.master) this.master.gain.value = v;
  }

  /** SFX-only volume. 0..1 */
  setSfxVolume(v: number): void {
    this.sfxVolume = v;
    if (this.sfx) this.sfx.gain.value = v * 0.5;
  }

  private tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    if (!this.ctx || !this.sfx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    gain.connect(this.sfx);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, freq: number, q: number, vol: number, freqEnd?: number, delay = 0): void {
    if (!this.ctx || !this.sfx || !this.noiseBuffer) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(freq, t);
    if (freqEnd !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t + dur);
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfx);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  hit(intensity: number): void {
    const v = Math.min(0.9, 0.12 * intensity);
    this.tone(150, 50, 0.16, 'sine', v);
    this.noise(0.1, 900, 1.2, v * 0.6, 300);
  }

  /** Meaty dash-landing impact: a low body thump under a sharp crack. */
  impact(): void {
    this.tone(96, 34, 0.22, 'sine', 0.6);
    this.tone(58, 30, 0.14, 'triangle', 0.4);
    this.noise(0.13, 520, 1.6, 0.5, 240);
  }

  dash(powered: boolean): void {
    this.noise(0.22, powered ? 2400 : 1500, 2.5, powered ? 0.5 : 0.3, 250);
    if (powered) this.tone(500, 900, 0.18, 'square', 0.12);
  }

  jump(double = false): void {
    // Double jump gets a brighter, rising second chirp.
    if (double) this.tone(360, 720, 0.13, 'triangle', 0.2);
    else this.tone(240, 480, 0.14, 'sine', 0.22);
  }

  /** Metallic clank: a perfectly timed brace bounced a dash back. */
  parry(): void {
    this.tone(1800, 1200, 0.12, 'square', 0.25);
    this.tone(2700, 2400, 0.08, 'triangle', 0.18, 0.01);
    this.noise(0.09, 3500, 3, 0.2, 1500);
  }

  /** Subtle two-tone blip when the local player's dash comes off cooldown. */
  dashReady(): void {
    this.tone(660, 660, 0.05, 'square', 0.07);
    this.tone(990, 990, 0.07, 'square', 0.07, 0.05);
  }

  tileWarn(): void {
    this.tone(1100, 900, 0.07, 'square', 0.05);
  }

  tileDrop(): void {
    this.tone(90, 40, 0.4, 'sine', 0.3);
    this.noise(0.3, 250, 1, 0.15, 80);
  }

  fall(): void {
    this.tone(600, 90, 0.5, 'sawtooth', 0.2);
  }

  /** Ring-out KO: a diving whoosh that lands in a heavy impact thud. */
  knockout(): void {
    // Whoosh — pitch and filter dive downward like a body flung off the edge.
    this.tone(880, 70, 0.4, 'sawtooth', 0.18);
    this.noise(0.4, 2200, 1.1, 0.3, 150);
    // Landing thud a beat later: a deep body under a short crack.
    this.tone(140, 38, 0.3, 'sine', 0.7, 0.17);
    this.tone(72, 30, 0.22, 'triangle', 0.42, 0.17);
    this.noise(0.16, 520, 1.8, 0.55, 220, 0.17);
  }

  orbSpawn(): void {
    this.tone(880, 880, 0.1, 'sine', 0.12);
    this.tone(1320, 1320, 0.12, 'sine', 0.1, 0.09);
  }

  /** knocked=true when the orb was smacked out of a carrier's hands. */
  orbLoose(): void {
    this.tone(1320, 660, 0.18, 'square', 0.14);
  }

  orbPickup(): void {
    this.tone(660, 660, 0.09, 'square', 0.14);
    this.tone(880, 880, 0.09, 'square', 0.14, 0.08);
    this.tone(1320, 1320, 0.14, 'square', 0.14, 0.16);
  }

  countdown(final: boolean): void {
    this.tone(final ? 880 : 440, final ? 880 : 440, final ? 0.35 : 0.12, 'square', 0.18);
  }

  uiClick(): void {
    this.tone(520, 520, 0.05, 'square', 0.08);
  }

  roundEnd(): void {
    this.tone(523, 523, 0.12, 'square', 0.16);
    this.tone(659, 659, 0.12, 'square', 0.16, 0.12);
    this.tone(784, 784, 0.24, 'square', 0.18, 0.24);
  }

  champion(): void {
    const notes = [523, 659, 784, 1047, 784, 1047];
    notes.forEach((f, i) => this.tone(f, f, 0.16, 'square', 0.18, i * 0.13));
  }
}
