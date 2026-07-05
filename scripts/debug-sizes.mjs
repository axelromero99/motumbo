// Tile counts for the bigger generated arenas — make sure none hit the 512 cap
// (which would silently truncate the arena) and report min/max/avg size.
import createMotumbo from '../web/src/gen/motumbo.js';

let min = 9999;
let max = 0;
let sum = 0;
let overflow = 0;
let maxLevel = 0;
let extentMax = 0;
for (let level = 20; level < 81; level++) {
  const M = await createMotumbo();
  M._motumbo_init(1, 4, level);
  const S = M.HEAPF32;
  const b = M._motumbo_state_ptr() >> 2;
  const pieces = S[b + 3];
  if (pieces < min) min = pieces;
  if (pieces > max) {
    max = pieces;
    maxLevel = level;
  }
  sum += pieces;
  if (pieces >= 720) overflow++;
  // Farthest tile from center → arena extent (meters).
  for (let i = 0; i < pieces; i++) {
    const pb = b + 8 + 8 * (4 + i);
    const ext = Math.hypot(S[pb], S[pb + 2]);
    if (ext > extentMax) extentMax = ext;
  }
}
console.log(`generados: baldosas min ${min}, max ${max} (nivel ${maxLevel}), prom ${(sum / 50).toFixed(0)}`);
console.log(`extent maximo: ${extentMax.toFixed(1)}m · niveles en el tope de 720: ${overflow}`);
