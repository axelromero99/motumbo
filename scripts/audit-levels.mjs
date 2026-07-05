// Level audit: load the real WASM sim, init every level with 8 players across a
// few seeds, and detect map bugs — a ball that spawns over the void or on a
// tilted ramp (and slides/dies untouched during the countdown), empty arenas,
// and arenas truncated at the 512-tile cap.
// Usage: node scripts/audit-levels.mjs
import createMotumbo from '../web/src/gen/motumbo.js';

const HEADER = 8;
const STRIDE = 8;
const FLAG_ALIVE = 1;
const SEEDS = [1, 7, 42, 12345];
const LEVELS = 81; // 0..75

function ballR(flags) {
  const r = ((flags >>> 11) & 31) / 20;
  return r >= 0.3 ? r : 0.6;
}

// Nearest static/warning tile covering (x,z); returns {top, ramp} or null.
function tileUnder(S, b, playerCount, pieceCount, x, z) {
  let best = null;
  let bestD2 = 1e30;
  for (let i = 0; i < pieceCount; i++) {
    const pb = b + HEADER + STRIDE * (playerCount + i);
    const st = Math.round(S[pb + 7]) & 15;
    if (st !== 1 && st !== 3) continue; // static or warning
    const dx = x - S[pb];
    const dz = z - S[pb + 2];
    if (dx > -0.76 && dx < 0.76 && dz > -0.76 && dz < 0.76) {
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        bestD2 = d2;
        // Ramp = tile quaternion far from identity (|qw| noticeably < 1).
        const qw = S[pb + 6];
        best = { top: S[pb + 1], ramp: Math.abs(qw) < 0.999 };
      }
    }
  }
  return best;
}

const perLevel = [];

for (let level = 0; level < LEVELS; level++) {
  let worstDeaths = 0;
  let voidSpawns = 0;
  let rampSpawns = 0;
  let isolatedSpawns = 0;
  let closest = Infinity;
  let pieceCount = 0;
  let sampleSeed = -1;

  for (const seed of SEEDS) {
    const M = await createMotumbo();
    M._motumbo_init(seed, 8, level);
    const S = M.HEAPF32;
    const b = M._motumbo_state_ptr() >> 2;
    pieceCount = S[b + 3];
    const players = S[b + 2];
    const countdown = M._motumbo_countdown_ticks();

    let vSpawns = 0;
    let rSpawns = 0;
    let isoSpawns = 0;
    let minPairDist = Infinity;
    const sx = [];
    const sz = [];
    for (let i = 0; i < players; i++) {
      const pbi = b + HEADER + STRIDE * i;
      const x = S[pbi];
      const z = S[pbi + 2];
      const y = S[pbi + 1];
      const r = ballR(S[pbi + 7] | 0);
      sx.push(x);
      sz.push(z);
      const t = tileUnder(S, b, players, pieceCount, x, z);
      if (t === null || y - r - t.top > 0.6) vSpawns++;
      else if (t.ramp) rSpawns++;
      // Neighbours: static tiles whose center is within ~1 step (1.5m) but not
      // the tile you're on. 0 neighbours ⇒ stranded on a 1-tile island.
      let neigh = 0;
      for (let j = 0; j < pieceCount; j++) {
        const pb = b + HEADER + STRIDE * (players + j);
        const st = Math.round(S[pb + 7]) & 15;
        if (st !== 1 && st !== 3) continue;
        const dx = x - S[pb];
        const dz = z - S[pb + 2];
        const d2 = dx * dx + dz * dz;
        if (d2 > 0.6 && d2 < 2.4 * 2.4) neigh++;
      }
      if (neigh === 0) isoSpawns++;
    }
    for (let i = 0; i < players; i++)
      for (let j = i + 1; j < players; j++)
        minPairDist = Math.min(minPairDist, Math.hypot(sx[i] - sx[j], sz[i] - sz[j]));
    if (vSpawns > voidSpawns) voidSpawns = vSpawns;
    if (rSpawns > rampSpawns) rampSpawns = rSpawns;
    if (isoSpawns > isolatedSpawns) isolatedSpawns = isoSpawns;
    if (minPairDist < closest) closest = minPairDist;

    // Step the countdown with zero input; nobody should die untouched.
    const inBase = M._motumbo_inputs_ptr() >> 2;
    for (let i = 0; i < 8; i++) M.HEAPU32[inBase + i] = 0;
    let deaths = 0;
    const deadSet = new Set();
    for (let t = 0; t < countdown + 20; t++) {
      M._motumbo_step();
      const SS = M.HEAPF32;
      const bb = M._motumbo_state_ptr() >> 2;
      for (let i = 0; i < players; i++) {
        const f = SS[bb + HEADER + STRIDE * i + 7] | 0;
        if ((f & FLAG_ALIVE) === 0 && !deadSet.has(i)) {
          deadSet.add(i);
          deaths++;
        }
      }
    }
    if (deaths > worstDeaths) {
      worstDeaths = deaths;
      sampleSeed = seed;
    }
  }

  const flags = [];
  if (pieceCount < 8) flags.push(`arena casi vacía (${pieceCount} baldosas)`);
  if (pieceCount >= 1152) flags.push(`truncada en el tope de 1152 baldosas`);
  if (voidSpawns > 0) flags.push(`${voidSpawns} spawn(s) sobre el vacío`);
  if (rampSpawns > 0) flags.push(`${rampSpawns} spawn(s) sobre rampa inclinada`);
  if (isolatedSpawns > 0) flags.push(`${isolatedSpawns} spawn(s) en isla de 1 baldosa`);
  if (closest < 1.3) flags.push(`spawns superpuestos (${closest.toFixed(2)}m)`);
  if (worstDeaths > 0) flags.push(`${worstDeaths} bola(s) muertas en countdown (seed ${sampleSeed})`);

  if (flags.length) perLevel.push({ level, pieceCount, flags });
}

if (perLevel.length === 0) {
  console.log(`OK — ${LEVELS} niveles auditados, sin problemas.`);
} else {
  console.log(`${perLevel.length}/${LEVELS} niveles con problemas:\n`);
  for (const r of perLevel) {
    console.log(`  nivel ${String(r.level).padStart(2)} (${r.pieceCount} baldosas): ${r.flags.join(' · ')}`);
  }
}
