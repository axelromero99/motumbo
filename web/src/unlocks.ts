// Progresión de desbloqueo de skins. 100% cosmético: solo lee las stats de por
// vida que ya persiste stats.ts en localStorage ('motumbo.stats.v1') y decide
// qué skins están disponibles. No toca el sim, el render ni el array SKINS.
//
// Modelo: un set inicial (~9 skins) siempre desbloqueado + el resto se gana con
// hitos de por vida (partidas jugadas/ganadas, rondas jugadas/ganadas, racha).
// Cada función RELEE las stats en el momento (persisten en localStorage, así que
// el estado cambia entre matches sin recargar) y es robusta a stats ausentes o
// en cero: un jugador nuevo ve solo el set inicial.
//
// API consumida por ui.ts (picker) y disponible para main.ts (fallback de skin):
//   isSkinUnlocked(index)  -> boolean
//   unlockHint(index)      -> string   ("Ganá 5 rondas", …) para skins bloqueadas
//   unlockedCount()        -> number   (para el contador "X/44 desbloqueadas")
//   nextUnlock()           -> { index, hint } | null  (próximo desbloqueo cercano)

import { SKIN_COUNT } from './skins';

/** Misma clave que persiste stats.ts (LifetimeStats). Solo lectura desde acá. */
const STATS_KEY = 'motumbo.stats.v1';

/** Métricas de por vida disponibles en 'motumbo.stats.v1' (ver stats.ts). */
type Metric = 'matches' | 'matchWins' | 'rounds' | 'roundWins' | 'bestStreak';

type Lifetime = Record<Metric, number>;

const ZERO: Lifetime = { matches: 0, matchWins: 0, rounds: 0, roundWins: 0, bestStreak: 0 };

/** Lee las stats de por vida frescas de localStorage; cero si no hay/está roto. */
function readLifetime(): Lifetime {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return { ...ZERO };
    const p = JSON.parse(raw) as Partial<Record<Metric, unknown>>;
    return {
      matches: Number(p.matches) || 0,
      matchWins: Number(p.matchWins) || 0,
      rounds: Number(p.rounds) || 0,
      roundWins: Number(p.roundWins) || 0,
      bestStreak: Number(p.bestStreak) || 0,
    };
  } catch {
    return { ...ZERO };
  }
}

/** Requisito de una skin: alcanzar `need` en la métrica dada. */
interface Req {
  metric: Metric;
  need: number;
}

/** Texto corto en español del hito de una métrica. */
const HINT: Record<Metric, (n: number) => string> = {
  matches: (n) => `Jugá ${n} ${n === 1 ? 'partida' : 'partidas'}`,
  matchWins: (n) => `Ganá ${n} ${n === 1 ? 'partida entera' : 'partidas enteras'}`,
  rounds: (n) => `Jugá ${n} rondas`,
  roundWins: (n) => `Ganá ${n} ${n === 1 ? 'ronda' : 'rondas'}`,
  bestStreak: (n) => `Hacé una racha de ${n} rondas`,
};

