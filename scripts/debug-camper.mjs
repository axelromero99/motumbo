// Does the new AI actually HUNT a camper instead of milling in the middle?
// Slot 0 never moves (a corner-camping human stand-in); slots 1-3 are bots.
// If the bots hunt the exposed camper, slot 0 wins FAR less than the 25%
// a passive player would get if simply ignored.
import createMotumbo from '../web/src/gen/motumbo.js';

const LEVELS = [0, 5, 12, 25, 70]; // clásica, herradura, diana, generado, mega
const SEEDS = [2, 9, 17, 23, 31, 44];

let camperWins = 0;
let camperFirstOut = 0;
let games = 0;
for (const level of LEVELS) {
  for (const seed of SEEDS) {
    const M = await createMotumbo();
    M._motumbo_init(seed, 4, level);
    for (let p = 1; p < 4; p++) M._motumbo_set_bot(p, 1);
    const base = M._motumbo_state_ptr() >> 2;
    const inBase = M._motumbo_inputs_ptr() >> 2;
    let firstOutIsCamper = null;
    let end = 3600;
    for (let t = 0; t < 3600; t++) {
      M.HEAPU32[inBase] = 0; // slot 0: never presses anything
      M._motumbo_step();
      const mask = M.HEAPF32[base + 1];
      if (firstOutIsCamper === null && (mask & 1) === 0) firstOutIsCamper = true;
      else if (firstOutIsCamper === null && mask !== 15 && (mask & 1) === 1) firstOutIsCamper = false;
      if (M.HEAPF32[base + 4] !== -1) {
        end = t;
        break;
      }
    }
    const winner = M.HEAPF32[base + 4];
    games++;
    if (winner === 0) camperWins++;
    if (firstOutIsCamper) camperFirstOut++;
  }
}
console.log(`camper inmóvil: gana ${camperWins}/${games} (${((camperWins / games) * 100).toFixed(0)}%, pasivo-ignorado seria ~25%)`);
console.log(`camper es el PRIMERO en caer: ${camperFirstOut}/${games} (${((camperFirstOut / games) * 100).toFixed(0)}%, azar seria ~25%)`);
