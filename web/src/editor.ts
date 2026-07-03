/**
 * MapEditor — editor de mapas custom de TUMBO. Solo presentación y storage:
 * el mapa son los bytes del códec (mapcodec.ts); acá nunca se ejecuta nada
 * que venga de un código importado, solo se decodifican bytes.
 *
 * Integración (contrato con main.ts):
 *   - listMaps() / getMapBytes(id) / deleteMap(id) leen y escriben
 *     localStorage 'tumbo.maps.v1' (JSON array de SavedMap).
 *   - new MapEditor(cb) toma la <section class="screen" data-screen="editor">
 *     de index.html. La visibilidad la maneja el propio MapEditor con la
 *     clase 'active' (open()/close()); NO pasa por UiShell.show(), aunque como
 *     comparte la clase .screen, un show() de la UiShell también la oculta.
 *   - open(id) carga un mapa guardado; open() sin id arranca un mapa nuevo,
 *     SALVO que se venga de PROBAR (onPlayTest): en ese caso restaura el
 *     borrador tal cual estaba, para no perder trabajo al volver del test.
 *   - PROBAR   -> cb.onPlayTest(encodeMap(mapa), theme)  (main.ts cierra y
 *     arranca la ronda de prueba).
 *   - GUARDAR  -> persiste + thumb 120px dataURL + cb.onMapsChanged().
 *   - VOLVER   -> cb.onExit() (con confirm si hay cambios sin guardar).
 */

import {
  type CustomMap,
  type MapTile,
  GRID_EXTENT,
  MAX_TILES,
  MAX_SPAWNS,
  encodeMap,
  decodeMap,
  validateMap,
  mapToBase64,
  mapFromBase64,
} from './mapcodec';
import { LEVEL_NAMES } from './sim';
import { THEMES } from './render';

export interface SavedMap {
  id: string;
  name: string;
  theme: number;
  /** Miniatura ~120px como dataURL. */
  thumb: string;
  /** base64 de encodeMap — los bytes SON el mapa. */
  code: string;
}

const MAPS_KEY = 'tumbo.maps.v1';
const CELLS = GRID_EXTENT * 2 + 1; // 15
/** Separación entre baldosas en el mundo (PIECE_STEP del sim), solo para el preview de la barra. */
const TILE_STEP = 1.5;

type Tool = 'floor' | 'mid' | 'high' | 'erase' | 'spawn';
const TOOL_HEIGHT: Record<string, number> = { floor: 0, mid: 1, high: 2 };

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function loadAll(): SavedMap[] {
  try {
    const raw = localStorage.getItem(MAPS_KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (m): m is SavedMap =>
        !!m &&
        typeof (m as SavedMap).id === 'string' &&
        typeof (m as SavedMap).name === 'string' &&
        typeof (m as SavedMap).theme === 'number' &&
        typeof (m as SavedMap).thumb === 'string' &&
        typeof (m as SavedMap).code === 'string',
    );
  } catch {
    return [];
  }
}

function saveAll(maps: SavedMap[]): void {
  try {
    localStorage.setItem(MAPS_KEY, JSON.stringify(maps));
  } catch {
    // sin storage (incógnito estricto): el guardado no persiste
  }
}

function newId(): string {
  return `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Mapas guardados, en orden de creación. */
export function listMaps(): SavedMap[] {
  return loadAll();
}

/** Bytes del códec de un mapa guardado (validados), o null si no está/está roto. */
export function getMapBytes(id: string): Uint8Array | null {
  const entry = loadAll().find((m) => m.id === id);
  if (!entry) return null;
  try {
    const raw = atob(entry.code.trim());
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return decodeMap(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/** Borra un mapa guardado (la usa la UiShell desde las cards de MIS MAPAS). */
export function deleteMap(id: string): void {
  saveAll(loadAll().filter((m) => m.id !== id));
}

// ---------------------------------------------------------------------------
// Helpers de color / DOM
// ---------------------------------------------------------------------------

function hexColor(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`;
}

