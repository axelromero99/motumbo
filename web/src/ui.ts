/**
 * UiShell — shell de pantallas + HUD DOM de MOTUMBO. Cero gameplay: solo DOM,
 * settings persistidos y callbacks hacia main.ts.
 *
 * =====================================================================
 * MAPA DE INTEGRACIÓN EXACTO PARA main.ts
 * =====================================================================
 *
 * Construcción:
 *   const ui = new UiShell({ ...callbacks });
 *   - El constructor carga settings de localStorage ('motumbo.settings.v1') y
 *     muestra la pantalla 'title'.
 *   - onSettingsChanged(settings) se emite UNA vez en un microtask después de
 *     que el constructor retorna (así main.ts ya tiene la variable `ui`
 *     asignada), y luego sincrónicamente en cada cambio del usuario. main.ts
 *     también puede leer ui.settings sincrónicamente apenas construye.
 *   - Si la URL trae '#room=<código>', el constructor deja el código pre-cargado
 *     en el input de UNIRSE, SIN disparar callbacks ni navegar: el flujo del
 *     link (mostrar 'online', unirse solo) es 100% responsabilidad de main.ts.
 *
 * Flujo de pantallas (la UiShell navega sola; main.ts NO necesita llamar a
 * show() salvo para pausa, para el setup online del host y para volver de
 * estados propios):
 *   - JUGAR  -> onPlay() y navega a 'setup' (fila RIVALES visible).
 *   - ONLINE -> navega a 'online' (estado idle) y dispara onOnline().
 *   - JUGAR (setup) -> onStartMatch(level, winTarget, mode, modeParam,
 *     botDifficulty, rivals) y navega a 'none'. level es índice de nivel,
 *     'random' o { custom: id } (main.ts resuelve random/bytes). winTarget es
 *     3, 5 o 7. mode es una constante MODE_* de sim.ts; modeParam es el
 *     parámetro contextual (KOTH: segundos en zona 10/15/20, COSECHA: orbes
 *     3/5/8, MALDITO: segundos de mecha 8/12/20; SUMO: 0) — pasable directo a
 *     sim.setMode(mode, modeParam). rivals: 'bots' (3 bots, aplica
 *     botDifficulty) | 'humano' (2 en un teclado). Con sala online conectada
 *     la fila RIVALES está oculta y rivals llega como 'humano'.
 *   - Volver (setup) -> 'title' (o 'online' si hay sala conectada).
 *   - Pausa: main.ts llama ui.show('pause') cuando detecta Esc.
 *     Reanudar -> onResume() + 'none'. Opciones -> pantalla interna de
 *     opciones (vuelve sola a 'pause'). Salir al menú -> onQuitToTitle() + 'title'.
 *   - Results: Revancha -> onStartMatch(mismos args que el último JUGAR) +
 *     'none' (en online solo el host debería actuar — el guest puede ignorar
 *     el callback o main.ts lo deshabilita con un toast). Menú ->
 *     onQuitToTitle() + 'title'.
 *
 * Online — salas con código corto:
 *   - CREAR SALA: la shell pasa sola a 'creating' y dispara onCreateRoom().
 *     main.ts crea la sala y llama setRoomState('waiting', undefined, code).
 *   - UNIRSE: input de 4 caracteres (autoupper; acepta pegar "MOTUMBO-XK42" o el
 *     link entero y extrae el código; validación visual: 4 alfanuméricos — la
 *     validación real es normalizeRoomCode de signal.ts, en main.ts). Al
 *     apretar UNIRSE la shell pasa sola a 'joining' y dispara onJoinRoom(code)
 *     con el código ya normalizado (4 chars, mayúsculas).
 *   - Cancelar (creating/waiting/joining/connecting) -> estado 'idle' +
 *     onCancelOnline(). Volver -> 'title' + onCancelOnline(). main.ts debe
 *     descartar sesión/señalización en onCancelOnline y también al recibir un
 *     nuevo onCreateRoom/onJoinRoom (Reintentar repite la última acción).
 *   - setRoomState(state, detail?, code?):
 *       'idle'        vuelve a CREAR SALA / UNIRSE
 *       'creating'    spinner "creando sala…"
 *       'waiting'     código GIGANTE (pasá code al menos la primera vez) +
 *                     "Copiar link de invitación" + spinner "esperando rival…"
 *       'joining'     spinner "buscando la sala…"
 *       'connecting'  spinner "conectando…"
 *       'connected'   "¡conectados!" (detail lo pisa, p.ej. "el anfitrión
 *                     elige la arena…"); marca la sala como conectada para que
 *                     show('setup') oculte RIVALES
 *       'error'       mensaje (detail) + botón Reintentar
 *     Cualquier otro string se muestra tal cual con spinner. detail opcional
 *     pisa el texto por defecto de cualquier estado.
 *   - "Copiar link de invitación": la shell copia
 *     `${origin}${pathname}#room=<code>` al portapapeles y muestra toast; NO
 *     hay callback. Click en el código gigante copia solo "MOTUMBO-<code>".
 *
 * HUD:
 *   - updateScorebar(entries, winTarget): llamar cuando cambie score/vidas
 *     (no hace falta cada frame; es barato pero reconstruye DOM). Lista vacía
 *     oculta la barra. Campos opcionales por entrada: score (string que se
 *     muestra junto a los pips, p.ej. '12s' o '3🔮') y cursed (borde rojo
 *     pulsante para el maldito en modo MALDITO).
 *   - showResults(opts): puebla Y muestra la pantalla results. nextInMs
 *     arranca un contador visual "siguiente ronda en N…" (solo display; el
 *     timing real lo maneja main.ts). champion es índice dentro de rows o null.
 *   - toast(text): aviso efímero (~2.6 s).
 *   - setLifetimeLine(text): línea de stats de por vida en la pantalla title
 *     (usar MatchStats.summaryLine() de stats.ts).
 *   - Los ids legacy #status #banner #countdown #netwait #help siguen en el
 *     DOM con el mismo comportamiento (display/innerHTML manejados por main.ts).
 *
 * Setup:
 *   - setLevelThumbs(urls, names): puebla la grilla (usar
 *     renderLevelThumbs(sim) de minimap.ts ANTES de la init real, y re-init
 *     después). La card ALEATORIO ahora es fija en el DOM y va PRIMERA;
 *     después van MIS MAPAS y recién entonces los niveles built-in. Aguanta
 *     ~70 niveles con scroll interno.
 *
 * Editor de mapas / MIS MAPAS:
 *   - EDITOR (title) -> navega a 'none' y dispara onEditor(); main.ts debe
 *     llamar mapEditor.open(). La pantalla del editor NO pasa por show():
 *     MapEditor maneja solo la clase 'active' de su propia
 *     <section data-screen="editor"> (por eso 'editor' no está en ScreenName;
 *     igual un show() de acá la oculta porque comparte la clase .screen).
 *   - setCustomMaps(maps): puebla las cards de mapas custom dentro de la
 *     grilla ARENA (llamarla al boot con listMaps() y de nuevo en
 *     onMapsChanged del editor). Elegir una card la selecciona como nivel;
 *     JUGAR/Revancha entregan { custom: id } en onStartMatch (main.ts resuelve
 *     los bytes con getMapBytes(id)). Sin mapas no se muestra nada extra.
 *   - Botón ✎ de una card -> navega a 'none' y dispara onEditMap(id); main.ts
 *     debe llamar mapEditor.open(id).
 *   - Botón ✕ de una card: la UiShell borra sola (deleteMap + re-render
 *     interno, con confirm); no hay callback. Si el mapa borrado estaba
 *     seleccionado, la selección vuelve a ALEATORIO.
 *
 * Settings (interface Settings):
 *   volMaster/volMusic 0..1 · shadows boolean · particles número 0..1
 *   (multiplicador de densidad, presets del toggle: ALTA=1, MEDIA=0.5,
 *   BAJA=0.2 — pasable directo a fx.setDensity) · reducedMotion boolean
 *   (la UiShell ya aplica la clase CSS 'reduced-motion' al <body>; main.ts
 *   debería además atenuar el screen-shake de fx).
 */

