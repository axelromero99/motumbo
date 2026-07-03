// Smoke + determinism test for the WASM sim, runs in Node (no browser needed).
// Runs every level twice with scripted inputs and compares state hashes,
// then runs an all-bots match twice (bots are part of the sim and must be
// bit-deterministic too).
// Usage: node scripts/test-sim.mjs
import createTumbo from '../web/src/gen/tumbo.js';

const STATE_HEADER = 8;
const STATE_STRIDE = 8;
const PLAYERS = 4;
const TICKS = 1500;
const LEVELS = 8;

// Deterministic scripted inputs: phase-shifted direction changes, periodic
// dashes, jumps and braces.
function inputFor(player, tick) {
  const dirs = [1, 8, 2, 4]; // up, right, down, left
  let word = dirs[(player + (tick >> 6)) % 4];
  if ((tick + player * 13) % 120 === 0) word |= 16; // dash
  if ((tick + player * 29) % 90 === 0) word |= 32; // jump
  if ((tick + player * 41) % 150 < 12) word |= 64; // brace
  return word;
}

async function run(level, label, useBots) {
  const M = await createTumbo();
  M._tumbo_init(42, PLAYERS, level);
  if (useBots) {
    for (let p = 0; p < PLAYERS; p++) M._tumbo_set_bot(p, p % 3);
  }
  const inputsBase = M._tumbo_inputs_ptr() >> 2;
  const stateBase = M._tumbo_state_ptr() >> 2;

  const hashes = [];
  for (let t = 0; t < TICKS; t++) {
    if (!useBots) {
      for (let p = 0; p < PLAYERS; p++) {
        M.HEAPU32[inputsBase + p] = inputFor(p, t);
      }
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
  return { hashes, winner, aliveMask };
}

let allOk = true;

for (let level = 0; level < LEVELS; level++) {
  const a = await run(level, 'A', false);
  const b = await run(level, 'B', false);
  const ok = a.hashes.length === b.hashes.length && a.hashes.every((h, i) => h === b.hashes[i]);
  if (!ok) {
    allOk = false;
    console.log(`  DESYNC nivel ${level}!`);
  } else {
    console.log(`  determinismo OK (${a.hashes.length} hashes identicos)`);
  }
}

console.log('--- bots ---');
const ba = await run(3, 'BOTS A', true);
const bb = await run(3, 'BOTS B', true);
const botsOk = ba.hashes.length === bb.hashes.length && ba.hashes.every((h, i) => h === bb.hashes[i]);
// Bots must actually play: after 25s of RULETA someone should have died.
const botsFight = ba.winner !== -1 || ba.aliveMask !== 15;
if (!botsOk) {
  allOk = false;
  console.log('  DESYNC en partida de bots!');
} else if (!botsFight) {
  allOk = false;
  console.log('  BOTS PASIVOS: nadie fue eliminado en 25s');
} else {
  console.log(`  bots deterministas y agresivos OK (winner=${ba.winner})`);
}

console.log(allOk ? 'TODOS LOS TESTS OK' : 'HAY FALLOS');
process.exit(allOk ? 0 : 1);
