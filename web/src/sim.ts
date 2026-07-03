// Thin typed wrapper over the WASM simulation. The sim is the single source
// of truth for gameplay; this class only moves bytes across the boundary.
import createTumbo from './gen/tumbo.js';

export const MAX_PLAYERS = 8;
export const STATE_HEADER = 8;
export const STATE_STRIDE = 8;
export const HAZARD_STRIDE = 12;
export const TICK_MS = 1000 / 60;

export const PIECE_GONE = 0;
export const PIECE_STATIC = 1;
export const PIECE_FALLING = 2;
export const PIECE_WARNING = 3;

export const FLAG_ALIVE = 1;
export const FLAG_DASH_READY = 2;
export const FLAG_HAS_POWER = 4;
export const FLAG_CD_SHIFT = 3;
export const FLAG_CD_MASK = 63;
export const FLAG_BRACED = 512;
export const DASH_COOLDOWN_TICKS = 45;

/** Dash cooldown ticks remaining, decoded from a player's packed flags. */
export function dashCooldownFrom(flags: number): number {
  return (flags >> FLAG_CD_SHIFT) & FLAG_CD_MASK;
}

export const LEVEL_NAMES = ['CLÁSICA', 'ANILLO', 'PUENTES', 'RULETA', 'PIRÁMIDE', 'HERRADURA', 'PASARELA', 'TARIMAS'];

// Gameplay events emitted by the sim each tick: [type, x, y, z, a, b] × count.
export const EVT_HIT = 0;
export const EVT_DASH = 1;
export const EVT_JUMP = 2;
export const EVT_TILE_DROP = 3;
export const EVT_TILE_WARN = 4;
export const EVT_FALL = 5;
export const EVT_ORB_SPAWN = 6;
export const EVT_ORB_PICKUP = 7;
export const EVT_ROUND_END = 8;
export const EVT_DASH_HIT = 9;
export const EVT_PARRY = 10;
export const EVENT_FLOATS = 6;

interface TumboModule {
  _tumbo_init(seed: number, playerCount: number, level: number): void;
  _tumbo_step(): void;
  _tumbo_inputs_ptr(): number;
  _tumbo_state_ptr(): number;
  _tumbo_state_floats(): number;
  _tumbo_level_count(): number;
  _tumbo_events_ptr(): number;
  _tumbo_event_count(): number;
  _tumbo_countdown_ticks(): number;
  _tumbo_set_bot(slot: number, difficulty: number): void;
  _tumbo_hash(): number;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
}

export class Sim {
  private module: TumboModule;
  private inputsPtr: number;
  private statePtr: number;
  private eventsPtr: number;

  playerCount = 0;
  pieceCount = 0;
  hazardCount = 0;
  levelCount = 0;
  countdownTicks = 0;
  /** Snapshot of the state buffer from the previous tick, for render interpolation. */
  prev: Float32Array = new Float32Array(0);
  /** Snapshot of the state buffer from the latest tick. */
  curr: Float32Array = new Float32Array(0);

  private constructor(module: TumboModule) {
    this.module = module;
    this.inputsPtr = module._tumbo_inputs_ptr();
    this.statePtr = module._tumbo_state_ptr();
    this.eventsPtr = module._tumbo_events_ptr();
    this.levelCount = module._tumbo_level_count();
    this.countdownTicks = module._tumbo_countdown_ticks();
  }

  static async create(): Promise<Sim> {
    const module = (await createTumbo()) as TumboModule;
    return new Sim(module);
  }

  init(seed: number, playerCount: number, level: number): void {
    this.module._tumbo_init(seed, playerCount, level);
    this.playerCount = playerCount;
    this.curr = this.readState(this.module._tumbo_state_floats());
    this.hazardCount = this.curr[6];
    this.pieceCount =
      (this.module._tumbo_state_floats() - STATE_HEADER - HAZARD_STRIDE * this.hazardCount - 4) / STATE_STRIDE -
      playerCount;
    this.prev = this.curr.slice();
  }

  /** Advance one tick. Returns this tick's gameplay events (6 floats each). */
  step(inputs: Uint32Array): Float32Array {
    // Memory can grow, so re-derive heap views every access.
    const base = this.inputsPtr >> 2;
    this.module.HEAPU32.set(inputs.subarray(0, this.playerCount), base);
    this.module._tumbo_step();
    this.prev = this.curr;
    this.curr = this.readState(this.module._tumbo_state_floats());
    const count = this.module._tumbo_event_count();
    const ebase = this.eventsPtr >> 2;
    return this.module.HEAPF32.slice(ebase, ebase + count * EVENT_FLOATS);
  }

  /**
   * Enable a deterministic bot on a slot (difficulty 0-2). Call after init
   * and before the first step; in lockstep, call identically on every peer.
   */
  setBot(slot: number, difficulty: number): void {
    this.module._tumbo_set_bot(slot, difficulty);
  }

  hash(): number {
    return this.module._tumbo_hash() >>> 0;
  }

  get frame(): number {
    return this.curr[0];
  }

  get aliveMask(): number {
    return this.curr[1];
  }

  /** -1 ongoing, -2 draw, otherwise the winning player index. */
  get winner(): number {
    return this.curr[4];
  }

  get level(): number {
    return this.curr[5];
  }

  playerBase(i: number): number {
    return STATE_HEADER + STATE_STRIDE * i;
  }

  pieceBase(i: number): number {
    return STATE_HEADER + STATE_STRIDE * (this.playerCount + i);
  }

  hazardBase(i: number): number {
    return STATE_HEADER + STATE_STRIDE * (this.playerCount + this.pieceCount) + HAZARD_STRIDE * i;
  }

  powerupBase(): number {
    return STATE_HEADER + STATE_STRIDE * (this.playerCount + this.pieceCount) + HAZARD_STRIDE * this.hazardCount;
  }

  private readState(floats: number): Float32Array {
    const base = this.statePtr >> 2;
    return this.module.HEAPF32.slice(base, base + floats);
  }
}
