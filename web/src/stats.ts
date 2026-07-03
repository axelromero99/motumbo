// Acumulador de estadísticas de match (por ronda y de por vida). Solo LEE los
// eventos que emite el sim — nunca alimenta nada de vuelta al gameplay.
//
// Uso desde main.ts:
//   const stats = new MatchStats();
//   stats.reset(playerCount, 0);          // al arrancar un match
//   stats.onRoundStart(sim.frame);        // al arrancar cada ronda (incl. la 1ª)
//   // dentro de handleEvents, por cada evento:
//   stats.onEvent(type, a, b, sim.frame);
//   // al mostrar resultados:
//   const rows = stats.roundRows();       // stats de la ronda que terminó
//   const totals = stats.matchRows();     // acumulado del match (para el podio)
//   // stats de por vida (localStorage 'tumbo.stats.v1'):
//   stats.recordRound(yoGané);            // al final de cada ronda
//   stats.recordMatch(yoGanéElMatch);     // al final del match
//   ui.setLifetimeLine(stats.summaryLine());

import { EVT_FALL, EVT_ORB_PICKUP, EVT_ROUND_END, EVT_DASH_HIT, EVT_PARRY } from './sim';

/** Un KO se acredita si la víctima cae ≤ este margen de ticks tras el último dash-hit. */
const KO_WINDOW_TICKS = 180;

const STATS_KEY = 'tumbo.stats.v1';

export interface PlayerRoundStats {
  /** Ticks que estuvo vivo en la ronda (los que no cayeron cierran en ROUND_END). */
  aliveTicks: number;
  /** Empujones dados (dash-hits conectados como atacante). */
  shoves: number;
  /** Caídas ajenas acreditadas: la víctima cayó ≤180 ticks después de tu dash-hit. */
  kos: number;
  /** Empujones bloqueados con brace (como parrier). */
  parries: number;
  /** Orbes de poder agarrados. */
  orbs: number;
}

interface LifetimeStats {
  matches: number;
  matchWins: number;
  rounds: number;
  roundWins: number;
  bestStreak: number;
  /** Racha actual de rondas ganadas (persistida para sobrevivir recargas). */
  streak: number;
}

const LIFETIME_ZERO: LifetimeStats = { matches: 0, matchWins: 0, rounds: 0, roundWins: 0, bestStreak: 0, streak: 0 };

function zeroRow(): PlayerRoundStats {
  return { aliveTicks: 0, shoves: 0, kos: 0, parries: 0, orbs: 0 };
}

export class MatchStats {
  private playerCount = 0;
  private roundStart = 0;
  private lastTick = 0;
  private roundEndTick: number | null = null;

  private round: PlayerRoundStats[] = [];
  private match: PlayerRoundStats[] = [];
  /** Tick de caída de cada jugador en la ronda actual (null = sigue vivo). */
  private fallTick: (number | null)[] = [];
  /** Último dash-hit recibido por cada jugador: [atacante, tick]. */
  private lastHit: ({ by: number; tick: number } | null)[] = [];

  /**
   * Reset total de match. Llama internamente a onRoundStart(startTick);
   * startTick por defecto 0 (sim.frame arranca en 0 en cada init).
   */
  reset(playerCount: number, startTick = 0): void {
    this.playerCount = playerCount;
    this.match = Array.from({ length: playerCount }, zeroRow);
    this.onRoundStart(startTick);
  }

  /** Arranque de ronda: limpia los acumuladores por ronda. */
  onRoundStart(tick: number): void {
    this.roundStart = tick;
    this.lastTick = tick;
    this.roundEndTick = null;
    this.round = Array.from({ length: this.playerCount }, zeroRow);
    this.fallTick = new Array<number | null>(this.playerCount).fill(null);
    this.lastHit = new Array<{ by: number; tick: number } | null>(this.playerCount).fill(null);
  }

