// Smoke + determinism test for the WASM sim, runs in Node (no browser needed).
// Runs every level twice with scripted inputs and compares state hashes.
// Usage: node scripts/test-sim.mjs
import createTumbo from '../web/src/gen/tumbo.js';

const STATE_HEADER = 8;
const STATE_STRIDE = 8;
const PLAYERS = 4;
const TICKS = 1500;
const LEVELS = 4;

// Deterministic scripted inputs: phase-shifted direction changes, periodic
// dashes and jumps.
function inputFor(player, tick) {
  const dirs = [1, 8, 2, 4]; // up, right, down, left
  let word = dirs[(player + (tick >> 6)) % 4];
  if ((tick + player * 13) % 120 === 0) word |= 16; // dash
  if ((tick + player * 29) % 90 === 0) word |= 32; // jump
  return word;
}

async function run(level, label) {
  const M = await createTumbo();
  M._tumbo_init(42, PLAYERS, level);
  const inputsBase = M._tumbo_inputs_ptr() >> 2;
  const stateBase = M._tumbo_state_ptr() >> 2;

  const hashes = [];
  for (let t = 0; t < TICKS; t++) {
    for (let p = 0; p < PLAYERS; p++) {
      M.HEAPU32[inputsBase + p] = inputFor(p, t);
    }
    M._tumbo_step();
    if (t % 100 === 0) hashes.push(M._tumbo_hash() >>> 0);
  }

  const S = M.HEAPF32;
  const aliveMask = S[stateBase + 1];
  const pieceCount = S[stateBase + 3];
  const winner = S[stateBase + 4];
  const hazards = S[stateBase + 6];

  let falling = 0;
  let gone = 0;
  let warning = 0;
  for (let i = 0; i < pieceCount; i++) {
    const st = S[stateBase + STATE_HEADER + STATE_STRIDE * (PLAYERS + i) + 7];
    if (st === 2) falling++;
    if (st === 0) gone++;
    if (st === 3) warning++;
  }

  console.log(
    `[nivel ${level} ${label}] alive=${aliveMask} winner=${winner} pieces=${pieceCount} ` +
      `warn=${warning} falling=${falling} gone=${gone} hazards=${hazards}`,
  );
  return hashes;
}

let allOk = true;
for (let level = 0; level < LEVELS; level++) {
  const a = await run(level, 'A');
  const b = await run(level, 'B');
  const ok = a.length === b.length && a.every((h, i) => h === b[i]);
  if (!ok) {
    allOk = false;
    console.log(`  DESYNC nivel ${level}!`);
    console.log(`  A: ${a.map((h) => h.toString(16)).join(' ')}`);
    console.log(`  B: ${b.map((h) => h.toString(16)).join(' ')}`);
  } else {
    console.log(`  determinismo OK (${a.length} hashes identicos)`);
  }
}

console.log(allOk ? 'TODOS LOS NIVELES DETERMINISTAS' : 'HAY DESYNCS');
process.exit(allOk ? 0 : 1);
