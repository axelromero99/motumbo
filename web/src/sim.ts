// Thin typed wrapper over the WASM simulation. The sim is the single source
// of truth for gameplay; this class only moves bytes across the boundary.
import createMotumbo from './gen/motumbo.js';

export const MAX_PLAYERS = 8;
export const MAX_ORBS = 6;
export const STATE_HEADER = 8;
export const STATE_STRIDE = 8;
export const HAZARD_STRIDE = 12;
export const TICK_MS = 1000 / 60;

export const PIECE_GONE = 0;
export const PIECE_STATIC = 1;
export const PIECE_FALLING = 2;
export const PIECE_WARNING = 3;

// Tile specials, packed into the piece state float as state + special*16.
export const SPECIAL_NONE = 0;
export const SPECIAL_BOOST = 1;
export const SPECIAL_BOUNCY = 2;

export function pieceStateOf(packed: number): number {
  return Math.round(packed) & 15;
}

export function pieceSpecialOf(packed: number): number {
  return Math.round(packed) >> 4;
}

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

export const LEVEL_NAMES = [
  'CLÁSICA',
  'ANILLO',
  'PUENTES',
  'RULETA',
  'PIRÁMIDE',
  'HERRADURA',
  'PASARELA',
  'TARIMAS',
  'CRUZ',
  'ASPAS',
  'GEMELAS',
  'PANAL',
  'DIANA',
  'VOLCÁN',
  'ZIGURAT',
  'TORRES',
  'RULETA DOBLE',
  'FÁBRICA',
  'MARTILLO',
  'CALLES',
];

// Levels 20-69 are procedurally generated in the sim (deterministic per id).
const GEN_PREFIX = ['NOVA', 'CRÁTER', 'ARRECIFE', 'FALLA', 'TÚNEL', 'BASTIÓN', 'PLAZA', 'ISLOTE', 'CIRCUITO', 'MESETA'];
for (let i = 20; i < 70; i++) {
  LEVEL_NAMES.push(`${GEN_PREFIX[i % 10]} ${i - 19}`);
}
// Levels 70-80: the oversized hand-designed mega arenas.
for (const n of [
  '⊕ COLOSO', '⊕ ARCHIPIÉLAGO', '⊕ GRAN CRUZ', '⊕ DOBLE ANILLO', '⊕ ESTADIO', '⊕ TORRE',
  '⊕ SALTOS', '⊕ CRÁTER', '⊕ PUENTES ALTOS', '⊕ ISLOTES', '⊕ TORRE ALTA',
]) {
  LEVEL_NAMES.push(n);
}

/** Current ball radius in meters, decoded from a player's packed flags. */
export function ballRadiusFrom(flags: number): number {
  const r = ((flags >> 11) & 31) / 20;
  return r >= 0.3 ? r : 0.6;
}

// Orb pickup types (EVT_ORB_SPAWN/PICKUP carry the type in `a`).
export const ORB_SUPER = 0;
export const ORB_TURBO = 1;
export const ORB_MEGA = 2;
export const ORB_SHIELD = 3;
export const ORB_SHOCK = 4;

// Per-type presentation: color, emoji icon, short label, one-line description.
// The icon mirrors the billboard glyph drawn over the orb in render.ts.
export const ORB_INFO = [
  { color: 0xffc93c, icon: '⚡', name: 'SÚPER', desc: 'próximo dash ×2.3' },
  { color: 0x35e8ff, icon: '»»', name: 'TURBO', desc: 'más velocidad (acumulable)' },
  { color: 0xff5964, icon: '✥', name: 'MEGA', desc: 'crecés y pesás más' },
  { color: 0x8affc0, icon: '🛡', name: 'ESCUDO', desc: 'bloquea el próximo empujón' },
  { color: 0xff8a3d, icon: '💥', name: 'BOMBA', desc: 'onda que empuja a todos' },
] as const;

export const FLAG_SHIELD = 65536;
export function hasShield(flags: number): boolean {
  return (flags & FLAG_SHIELD) !== 0;
}

// Game modes (deterministic, resolved inside the sim).
export const MODE_SUMO = 0;
export const MODE_KOTH = 1; // rey de la colina: puntuás estando SOLO en la zona
export const MODE_COSECHA = 2; // primero a N orbes
export const MODE_MALDITO = 3; // papa caliente: el maldito explota al vencer el timer
export const MODE_NAMES = ['SUMO', 'REY DE LA COLINA', 'COSECHA', 'MALDITO'];

export const FLAG_CURSED = 1024;

// Mode section appended after the powerup floats: [mode, m0, m1, m2] then 8
// per-player scores. KOTH: m0/m1 = zone x/z. MALDITO: m0 = cursed index,
// m1 = ticks left. m2 = target param.
export const MODE_FLOATS = 12;

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
export const EVT_CURSE = 11;
export const EVT_ZONE = 12;
export const EVT_MODE_POINT = 13;
export const EVT_SHIELD = 14;
export const EVT_SHOCK = 15;
export const EVENT_FLOATS = 6;