import { deleteMap, listMaps } from './editor';
import type { SavedMap } from './editor';
import { MODE_COSECHA, MODE_KOTH, MODE_MALDITO, MODE_SUMO } from './sim';

/** Presets del toggle de partículas (valor = multiplicador de densidad). */
export const PARTICLE_PRESETS: Record<string, number> = { alta: 1, media: 0.5, baja: 0.2 };

/**
 * Parámetro contextual de cada modo (clave = MODE_* de sim.ts). SUMO no está:
 * no tiene parámetro y onStartMatch entrega 0.
 */
const MODE_PARAM_CFG: Record<number, { label: string; suffix: string; options: number[]; def: number }> = {
  [MODE_KOTH]: { label: 'ZONA', suffix: 's', options: [10, 15, 20], def: 15 },
  [MODE_COSECHA]: { label: 'ORBES', suffix: '', options: [3, 5, 8], def: 5 },
  [MODE_MALDITO]: { label: 'MECHA', suffix: 's', options: [8, 12, 20], def: 12 },
};

/** Descripción de una línea por modo (clave = MODE_* de sim.ts). */
const MODE_DESC: Record<number, string> = {
  [MODE_SUMO]: 'El último en pie gana la ronda.',
  [MODE_KOTH]: 'Sumá segundos estando solo en la zona.',
  [MODE_COSECHA]: 'Juntá los orbes antes que nadie.',
  [MODE_MALDITO]: 'Pasale la maldición a otro antes de que explote.',
};

/** Nivel elegido en el setup: built-in, aleatorio o mapa custom (id de SavedMap). */
export type LevelChoice = number | 'random' | { custom: string };

/** Rivales del setup local: 3 bots o un humano en el mismo teclado. */
export type Rivals = 'bots' | 'humano';

export interface Settings {
  volMaster: number;
  volMusic: number;
  shadows: boolean;
  /** Multiplicador de densidad de partículas 0..1 (ALTA=1, MEDIA=0.5, BAJA=0.2). */
  particles: number;
  reducedMotion: boolean;
}

