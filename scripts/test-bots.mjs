// Bot AI diagnostic harness. Measures how bots die: when, and whether they
// were shoved (DASH_HIT shortly before falling) or walked off on their own.
// Also pits difficulties head-to-head. Usage: node scripts/test-bots.mjs
import createTumbo from '../web/src/gen/tumbo.js';

const EVENT_FLOATS = 6;
const EVT_FALL = 5;
const EVT_DASH_HIT = 9;
const EVT_ROUND_END = 8;
const COUNTDOWN = 180;
const LEVELS = [0, 3, 7, 11, 13]; // clásica, ruleta, tarimas, panal, volcán
const SEEDS = [11, 22, 33, 44, 55, 66];

async function runMatch(seed, level, difficulties) {
  const M = await createTumbo();
  M._tumbo_init(seed, difficulties.length, level);
  for (let p = 0; p < difficulties.length; p++) M._tumbo_set_bot(p, difficulties[p]);
  const evBase = M._tumbo_events_ptr() >> 2;

  const lastShoved = new Array(difficulties.length).fill(-9999);
  const falls = [];
  let winner = -1;
  let endTick = 5400;

  for (let t = 0; t < 5400; t++) {
    M._tumbo_step();
    const n = M._tumbo_event_count();
    for (let e = 0; e < n; e++) {
      const o = evBase + e * EVENT_FLOATS;
      const type = M.HEAPF32[o];
      const a = M.HEAPF32[o + 4];
      const b = M.HEAPF32[o + 5];
      if (type === EVT_DASH_HIT) lastShoved[b] = t;
      if (type === EVT_FALL) falls.push({ who: b, tick: t, shoved: t - lastShoved[b] < 150 });
      if (type === EVT_ROUND_END) {
        winner = a;
        endTick = t;
      }
    }
    if (winner !== -1) break;
  }
  return { falls, winner, endTick };
}

console.log('=== supervivencia por dificultad (4 bots iguales) ===');
for (const diff of [0, 1, 2]) {
  let firstFalls = [];
  let selfFalls = 0;
  let totalFalls = 0;
  let durations = [];
  for (const level of LEVELS) {
    for (const seed of SEEDS) {
      const r = await runMatch(seed, level, [diff, diff, diff, diff]);
      if (r.falls.length > 0) firstFalls.push(r.falls[0].tick - COUNTDOWN);
      for (const f of r.falls) {
        totalFalls++;
        if (!f.shoved) selfFalls++;
      }
      durations.push(r.endTick - COUNTDOWN);
    }
  }
  const avg = (arr) => (arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length) / 60).toFixed(1);
  const selfPct = ((selfFalls / Math.max(1, totalFalls)) * 100).toFixed(0);
  console.log(
    `dif ${diff}: primera caída media ${avg(firstFalls)}s tras el ¡TUMBO! · ` +
      `duración media de ronda ${avg(durations)}s · caídas solas ${selfPct}% (${selfFalls}/${totalFalls})`,
  );
}

console.log('=== duelo de dificultades: 2 difíciles vs 2 fáciles ===');
let hardWins = 0;
let games = 0;
for (const level of LEVELS) {
  for (const seed of SEEDS) {
    const r = await runMatch(seed, level, [2, 2, 0, 0]);
    if (r.winner >= 0) {
      games++;
      if (r.winner < 2) hardWins++;
    }
  }
}
console.log(`difíciles ganan ${hardWins}/${games} (${((hardWins / Math.max(1, games)) * 100).toFixed(0)}%)`);
