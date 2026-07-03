/**
 * UiShell — shell de pantallas + HUD DOM de TUMBO. Cero gameplay: solo DOM,
 * settings persistidos y callbacks hacia main.ts.
 *
 * =====================================================================
 * MAPA DE INTEGRACIÓN EXACTO PARA main.ts
 * =====================================================================
 *
 * Construcción:
 *   const ui = new UiShell({ ...callbacks });
 *   - El constructor carga settings de localStorage ('tumbo.settings.v1') y
 *     muestra la pantalla 'title'.
 *   - onSettingsChanged(settings) se emite UNA vez en un microtask después de
 *     que el constructor retorna (así main.ts ya tiene la variable `ui`
 *     asignada), y luego sincrónicamente en cada cambio del usuario. main.ts
 *     también puede leer ui.settings sincrónicamente apenas construye.
 *   - Si la URL trae '#join=<código>', el constructor deja pre-seleccionada
 *     la pestaña UNIRSE y pre-pega el código en el textarea, SIN disparar
 *     callbacks: el flujo del link (mostrar 'online', crear sesión, conectar)
 *     es 100% responsabilidad de main.ts.
 *
 * Flujo de pantallas (la UiShell navega sola; main.ts NO necesita llamar a
 * show() salvo para pausa y para volver de estados propios):
 *   - SOLO   -> onSolo()  y navega a 'setup'
 *   - LOCAL  -> onLocal() y navega a 'setup'
 *   - ONLINE -> navega a 'online' y dispara onOnline(true) (pestaña CREAR).
 *     Cambiar de pestaña vuelve a disparar onOnline(host); main.ts debe
 *     descartar la sesión anterior y crear una nueva en cada onOnline.
 *   - JUGAR (setup) -> onStartMatch(level, winTarget, mode, modeParam) y
 *     navega a 'none'. level es índice de nivel o 'random' (main.ts resuelve
 *     el random — es elección de host, no gameplay). winTarget es 3, 5 o 7.
 *     mode es una constante MODE_* de sim.ts; modeParam es el parámetro
 *     contextual del modo (KOTH: segundos en zona 10/15/20, COSECHA: orbes
 *     3/5/8, MALDITO: segundos de mecha 8/12/20; SUMO: 0, sin parámetro) —
 *     pasable directo a sim.setMode(mode, modeParam).
 *   - Volver (setup) -> 'title'. Volver (online) -> 'title' + onQuitToTitle()
 *     (para que main.ts descarte la sesión WebRTC).
 *   - Pausa: main.ts llama ui.show('pause') cuando detecta Esc.
 *     Reanudar -> onResume() + 'none'. Opciones -> pantalla interna de
 *     opciones (vuelve sola a 'pause'). Salir al menú -> onQuitToTitle() + 'title'.
 *   - Results: Revancha -> onStartMatch(últimoNivel, últimoWinTarget,
 *     últimoModo, últimoModeParam) + 'none' (misma semántica que JUGAR; en
 *     online solo el host debería actuar — el guest puede ignorar el callback
 *     o main.ts lo deshabilita mostrando un toast). Menú -> onQuitToTitle()
 *     + 'title'.
 *
 * Online — protocolo de setOnlineState(state, detail?):
 *   'idle'         reset del wizard (pasos según pestaña activa)
 *   'creating'     paso "tu código" con spinner ("generando código…")
 *                  (alias: 'generating')
 *   'offer-ready'  tu código listo (check verde); llamá antes setOfferCode(code)
 *                  (alias: 'code-ready')
 *   'answer-ready' (pestaña UNIRSE) respuesta generada, hay que mandársela al
 *                  anfitrión; llamá antes setOfferCode(respuesta)
 *   'connecting'   conectando (spinner en paso conexión)
 *   'waiting'      conectado a nivel transporte, esperando al rival/anfitrión
 *   'connected'    todo verde; detail opcional se muestra como estado
 *   'error'        marca el paso activo en rojo y muestra `detail` en rojo
 *   Cualquier otro string se muestra tal cual en la línea de estado.
 *   setOfferCode(code) llena el textarea de "tu código" (offer del host o
 *   respuesta del guest) y lo guarda para los botones de copiar.
 *   Copiar código / Copiar link escriben al portapapeles DESDE la UiShell
 *   (con toast) y después notifican onCopyCode()/onInviteLink() — main.ts no
 *   tiene que copiar nada. El link es `${origin}${pathname}#join=<código>`;
 *   main.ts no necesita parsear el hash (lo hace la UiShell, ver arriba).
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
 *     después). La card ALEATORIO se agrega sola al final.
 *
 * Editor de mapas / MIS MAPAS:
 *   - EDITOR (title) -> navega a 'none' y dispara onEditor(); main.ts debe
 *     llamar mapEditor.open(). La pantalla del editor NO pasa por show():
 *     MapEditor maneja solo la clase 'active' de su propia
 *     <section data-screen="editor"> (por eso 'editor' no está en ScreenName;
 *     igual un show() de acá la oculta porque comparte la clase .screen).
 *   - setCustomMaps(maps): puebla la sección MIS MAPAS del setup (llamarla al
 *     boot con listMaps() y de nuevo en onMapsChanged del editor). Elegir una
 *     card la selecciona como nivel; JUGAR/Revancha entregan { custom: id }
 *     en onStartMatch (main.ts resuelve los bytes con getMapBytes(id)).
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
  [MODE_KOTH]: { label: 'SEGUNDOS EN ZONA', suffix: 's', options: [10, 15, 20], def: 15 },
  [MODE_COSECHA]: { label: 'ORBES PARA GANAR', suffix: '', options: [3, 5, 8], def: 5 },
  [MODE_MALDITO]: { label: 'SEGUNDOS DE MECHA', suffix: 's', options: [8, 12, 20], def: 12 },
};

/** Nivel elegido en el setup: built-in, aleatorio o mapa custom (id de SavedMap). */
export type LevelChoice = number | 'random' | { custom: string };

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
}

