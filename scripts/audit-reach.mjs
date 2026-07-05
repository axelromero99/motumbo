// Reachability audit: for every level, build a graph of the static tiles where
// two tiles are linked if a ball can hop between them (a small horizontal gap
// AND a height difference a double-jump clears), then flood-fill from each
// spawn. A spawn whose reachable island is tiny is a stranded/broken parkour —
// you can't actually play from there. Rising tiles start hidden on purpose, so
// this checks "not stranded", not "everyone connected".
// Usage: node scripts/audit-reach.mjs
import createMotumbo from '../web/src/gen/motumbo.js';

const HEADER = 8;
const STRIDE = 8;
const SEEDS = [1, 7, 42];
const LEVELS = 81;

const MAX_HOP = 3.2; // tile-centre horizontal distance a jump can bridge (m)
const MAX_RISE = 2.6; // vertical difference a double-jump clears (m)
const MIN_ISLAND = 4; // fewer reachable tiles than this ⇒ effectively stranded

function ballR(flags) {
  const r = ((flags >>> 11) & 31) / 20;
  return r >= 0.3 ? r : 0.6;
}

const perLevel = [];

for (let level = 0; level < LEVELS; level++) {
  let worstIsland = Infinity;
  let worstSeed = -1;
  let tiles = 0;

  for (const seed of SEEDS) {
    const M = await createMotumbo();
    M._motumbo_init(seed, 8, level);
    const S = M.HEAPF32;
    const b = M._motumbo_state_ptr() >> 2;
    const pieceCount = S[b + 3];
    const players = S[b + 2];

    // Collect static tiles (x, y, z).
    const tx = [];
    const ty = [];
    const tz = [];
    for (let i = 0; i < pieceCount; i++) {
      const pb = b + HEADER + STRIDE * (players + i);
      const st = Math.round(S[pb + 7]) & 15;
      if (st !== 1) continue; // static only
      tx.push(S[pb]);
      ty.push(S[pb + 1]);
      tz.push(S[pb + 2]);
    }
    tiles = tx.length;
    if (tiles === 0) continue;

    // Adjacency by hop reachability (grid-bucketed to stay cheap).
    const adj = Array.from({ length: tiles }, () => []);
    const cell = 1.6;
    const buckets = new Map();
    const key = (cx, cz) => cx * 100000 + cz;
    for (let i = 0; i < tiles; i++) {
      const cx = Math.round(tx[i] / cell);
      const cz = Math.round(tz[i] / cell);
      const k = key(cx, cz);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(i);
    }
    for (let i = 0; i < tiles; i++) {
      const cx = Math.round(tx[i] / cell);
      const cz = Math.round(tz[i] / cell);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const arr = buckets.get(key(cx + dx, cz + dz));
          if (!arr) continue;
          for (const j of arr) {
            if (j <= i) continue;
            const hd = Math.hypot(tx[i] - tx[j], tz[i] - tz[j]);
            if (hd <= MAX_HOP && Math.abs(ty[i] - ty[j]) <= MAX_RISE) {
              adj[i].push(j);
              adj[j].push(i);
            }
          }
        }
      }
    }

    // Flood-fill each spawn's island; keep the smallest.
    for (let p = 0; p < players; p++) {
      const pbi = b + HEADER + STRIDE * p;
      const px = S[pbi];
      const pz = S[pbi + 2];
      // Nearest static tile to the spawn.
      let start = -1;
      let bd = 1e30;
      for (let i = 0; i < tiles; i++) {
        const d = (px - tx[i]) ** 2 + (pz - tz[i]) ** 2;
        if (d < bd) {
          bd = d;
          start = i;
        }
      }
      if (start < 0) continue;
      const seen = new Uint8Array(tiles);
      const stack = [start];
      seen[start] = 1;
      let size = 0;
      while (stack.length) {
        const n = stack.pop();
        size++;
        for (const m of adj[n]) if (!seen[m]) {
          seen[m] = 1;
          stack.push(m);
        }
      }
      if (size < worstIsland) {
        worstIsland = size;
        worstSeed = seed;
      }
    }
  }

  if (worstIsland < MIN_ISLAND) {
    perLevel.push({ level, worstIsland, worstSeed, tiles });
  }
}

if (perLevel.length === 0) {
  console.log(`REACHABILITY OK — ${LEVELS} niveles, ningún spawn varado en isla chica.`);
} else {
  console.log(`REACHABILITY FALLO — ${perLevel.length} nivel(es) con spawns varados:\n`);
  for (const r of perLevel) {
    console.log(`  nivel ${String(r.level).padStart(2)}: spawn en isla de ${r.worstIsland} baldosa(s) (seed ${r.worstSeed})`);
  }
  process.exit(1);
}