export type ScreenName = 'title' | 'setup' | 'online' | 'pause' | 'results' | 'none';

export interface ScoreEntry {
  color: number;
  wins: number;
  alive: boolean;
  you: boolean;
  /** Texto de score del modo mostrado junto a los pips (p.ej. '12s', '3🔮'). */
  score?: string;
  /** MALDITO: marca el chip del maldito con borde rojo pulsante. */
  cursed?: boolean;
}

export interface ResultRow {
  name: string;
  color: number;
  wins: number;
  aliveTicks: number;
  shoves: number;
  kos: number;
  winner: boolean;
}

export interface ResultsOpts {
  rows: ResultRow[];
  winTarget: number;
  champion: number | null;
  nextInMs: number | null;
  /** Did the local player win this round/match? Drives the title flourish. */
  youWon?: boolean;
}

export interface UiCallbacks {
  /** Botón JUGAR del título (la UiShell ya navegó a 'setup'). */
  onPlay(): void;
  /** Botón ONLINE del título (la UiShell ya navegó a 'online', estado idle). */
  onOnline(): void;
  /** PARTIDA RÁPIDA (la UiShell ya pasó a estado 'searching'). */
  onQuickMatch(): void;
  /** CREAR SALA (la UiShell ya pasó a estado 'creating'). */
  onCreateRoom(): void;
  /** UNIRSE con código ya normalizado a 4 chars mayúsculas ('joining' ya visible). */
  onJoinRoom(code: string): void;
  /** Cancelar/Volver del flujo online: descartar sesión y señalización. */
  onCancelOnline(): void;
  /** mode = MODE_* de sim.ts; modeParam = parámetro contextual (SUMO: 0). */
  onStartMatch(
    level: LevelChoice,
    winTarget: number,
    mode: number,
    modeParam: number,
    botDifficulty: number,
    rivals: Rivals,
    /** Online only: extra bots to add to the room (0-2). 0 otherwise. */
    onlineBots: number,
  ): void;
  onResume(): void;
  onQuitToTitle(): void;
  onSettingsChanged(s: Settings): void;
  /** Botón EDITOR de la pantalla title (la UiShell ya navegó a 'none'). */
  onEditor(): void;
  /** Botón ✎ de una card de MIS MAPAS (la UiShell ya navegó a 'none'). */
  onEditMap(id: string): void;
}

const SETTINGS_KEY = 'motumbo.settings.v1';
const USERNAME_KEY = 'motumbo.username';

const DEFAULT_SETTINGS: Settings = {
  volMaster: 0.8,
  volMusic: 0.6,
  shadows: true,
  particles: 1,
  reducedMotion: false,
};

/** Validación VISUAL del código de sala (la real es normalizeRoomCode en signal.ts). */
const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

/**
 * Extrae un código de sala de lo que sea que pegue el usuario: "XK42",
 * "MOTUMBO-XK42" o el link entero con '#room=XK42'. Devuelve hasta 4 chars
 * alfanuméricos en mayúsculas (puede ser parcial mientras tipea).
 */
function extractRoomCode(raw: string): string {
  let s = raw;
  const m = /#room=([^&\s]+)/i.exec(s);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/^\s*MOTUMBO-?/, '').replace(/[^A-Z0-9]/g, '');
  return s.slice(0, 4);
}

function hexColor(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`UiShell: falta #${id} en index.html`);
  return el;
}

/** Pips ●●○○○ como spans estilizables. */
function buildPips(wins: number, target: number, color: string): HTMLSpanElement {
  const wrap = document.createElement('span');
  wrap.className = 'pips';
  for (let i = 0; i < target; i++) {
    const pip = document.createElement('span');
    pip.className = i < wins ? 'pip-on' : 'pip-off';
    pip.textContent = i < wins ? '●' : '○';
    if (i < wins) pip.style.color = color;
    wrap.appendChild(pip);
  }
  return wrap;
}

export class UiShell {
  private cb: UiCallbacks;
  private settingsData: Settings;
  private current: ScreenName | 'options' | 'howto' = 'none';
  private optionsReturnTo: ScreenName | 'options' = 'title';

  private screens = new Map<string, HTMLElement>();
  private levelNames: string[] = [];
  private customMaps: SavedMap[] = [];
  private selLevel: LevelChoice = 'random';
  private winTarget = 5;
  private selMode: number = MODE_SUMO;
  private rivals: Rivals = 'bots';
  /** Último parámetro elegido por modo (arranca en el default de cada uno). */
  private modeParamSel: Record<number, number> = {
    [MODE_KOTH]: MODE_PARAM_CFG[MODE_KOTH].def,
    [MODE_COSECHA]: MODE_PARAM_CFG[MODE_COSECHA].def,
    [MODE_MALDITO]: MODE_PARAM_CFG[MODE_MALDITO].def,
  };
  private botDiff = 1;
  private onlineBots = 0;
  private onlineBotDiff = 1;
  private lastStart: {
    level: LevelChoice;
    winTarget: number;
    mode: number;
    modeParam: number;
    botDifficulty: number;
    rivals: Rivals;
    onlineBots: number;
  } = { level: 'random', winTarget: 5, mode: MODE_SUMO, modeParam: 0, botDifficulty: 1, rivals: 'bots', onlineBots: 0 };

