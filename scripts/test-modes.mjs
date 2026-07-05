// Mode objective test: run 4 bots per objective mode and require the round to be
// won by the OBJECTIVE (KOTH zone-control ticks, COSECHA orb count) rather than
// by elimination. MALDITO stays elimination-based. Also checks determinism.
// Usage: node scripts/test-modes.mjs
import createMotumbo from '../web/src/gen/motumbo.js';

const H = 8, S = 8, HZ = 12, MAX_ORBS = 6;
const MODE_KOTH = 1, MODE_COSECHA = 2, MODE_MALDITO = 3;

function modeBaseOf(M) {
  const b = M._motumbo_state_ptr() >> 2, F = M.HEAPF32;
  return b + H + S * (F[b + 2] + F[b + 3]) + HZ * F[b + 6] + 4 * MAX_ORBS;
}

async function run(mode, param, diff, seed = 4242, level = 0) {
  const M = await createMotumbo();
  M._motumbo_init(seed, 4, level);
  M._motumbo_set_mode(mode, param);
  for (let i = 0; i < 4; i++) M._motumbo_set_bot(i, diff);
  const inBase = M._motumbo_inputs_ptr() >> 2;
  const hashes = [];
  let winner = -1, winTick = -1;
  for (let t = 0; t < 60 * 150; t++) {
    for (let i = 0; i < 4; i++) M.HEAPU32[inBase + i] = 0;
    M._motumbo_step();
    if (t % 60 === 0) hashes.push(M._motumbo_hash() >>> 0);
    const b = M._motumbo_state_ptr() >> 2;
    if (M.HEAPF32[b + 4] !== -1) { winner = M.HEAPF32[b + 4]; winTick = t; break; }
  }
  const mb = modeBaseOf(M);
  const scores = [0, 1, 2, 3].map((i) => M.HEAPF32[mb + 4 + i]);
  const threshold = mode === MODE_KOTH ? param * 60 : param;
  return { winner, winTick, scores, byObjective: winner >= 0 && scores[winner] >= threshold, hashes };
}

let ok = true;
console.log('Modos objetivo (4 bots dif 2):');
for (const [mode, param, name] of [[MODE_KOTH, 15, 'REY 15s'], [MODE_COSECHA, 5, 'COSECHA 5']]) {
  const a = await run(mode, param, 2);
  const b = await run(mode, param, 2);
  const det = a.hashes.length === b.hashes.length && a.hashes.every((h, i) => h === b.hashes[i]) && a.winner === b.winner;
  console.log(`  ${name}: winner=${a.winner} en ${(a.winTick / 60).toFixed(1)}s por ${a.byObjective ? 'OBJETIVO ✓' : 'eliminación ✗'} · scores=${a.scores.join(',')} · det=${det ? 'OK' : 'FAIL'}`);
  if (!a.byObjective || !det) ok = false;
}
const m = await run(MODE_MALDITO, 12, 2);
console.log(`  MALDITO 12s: winner=${m.winner} en ${(m.winTick / 60).toFixed(1)}s (eliminación, esperado)`);
if (m.winner < 0) ok = false;

// Regression guard: KOTH/COSECHA rounds are usually cut short by elimination
// (bots shove each other off before the objective is met). The winner MUST be
// whoever controlled the objective most (argmax score), never the last ball
// standing with score 0. The old code crowned last-alive; a single lucky seed
// (4242/0) masked it, so sweep many.
console.log('\nBarrido — el ganador debe ser el de mayor score, no el último vivo:');
for (const [mode, param, name] of [[MODE_KOTH, 15, 'REY'], [MODE_COSECHA, 5, 'COSECHA']]) {
  let bad = 0;
  let byElim = 0;
  for (const seed of [2, 7, 9999, 4242, 123, 55]) {
    for (const level of [0, 7, 12]) {
      const r = await run(mode, param, 2, seed, level);
      const maxScore = Math.max(...r.scores);
      const argmax = maxScore > 0 ? r.scores.indexOf(maxScore) : -2;
      if (!r.byObjective) byElim++;
      if (r.winner !== argmax) {
        bad++;
        if (bad <= 3) console.log(`    ✗ ${name} seed=${seed} lvl=${level}: winner=${r.winner} (score ${r.scores[r.winner] ?? 0}) pero el top es ${argmax} (${maxScore})`);
      }
    }
  }
  console.log(`  ${name}: ${bad}/18 ganadores incorrectos · ${byElim}/18 cortadas por eliminación`);
  if (bad > 0) ok = false;
}
console.log(ok ? '\nMODOS OK — los objetivos deciden la ronda.' : '\nHAY MODOS ROTOS.');
process.exit(ok ? 0 : 1);
