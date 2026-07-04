// Probe: on low-surface maps, do bots freeze in place? Reports the longest
// stationary streak (within 0.5m) of any living bot, plus round duration.
import createMotumbo from '../web/src/gen/motumbo.js';

const LEVELS = [7, 11, 25, 31]; // TARIMAS, PANAL, dos generados de pads
const SEEDS = [3, 14, 27, 58];

for (const level of LEVELS) {
  let worstStuck = 0;
  let durations = [];
  for (const seed of SEEDS) {
    const M = await createMotumbo();
    M._motumbo_init(seed, 4, level);
    for (let p = 0; p < 4; p++) M._motumbo_set_bot(p, 1);
    const base = M._motumbo_state_ptr() >> 2;
    const evBase = M._motumbo_events_ptr() >> 2;
    const anchor = [[0, 0], [0, 0], [0, 0], [0, 0]];
    const streak = [0, 0, 0, 0];
    const lastShove = [-9999, -9999, -9999, -9999];
    let end = 3600;
    for (let t = 0; t < 3600; t++) {
      M._motumbo_step();
      for (let e = 0; e < M._motumbo_event_count(); e++) {
        const o = evBase + e * 6;
        const type = M.HEAPF32[o];
        if (type === 9) lastShove[M.HEAPF32[o + 5]] = t; // DASH_HIT b=victima
        if (type === 0 && M.HEAPF32[o + 4] > 4 && M.HEAPF32[o + 5] >= 0) lastShove[M.HEAPF32[o + 5]] = t; // HIT fuerte
        if (type === 5) {
          const who = M.HEAPF32[o + 5];
          globalThis.__falls = globalThis.__falls || { shoved: 0, solo: 0 };
          if (t - lastShove[who] < 150) globalThis.__falls.shoved++;
          else globalThis.__falls.solo++;
        }
      }
      const mask = M.HEAPF32[base + 1];
      if (t > 200) {
        for (let p = 0; p < 4; p++) {
          if (!(mask & (1 << p))) continue;
          const pb = base + 8 + 8 * p;
          const dx = M.HEAPF32[pb] - anchor[p][0];
          const dz = M.HEAPF32[pb + 2] - anchor[p][1];
          if (dx * dx + dz * dz < 0.25) {
            streak[p]++;
            if (streak[p] > worstStuck) worstStuck = streak[p];
          } else {
            anchor[p] = [M.HEAPF32[pb], M.HEAPF32[pb + 2]];
            streak[p] = 0;
          }
        }
      }
      if (M.HEAPF32[base + 4] !== -1) {
        end = t;
        break;
      }
    }
    durations.push(end);
  }
  const avgDur = (durations.reduce((s, v) => s + v, 0) / durations.length / 60).toFixed(1);
  const f = globalThis.__falls || { shoved: 0, solo: 0 };
  globalThis.__falls = { shoved: 0, solo: 0 };
  console.log(
    `nivel ${level}: peor quedada ${(worstStuck / 60).toFixed(1)}s · ronda media ${avgDur}s · ` +
      `caídas: ${f.shoved} empujado / ${f.solo} solo`,
  );
}