  // Estado online.
  private roomCode = '';
  private roomConnected = false;
  private usernameValue = '';
  private lastRoomAction: { type: 'create' } | { type: 'join'; code: string } | { type: 'quick' } | null = null;

  private nextTimer = 0;

  constructor(callbacks: UiCallbacks) {
    this.cb = callbacks;
    this.settingsData = this.loadSettings();

    for (const el of document.querySelectorAll<HTMLElement>('.screen')) {
      this.screens.set(el.dataset.screen ?? '', el);
    }

    this.wireUsername();
    this.wireTitle();
    this.wireSetup();
    this.wireOnline();
    this.wirePause();
    this.wireResults();
    this.wireOptions();
    this.applySettingsToControls();
    this.applyBodyClasses();

    this.show('title');

    // Link de invitación: solo pre-cargamos el código en el input de UNIRSE.
    // Navegar a 'online' y unirse lo maneja main.ts con su propio parseo del
    // hash — acá NO se dispara ningún callback.
    if (/#room=/i.test(location.hash)) {
      (document.getElementById('room-code-in') as HTMLInputElement).value = extractRoomCode(location.hash);
      this.syncJoinInput();
    }

    // Diferido a microtask: cuando main.ts recibe este callback, la variable
    // `ui` de su lado ya está asignada.
    queueMicrotask(() => this.cb.onSettingsChanged(this.settings));
  }

  // -------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------

  show(screen: ScreenName): void {
    this.showAny(screen);
  }

  /** Puebla la grilla de niveles del setup (thumbs de minimap.ts). */
  setLevelThumbs(urls: string[], names: string[]): void {
    this.levelNames = names.slice();
    const grid = $('level-grid');
    grid.textContent = '';
    for (let i = 0; i < names.length; i++) {
      const card = document.createElement('button');
      card.className = 'level-card';
      card.type = 'button';
      const img = document.createElement('img');
      img.src = urls[i] ?? '';
      img.alt = names[i];
      img.loading = 'lazy';
      img.draggable = false;
      const label = document.createElement('span');
      label.className = 'lname';
      label.textContent = names[i];
      card.append(img, label);
      card.addEventListener('click', () => this.selectLevel(i));
      grid.appendChild(card);
    }
    this.selectLevel(this.selLevel);
  }