// Requisito por índice de skin (0..43). null = set inicial (siempre desbloqueado).
// El orden acompaña la vibra: banderas fáciles con partidas jugadas, patrones con
// rondas ganadas, materiales vistosos (Oro/Cromo/Galaxia/Arcoíris/Circuito) al
// final con hitos duros. Índices fuera de la tabla caen a "desbloqueado" para no
// trabar skins nuevas que se agreguen a SKINS a futuro.
const RULES: (Req | null)[] = [
  // ---- banderas (0..16) ----
  null, // 0  Argentina  (inicial)
  { metric: 'matches', need: 1 }, //  1  Uruguay
  null, // 2  Brasil     (inicial)
  null, // 3  España     (inicial)
  null, // 4  Italia     (inicial)
  null, // 5  Francia    (inicial)
  { metric: 'matches', need: 2 }, //  6  Alemania
  { metric: 'rounds', need: 15 }, //  7  Japón
  { metric: 'matches', need: 3 }, //  8  México
  { metric: 'matches', need: 4 }, //  9  Colombia
  { metric: 'rounds', need: 30 }, // 10  Chile
  { metric: 'roundWins', need: 10 }, // 11  Japón Sol
  { metric: 'matches', need: 6 }, // 12  Portugal
  { metric: 'roundWins', need: 20 }, // 13  Grecia
  { metric: 'matches', need: 8 }, // 14  Perú
  { metric: 'matches', need: 10 }, // 15  Suecia
  { metric: 'matches', need: 12 }, // 16  Irlanda
  // ---- patrones (17..30) ----
  null, // 17  Rayas      (inicial)
  null, // 18  Lunares    (inicial)
  { metric: 'roundWins', need: 1 }, // 19  Bandas
  { metric: 'roundWins', need: 3 }, // 20  Damero
  { metric: 'roundWins', need: 5 }, // 21  Diagonal
  { metric: 'roundWins', need: 8 }, // 22  Onda
  { metric: 'roundWins', need: 12 }, // 23  Aros
  { metric: 'roundWins', need: 18 }, // 24  Triángulos
  { metric: 'roundWins', need: 25 }, // 25  Estrellas
  { metric: 'rounds', need: 25 }, // 26  Camuflaje
  { metric: 'rounds', need: 50 }, // 27  Corazones
  { metric: 'rounds', need: 80 }, // 28  Cebra
  { metric: 'bestStreak', need: 3 }, // 29  Cuadros
  { metric: 'bestStreak', need: 5 }, // 30  Rombos
  // ---- materiales (31..43) ----
  null, // 31  Metal      (inicial)
  { metric: 'matches', need: 15 }, // 32  Peluda
  { metric: 'matchWins', need: 1 }, // 33  Slime
  null, // 34  Neón       (inicial)
  { metric: 'matchWins', need: 3 }, // 35  Piedra
  { metric: 'matchWins', need: 6 }, // 36  Cromo
  { metric: 'matchWins', need: 10 }, // 37  Galaxia
  { metric: 'roundWins', need: 40 }, // 38  Lava
  { metric: 'roundWins', need: 60 }, // 39  Oro
  { metric: 'matchWins', need: 15 }, // 40  Cobre
  { metric: 'bestStreak', need: 8 }, // 41  Hielo
  { metric: 'bestStreak', need: 12 }, // 42  Arcoíris
  { metric: 'roundWins', need: 100 }, // 43  Circuito
];

/** Requisito de una skin (null = inicial / fuera de tabla = desbloqueada). */
function ruleFor(index: number): Req | null {
  const i = ((index % SKIN_COUNT) + SKIN_COUNT) % SKIN_COUNT;
  return RULES[i] ?? null;
}

/** ¿La skin está disponible con las stats actuales? */
export function isSkinUnlocked(index: number): boolean {
  const rule = ruleFor(index);
  if (!rule) return true;
  return readLifetime()[rule.metric] >= rule.need;
}

/** Texto corto de cómo desbloquear la skin (o "Desbloqueado" si ya lo está). */
export function unlockHint(index: number): string {
  const rule = ruleFor(index);
  if (!rule) return 'Desbloqueado';
  return HINT[rule.metric](rule.need);
}

/** Cuántas de las SKIN_COUNT skins están desbloqueadas ahora mismo. */
export function unlockedCount(): number {
  const life = readLifetime();
  let n = 0;
  for (let i = 0; i < SKIN_COUNT; i++) {
    const rule = RULES[i] ?? null;
    if (!rule || life[rule.metric] >= rule.need) n++;
  }
  return n;
}

/**
 * Skin bloqueada más cercana a desbloquearse (menos unidades faltantes en su
 * propia métrica), para una línea "próximo desbloqueo". null si ya está todo.
 */
export function nextUnlock(): { index: number; hint: string } | null {
  const life = readLifetime();
  let best: { index: number; remaining: number } | null = null;
  for (let i = 0; i < SKIN_COUNT; i++) {
    const rule = RULES[i] ?? null;
    if (!rule) continue;
    const remaining = rule.need - life[rule.metric];
    if (remaining <= 0) continue; // ya desbloqueada
    if (!best || remaining < best.remaining) best = { index: i, remaining };
  }
  if (!best) return null;
  return { index: best.index, hint: unlockHint(best.index) };
}
