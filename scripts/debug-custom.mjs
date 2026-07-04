// Debug: does an asymmetric custom map come out of the sim with the exact
// tile positions we encoded? Catches codec/BuildCustomLevel mismatches,
// including axis swaps and sign flips.
import createMotumbo from '../web/src/gen/motumbo.js';

// L-shape: horizontal arm along +X at gz=0, vertical arm along +Z at gx=0.
// Plus one lone marker tile at (5, -3) to detect mirroring.
const tiles = [];
for (let gx = 0; gx <= 4; gx++) tiles.push([gx, 0, 0]);
for (let gz = 1; gz <= 4; gz++) tiles.push([0, gz, 1]);
tiles.push([5, -3, 2]);
const spawns = [
  [0, 0],
  [4, 0],
];

const bytes = new Uint8Array(8 + tiles.length * 3 + spawns.length * 2);
bytes[0] = 1;
bytes[1] = 0;
bytes[2] = 60;
bytes[3] = 30;
bytes[4] = tiles.length;
bytes[5] = spawns.length;
bytes[6] = 0;
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

const M = await createMotumbo();
M.HEAPU8.set(bytes, M._motumbo_custom_ptr());
M._motumbo_set_custom(bytes.length);
M._motumbo_init(1, 2, 70);
const S = M.HEAPF32;
const base = M._motumbo_state_ptr() >> 2;
const pieceCount = S[base + 3];
console.log(`level=${S[base + 5]} pieces=${pieceCount} (esperado ${tiles.length})`);
for (let i = 0; i < pieceCount; i++) {
  const pb = base + 8 + 8 * (2 + i);
  const gx = Math.round(S[pb] / 1.5);
  const gz = Math.round(S[pb + 2] / 1.5);
  const y = S[pb + 1].toFixed(2);
  const expected = tiles.find(([ex, ez]) => ex === gx && ez === gz);
  console.log(`tile ${i}: g(${gx},${gz}) y=${y} ${expected ? 'OK' : '<<< INESPERADA'}`);
}
const p0 = base + 8;
console.log(`spawn P0: (${S[p0].toFixed(1)}, ${S[p0 + 2].toFixed(1)}) esperado ~(0,0)`);
console.log(`spawn P1: (${S[p0 + 8].toFixed(1)}, ${S[p0 + 10].toFixed(1)}) esperado ~(6,0)`);