  /** Puebla las cards de MIS MAPAS dentro de la grilla ARENA. */
  setCustomMaps(maps: SavedMap[]): void {
    this.customMaps = maps.slice();
    const grid = $('custom-grid');
    grid.textContent = '';
    for (const m of maps) {
      const card = document.createElement('div');
      card.className = 'level-card custom-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'button');

      const img = document.createElement('img');
      img.src = m.thumb;
      img.alt = m.name;
      img.draggable = false;

      const label = document.createElement('span');
      label.className = 'lname';
      label.textContent = m.name;

      const acts = document.createElement('div');
      acts.className = 'card-acts';
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'card-act';
      edit.textContent = '✎';
      edit.title = 'Editar';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showAny('none');
        this.cb.onEditMap(m.id);
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'card-act danger';
      del.textContent = '✕';
      del.title = 'Borrar';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!window.confirm(`¿Borrar "${m.name}"?`)) return;
        deleteMap(m.id);
        if (typeof this.selLevel === 'object' && this.selLevel.custom === m.id) {
          this.selLevel = 'random';
        }
        this.setCustomMaps(listMaps());
        this.toast('Mapa borrado');
      });
      acts.append(edit, del);

      card.append(img, label, acts);
      const select = (): void => this.selectLevel({ custom: m.id });
      card.addEventListener('click', select);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select();
        }
      });
      grid.appendChild(card);
    }
    this.selectLevel(this.selLevel);
  }

  /**
   * Estado visual de la pantalla de salas. Ver protocolo en el header.
   * code: código de sala (solo hace falta pasarlo con 'waiting').
   */
  setRoomState(state: string, detail?: string, code?: string): void {
    if (code) this.roomCode = extractRoomCode(code) || code.toUpperCase();
    if (state === 'connected') this.roomConnected = true;
    else if (state === 'idle' || state === 'error') this.roomConnected = false;

    const idle = $('room-idle');
    const live = $('room-live');
    const error = $('room-error');
    const codeBig = $('room-code-big');
    const copyBtn = $('btn-copy-invite');
    const spinner = $('room-spinner');
    const ok = $('room-ok');
    const statusEl = $('room-status');
    const cancelBtn = $('btn-room-cancel');

    const view = state === 'idle' ? idle : state === 'error' ? error : live;
    idle.style.display = view === idle ? '' : 'none';
    live.style.display = view === live ? '' : 'none';
    error.style.display = view === error ? '' : 'none';
    if (view !== live) return;

    const waiting = state === 'waiting';
    const connected = state === 'connected';
    codeBig.style.display = waiting ? '' : 'none';
    copyBtn.style.display = waiting ? '' : 'none';
    if (waiting) $('room-code-chars').textContent = this.roomCode;
    spinner.style.display = connected ? 'none' : '';
    ok.style.display = connected ? '' : 'none';
    cancelBtn.style.display = connected ? 'none' : '';

    const DEFAULTS: Record<string, string> = {
      creating: 'creando sala…',
      waiting: 'esperando rival…',
      joining: 'buscando la sala…',
      connecting: 'conectando…',
      connected: '¡conectados!',
    };
    statusEl.textContent = detail ?? DEFAULTS[state] ?? state;
  }

  setLifetimeLine(text: string): void {
    $('lifetime-line').textContent = text;
  }

  updateScorebar(entries: ScoreEntry[], winTarget: number): void {
    const bar = $('scorebar');
    bar.textContent = '';
    for (const e of entries) {
      const chip = document.createElement('div');
      chip.className =
        'chip' + (e.you ? ' you' : '') + (e.alive ? '' : ' dead') + (e.cursed ? ' cursed' : '');
      const ball = document.createElement('span');
      ball.className = 'chip-ball';
      ball.style.background = hexColor(e.color);
      chip.appendChild(ball);
      chip.appendChild(buildPips(e.wins, winTarget, hexColor(e.color)));
      if (e.score) {
        const sc = document.createElement('span');
        sc.className = 'chip-score';
        sc.textContent = e.score;
        chip.appendChild(sc);
      }
      if (e.you) {
        const tag = document.createElement('span');
        tag.className = 'you-tag';
        tag.textContent = 'VOS';
        chip.appendChild(tag);
      }
      bar.appendChild(chip);
    }
  }

  showResults(opts: ResultsOpts): void {
    const title = $('results-title');
    const champEl = $('results-champion');
    const rowsEl = $('results-rows');
    const nextEl = $('results-next');
    rowsEl.textContent = '';

    const isFinal = opts.champion !== null;
    title.classList.remove('win', 'lose');
    if (opts.youWon === true) {
      title.textContent = isFinal ? '🏆 ¡GANASTE! 🏆' : '¡GANASTE LA RONDA!';
      title.classList.add('win');
    } else if (opts.youWon === false) {
      title.textContent = isFinal ? 'PERDISTE' : 'CAÍSTE';
      title.classList.add('lose');
    } else {
      title.textContent = isFinal ? 'FIN DEL MATCH' : 'FIN DE RONDA';
    }

    if (isFinal && opts.rows[opts.champion!]) {
      const champ = opts.rows[opts.champion!];
      champEl.style.display = 'block';
      champEl.textContent = '';
      const name = document.createElement('span');
      name.textContent = champ.name;
      name.style.color = hexColor(champ.color);
      const sub = document.createElement('small');
      sub.textContent = 'CAMPEÓN';
      champEl.append(name, sub);
    } else {
      champEl.style.display = 'none';
    }

    const maxAlive = Math.max(1, ...opts.rows.map((r) => r.aliveTicks));
    const maxShoves = Math.max(1, ...opts.rows.map((r) => r.shoves));
    const maxKos = Math.max(1, ...opts.rows.map((r) => r.kos));

    for (const r of opts.rows) {
      const row = document.createElement('div');
      row.className = 'rrow' + (r.winner ? ' winner' : '');
      const color = hexColor(r.color);

      const ball = document.createElement('span');
      ball.className = 'chip-ball';
      ball.style.background = color;

      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = r.name;
      name.style.color = color;

      const pips = buildPips(r.wins, opts.winTarget, color);
      pips.className = 'rpips';

      const stats = document.createElement('div');
      stats.className = 'rstats';
      const bar = (label: string, value: number, max: number, text: string): HTMLElement => {
        const stat = document.createElement('div');
        stat.className = 'rstat';
        const lbl = document.createElement('span');
        lbl.className = 'rlabel';
        lbl.textContent = label;
        const track = document.createElement('div');
        track.className = 'rtrack';
        const fill = document.createElement('div');
        fill.className = 'rfill';
        fill.style.width = `${Math.round((value / max) * 100)}%`;
        fill.style.background = color;
        track.appendChild(fill);
        const val = document.createElement('span');
        val.className = 'rval';
        val.textContent = text;
        stat.append(lbl, track, val);
        return stat;
      };
      stats.appendChild(bar('VIVO', r.aliveTicks, maxAlive, `${(r.aliveTicks / 60).toFixed(1)}s`));
      stats.appendChild(bar('EMPUJONES', r.shoves, maxShoves, String(r.shoves)));
      stats.appendChild(bar('KOS', r.kos, maxKos, String(r.kos)));

      row.append(ball, name, pips, stats);
      rowsEl.appendChild(row);
    }

    window.clearInterval(this.nextTimer);
    if (opts.nextInMs !== null && opts.nextInMs > 0) {
      const deadline = performance.now() + opts.nextInMs;
      const tickDown = (): void => {
        const left = Math.ceil((deadline - performance.now()) / 1000);
        if (left <= 0) {
          nextEl.textContent = 'siguiente ronda…';
          window.clearInterval(this.nextTimer);
        } else {
          nextEl.textContent = `siguiente ronda en ${left}…`;
        }
      };
      tickDown();
      this.nextTimer = window.setInterval(tickDown, 250);
    } else {
      nextEl.textContent = '';
    }

    this.showAny('results');
  }

  toast(text: string): void {
    const zone = $('toasts');
    while (zone.children.length >= 4) zone.removeChild(zone.firstChild!);
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    zone.appendChild(t);
    window.setTimeout(() => t.classList.add('out'), 2200);
    window.setTimeout(() => t.remove(), 2600);
  }

  get settings(): Settings {
    return { ...this.settingsData };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private showAny(screen: ScreenName | 'options' | 'howto'): void {
    if (this.current === 'results' && screen !== 'results') {
      window.clearInterval(this.nextTimer);
    }
    if (screen === 'setup') this.applySetupContext();
    this.current = screen;
    for (const [name, el] of this.screens) {
      el.classList.toggle('active', name === screen);
    }
  }

  /** Con sala online conectada, el rival es la otra persona: RIVALES se
   * oculta y aparece la opción de sumar bots a la sala. */
  private applySetupContext(): void {
    $('rival-block').style.display = this.roomConnected ? 'none' : '';
    $('online-bots-block').style.display = this.roomConnected ? '' : 'none';
    $('setup-mode').textContent = this.roomConnected ? 'ONLINE · ELEGÍS VOS LA ARENA' : '';
  }

  /** Nombre del jugador local (slither.io style), persistido en localStorage. */
  get username(): string {
    return this.usernameValue;
  }

  private wireUsername(): void {
    const input = document.getElementById('username-input') as HTMLInputElement;
    try {
      this.usernameValue = localStorage.getItem(USERNAME_KEY) ?? '';
    } catch {
      this.usernameValue = '';
    }
    input.value = this.usernameValue;
    input.addEventListener('input', () => {
      this.usernameValue = input.value.trim().slice(0, 18);
      try {
        localStorage.setItem(USERNAME_KEY, this.usernameValue);
      } catch {
        // ignore storage errors
      }
    });
  }

  private wireTitle(): void {
    $('btn-play').addEventListener('click', () => {
      this.cb.onPlay();
      this.showAny('setup');
    });
    $('btn-online').addEventListener('click', () => {
      this.setRoomState('idle');
      this.showAny('online');
      this.cb.onOnline();
    });
    $('btn-options').addEventListener('click', () => {
      this.optionsReturnTo = 'title';
      this.showAny('options');
    });
    $('btn-editor').addEventListener('click', () => {
      this.showAny('none');
      this.cb.onEditor();
    });
    $('btn-howto').addEventListener('click', () => this.showAny('howto'));
    $('btn-howto-back').addEventListener('click', () => this.showAny('title'));
  }

  private wireSetup(): void {
    // RIVALES: dos cards; el seg de dificultad vive dentro de la card de bots.
    const botsCard = $('rival-bots');
    const humanCard = $('rival-humano');
    const pickRivals = (r: Rivals): void => {
      this.rivals = r;
      botsCard.classList.toggle('selected', r === 'bots');
      humanCard.classList.toggle('selected', r === 'humano');
    };
    botsCard.addEventListener('click', () => pickRivals('bots'));
    humanCard.addEventListener('click', () => pickRivals('humano'));
    for (const card of [botsCard, humanCard]) {
      card.addEventListener('keydown', (e) => {
        if (e.target === card && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          pickRivals(card === botsCard ? 'bots' : 'humano');
        }
      });
    }
    for (const btn of $('seg-botdiff').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        // El click burbujea a la card y selecciona bots solo.
        this.botDiff = Number(btn.dataset.diff) || 0;
        for (const b of $('seg-botdiff').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }
    // Bots para la sala online (2 humanos + N bots).
    for (const btn of $('seg-online-bots').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        this.onlineBots = Number(btn.dataset.bots) || 0;
        for (const b of $('seg-online-bots').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }
    for (const btn of $('seg-online-botdiff').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        this.onlineBotDiff = Number(btn.dataset.diff) || 0;
        for (const b of $('seg-online-botdiff').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }

    $('card-random').addEventListener('click', () => this.selectLevel('random'));

    for (const btn of $('seg-rounds').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        this.winTarget = Number(btn.dataset.rounds) || 5;
        for (const b of $('seg-rounds').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }

    const modeChips = $('mode-chips').querySelectorAll<HTMLButtonElement>('.mode-chip');
    for (const chip of modeChips) {
      chip.addEventListener('click', () => {
        this.selMode = Number(chip.dataset.mode) || MODE_SUMO;
        for (const c of modeChips) c.classList.toggle('selected', c === chip);
        this.renderModeUi();
      });
    }
    this.renderModeUi();

    $('btn-start').addEventListener('click', () => {
      const modeParam = this.currentModeParam();
      const rivals: Rivals = this.roomConnected ? 'humano' : this.rivals;
      // Online: the difficulty applies to the room's bots; count = onlineBots.
      const botDifficulty = this.roomConnected ? this.onlineBotDiff : this.botDiff;
      const onlineBots = this.roomConnected ? this.onlineBots : 0;
      this.lastStart = {
        level: this.selLevel,
        winTarget: this.winTarget,
        mode: this.selMode,
        modeParam,
        botDifficulty,
        rivals,
        onlineBots,
      };
      this.showAny('none');
      this.cb.onStartMatch(this.selLevel, this.winTarget, this.selMode, modeParam, botDifficulty, rivals, onlineBots);
    });
    $('btn-setup-back').addEventListener('click', () => {
      this.showAny(this.roomConnected ? 'online' : 'title');
    });
  }

  /** Parámetro contextual del modo seleccionado (0 si el modo no tiene). */
  private currentModeParam(): number {
    const cfg = MODE_PARAM_CFG[this.selMode];
    return cfg ? (this.modeParamSel[this.selMode] ?? cfg.def) : 0;
  }

  /** Rehace descripción + segmento del parámetro según el modo elegido. */
  private renderModeUi(): void {
    $('mode-desc').textContent = MODE_DESC[this.selMode] ?? '';
    const row = $('mode-param-row');
    const cfg = MODE_PARAM_CFG[this.selMode];
    if (!cfg) {
      row.style.display = 'none';
      return;
    }
    row.style.display = '';
    $('mode-param-label').textContent = cfg.label;
    const seg = $('seg-mode-param');
    seg.textContent = '';
    const selected = this.modeParamSel[this.selMode] ?? cfg.def;
    for (const v of cfg.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${v}${cfg.suffix}`;
      b.classList.toggle('active', v === selected);
      b.addEventListener('click', () => {
        this.modeParamSel[this.selMode] = v;
        for (const other of seg.querySelectorAll('button')) other.classList.toggle('active', other === b);
      });
      seg.appendChild(b);
    }
  }

  private selectLevel(sel: LevelChoice): void {
    if (typeof sel === 'number' && (sel < 0 || sel >= this.levelNames.length)) sel = 'random';
    if (typeof sel === 'object') {
      const id = sel.custom;
      if (!this.customMaps.some((m) => m.id === id)) sel = 'random';
    }
    this.selLevel = sel;
    const chosen = sel; // const: TS puede narrowear dentro de los callbacks
    $('card-random').classList.toggle('selected', chosen === 'random');
    $('level-grid')
      .querySelectorAll('.level-card')
      .forEach((card, i) => card.classList.toggle('selected', chosen === i));
    const customCards = $('custom-grid').querySelectorAll('.custom-card');
    customCards.forEach((card, i) => {
      const on = typeof chosen === 'object' && this.customMaps[i]?.id === chosen.custom;
      card.classList.toggle('selected', on);
    });
  }

  // -------------------------------------------------------------------
  // Online (salas)
  // -------------------------------------------------------------------

  /** Normaliza el input de UNIRSE y habilita el botón con 4 chars válidos. */
  private syncJoinInput(): void {
    const input = document.getElementById('room-code-in') as HTMLInputElement;
    const btn = document.getElementById('btn-join-room') as HTMLButtonElement;
    const code = extractRoomCode(input.value);
    if (input.value !== code) input.value = code;
    btn.disabled = !ROOM_CODE_RE.test(code);
  }

  private wireOnline(): void {
    const input = document.getElementById('room-code-in') as HTMLInputElement;
    const joinBtn = document.getElementById('btn-join-room') as HTMLButtonElement;

    input.addEventListener('input', () => this.syncJoinInput());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
    });

    $('btn-quick').addEventListener('click', () => {
      this.lastRoomAction = { type: 'quick' };
      this.setRoomState('searching', 'buscando rival…');
      this.cb.onQuickMatch();
    });

    $('btn-create-room').addEventListener('click', () => {
      this.lastRoomAction = { type: 'create' };
      this.setRoomState('creating');
      this.cb.onCreateRoom();
    });

    joinBtn.addEventListener('click', () => {
      const code = extractRoomCode(input.value);
      if (!ROOM_CODE_RE.test(code)) return;
      this.lastRoomAction = { type: 'join', code };
      this.setRoomState('joining');
      this.cb.onJoinRoom(code);
    });

    $('btn-copy-invite').addEventListener('click', () => {
      if (!this.roomCode) return;
      const link = `${location.origin}${location.pathname}#room=${this.roomCode}`;
      void navigator.clipboard.writeText(link);
      this.toast('Link copiado — mandáselo a tu rival');
    });

    $('room-code-big').addEventListener('click', () => {
      if (!this.roomCode) return;
      void navigator.clipboard.writeText(`MOTUMBO-${this.roomCode}`);
      this.toast('Código copiado');
    });

    $('btn-room-cancel').addEventListener('click', () => {
      this.setRoomState('idle');
      this.cb.onCancelOnline();
    });

    $('btn-room-retry').addEventListener('click', () => {
      const act = this.lastRoomAction;
      if (act?.type === 'create') {
        this.setRoomState('creating');
        this.cb.onCreateRoom();
      } else if (act?.type === 'join') {
        this.setRoomState('joining');
        this.cb.onJoinRoom(act.code);
      } else if (act?.type === 'quick') {
        this.setRoomState('searching', 'buscando rival…');
        this.cb.onQuickMatch();
      } else {
        this.setRoomState('idle');
      }
    });

    $('btn-online-back').addEventListener('click', () => {
      this.setRoomState('idle');
      this.showAny('title');
      this.cb.onCancelOnline();
    });
  }

  private wirePause(): void {
    $('btn-resume').addEventListener('click', () => {
      this.showAny('none');
      this.cb.onResume();
    });
    $('btn-pause-options').addEventListener('click', () => {
      this.optionsReturnTo = 'pause';
      this.showAny('options');
    });
    $('btn-quit').addEventListener('click', () => {
      this.setRoomState('idle');
      this.showAny('title');
      this.cb.onQuitToTitle();
    });
  }

  private wireResults(): void {
    $('btn-rematch').addEventListener('click', () => {
      this.showAny('none');
      const s = this.lastStart;
      this.cb.onStartMatch(s.level, s.winTarget, s.mode, s.modeParam, s.botDifficulty, s.rivals, s.onlineBots);
    });
    $('btn-results-menu').addEventListener('click', () => {
      this.setRoomState('idle');
      this.showAny('title');
      this.cb.onQuitToTitle();
    });
  }

  // -------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------

  private loadSettings(): Settings {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw) as Partial<Record<keyof Settings, unknown>>;
      const s: Settings = { ...DEFAULT_SETTINGS, ...(parsed as Partial<Settings>) };
      // Migración de versiones viejas que guardaban 'alta'|'media'|'baja'.
      if (typeof s.particles === 'string') s.particles = PARTICLE_PRESETS[s.particles] ?? 1;
      if (typeof s.particles !== 'number' || !isFinite(s.particles)) s.particles = 1;
      s.particles = Math.min(1, Math.max(0, s.particles));
      s.volMaster = Math.min(1, Math.max(0, Number(s.volMaster) || 0));
      s.volMusic = Math.min(1, Math.max(0, Number(s.volMusic) || 0));
      s.shadows = Boolean(s.shadows);
      s.reducedMotion = Boolean(s.reducedMotion);
      return s;
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settingsData));
    } catch {
      // sin storage (modo incógnito estricto): seguimos en memoria
    }
    this.applyBodyClasses();
    this.cb.onSettingsChanged(this.settings);
  }

  private applyBodyClasses(): void {
    document.body.classList.toggle('reduced-motion', this.settingsData.reducedMotion);
  }

  private applySettingsToControls(): void {
    const s = this.settingsData;
    (document.getElementById('opt-vol-master') as HTMLInputElement).value = String(s.volMaster);
    (document.getElementById('opt-vol-music') as HTMLInputElement).value = String(s.volMusic);
    (document.getElementById('opt-shadows') as HTMLInputElement).checked = s.shadows;
    (document.getElementById('opt-reduced') as HTMLInputElement).checked = s.reducedMotion;
    // Marca activo el preset más cercano al valor numérico guardado.
    let bestBtn: Element | null = null;
    let bestDist = Infinity;
    const buttons = $('opt-particles').querySelectorAll('button');
    for (const b of buttons) {
      const dist = Math.abs((PARTICLE_PRESETS[b.dataset.q ?? ''] ?? 1) - s.particles);
      if (dist < bestDist) {
        bestDist = dist;
        bestBtn = b;
      }
    }
    for (const b of buttons) b.classList.toggle('active', b === bestBtn);
  }

  private wireOptions(): void {
    const master = document.getElementById('opt-vol-master') as HTMLInputElement;
    const music = document.getElementById('opt-vol-music') as HTMLInputElement;
    const shadows = document.getElementById('opt-shadows') as HTMLInputElement;
    const reduced = document.getElementById('opt-reduced') as HTMLInputElement;

    master.addEventListener('input', () => {
      this.settingsData.volMaster = Number(master.value);
      this.saveSettings();
    });
    music.addEventListener('input', () => {
      this.settingsData.volMusic = Number(music.value);
      this.saveSettings();
    });
    shadows.addEventListener('change', () => {
      this.settingsData.shadows = shadows.checked;
      this.saveSettings();
    });
    reduced.addEventListener('change', () => {
      this.settingsData.reducedMotion = reduced.checked;
      this.saveSettings();
    });
    for (const b of $('opt-particles').querySelectorAll('button')) {
      b.addEventListener('click', () => {
        this.settingsData.particles = PARTICLE_PRESETS[b.dataset.q ?? ''] ?? 1;
        this.applySettingsToControls();
        this.saveSettings();
      });
    }
    $('btn-options-back').addEventListener('click', () => this.showAny(this.optionsReturnTo));
  }
}
