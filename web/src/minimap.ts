// Thumbnails de niveles para la pantalla de setup: vista cenital 120×120 de
// cada arena, dibujada leyendo el buffer de estado real del sim recién
// inicializado (misma fuente de verdad que el render 3D, cero duplicación de
// geometría de niveles en JS).
//
// ADVERTENCIA PARA EL CALLER: renderLevelThumbs() llama a sim.init() una vez
// por nivel y deja el sim en el estado del ÚLTIMO nivel. Hay que volver a
// llamar a sim.init(...) con la partida real después de usar esta función
// (típico: generar los thumbs una sola vez en el arranque, antes de la init
// del juego).

import { Sim, PIECE_GONE } from './sim';
import { THEMES } from './render';

const SIZE = 120;
const PAD = 8;
/** Footprint en mundo de una baldosa (PIECE_SIZE de render.ts). */
const TILE_WORLD = 1.48;

interface ThumbTheme {
  bg: number;
  tileA: number;
  tileB: number;
  beam: number;
}

function css(n: number): string {
  return `#${(n >>> 0).toString(16).padStart(6, '0')}`;
}

/** Mezcla un color 0xRRGGBB hacia blanco (t en 0..1) y devuelve css. */
function lighten(n: number, t: number): string {
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  const mix = (c: number): number => Math.round(c + (255 - c) * t);
  return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
}

function roundedRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * Dibuja un thumbnail cenital del estado actual del sim (post-init, tick 0).
 * Exportada por si alguna vez se quiere un minimapa en vivo.
 */
export function drawLevelThumb(sim: Sim, level: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d')!;
  const theme = THEMES[level % THEMES.length] as ThumbTheme;
  const st = sim.curr;

  g.fillStyle = css(theme.bg);
  g.fillRect(0, 0, SIZE, SIZE);

  // Piezas vivas del buffer: x/z para posición, y para "elevación" (los
  // niveles con tarimas/pirámide tienen baldosas más altas → más claras).
  interface P {
    x: number;
    y: number;
    z: number;
    idx: number;
  }
  const pieces: P[] = [];
  for (let i = 0; i < sim.pieceCount; i++) {
    const base = sim.pieceBase(i);
    if (st[base + 7] === PIECE_GONE) continue;
    pieces.push({ x: st[base], y: st[base + 1], z: st[base + 2], idx: i });
  }

  // Encuadre: bounding box de baldosas + hazards, encajado con padding.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  let minY = Infinity;
  const half = TILE_WORLD / 2;
  for (const p of pieces) {
    minX = Math.min(minX, p.x - half);
    maxX = Math.max(maxX, p.x + half);
    minZ = Math.min(minZ, p.z - half);
    maxZ = Math.max(maxZ, p.z + half);
    minY = Math.min(minY, p.y);
  }
  for (let i = 0; i < sim.hazardCount; i++) {
    const base = sim.hazardBase(i);
    const reach = Math.max(st[base + 7], st[base + 9]);
    minX = Math.min(minX, st[base] - reach);
    maxX = Math.max(maxX, st[base] + reach);
    minZ = Math.min(minZ, st[base + 2] - reach);
    maxZ = Math.max(maxZ, st[base + 2] + reach);
  }
  if (!isFinite(minX)) return canvas.toDataURL();
  const span = Math.max(maxX - minX, maxZ - minZ, 0.001);
  const scale = (SIZE - PAD * 2) / span;
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const toX = (x: number): number => SIZE / 2 + (x - cx) * scale;
  const toY = (z: number): number => SIZE / 2 + (z - cz) * scale;

  // Bajas primero, altas encima (pirámides se leen bien).
  pieces.sort((a, b) => a.y - b.y);
  const tile = TILE_WORLD * scale * 0.92;
  for (const p of pieces) {
    const base = p.idx % 2 === 0 ? theme.tileA : theme.tileB;
    const elev = Math.min(0.55, Math.max(0, (p.y - minY) * 0.3));
    g.fillStyle = elev > 0.01 ? lighten(base, elev) : css(base);
    roundedRect(g, toX(p.x) - tile / 2, toY(p.z) - tile / 2, tile, tile, 2.5);
    g.fill();
  }

  // Hazards como barras color beam, rotadas por el yaw del quaternion
  // (rotación pura alrededor de Y en el estado inicial: yaw = 2·atan2(qy, qw)).
  for (let i = 0; i < sim.hazardCount; i++) {
    const base = sim.hazardBase(i);
    const x = st[base];
    const z = st[base + 2];
    const qy = st[base + 4];
    const qw = st[base + 6];
    const sx = st[base + 7];
    const sz = st[base + 9];
    const yaw = 2 * Math.atan2(qy, qw);
    g.save();
    g.translate(toX(x), toY(z));
    g.rotate(-yaw);
    g.globalAlpha = 0.9;
    g.fillStyle = css(theme.beam);
    const w = Math.max(3, sx * 2 * scale);
    const h = Math.max(3, sz * 2 * scale);
    roundedRect(g, -w / 2, -h / 2, w, h, 2);
    g.fill();
    g.restore();
  }

  return canvas.toDataURL();
}

/**
 * Genera un dataURL de thumbnail por nivel (0..sim.levelCount-1), haciendo
 * sim.init(1, 2, level) para cada uno. IMPORTANTE: pisa el estado del sim —
 * el caller DEBE re-init el sim con su partida real después de llamar esto.
 */
export function renderLevelThumbs(sim: Sim): string[] {
  const urls: string[] = [];
  for (let level = 0; level < sim.levelCount; level++) {
    sim.init(1, 2, level);
    urls.push(drawLevelThumb(sim, level));
  }
  return urls;
}