export interface UiCallbacks {
  onSolo(): void;
  onLocal(): void;
  onOnline(host: boolean): void;
  onConnectClicked(code: string): void;
  onCopyCode(): void;
  onInviteLink(): void;
  /** mode = MODE_* de sim.ts; modeParam = parámetro contextual (SUMO: 0). */
  onStartMatch(level: LevelChoice, winTarget: number, mode: number, modeParam: number, botDifficulty: number): void;
  onResume(): void;
  onQuitToTitle(): void;
  onSettingsChanged(s: Settings): void;
  /** Botón EDITOR de la pantalla title (la UiShell ya navegó a 'none'). */
  onEditor(): void;
  /** Botón ✎ de una card de MIS MAPAS (la UiShell ya navegó a 'none'). */
  onEditMap(id: string): void;
}

const SETTINGS_KEY = 'tumbo.settings.v1';

const DEFAULT_SETTINGS: Settings = {
  volMaster: 0.8,
  volMusic: 0.6,
  shadows: true,
  particles: 1,
  reducedMotion: false,
};

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
  /** Último parámetro elegido por modo (arranca en el default de cada uno). */
  private modeParamSel: Record<number, number> = {
    [MODE_KOTH]: MODE_PARAM_CFG[MODE_KOTH].def,
    [MODE_COSECHA]: MODE_PARAM_CFG[MODE_COSECHA].def,
    [MODE_MALDITO]: MODE_PARAM_CFG[MODE_MALDITO].def,
  };
  private botDiff = 1;
  private lastStart: { level: LevelChoice; winTarget: number; mode: number; modeParam: number; botDifficulty: number } = {
    level: 'random',
    winTarget: 5,
    mode: MODE_SUMO,
    modeParam: 0,
    botDifficulty: 1,
  };

  private hostTab = true;
  private offerCode = '';
  private nextTimer = 0;

  constructor(callbacks: UiCallbacks) {
    this.cb = callbacks;
    this.settingsData = this.loadSettings();

    for (const el of document.querySelectorAll<HTMLElement>('.screen')) {
      this.screens.set(el.dataset.screen ?? '', el);
    }

    this.wireTitle();
    this.wireSetup();
    this.wireOnline();
    this.wirePause();
    this.wireResults();
    this.wireOptions();
    this.applySettingsToControls();
    this.applyBodyClasses();

    this.show('title');

    // Link de invitación: solo preparamos el aspecto (pestaña UNIRSE + código
    // pegado). Conectar y mostrar 'online' lo maneja main.ts con su propio
    // parseo del hash — acá NO se dispara ningún callback.
    const m = /^#join=(.+)$/.exec(location.hash);
    if (m) {
      this.selectTab(false, false);
      try {
        (document.getElementById('code-in') as HTMLTextAreaElement).value = decodeURIComponent(m[1]);
      } catch {
        // hash malformado: main.ts mostrará el error al intentar conectar
      }
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
      const label = document.createElement('span');
      label.className = 'lname';
      label.textContent = names[i];
      card.append(img, label);
      card.addEventListener('click', () => this.selectLevel(i));
      grid.appendChild(card);
    }
    const rand = document.createElement('button');
    rand.className = 'level-card';
    rand.type = 'button';
    const q = document.createElement('span');
    q.className = 'random-thumb';
    q.textContent = '?';
    const label = document.createElement('span');
    label.className = 'lname';
    label.textContent = 'ALEATORIO';
    rand.append(q, label);
    rand.addEventListener('click', () => this.selectLevel('random'));
    grid.appendChild(rand);
    this.selectLevel(this.selLevel);
  }

  /** Puebla la sección MIS MAPAS del setup con los mapas custom guardados. */
  setCustomMaps(maps: SavedMap[]): void {
    this.customMaps = maps.slice();
    const grid = $('custom-grid');
    grid.textContent = '';
    if (maps.length === 0) {
      const p = document.createElement('p');
      p.className = 'custom-empty';
      p.textContent = 'creá tu primer mapa en el EDITOR';
      grid.appendChild(p);
    }
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

  setOnlineState(state: string, detail?: string): void {
    const code = $('wstep-code');
    const paste = $('wstep-paste');
    const conn = $('wstep-conn');
    const connStatus = $('conn-status');
    const errEl = $('online-error');
    errEl.textContent = '';

    const set = (el: HTMLElement, s: string): void => {
      el.dataset.state = s;
    };
    const firstStep = this.hostTab ? code : paste;
    const secondStep = this.hostTab ? paste : code;

    switch (state) {
      case 'idle':
        set(firstStep, 'active');
        set(secondStep, 'idle');
        set(conn, 'idle');
        connStatus.textContent = detail ?? 'esperando los pasos anteriores…';
        break;
      case 'creating':
      case 'generating':
        set(code, 'busy');
        connStatus.textContent = detail ?? 'generando código…';
        break;
      case 'offer-ready':
      case 'code-ready':
        set(code, 'done');
        set(paste, 'active');
        connStatus.textContent = detail ?? 'código listo — mandáselo al rival';
        break;
      case 'answer-ready':
        set(paste, 'done');
        set(code, 'done');
        set(conn, 'busy');
        connStatus.textContent = detail ?? 'mandale tu respuesta al anfitrión y esperá…';
        break;
      case 'connecting':
        set(code, 'done');
        set(paste, 'done');
        set(conn, 'busy');
        connStatus.textContent = detail ?? 'conectando…';
        break;
      case 'waiting':
        set(conn, 'busy');
        connStatus.textContent = detail ?? 'esperando al rival…';
        break;
      case 'connected':
        set(code, 'done');
        set(paste, 'done');
        set(conn, 'done');
        connStatus.textContent = detail ?? 'conectados — arranca la partida';
        break;
      case 'error': {
        for (const el of [code, paste, conn]) {
          if (el.dataset.state === 'busy' || el.dataset.state === 'active') set(el, 'error');
        }
        errEl.textContent = detail ?? 'algo salió mal, probá de nuevo';
        break;
      }
      default:
        connStatus.textContent = detail ?? state;
    }
  }

  setOfferCode(code: string): void {
    this.offerCode = code;
    (document.getElementById('code-out') as HTMLTextAreaElement).value = code;
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
    title.textContent = isFinal ? 'FIN DEL MATCH' : 'FIN DE RONDA';

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
    this.current = screen;
    for (const [name, el] of this.screens) {
      el.classList.toggle('active', name === screen);
    }
  }

  private wireTitle(): void {
    $('btn-solo').addEventListener('click', () => {
      $('setup-mode').textContent = 'SOLO — VOS CONTRA BOTS';
      $('bot-diff-row').style.display = '';
      this.cb.onSolo();
      this.showAny('setup');
    });
    $('btn-local').addEventListener('click', () => {
      $('bot-diff-row').style.display = 'none';
      $('setup-mode').textContent = 'LOCAL — 2 EN UN TECLADO';
      this.cb.onLocal();
      this.showAny('setup');
    });
    $('btn-online').addEventListener('click', () => {
      this.showAny('online');
      this.selectTab(true, true);
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
    for (const btn of $('seg-rounds').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        this.winTarget = Number(btn.dataset.rounds) || 5;
        for (const b of $('seg-rounds').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }
    for (const btn of $('seg-botdiff').querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        this.botDiff = Number(btn.dataset.diff) || 0;
        for (const b of $('seg-botdiff').querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }
    const modeCards = $('mode-grid').querySelectorAll<HTMLButtonElement>('.mode-card');
    for (const card of modeCards) {
      card.addEventListener('click', () => {
        this.selMode = Number(card.dataset.mode) || MODE_SUMO;
        for (const c of modeCards) c.classList.toggle('selected', c === card);
        this.renderModeParam();
      });
    }
    this.renderModeParam();
    $('btn-play').addEventListener('click', () => {
      const modeParam = this.currentModeParam();
      this.lastStart = {
        level: this.selLevel,
        winTarget: this.winTarget,
        mode: this.selMode,
        modeParam,
        botDifficulty: this.botDiff,
      };
      this.showAny('none');
      this.cb.onStartMatch(this.selLevel, this.winTarget, this.selMode, modeParam, this.botDiff);
    });
    $('btn-setup-back').addEventListener('click', () => this.showAny('title'));
  }

  /** Parámetro contextual del modo seleccionado (0 si el modo no tiene). */
  private currentModeParam(): number {
    const cfg = MODE_PARAM_CFG[this.selMode];
    return cfg ? (this.modeParamSel[this.selMode] ?? cfg.def) : 0;
  }

  /** Rehace el segmento del parámetro contextual según el modo elegido. */
  private renderModeParam(): void {
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
    if (typeof sel === 'number' && sel >= this.levelNames.length) sel = 'random';
    if (typeof sel === 'object') {
      const id = sel.custom;
      if (!this.customMaps.some((m) => m.id === id)) sel = 'random';
    }
    this.selLevel = sel;
    const chosen = sel; // const: TS puede narrowear dentro de los callbacks
    const cards = $('level-grid').querySelectorAll('.level-card');
    cards.forEach((card, i) => {
      const isRandom = i === cards.length - 1;
      const on = typeof chosen === 'object' ? false : isRandom ? chosen === 'random' : chosen === i;
      card.classList.toggle('selected', on);
    });
    const customCards = $('custom-grid').querySelectorAll('.custom-card');
    customCards.forEach((card, i) => {
      const on = typeof chosen === 'object' && this.customMaps[i]?.id === chosen.custom;
      card.classList.toggle('selected', on);
    });
  }

  private selectTab(host: boolean, fire: boolean): void {
    this.hostTab = host;
    $('tab-crear').classList.toggle('active', host);
    $('tab-unirse').classList.toggle('active', !host);

    // Reordenar pasos: CREAR = [mi código, pegar respuesta, conexión];
    // UNIRSE = [pegar código del anfitrión, mi respuesta, conexión].
    const wizard = $('wizard');
    const code = $('wstep-code');
    const paste = $('wstep-paste');
    const conn = $('wstep-conn');
    if (host) {
      wizard.append(code, paste, conn);
      $('wstep-code-title').textContent = 'Generá tu código';
      $('wstep-code-hint').textContent = 'Mandáselo al rival por donde quieras.';
      $('wstep-paste-title').textContent = 'Pegá la respuesta del rival';
    } else {
      wizard.append(paste, code, conn);
      $('wstep-paste-title').textContent = 'Pegá el código del anfitrión';
      $('wstep-code-title').textContent = 'Tu respuesta';
      $('wstep-code-hint').textContent = 'Copiala y mandásela al anfitrión.';
    }
    (document.getElementById('code-out') as HTMLTextAreaElement).value = '';
    (document.getElementById('code-in') as HTMLTextAreaElement).value = '';
    this.offerCode = '';
    this.setOnlineState('idle');
    if (fire) this.cb.onOnline(host);
  }

  private wireOnline(): void {
    $('tab-crear').addEventListener('click', () => this.selectTab(true, true));
    $('tab-unirse').addEventListener('click', () => this.selectTab(false, true));

    $('btn-connect').addEventListener('click', () => {
      const code = (document.getElementById('code-in') as HTMLTextAreaElement).value.trim();
      if (!code) {
        this.setOnlineState('error', 'Pegá un código primero.');
        return;
      }
      this.cb.onConnectClicked(code);
    });

    $('btn-copy-code').addEventListener('click', () => {
      if (!this.offerCode) {
        this.toast('Todavía no hay código para copiar');
        return;
      }
      void navigator.clipboard.writeText(this.offerCode);
      this.toast('Código copiado');
      this.cb.onCopyCode();
    });

    $('btn-copy-link').addEventListener('click', () => {
      if (!this.offerCode) {
        this.toast('Todavía no hay código para copiar');
        return;
      }
      const link = `${location.origin}${location.pathname}#join=${encodeURIComponent(this.offerCode)}`;
      void navigator.clipboard.writeText(link);
      this.toast('Link de invitación copiado');
      this.cb.onInviteLink();
    });

    $('btn-online-back').addEventListener('click', () => {
      this.showAny('title');
      this.cb.onQuitToTitle();
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
      this.showAny('title');
      this.cb.onQuitToTitle();
    });
  }

  private wireResults(): void {
    $('btn-rematch').addEventListener('click', () => {
      this.showAny('none');
      const s = this.lastStart;
      this.cb.onStartMatch(s.level, s.winTarget, s.mode, s.modeParam, s.botDifficulty);
    });
    $('btn-results-menu').addEventListener('click', () => {
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
