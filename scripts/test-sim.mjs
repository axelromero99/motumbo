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
const LEVELS = 20;

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
    // Piece float packs state + special*16 — unpack before comparing.
    const st = Math.round(S[stateBase + STATE_HEADER + STATE_STRIDE * (PLAYERS + i) + 7]) & 15;
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

console.log('--- modos ---');
async function runMode(mode, param, label) {
  const M = await createTumbo();
  M._tumbo_init(7, PLAYERS, 0);
  M._tumbo_set_mode(mode, param);
  for (let p = 0; p < PLAYERS; p++) M._tumbo_set_bot(p, 2);
  const stateBase = M._tumbo_state_ptr() >> 2;
  const hashes = [];
  let winnerTick = -1;
  for (let t = 0; t < 3600; t++) {
    M._tumbo_step();
    if (t % 100 === 0) hashes.push(M._tumbo_hash() >>> 0);
    if (winnerTick < 0 && M.HEAPF32[stateBase + 4] !== -1) winnerTick = t;
  }
  const S = M.HEAPF32;
  const floats = M._tumbo_state_floats();
  const modeBase = stateBase + floats - 12;
  const scores = [];
  for (let i = 0; i < PLAYERS; i++) scores.push(S[modeBase + 4 + i]);
  console.log(
    `[modo ${mode} ${label}] winner=${S[stateBase + 4]} winnerTick=${winnerTick} scores=${scores.join(',')}`,
  );
  return { hashes, winner: S[stateBase + 4], winnerTick };
}

for (const [mode, param, name] of [
  [1, 12, 'REY'],
  [2, 4, 'COSECHA'],
  [3, 8, 'MALDITO'],
]) {
  const ma = await runMode(mode, param, `${name} A`);
  const mb = await runMode(mode, param, `${name} B`);
  const ok = ma.hashes.every((h, i) => h === mb.hashes[i]) && ma.winner === mb.winner;
  const resolved = ma.winner !== -1;
  if (!ok || !resolved) {
    allOk = false;
    console.log(`  FALLO modo ${name}: ok=${ok} resolved=${resolved}`);
  } else {
    console.log(`  modo ${name} determinista y con ganador OK`);
  }
}

console.log('--- mapa custom ---');
// Cross-shaped custom map with raised ends and a spinning beam, built with
// the same byte layout as mapcodec.ts / BuildCustomLevel.
function buildTestMap() {
  const tiles = [];
  for (let gx = -4; gx <= 4; gx++) {
    for (let gz = -4; gz <= 4; gz++) {
      if (Math.abs(gx) <= 1 || Math.abs(gz) <= 1) {
        tiles.push([gx, gz, Math.abs(gx) === 4 || Math.abs(gz) === 4 ? 1 : 0]);
      }
    }
  }
  const spawns = [
    [-4, 0],
    [4, 0],
    [0, -4],
    [0, 4],
  ];
  const bytes = new Uint8Array(8 + tiles.length * 3 + spawns.length * 2);
  bytes[0] = 1; // version
  bytes[1] = 3; // theme
  bytes[2] = 30; // crumble start (300 ticks)
  bytes[3] = 20; // crumble interval
  bytes[4] = tiles.length;
  bytes[5] = spawns.length;
  bytes[6] = 40; // beam half-length 4.0m
  let o = 8;
  for (const [gx, gz, h] of tiles) {
    bytes[o++] = gx + 16;
    bytes[o++] = gz + 16;
    bytes[o++] = h;
  }
  for (const [gx, gz] of spawns) {
    bytes[o++] = gx + 16;
    bytes[o++] = gz + 16;
  }
  return bytes;
}

async function runCustom(label) {
  const M = await createTumbo();
  const bytes = buildTestMap();
  M.HEAPU8.set(bytes, M._tumbo_custom_ptr());
  M._tumbo_set_custom(bytes.length);
  M._tumbo_init(99, PLAYERS, 20);
  const inputsBase = M._tumbo_inputs_ptr() >> 2;
  const stateBase = M._tumbo_state_ptr() >> 2;
  const hashes = [];
  for (let t = 0; t < TICKS; t++) {
    for (let p = 0; p < PLAYERS; p++) M.HEAPU32[inputsBase + p] = inputFor(p, t);
    M._tumbo_step();
    if (t % 100 === 0) hashes.push(M._tumbo_hash() >>> 0);
  }
  const S = M.HEAPF32;
  console.log(
    `[custom ${label}] pieces=${S[stateBase + 3]} hazards=${S[stateBase + 6]} ` +
      `level=${S[stateBase + 5]} alive=${S[stateBase + 1]} winner=${S[stateBase + 4]}`,
  );
  return { hashes, pieces: S[stateBase + 3], hazards: S[stateBase + 6] };
}

const ca = await runCustom('A');
const cb = await runCustom('B');
const customOk =
  ca.pieces === 45 && ca.hazards === 1 && ca.hashes.length === cb.hashes.length && ca.hashes.every((h, i) => h === cb.hashes[i]);
if (!customOk) {
  allOk = false;
  console.log('  FALLO en mapa custom');
} else {
  console.log('  mapa custom determinista OK (45 baldosas, 1 hazard)');
}

console.log(allOk ? 'TODOS LOS TESTS OK' : 'HAY FALLOS');
process.exit(allOk ? 0 : 1);