  /**
   * Consumí acá cada evento del sim (mismos [type, a, b] del buffer de
   * eventos; tick = sim.frame del tick en que salió el evento).
   */
  onEvent(type: number, a: number, b: number, tick: number): void {
    this.lastTick = Math.max(this.lastTick, tick);
    const ai = Math.round(a);
    const bi = Math.round(b);
    const valid = (i: number): boolean => i >= 0 && i < this.playerCount;

    switch (type) {
      case EVT_DASH_HIT: // a = atacante, b = víctima
        if (valid(ai)) {
          this.round[ai].shoves++;
          this.match[ai].shoves++;
        }
        if (valid(bi) && valid(ai) && ai !== bi) this.lastHit[bi] = { by: ai, tick };
        break;

      case EVT_PARRY: // a = atacante, b = parrier
        if (valid(bi)) {
          this.round[bi].parries++;
          this.match[bi].parries++;
        }
        break;

      case EVT_ORB_PICKUP: // b = jugador
        if (valid(bi)) {
          this.round[bi].orbs++;
          this.match[bi].orbs++;
        }
        break;

      case EVT_FALL: {
        // b = jugador que cayó
        if (!valid(bi) || this.fallTick[bi] !== null) break;
        this.fallTick[bi] = tick;
        const alive = tick - this.roundStart;
        this.round[bi].aliveTicks = alive;
        this.match[bi].aliveTicks += alive;
        const hit = this.lastHit[bi];
        if (hit && tick - hit.tick <= KO_WINDOW_TICKS && valid(hit.by)) {
          this.round[hit.by].kos++;
          this.match[hit.by].kos++;
        }
        break;
      }

      case EVT_ROUND_END:
        // Cierra el tiempo vivo de los que no cayeron (ganador o empate).
        this.roundEndTick = tick;
        for (let i = 0; i < this.playerCount; i++) {
          if (this.fallTick[i] === null) {
            const alive = tick - this.roundStart;
            this.round[i].aliveTicks = alive;
            this.match[i].aliveTicks += alive;
            this.fallTick[i] = tick; // evita doble cierre si llega otro evento
          }
        }
        break;
    }
  }

  /** Filas de la ronda actual/recién terminada, indexadas por slot de jugador. */
  roundRows(): PlayerRoundStats[] {
    return this.round.map((_, i) => ({
      aliveTicks: this.aliveTicks(i),
      shoves: this.shoves(i),
      kos: this.kos(i),
      parries: this.parries(i),
      orbs: this.orbs(i),
    }));
  }

  // Accesores por jugador de la ronda actual (los que usa main.ts para armar
  // las filas de ui.showResults).

  /** Ticks vivo del jugador i en la ronda (parcial si la ronda sigue). */
  aliveTicks(i: number): number {
    if (i < 0 || i >= this.playerCount) return 0;
    if (this.fallTick[i] !== null) return this.round[i].aliveTicks;
    const end = this.roundEndTick ?? this.lastTick;
    return Math.max(0, end - this.roundStart);
  }

  shoves(i: number): number {
    return this.round[i]?.shoves ?? 0;
  }

  kos(i: number): number {
    return this.round[i]?.kos ?? 0;
  }

  parries(i: number): number {
    return this.round[i]?.parries ?? 0;
  }

  orbs(i: number): number {
    return this.round[i]?.orbs ?? 0;
  }

  /** Acumulado de todo el match (aliveTicks suma todas las rondas cerradas). */
  matchRows(): PlayerRoundStats[] {
    return this.match.map((r) => ({ ...r }));
  }

  // -------------------------------------------------------------------
  // Stats de por vida (localStorage 'tumbo.stats.v1')
  // -------------------------------------------------------------------

  private loadLifetime(): LifetimeStats {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (!raw) return { ...LIFETIME_ZERO };
      const p = JSON.parse(raw) as Partial<LifetimeStats>;
      return {
        matches: Number(p.matches) || 0,
        matchWins: Number(p.matchWins) || 0,
        rounds: Number(p.rounds) || 0,
        roundWins: Number(p.roundWins) || 0,
        bestStreak: Number(p.bestStreak) || 0,
        streak: Number(p.streak) || 0,
      };
    } catch {
      return { ...LIFETIME_ZERO };
    }
  }

  private saveLifetime(s: LifetimeStats): void {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(s));
    } catch {
      // sin storage: las stats de por vida simplemente no persisten
    }
  }

  /** Registrá cada ronda terminada (won = la ganó el jugador local). */
  recordRound(won: boolean): void {
    const s = this.loadLifetime();
    s.rounds++;
    if (won) {
      s.roundWins++;
      s.streak++;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
    } else {
      s.streak = 0;
    }
    this.saveLifetime(s);
  }

  /** Registrá cada match terminado (won = campeón el jugador local). */
  recordMatch(won: boolean): void {
    const s = this.loadLifetime();
    s.matches++;
    if (won) s.matchWins++;
    this.saveLifetime(s);
  }

  /** Línea de por vida para la pantalla de título (ui.setLifetimeLine). */
  summaryLine(): string {
    const s = this.loadLifetime();
    if (s.matches === 0 && s.rounds === 0) return 'Todavía no jugaste ningún match — dale, tumbá a alguien.';
    const parts = [`${s.matches} ${s.matches === 1 ? 'match' : 'matches'} (${s.matchWins} ganados)`, `${s.rounds} rondas (${s.roundWins} ganadas)`];
    if (s.bestStreak > 1) parts.push(`mejor racha ${s.bestStreak}`);
    return parts.join(' · ');
  }
}