function rgba(n: number, a: number): string {
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Aclara un color hacia blanco según la altura (0, 1, 2). */
function shade(n: number, height: number): string {
  const f = height * 0.22;
  const ch = (c: number): number => Math.round(c + (255 - c) * f);
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`MapEditor: falta #${id} en index.html`);
  return el;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// MapEditor
// ---------------------------------------------------------------------------

export interface MapEditorCallbacks {
  onPlayTest(bytes: Uint8Array, theme: number): void;
  onExit(): void;
  onMapsChanged(): void;
}

export class MapEditor {
  private cb: MapEditorCallbacks;

  private screen: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private nameIn: HTMLInputElement;
  private themeSel: HTMLSelectElement;
  private swatchEl: HTMLElement;
  private cstartIn: HTMLInputElement;
  private cstartVal: HTMLElement;
  private cspeedIn: HTMLInputElement;
  private cspeedVal: HTMLElement;
  private beamChk: HTMLInputElement;
  private beamLenIn: HTMLInputElement;
  private beamVal: HTMLElement;
  private countEl: HTMLElement;
  private errEl: HTMLElement;
  private btnTest: HTMLButtonElement;
  private btnSave: HTMLButtonElement;

  // Estado del mapa en edición
  private tiles = new Map<string, number>(); // "gx,gz" -> altura 0..2
  private spawns: { gx: number; gz: number }[] = [];
  private theme = 0;
  private crumbleStartSec = 15;
  private crumbleInterval = 30;
  private beamOn = false;
  private beamLen = 6; // brazo desde el centro, en metros
  private currentId: string | null = null;
  private dirty = false;
  /** true mientras el borrador está "suspendido" por un PROBAR. */
  private suspended = false;

  // Estado de interacción
  private tool: Tool = 'floor';
  private painting = false;
  private paintErase = false; // click derecho = borrar rápido
  private lastKey = '';
  private hover: { gx: number; gz: number } | null = null;
  private hoverKey = '';

  constructor(cb: MapEditorCallbacks) {
    this.cb = cb;

    const screen = document.querySelector<HTMLElement>('.screen[data-screen="editor"]');
    if (!screen) throw new Error('MapEditor: falta la pantalla data-screen="editor" en index.html');
    this.screen = screen;

    this.canvas = $('ed-canvas') as HTMLCanvasElement;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('MapEditor: sin contexto 2D');
    this.ctx = ctx;

    this.nameIn = $('ed-name') as HTMLInputElement;
    this.themeSel = $('ed-theme') as HTMLSelectElement;
    this.swatchEl = $('ed-swatch');
    this.cstartIn = $('ed-cstart') as HTMLInputElement;
    this.cstartVal = $('ed-cstart-val');
    this.cspeedIn = $('ed-cspeed') as HTMLInputElement;
    this.cspeedVal = $('ed-cspeed-val');
    this.beamChk = $('ed-beam') as HTMLInputElement;
    this.beamLenIn = $('ed-beam-len') as HTMLInputElement;
    this.beamVal = $('ed-beam-val');
    this.countEl = $('ed-count');
    this.errEl = $('ed-error');
    this.btnTest = $('ed-test') as HTMLButtonElement;
    this.btnSave = $('ed-save') as HTMLButtonElement;

    // Select de temas: mismos nombres que los niveles built-in.
    for (let i = 0; i < THEMES.length; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = LEVEL_NAMES[i] ?? `TEMA ${i + 1}`;
      this.themeSel.appendChild(opt);
    }

    this.wireTools();
    this.wireCanvas();
    this.wirePanel();
    this.wireActions();
    this.syncControls();
    this.refresh();
  }

  // -------------------------------------------------------------------
  // API pública
  // -------------------------------------------------------------------

  /** Muestra la pantalla. Con id carga un mapa guardado; sin id, mapa nuevo
   *  (salvo que se vuelva de un PROBAR: ahí se restaura el borrador). */
  open(id?: string): void {
    if (id) {
      this.suspended = false;
      const entry = loadAll().find((m) => m.id === id);
      const dec = entry ? mapFromBase64(entry.code) : null;
      this.resetState();
      if (entry && dec) {
        this.loadDecoded(dec);
        this.nameIn.value = entry.name;
        this.currentId = id;
      } else {
        this.toast('No se pudo cargar el mapa');
      }
      this.dirty = false;
    } else if (this.suspended) {
      // Volvemos de una ronda de prueba: conservamos el borrador tal cual.
      this.suspended = false;
    } else {
      this.resetState();
      this.dirty = false;
    }
    this.syncControls();
    this.refresh();
    this.screen.classList.add('active');
  }

  /** Oculta la pantalla (no toca el estado en edición). */
  close(): void {
    this.screen.classList.remove('active');
  }

  // -------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------

  private resetState(): void {
    this.tiles.clear();
    this.spawns = [];
    this.theme = 0;
    this.crumbleStartSec = 15;
    this.crumbleInterval = 30;
    this.beamOn = false;
    this.beamLen = 6;
    this.currentId = null;
    this.nameIn.value = '';
    this.hover = null;
    this.hoverKey = '';
  }

  private loadDecoded(dec: Omit<CustomMap, 'name'>): void {
    this.tiles.clear();
    for (const t of dec.tiles) {
      if (Math.abs(t.gx) > GRID_EXTENT || Math.abs(t.gz) > GRID_EXTENT) continue;
      this.tiles.set(`${t.gx},${t.gz}`, clamp(t.height, 0, 2));
    }
    this.spawns = dec.spawns
      .filter((s) => Math.abs(s.gx) <= GRID_EXTENT && Math.abs(s.gz) <= GRID_EXTENT)
      .slice(0, MAX_SPAWNS)
      .map((s) => ({ gx: s.gx, gz: s.gz }));
    this.theme = dec.theme & 7;
    this.crumbleStartSec = clamp(Math.round(dec.crumbleStartSec), 5, 40);
    this.crumbleInterval = clamp(Math.round(dec.crumbleInterval), 6, 60);
    this.beamOn = dec.beamHalfLength > 0;
    if (this.beamOn) this.beamLen = clamp(Math.round(dec.beamHalfLength * 2) / 2, 2, 12);
  }

  private buildMap(): CustomMap {
    const tiles: MapTile[] = [];
    for (const [key, height] of this.tiles) {
      const [gx, gz] = key.split(',').map(Number);
      tiles.push({ gx, gz, height });
    }
    // Orden canónico: el mismo dibujo produce siempre los mismos bytes.
    tiles.sort((a, b) => a.gz - b.gz || a.gx - b.gx);
    return {
      name: this.nameIn.value.trim() || 'SIN NOMBRE',
      theme: this.theme,
      crumbleStartSec: this.crumbleStartSec,
      crumbleInterval: this.crumbleInterval,
      beamHalfLength: this.beamOn ? this.beamLen : 0,
      tiles,
      spawns: this.spawns.slice(),
    };
  }

  // -------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------

  private wireTools(): void {
    const buttons = $('ed-tools').querySelectorAll('button');
    for (const b of buttons) {
      b.addEventListener('click', () => {
        this.tool = (b.dataset.tool as Tool) ?? 'floor';
        for (const other of buttons) other.classList.toggle('active', other === b);
      });
    }
  }

  private wireCanvas(): void {
    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      this.painting = true;
      this.paintErase = e.button === 2;
      const cell = this.cellAt(e);
      this.lastKey = cell ? `${cell.gx},${cell.gz}` : '';
      if (cell) this.applyAt(cell, true);
    });
    c.addEventListener('pointermove', (e) => {
      const cell = this.cellAt(e);
      if (!this.painting) {
        const key = cell ? `${cell.gx},${cell.gz}` : '';
        if (key !== this.hoverKey) {
          this.hover = cell;
          this.hoverKey = key;
          this.draw();
        }
        return;
      }
      if (!cell) return;
      const key = `${cell.gx},${cell.gz}`;
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.applyAt(cell, false);
    });
    const end = (): void => {
      this.painting = false;
      this.paintErase = false;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      if (!this.painting && this.hover) {
        this.hover = null;
        this.hoverKey = '';
        this.draw();
      }
    });
  }

  private wirePanel(): void {
    this.nameIn.addEventListener('input', () => {
      this.dirty = true;
    });
    this.themeSel.addEventListener('change', () => {
      this.theme = Number(this.themeSel.value) & 7;
      this.dirty = true;
      this.updateSwatch();
      this.draw();
    });
    this.cstartIn.addEventListener('input', () => {
      this.crumbleStartSec = Number(this.cstartIn.value);
      this.cstartVal.textContent = `${this.crumbleStartSec} s`;
      this.dirty = true;
    });
    this.cspeedIn.addEventListener('input', () => {
      // Slider 0..100 -> crumbleInterval 60 (lento) .. 6 (rápido) ticks.
      this.crumbleInterval = 60 - Math.round(Number(this.cspeedIn.value) * 0.54);
      this.cspeedVal.textContent = this.speedLabel();
      this.dirty = true;
    });
    this.beamChk.addEventListener('change', () => {
      this.beamOn = this.beamChk.checked;
      this.beamLenIn.disabled = !this.beamOn;
      this.dirty = true;
      this.draw();
    });
    this.beamLenIn.addEventListener('input', () => {
      this.beamLen = Number(this.beamLenIn.value);
      this.beamVal.textContent = `${this.beamLen} m`;
      this.dirty = true;
      this.draw();
    });
  }

  private wireActions(): void {
    this.btnTest.addEventListener('click', () => {
      const map = this.buildMap();
      if (validateMap(map) !== null) return;
      this.suspended = true; // open() sin id restaura este borrador
      this.cb.onPlayTest(encodeMap(map), map.theme);
    });

    this.btnSave.addEventListener('click', () => this.save());

    $('ed-export').addEventListener('click', () => {
      if (this.tiles.size === 0) {
        this.toast('Dibujá al menos una baldosa antes de exportar');
        return;
      }
      const code = mapToBase64(this.buildMap());
      const fallback = (): void => {
        window.prompt('Copiá el código del mapa:', code);
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code).then(
          () => this.toast('Código copiado al portapapeles'),
          fallback,
        );
      } else {
        fallback();
      }
    });

    $('ed-import').addEventListener('click', () => {
      const code = window.prompt('Pegá el código del mapa:');
      if (!code || !code.trim()) return;
      const dec = mapFromBase64(code);
      if (!dec) {
        this.toast('Código inválido');
        return;
      }
      this.loadDecoded(dec);
      if (!this.nameIn.value.trim()) this.nameIn.value = 'IMPORTADO';
      this.dirty = true;
      this.syncControls();
      this.refresh();
      this.toast('Mapa importado');
    });

    $('ed-back').addEventListener('click', () => {
      if (this.dirty && !window.confirm('¿Salir sin guardar? Se pierden los cambios.')) return;
      this.suspended = false;
      this.cb.onExit();
    });
  }

  // -------------------------------------------------------------------
  // Edición
  // -------------------------------------------------------------------

  private cellAt(e: PointerEvent): { gx: number; gz: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fz = (e.clientY - rect.top) / rect.height;
    if (fx < 0 || fx >= 1 || fz < 0 || fz >= 1) return null;
    return { gx: Math.floor(fx * CELLS) - GRID_EXTENT, gz: Math.floor(fz * CELLS) - GRID_EXTENT };
  }

  private applyAt(cell: { gx: number; gz: number }, isDown: boolean): void {
    const key = `${cell.gx},${cell.gz}`;
    this.hover = cell;
    this.hoverKey = key;

    if (this.paintErase || this.tool === 'erase') {
      const hadTile = this.tiles.delete(key);
      const before = this.spawns.length;
      this.spawns = this.spawns.filter((s) => s.gx !== cell.gx || s.gz !== cell.gz);
      if (hadTile || this.spawns.length !== before) this.dirty = true;
    } else if (this.tool === 'spawn') {
      if (!isDown) {
        this.draw();
        return; // los spawns se ponen de a un click, no arrastrando
      }
      const at = this.spawns.findIndex((s) => s.gx === cell.gx && s.gz === cell.gz);
      if (at >= 0) {
        this.spawns.splice(at, 1);
        this.dirty = true;
      } else if (!this.tiles.has(key)) {
        this.toast('El spawn necesita una baldosa debajo');
      } else if (this.spawns.length >= MAX_SPAWNS) {
        this.toast(`Máximo ${MAX_SPAWNS} puntos de aparición`);
      } else {
        this.spawns.push({ gx: cell.gx, gz: cell.gz });
        this.dirty = true;
      }
    } else {
      const h = TOOL_HEIGHT[this.tool] ?? 0;
      if (this.tiles.get(key) !== h) {
        this.tiles.set(key, h);
        this.dirty = true;
      }
    }
    this.refresh();
  }

  // -------------------------------------------------------------------
  // Refresh / validación / guardado
  // -------------------------------------------------------------------

  private speedLabel(): string {
    const v = Number(this.cspeedIn.value);
    return v < 34 ? 'lento' : v < 67 ? 'medio' : 'rápido';
  }

  private updateSwatch(): void {
    const t = THEMES[this.theme] ?? THEMES[0];
    const chips = this.swatchEl.querySelectorAll('i');
    if (chips[0]) (chips[0] as HTMLElement).style.background = hexColor(t.tileA);
    if (chips[1]) (chips[1] as HTMLElement).style.background = hexColor(t.tileB);
  }

  /** Vuelca el estado a los controles del panel (al abrir/importar). */
  private syncControls(): void {
    this.themeSel.value = String(this.theme);
    this.updateSwatch();
    this.cstartIn.value = String(this.crumbleStartSec);
    this.cstartVal.textContent = `${this.crumbleStartSec} s`;
    this.cspeedIn.value = String(clamp(Math.round((60 - this.crumbleInterval) / 0.54), 0, 100));
    this.cspeedVal.textContent = this.speedLabel();
    this.beamChk.checked = this.beamOn;
    this.beamLenIn.value = String(this.beamLen);
    this.beamLenIn.disabled = !this.beamOn;
    this.beamVal.textContent = `${this.beamLen} m`;
  }

  private refresh(): void {
    this.countEl.textContent = `${this.tiles.size}/${MAX_TILES} baldosas · ${this.spawns.length}/${MAX_SPAWNS} spawns`;
    const err = validateMap(this.buildMap());
    this.errEl.textContent = err ?? '';
    this.btnTest.disabled = err !== null;
    this.btnSave.disabled = err !== null;
    this.draw();
  }

  private save(): void {
    const map = this.buildMap();
    if (validateMap(map) !== null) return;
    const maps = loadAll();
    const id = this.currentId ?? newId();
    const entry: SavedMap = {
      id,
      name: map.name,
      theme: map.theme,
      thumb: this.makeThumb(),
      code: mapToBase64(map),
    };
    const i = maps.findIndex((m) => m.id === id);
    if (i >= 0) maps[i] = entry;
    else maps.push(entry);
    saveAll(maps);
    this.currentId = id;
    this.dirty = false;
    this.toast('Mapa guardado');
    this.cb.onMapsChanged();
  }

  private makeThumb(): string {
    const c = document.createElement('canvas');
    c.width = c.height = 120;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    this.renderTo(ctx, 120, false);
    try {
      return c.toDataURL('image/png');
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------
  // Dibujo
  // -------------------------------------------------------------------

  private draw(): void {
    this.renderTo(this.ctx, this.canvas.width, true);
  }

  private renderTo(ctx: CanvasRenderingContext2D, size: number, interactive: boolean): void {
    const t = THEMES[this.theme] ?? THEMES[0];
    const cell = size / CELLS;
    const gap = Math.max(0.5, cell * 0.06);

    ctx.fillStyle = '#0a0d1c';
    ctx.fillRect(0, 0, size, size);

    for (let gz = -GRID_EXTENT; gz <= GRID_EXTENT; gz++) {
      for (let gx = -GRID_EXTENT; gx <= GRID_EXTENT; gx++) {
        const x = (gx + GRID_EXTENT) * cell;
        const y = (gz + GRID_EXTENT) * cell;
        const h = this.tiles.get(`${gx},${gz}`);
        if (h === undefined) {
          ctx.fillStyle = '#10142a';
          ctx.fillRect(x + gap, y + gap, cell - gap * 2, cell - gap * 2);
        } else {
          const base = ((gx + gz) & 1) === 0 ? t.tileA : t.tileB;
          ctx.fillStyle = shade(base, h);
          ctx.fillRect(x + gap * 0.5, y + gap * 0.5, cell - gap, cell - gap);
        }
      }
    }

    // Preview de la barra giratoria (arranca alineada al eje X, como en el sim).
    if (this.beamOn) {
      const c = size / 2;
      const half = (this.beamLen / TILE_STEP) * cell;
      const w = Math.max(2, cell * 0.42);
      ctx.fillStyle = rgba(t.beam, 0.45);
      ctx.fillRect(c - half, c - w / 2, half * 2, w);
      ctx.beginPath();
      ctx.arc(c, c, w * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    // Spawns: círculos numerados.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.spawns.length; i++) {
      const s = this.spawns[i];
      const cx = (s.gx + GRID_EXTENT + 0.5) * cell;
      const cy = (s.gz + GRID_EXTENT + 0.5) * cell;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = '#e8eaf6';
      ctx.fill();
      ctx.lineWidth = Math.max(1, cell * 0.06);
      ctx.strokeStyle = '#0b0e1a';
      ctx.stroke();
      if (cell >= 14) {
        ctx.fillStyle = '#141931';
        ctx.font = `800 ${Math.round(cell * 0.38)}px system-ui, sans-serif`;
        ctx.fillText(String(i + 1), cx, cy + cell * 0.02);
      }
    }

    if (interactive && this.hover) {
      const x = (this.hover.gx + GRID_EXTENT) * cell;
      const y = (this.hover.gz + GRID_EXTENT) * cell;
      ctx.lineWidth = Math.max(1.5, cell * 0.07);
      ctx.strokeStyle = '#35a7ff';
      ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
    }
  }

  // -------------------------------------------------------------------
  // Toast propio (usa la zona #toasts del DOM, sin depender de UiShell)
  // -------------------------------------------------------------------

  private toast(text: string): void {
    const zone = document.getElementById('toasts');
    if (!zone) {
      window.alert(text);
      return;
    }
    while (zone.children.length >= 4) zone.removeChild(zone.firstChild!);
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    zone.appendChild(t);
    window.setTimeout(() => t.classList.add('out'), 2200);
    window.setTimeout(() => t.remove(), 2600);
  }
}