interface MotumboModule {
  _motumbo_init(seed: number, playerCount: number, level: number): void;
  _motumbo_step(): void;
  _motumbo_inputs_ptr(): number;
  _motumbo_state_ptr(): number;
  _motumbo_state_floats(): number;
  _motumbo_level_count(): number;
  _motumbo_events_ptr(): number;
  _motumbo_event_count(): number;
  _motumbo_countdown_ticks(): number;
  _motumbo_set_bot(slot: number, difficulty: number): void;
  _motumbo_set_mode(mode: number, param: number): void;
  _motumbo_custom_ptr(): number;
  _motumbo_set_custom(len: number): void;
  _motumbo_hash(): number;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  HEAPU8: Uint8Array;
}

export class Sim {
  private module: MotumboModule;
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

  private constructor(module: MotumboModule) {
    this.module = module;
    this.inputsPtr = module._motumbo_inputs_ptr();
    this.statePtr = module._motumbo_state_ptr();
    this.eventsPtr = module._motumbo_events_ptr();
    this.levelCount = module._motumbo_level_count();
    this.countdownTicks = module._motumbo_countdown_ticks();
  }

  static async create(): Promise<Sim> {
    const module = (await createMotumbo()) as MotumboModule;
    return new Sim(module);
  }

  init(seed: number, playerCount: number, level: number): void {
    this.module._motumbo_init(seed, playerCount, level);
    this.playerCount = playerCount;
    this.curr = this.readState(this.module._motumbo_state_floats());
    this.hazardCount = this.curr[6];
    // State tail after the pieces = hazards + orbs (MAX_ORBS×4) + mode section
    // (MODE_FLOATS). Subtracting only 4 (the pre-v7 single powerup) overcounted
    // pieceCount by 4, so the camera auto-fit read the mode section's −1000
    // sentinel as a tile, blew `ext` up to ~1000 and parked the camera past the
    // far plane — every arena rendered black.
    this.pieceCount =
      (this.module._motumbo_state_floats() - STATE_HEADER - HAZARD_STRIDE * this.hazardCount - 4 * MAX_ORBS - MODE_FLOATS) /
        STATE_STRIDE -
      playerCount;
    this.prev = this.curr.slice();
  }

  /** Advance one tick. Returns this tick's gameplay events (6 floats each). */
  step(inputs: Uint32Array): Float32Array {
    // Memory can grow, so re-derive heap views every access.
    const base = this.inputsPtr >> 2;
    this.module.HEAPU32.set(inputs.subarray(0, this.playerCount), base);
    this.module._motumbo_step();
    this.prev = this.curr;
    this.curr = this.readState(this.module._motumbo_state_floats());
    const count = this.module._motumbo_event_count();
    const ebase = this.eventsPtr >> 2;
    return this.module.HEAPF32.slice(ebase, ebase + count * EVENT_FLOATS);
  }

  /**
   * Enable a deterministic bot on a slot (difficulty 0-2). Call after init
   * and before the first step; in lockstep, call identically on every peer.
   */
  setBot(slot: number, difficulty: number): void {
    this.module._motumbo_set_bot(slot, difficulty);
  }

  /**
   * Load custom map bytes (see mapcodec.ts). Call BEFORE init with level 8;
   * in lockstep, both peers must load identical bytes. Persists across
   * rounds until replaced.
   */
  loadCustomMap(bytes: Uint8Array): void {
    const ptr = this.module._motumbo_custom_ptr();
    this.module.HEAPU8.set(bytes, ptr);
    this.module._motumbo_set_custom(bytes.length);
  }

  hash(): number {
    return this.module._motumbo_hash() >>> 0;
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

  /** Base of the orb section: MAX_ORBS × [x, y, z, active(0 or 1+type)]. */
  orbsBase(): number {
    return STATE_HEADER + STATE_STRIDE * (this.playerCount + this.pieceCount) + HAZARD_STRIDE * this.hazardCount;
  }

  /** [mode, m0, m1, m2] followed by 8 per-player scores. */
  modeBase(): number {
    return this.orbsBase() + 4 * MAX_ORBS;
  }

  get mode(): number {
    return this.curr[this.modeBase()];
  }

  score(i: number): number {
    return this.curr[this.modeBase() + 4 + i];
  }

  /**
   * Set the game mode (call after init, before the first step; identical on
   * every lockstep peer). KOTH: param = seconds to hold. COSECHA: param =
   * orbs to collect. MALDITO: param = curse timer seconds.
   */
  setMode(mode: number, param: number): void {
    this.module._motumbo_set_mode(mode, param);
    this.curr = this.readState(this.module._motumbo_state_floats());
    this.prev = this.curr.slice();
  }

  private readState(floats: number): Float32Array {
    const base = this.statePtr >> 2;
    return this.module.HEAPF32.slice(base, base + floats);
  }
}
