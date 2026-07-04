// Custom map codec. The byte layout mirrors BuildCustomLevel in sim/motumbo.c
// exactly — these bytes ARE the map: they get loaded into the sim, sent to
// lockstep peers, and shared as base64 codes. Keep both sides in sync.
//
//   [0] version (1)             [1] theme id (0..7, presentation only)
//   [2] crumble start, 10-tick units   [3] crumble interval, ticks
//   [4] tile count              [5] spawn count (max 8)
//   [6] beam half-length, 0.1m units (0 = none)   [7] reserved
//   tiles: 3 bytes each  (gx+16, gz+16, heightCode | prio << 4)
//   spawns: 2 bytes each (gx+16, gz+16)

export const MAP_VERSION = 1;
export const GRID_EXTENT = 7; // tiles live in gx,gz ∈ [-7, 7]
export const MAX_TILES = 225; // 15×15 grid
export const MAX_SPAWNS = 8;
// Must match LEVEL_CUSTOM in sim/motumbo.c (20 handmade + 50 generated + 5 mega).
export const LEVEL_CUSTOM = 75;

export interface MapTile {
  gx: number;
  gz: number;
  /** 0 = floor, 1 = +0.8m, 2 = +1.6m */
  height: number;
}

export interface CustomMap {
  name: string;
  theme: number;
  /** Seconds until the arena starts crumbling (5..40). */
  crumbleStartSec: number;
  /** Ticks between tile drops (6..120); lower = faster collapse. */
  crumbleInterval: number;
  /** Spinning beam half-length in meters; 0 disables it. */
  beamHalfLength: number;
  tiles: MapTile[];
  spawns: { gx: number; gz: number }[];
}

export function encodeMap(map: CustomMap): Uint8Array {
  const tiles = map.tiles.slice(0, MAX_TILES);
  const spawns = map.spawns.slice(0, MAX_SPAWNS);
  const bytes = new Uint8Array(8 + tiles.length * 3 + spawns.length * 2);
  bytes[0] = MAP_VERSION;
  bytes[1] = map.theme & 31; // 20 temas; 5 bits de sobra
  bytes[2] = Math.max(0, Math.min(255, Math.round((map.crumbleStartSec * 60) / 10)));
  bytes[3] = Math.max(6, Math.min(255, Math.round(map.crumbleInterval)));
  bytes[4] = tiles.length;
  bytes[5] = spawns.length;
  bytes[6] = Math.max(0, Math.min(255, Math.round(map.beamHalfLength * 10)));
  bytes[7] = 0;
  let o = 8;
  for (const t of tiles) {
    bytes[o++] = t.gx + 16;
    bytes[o++] = t.gz + 16;
    bytes[o++] = (t.height & 3) | 0; // priority nibble reserved (auto order)
  }
  for (const s of spawns) {
    bytes[o++] = s.gx + 16;
    bytes[o++] = s.gz + 16;
  }
  return bytes;
}

export function decodeMap(bytes: Uint8Array): Omit<CustomMap, 'name'> | null {
  if (bytes.length < 8 || bytes[0] !== MAP_VERSION) return null;
  const tileCount = bytes[4];
  const spawnCount = bytes[5];
  if (bytes.length < 8 + tileCount * 3 + spawnCount * 2 || tileCount === 0) return null;
  const tiles: MapTile[] = [];
  let o = 8;
  for (let i = 0; i < tileCount; i++) {
    tiles.push({ gx: bytes[o] - 16, gz: bytes[o + 1] - 16, height: bytes[o + 2] & 3 });
    o += 3;
  }
  const spawns: { gx: number; gz: number }[] = [];
  for (let i = 0; i < spawnCount; i++) {
    spawns.push({ gx: bytes[o] - 16, gz: bytes[o + 1] - 16 });
    o += 2;
  }
  return {
    theme: bytes[1],
    crumbleStartSec: (bytes[2] * 10) / 60,
    crumbleInterval: bytes[3],
    beamHalfLength: bytes[6] / 10,
    tiles,
    spawns,
  };
}

/** Returns a user-readable problem, or null when the map is playable. */
export function validateMap(map: CustomMap): string | null {
  if (map.tiles.length < 8) return 'El mapa necesita al menos 8 baldosas.';
  if (map.tiles.length > MAX_TILES) return `Máximo ${MAX_TILES} baldosas.`;
  if (map.spawns.length < 2) return 'Marcá al menos 2 puntos de aparición.';
  const tileSet = new Set(map.tiles.map((t) => `${t.gx},${t.gz}`));
  for (const s of map.spawns) {
    if (!tileSet.has(`${s.gx},${s.gz}`)) return 'Hay un punto de aparición sobre el vacío.';
  }
  return null;
}

export function mapToBase64(map: CustomMap): string {
  return btoa(String.fromCharCode(...encodeMap(map)));
}

export function mapFromBase64(code: string): Omit<CustomMap, 'name'> | null {
  try {
    const raw = atob(code.trim());
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return decodeMap(bytes);
  } catch {
    return null;
  }
}
