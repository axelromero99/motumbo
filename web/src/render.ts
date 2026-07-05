// Three.js presentation layer. Reads interpolated snapshots of the sim state
// buffer and never writes anything back — rendering must not affect the sim.
import * as THREE from 'three';
import {
  Sim,
  PIECE_GONE,
  PIECE_STATIC,
  PIECE_WARNING,
  FLAG_ALIVE,
  FLAG_DASH_READY,
  FLAG_HAS_POWER,
  FLAG_BRACED,
  FLAG_CURSED,
  MODE_KOTH,
  MODE_MALDITO,
  DASH_COOLDOWN_TICKS,
  dashCooldownFrom,
  ballRadiusFrom,
  ORB_INFO,
  MAX_ORBS,
  hasShield,
  pieceStateOf,
  pieceSpecialOf,
  SPECIAL_BOOST,
  SPECIAL_BOUNCY,
} from './sim';
import { FxSystem } from './fx';
import { makeSkinMaterial, SKIN_COUNT } from './skins';
import { loadTune, saveTune, tuneVal } from './tune';

export const PLAYER_COLORS = [0xff5964, 0x35a7ff, 0xffe74c, 0x6bf178, 0xb388ff, 0xff9f1c, 0x2ec4b6, 0xf72585];
const PIECE_SIZE = { x: 1.48, y: 0.8, z: 1.48 };
const PLAYER_RADIUS = 0.6;
// Rey de la colina: mirror of ZONE_RADIUS in motumbo.c (presentation only).
const ZONE_RADIUS = 2.3;
const ZONE_COLOR = 0xffbe3d;
const CURSE_COLOR = 0xff2020;
const CURSE_DRIP_COLOR = 0x6b0a14;
// Below this many curse ticks left the red pulse starts accelerating.
const CURSE_PANIC_TICKS = 300;
const TRAIL_MIN_SPEED = 7.5;
const STRETCH_MIN_SPEED = 6;
const LANDING_VY = -3;
const DUST_COLOR = 0x9aa4c0;
// Squash spring: critically damped, ~w rad/s. An impulse of amount*w*e dips the
// scale by ≈amount before recovering.
const SPRING_W = 18;
const UP = new THREE.Vector3(0, 1, 0);

export interface Theme {
  bg: number;
  tileA: number;
  tileB: number;
  warn: number;
  beam: number;
  ground: number;
  sky: number;
  skyTop: number;
  skyBottom: number;
}

// One visual identity per level, same order as LEVEL_NAMES (20 entries).
export const THEMES: Theme[] = [
  // CLÁSICA — noche azul
  { bg: 0x0b0e1a, tileA: 0x2e3a6e, tileB: 0x3d4c8f, warn: 0xff4040, beam: 0xffffff, ground: 0x1a1f33, sky: 0x9fb4ff, skyTop: 0x04060e, skyBottom: 0x1c2750 },
  // ANILLO — brasas
  { bg: 0x160a06, tileA: 0x33201a, tileB: 0x4a2a1c, warn: 0xff7b00, beam: 0xffffff, ground: 0x33140a, sky: 0xffb38a, skyTop: 0x0c0402, skyBottom: 0x542012 },
  // PUENTES — hielo
  { bg: 0x0e1626, tileA: 0xd8e3f0, tileB: 0xaebfdc, warn: 0xff5964, beam: 0xffffff, ground: 0x25314d, sky: 0xcfe0ff, skyTop: 0x0a1220, skyBottom: 0x3d5f92 },
  // RULETA — synth violeta
  { bg: 0x150823, tileA: 0x3d2352, tileB: 0x582f78, warn: 0xff2e93, beam: 0x00e5ff, ground: 0x2a1440, sky: 0xe08aff, skyTop: 0x0d0419, skyBottom: 0x521f78 },
  // PIRÁMIDE — selva esmeralda
  { bg: 0x06140d, tileA: 0x1e5c40, tileB: 0x2b7a52, warn: 0xffd23f, beam: 0x8dffb0, ground: 0x0d2b1c, sky: 0xa8ffd0, skyTop: 0x03100a, skyBottom: 0x1d5c3f },
  // HERRADURA — desierto ocre/arena
  { bg: 0x2a190f, tileA: 0xc2924e, tileB: 0xa87938, warn: 0xe63946, beam: 0xffe0a3, ground: 0x4d3319, sky: 0xffd9a0, skyTop: 0x2b1a2e, skyBottom: 0xd98e4a },
  // PASARELA — acero industrial y óxido
  { bg: 0x101216, tileA: 0x4a525e, tileB: 0x363d47, warn: 0xff5714, beam: 0xffa040, ground: 0x15181d, sky: 0x8a99ad, skyTop: 0x0a0c10, skyBottom: 0x3d4654 },
  // TARIMAS — océano profundo
  { bg: 0x03151c, tileA: 0x0f5e6b, tileB: 0x14808f, warn: 0xff6b6b, beam: 0x4dfbe0, ground: 0x06222c, sky: 0x9ff0ff, skyTop: 0x020b10, skyBottom: 0x0e5261 },
  // CRUZ — carmesí sobre pizarra
  { bg: 0x14161d, tileA: 0x3d4352, tileB: 0x2c313d, warn: 0xff3352, beam: 0xe0294f, ground: 0x1b1e28, sky: 0xd88a95, skyTop: 0x0b0c12, skyBottom: 0x5c1a2a },
  // ASPAS — cian galaxia
  { bg: 0x060a18, tileA: 0x1b2a55, tileB: 0x24407a, warn: 0xff4f9a, beam: 0x35f5ff, ground: 0x0a1130, sky: 0x9fefff, skyTop: 0x03040f, skyBottom: 0x123c66 },
  // GEMELAS — violeta dual
  { bg: 0x120a20, tileA: 0x5b2d91, tileB: 0x8447d1, warn: 0xff3d81, beam: 0xc77bff, ground: 0x241040, sky: 0xd9b3ff, skyTop: 0x0a0516, skyBottom: 0x4a2380 },
  // PANAL — miel y ámbar
  { bg: 0x1f1204, tileA: 0xd9971e, tileB: 0xb4770f, warn: 0xe63946, beam: 0xffd447, ground: 0x3d2405, sky: 0xffe0a3, skyTop: 0x170d02, skyBottom: 0x8a5a10 },
  // DIANA — rojo/blanco arcade
  { bg: 0x1a0d10, tileA: 0xe8e6e0, tileB: 0xd42b35, warn: 0xffd23f, beam: 0xff4d5e, ground: 0x33141a, sky: 0xffc9cf, skyTop: 0x120608, skyBottom: 0x66202c },
  // VOLCÁN — basalto negro y lava incandescente
  { bg: 0x0a0503, tileA: 0x1e1714, tileB: 0x2e211a, warn: 0xffb300, beam: 0xff4400, ground: 0x140a06, sky: 0xff9a5c, skyTop: 0x060202, skyBottom: 0x611607 },
  // ZIGURAT — dorado azteca
  { bg: 0x181004, tileA: 0xcfa93f, tileB: 0xa17d24, warn: 0xe8402a, beam: 0xffd873, ground: 0x2f2008, sky: 0xffe6a8, skyTop: 0x120b02, skyBottom: 0x7a5514 },
  // TORRES — piedra gótica y azul luna
  { bg: 0x0c1018, tileA: 0x555e6e, tileB: 0x3d4553, warn: 0xff5964, beam: 0x9fc4ff, ground: 0x131822, sky: 0xaec6f2, skyTop: 0x060a12, skyBottom: 0x2c3f61 },
  // RULETA DOBLE — synthwave intenso
  { bg: 0x0d0418, tileA: 0x3a1257, tileB: 0x5c1a80, warn: 0xff2e93, beam: 0x00f0ff, ground: 0x1e0a33, sky: 0xff8ae2, skyTop: 0x08020f, skyBottom: 0x77127f },
  // FÁBRICA — amarillo industrial sobre negro
  { bg: 0x111110, tileA: 0xe0b422, tileB: 0x23241f, warn: 0xff3b1f, beam: 0xffcf33, ground: 0x191913, sky: 0xd9cf9a, skyTop: 0x0a0a08, skyBottom: 0x4d4416 },
  // MARTILLO — cobre y óxido
  { bg: 0x150c08, tileA: 0xa9663a, tileB: 0x7d4526, warn: 0xff3030, beam: 0xffb36b, ground: 0x2a1710, sky: 0xffc9a1, skyTop: 0x0e0704, skyBottom: 0x5c3018 },
  // CALLES — asfalto y neón verde
  { bg: 0x0a0d0b, tileA: 0x2e3236, tileB: 0x24272b, warn: 0xffb300, beam: 0x39ff6e, ground: 0x101312, sky: 0xa8ffc2, skyTop: 0x05080a, skyBottom: 0x14522e },
];

/**
 * Equirectangular ball texture: base color + a per-player pattern + the player
 * number painted large on two opposite sides, so players are identifiable
 * without relying on color alone (colorblind-friendly).
 */
export function makeBallTexture(colorHex: number, patternId: number, playerNumber: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const base = new THREE.Color(colorHex);
  const dark = base.clone().multiplyScalar(0.62);
  const darker = base.clone().multiplyScalar(0.26);
  const darkCss = `#${dark.getHexString()}`;
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = darkCss;

  switch (((patternId % 8) + 8) % 8) {
    case 0: // rayas verticales
      for (let i = 0; i < 8; i += 2) g.fillRect(32 * i, 0, 32, 128);
      break;
    case 1: // lunares
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 6; col++) {
          g.beginPath();
          g.arc(col * 44 + (row % 2) * 22, row * 34 + 16, 11, 0, Math.PI * 2);
          g.fill();
        }
      }
      break;
    case 2: // bandas horizontales
      for (let y = 0; y < 128; y += 42) g.fillRect(0, y, 256, 20);
      break;
    case 3: // damero
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 8; x++) {
          if ((x + y) % 2 === 0) g.fillRect(x * 32, y * 32, 32, 32);
        }
      }
      break;
    case 4: // rayas diagonales
      g.lineWidth = 16;
      g.strokeStyle = darkCss;
      for (let x = -96; x < 256; x += 48) {
        g.beginPath();
        g.moveTo(x, -8);
        g.lineTo(x + 80, 136);
        g.stroke();
      }
      break;
    case 5: // onda / espiral
      g.lineWidth = 14;
      g.strokeStyle = darkCss;
      g.beginPath();
      for (let x = 0; x <= 256; x += 4) {
        const y = 64 + Math.sin((x / 256) * Math.PI * 4) * 34;
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      break;
    case 6: // aros concéntricos
      g.lineWidth = 9;
      g.strokeStyle = darkCss;
      for (const cx of [64, 192] as const) {
        for (const r of [36, 54] as const) {
          g.beginPath();
          g.arc(cx, 64, r, 0, Math.PI * 2);
          g.stroke();
        }
      }
      break;
    case 7: // triángulos
      for (let x = 0; x < 256; x += 52) {
        g.beginPath();
        g.moveTo(x, 96);
        g.lineTo(x + 22, 32);
        g.lineTo(x + 44, 96);
        g.closePath();
        g.fill();
      }
      break;
  }

  // Player number twice (opposite hemispheres) so it's almost always visible.
  g.font = '900 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const label = String(playerNumber);
  for (const cx of [64, 192] as const) {
    g.lineWidth = 10;
    g.strokeStyle = `#${darker.getHexString()}`;
    g.strokeText(label, cx, 66);
    g.fillStyle = '#ffffff';
    g.fillText(label, cx, 66);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Grayscale height map for the bump channel: fur strokes, rocky blobs, brushed
// metal lines or slime globs. Linear color space (it's data, not color).
function makeBumpTexture(kind: 'fur' | 'stone' | 'metal' | 'slime'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 256, 128);
  if (kind === 'fur') {
    for (let i = 0; i < 2800; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      const a = Math.random() * Math.PI * 2;
      const len = 3 + Math.random() * 4;
      g.strokeStyle = Math.random() < 0.5 ? '#c8c8c8' : '#4a4a4a';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      g.stroke();
    }
  } else if (kind === 'stone') {
    for (let i = 0; i < 1000; i++) {
      const v = (95 + Math.random() * 120) | 0;
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.beginPath();
      g.arc(Math.random() * 256, Math.random() * 128, 2 + Math.random() * 8, 0, 7);
      g.fill();
    }
  } else if (kind === 'metal') {
    for (let y = 0; y < 128; y++) {
      const v = 118 + ((Math.random() * 22) | 0);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(0, y, 256, 1);
    }
  } else {
    for (let i = 0; i < 44; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      const r = 8 + Math.random() * 22;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, '#d2d2d2');
      grd.addColorStop(1, '#808080');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, r, 0, 7);
      g.fill();
    }
  }
  return new THREE.CanvasTexture(c);
}

// Per-player ball surface: a distinct material style (metal, furry, slime,
// stone, chrome, neon…) so the arena reads with real texture variety.
const BALL_STYLE_COUNT = 8;
export function makeBallMaterial(colorHex: number, index: number, playerNumber: number): THREE.MeshStandardMaterial {
  const s = ((index % BALL_STYLE_COUNT) + BALL_STYLE_COUNT) % BALL_STYLE_COUNT;
  const col = new THREE.Color(colorHex);
  const p: THREE.MeshStandardMaterialParameters = { map: makeBallTexture(colorHex, index, playerNumber) };
  switch (s) {
    case 0: // playa (glossy classic)
      p.roughness = 0.34;
      p.metalness = 0.12;
      break;
    case 1: // metal cepillado
      p.roughness = 0.28;
      p.metalness = 0.95;
      p.bumpMap = makeBumpTexture('metal');
      p.bumpScale = 0.015;
      break;
    case 2: // peluda
      p.roughness = 1.0;
      p.metalness = 0.0;
      p.bumpMap = makeBumpTexture('fur');
      p.bumpScale = 0.09;
      break;
    case 3: // slime
      p.roughness = 0.05;
      p.metalness = 0.1;
      p.emissive = col.clone().multiplyScalar(0.4);
      p.emissiveIntensity = 0.45;
      p.bumpMap = makeBumpTexture('slime');
      p.bumpScale = 0.05;
      break;
    case 4: // neón
      p.roughness = 0.5;
      p.metalness = 0.2;
      p.emissive = col;
      p.emissiveIntensity = 0.6;
      break;
    case 5: // piedra
      p.roughness = 1.0;
      p.metalness = 0.05;
      p.bumpMap = makeBumpTexture('stone');
      p.bumpScale = 0.08;
      break;
    case 6: // cromo
      p.roughness = 0.1;
      p.metalness = 1.0;
      break;
    default: // galaxia (dark shimmer)
      p.roughness = 0.4;
      p.metalness = 0.35;
      p.emissive = col.clone().multiplyScalar(0.18);
      p.emissiveIntensity = 0.35;
      break;
  }
  return new THREE.MeshStandardMaterial(p);
}

// Crisp white pictogram per orb type, drawn once and billboarded above the orb
// so a glance tells you what a pickup DOES — colour alone never read clearly.
export function makeOrbGlyphTexture(type: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffff';
  g.fillStyle = '#ffffff';
  g.lineWidth = 13;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  // Dark halo so the white glyph pops on light-coloured orbs too.
  g.shadowColor = 'rgba(0,0,0,0.75)';
  g.shadowBlur = 7;
  const cx = 64;
  const cy = 64;
  switch (((type % 5) + 5) % 5) {
    case 0: // SÚPER — lightning bolt (next dash ×2.3)
      g.beginPath();
      g.moveTo(78, 16);
      g.lineTo(40, 70);
      g.lineTo(62, 70);
      g.lineTo(50, 112);
      g.lineTo(94, 52);
      g.lineTo(70, 52);
      g.closePath();
      g.fill();
      break;
    case 1: // TURBO — double chevron (stacking speed)
      g.lineWidth = 15;
      for (const dx of [-14, 16]) {
        g.beginPath();
        g.moveTo(cx - 22 + dx, 30);
        g.lineTo(cx + 10 + dx, 64);
        g.lineTo(cx - 22 + dx, 98);
        g.stroke();
      }
      break;
    case 2: // MEGA — four outward arrows (you grow)
      g.lineWidth = 12;
      for (let k = 0; k < 4; k++) {
        const a = k * (Math.PI / 2) + Math.PI / 4;
        const ux = Math.cos(a);
        const uy = Math.sin(a);
        const x1 = cx + ux * 48;
        const y1 = cy + uy * 48;
        g.beginPath();
        g.moveTo(cx + ux * 18, cy + uy * 18);
        g.lineTo(x1, y1);
        g.stroke();
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x1 + Math.cos(a + 2.5) * 17, y1 + Math.sin(a + 2.5) * 17);
        g.moveTo(x1, y1);
        g.lineTo(x1 + Math.cos(a - 2.5) * 17, y1 + Math.sin(a - 2.5) * 17);
        g.stroke();
      }
      break;
    case 3: // ESCUDO — shield (blocks the next shove)
      g.lineWidth = 12;
      g.beginPath();
      g.moveTo(cx, 20);
      g.lineTo(102, 40);
      g.lineTo(102, 68);
      g.quadraticCurveTo(102, 100, cx, 112);
      g.quadraticCurveTo(26, 100, 26, 68);
      g.lineTo(26, 40);
      g.closePath();
      g.stroke();
      break;
    default: // BOMBA — burst star (shockwave that shoves everyone)
      g.beginPath();
      for (let k = 0; k < 12; k++) {
        const a = k * (Math.PI / 6);
        const rr = k % 2 === 0 ? 48 : 21;
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (k === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      break;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Diagonal caution stripes so beams and pistons read as "danger", not decor.
function makeHazardTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffcf1a';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#161616';
  // Slanted black bars (shift by one tile-height over the tile → ~45°).
  for (let x = -64; x < 128; x += 30) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 15, 0);
    g.lineTo(x + 15 + 64, 64);
    g.lineTo(x + 64, 64);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Floating tag hovering over the local player's ball so you always know which
// one is you — shows your username (or "VOS" if unset), white with a dark
// outline so it reads on any arena. Font shrinks to fit longer names.
function makeYouMarkerTexture(label: string): THREE.CanvasTexture {
  const text = (label || 'VOS').toUpperCase().slice(0, 12);
  const W = 256;
  const H = 128;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  // Fit the font to the label width.
  let fs = 46;
  do {
    g.font = `900 ${fs}px system-ui, sans-serif`;
    if (g.measureText(text).width <= W - 24) break;
    fs -= 2;
  } while (fs > 18);
  g.lineWidth = Math.max(6, fs * 0.2);
  g.strokeStyle = 'rgba(0,0,0,0.85)';
  g.strokeText(text, W / 2, 40);
  g.fillStyle = '#ffffff';
  g.fillText(text, W / 2, 40);
  // Downward pointer.
  g.beginPath();
  g.moveTo(W / 2 - 22, 78);
  g.lineTo(W / 2 + 22, 78);
  g.lineTo(W / 2, 116);
  g.closePath();
  g.lineWidth = 9;
  g.stroke();
  g.fillStyle = '#ffffff';
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- Ball faces -----------------------------------------------------------
// A pair of eyes + eyebrows on the front of each ball that TURN toward the
// travel heading (clamped to the front so they never rotate out of sight) and
// react to what the ball is doing. Purely cosmetic: reads sim flags/velocity,
// never writes back. Shared geometry and unlit materials keep it bright and
// cheap across 8 balls.
const EYE_GEO = new THREE.SphereGeometry(1, 16, 12);
const PUPIL_GEO = new THREE.SphereGeometry(1, 12, 10);
const BROW_GEO = new THREE.BoxGeometry(1, 1, 1);
const EYE_WHITE_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff });
const FACE_DARK_MAT = new THREE.MeshBasicMaterial({ color: 0x181c26 });
// Eye anchor on the front-upper hemisphere (in units of the ball radius).
const EX = 0.32;
const EY = 0.4;
const EZ = 0.76;

interface FaceRig {
  group: THREE.Group;
  eyeL: THREE.Mesh;
  eyeR: THREE.Mesh;
  pupilL: THREE.Mesh;
  pupilR: THREE.Mesh;
  browL: THREE.Mesh;
  browR: THREE.Mesh;
  yaw: number; // smoothed heading the face turns toward (radians)
  pitch: number; // smoothed tilt: up when heading away, down when toward camera
  blink: number; // seconds until the next blink
  closing: number; // 0 open .. 1 shut
  browY: number; // smoothed expression params
  browAngle: number;
  eyeSY: number;
  pupilS: number;
}

function makeFace(): FaceRig {
  const group = new THREE.Group();
  // Yaw (turn toward travel) then pitch (tilt up toward the high camera).
  group.rotation.order = 'YXZ';
  const eyeL = new THREE.Mesh(EYE_GEO, EYE_WHITE_MAT);
  const eyeR = new THREE.Mesh(EYE_GEO, EYE_WHITE_MAT);
  eyeL.position.set(-EX, EY, EZ);
  eyeR.position.set(EX, EY, EZ);
  eyeL.scale.set(0.26, 0.3, 0.14);
  eyeR.scale.copy(eyeL.scale);
  const pupilL = new THREE.Mesh(PUPIL_GEO, FACE_DARK_MAT);
  const pupilR = new THREE.Mesh(PUPIL_GEO, FACE_DARK_MAT);
  pupilL.scale.setScalar(0.13);
  pupilR.scale.setScalar(0.13);
  pupilL.position.set(-EX, EY, EZ + 0.08);
  pupilR.position.set(EX, EY, EZ + 0.08);
  const browL = new THREE.Mesh(BROW_GEO, FACE_DARK_MAT);
  const browR = new THREE.Mesh(BROW_GEO, FACE_DARK_MAT);
  browL.scale.set(0.3, 0.07, 0.09);
  browR.scale.copy(browL.scale);
  browL.position.set(-EX, EY + 0.3, EZ);
  browR.position.set(EX, EY + 0.3, EZ);
  group.add(eyeL, eyeR, pupilL, pupilR, browL, browR);
  return { group, eyeL, eyeR, pupilL, pupilR, browL, browR, yaw: 0, pitch: -0.18, blink: 2 + Math.random() * 3, closing: 0, browY: 0, browAngle: 0, eyeSY: 1, pupilS: 1 };
}

// Gradient dome (skyBottom → skyTop) with cheap hashed twinkling stars.
// Sky dome: aurora curtains drifting over a vertical gradient, a soft moon
// halo and a handful of big slow stars. Everything tinted by the theme.
function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSkyTop: { value: new THREE.Color(0x04060e) },
      uSkyBottom: { value: new THREE.Color(0x1c2750) },
      uAccent: { value: new THREE.Color(0x9fb4ff) },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSkyTop;
      uniform vec3 uSkyBottom;
      uniform vec3 uAccent;
      uniform float uTime;
      varying vec3 vDir;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int k = 0; k < 3; k++) {
          v += a * vnoise(p);
          p *= 2.15;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uSkyBottom, uSkyTop, pow(h, 1.35));

        // Aurora curtains: domain-warped noise sampled on a circle (periodic
        // in azimuth — no seam), drifting slowly with height and time.
        float az = atan(d.z, d.x);
        vec2 circ = vec2(cos(az), sin(az)) * 1.8;
        vec2 ap = circ + vec2(0.0, d.y * 2.4 - uTime * 0.045);
        float n = fbm(ap + fbm(ap + uTime * 0.05) * 1.5);
        float band = smoothstep(0.5, 0.85, n);
        band *= smoothstep(-0.12, 0.3, d.y) * (1.0 - smoothstep(0.55, 0.95, d.y));
        col += uAccent * band * 0.32;

        // Soft moon with a wide halo.
        vec3 moonDir = normalize(vec3(0.55, 0.38, -0.6));
        float md = max(dot(d, moonDir), 0.0);
        col += uAccent * smoothstep(0.9982, 0.99965, md) * 0.85;
        col += uAccent * pow(md, 48.0) * 0.10;

        // Sparse, slow stars: 3D direction cells, seamless everywhere.
        vec3 g3 = d * 26.0;
        vec3 cell3 = floor(g3);
        float rnd = fract(sin(dot(cell3, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        if (rnd > 0.972 && d.y > 0.02) {
          float dist = length(fract(g3) - 0.5);
          float tw = 0.6 + 0.4 * sin(uTime * (0.6 + rnd * 1.6) + rnd * 100.0);
          col += vec3(1.0) * smoothstep(0.3, 0.0, dist) * tw * 0.5;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Abyss floor: a slow energy well — spiral streaks and mist drawn toward a
// faint glowing core, so falling reads as being swallowed.
function makeAbyssMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBeam: { value: new THREE.Color(0xffffff) },
      uBg: { value: new THREE.Color(0x0b0e1a) },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uBeam;
      uniform vec3 uBg;
      uniform float uTime;
      varying vec3 vWorld;

      float hash21(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec2 p = vWorld.xz;
        float r = length(p);
        float ang = atan(p.y, p.x);

        // Two counter-drifting spiral streak sets plus a mist layer. The
        // sin() spirals use integer harmonics (periodic in ang, no seam) and
        // the mist samples noise on a circle for the same reason.
        float s1 = 0.5 + 0.5 * sin(ang * 3.0 + r * 0.5 - uTime * 0.55);
        float s2 = 0.5 + 0.5 * sin(ang * 5.0 - r * 0.32 + uTime * 0.35);
        vec2 ring = vec2(cos(ang), sin(ang));
        float mist = vnoise(ring * 1.6 + vec2(r * 0.4 - uTime * 0.22, r * 0.2)) * 0.6 +
                     vnoise(ring * 3.1 + vec2(r * 0.9 + uTime * 0.1, 7.0)) * 0.4;

        float fade = exp(-r * 0.05);
        float core = exp(-r * 0.16);
        float glow = (s1 * s2 * 0.5 + mist * 0.35) * fade + core * 0.55;
        vec3 col = mix(uBg, uBeam, clamp(glow, 0.0, 1.0) * 0.8);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Flat cooldown arc drawn under each ball; uFrac 0..1 fills the ring clockwise.
function makeCooldownRing(colorHex: number): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uFrac: { value: 1 },
      uAlpha: { value: 0.55 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uFrac;
      uniform float uAlpha;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float band = smoothstep(0.58, 0.68, r) * (1.0 - smoothstep(0.86, 0.96, r));
        float ang = fract(atan(p.x, -p.y) * 0.15915494 + 0.5);
        float arc = max(step(ang, uFrac), step(0.999, uFrac));
        float a = band * (0.15 + 0.85 * arc) * uAlpha;
        if (a < 0.012) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  return { mesh, mat };
}

// Rey de la colina zone: additive pulsing ring + soft fill + breathing wave.
function makeZoneMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(ZONE_COLOR) },
      uTime: { value: 0 },
      uAlpha: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uAlpha;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r = length(p);
        float pulse = 0.5 + 0.5 * sin(uTime * 3.2);
        float edge = smoothstep(0.82, 0.92, r) * (1.0 - smoothstep(0.96, 1.0, r));
        float fill = (1.0 - smoothstep(0.15, 0.95, r)) * 0.14;
        float br = 0.45 + 0.35 * pulse;
        float wave = smoothstep(br - 0.06, br, r) * (1.0 - smoothstep(br + 0.02, br + 0.1, r)) * 0.5;
        float a = (edge * (0.7 + 0.3 * pulse) + fill + wave) * uAlpha;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
}

export class GameRenderer {
  readonly fx = new FxSystem();

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private cameraBase = new THREE.Vector3(0, 22, 20.5);
  private cameraMode = 0; // 0 isométrica · 1 desde arriba · 2 tercera persona
  private arenaExt = 10; // arena half-extent from setup, for the camera presets
  private lookTarget = new THREE.Vector3(0, 0, 0);
  // Smoothed follow state for the top-down and third-person cameras.
  private camFocus = new THREE.Vector3();
  private camInit = false;
  private localAlive = false; // follow cams fall back to the crowd once you're out
  private chaseYaw = 0; // heading the third-person cam sits behind (world yaw)
  private tune = loadTune(); // live feel knobs (dev panel writes, we read)
  private shakeTmp = new THREE.Vector3();
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private skyMat: THREE.ShaderMaterial;
  private abyssMat: THREE.ShaderMaterial;
  private pieces: THREE.InstancedMesh | null = null;

  // Per-player node hierarchy: root (interpolated position + squash scale)
  // → deform (velocity-oriented stretch) → mesh (rolling quaternion, intact).
  private playerRoots: THREE.Group[] = [];
  private playerDeforms: THREE.Group[] = [];
  private playerMeshes: THREE.Mesh[] = [];
  private playerMats: THREE.MeshStandardMaterial[] = [];
  private cdRings: THREE.Mesh[] = [];
  private cdRingMats: THREE.ShaderMaterial[] = [];
  private shields: THREE.Mesh[] = [];

  // Cosmetic per-player animation state (springs never touch the sim).
  private sqS = new Float32Array(0);
  private sqV = new Float32Array(0);
  private stretchK = new Float32Array(0);
  private prevVy = new Float32Array(0);
  private prevCdFrac = new Float32Array(0);
  private ringPulse = new Float32Array(0);
  private lastSimFrame = -1;
  private lastUpdateMs = -1;

  private faces: FaceRig[] = [];
  private playerSkins: number[] = []; // skin index per player (empty → auto variety)
  // Local human's slot (−1 = none, e.g. attract mode) and the "VOS" tag over it.
  private localSlot = -1;
  private youMarker: THREE.Sprite;

  private hazardMeshes: THREE.Mesh[] = [];
  private hazardTex = makeHazardTexture();
  private orbs: THREE.Mesh[] = [];
  private orbLights: THREE.PointLight[] = [];
  private orbGlyphs: THREE.Sprite[] = [];
  private orbSpawn = new Float32Array(MAX_ORBS).fill(1); // 1 = settled; <1 = popping in
  private prevOrbActive = new Uint8Array(MAX_ORBS);
  private orbGlyphTex = ORB_INFO.map((_, i) => makeOrbGlyphTexture(i));

  // Rey de la colina zone marker (cosmetic; position mirrors the sim's mode section).
  private zoneMesh: THREE.Mesh;
  private zoneMat: THREE.ShaderMaterial;
  private zonePos = new THREE.Vector3();
  private zoneTX = 0;
  private zoneTZ = 0;
  private zoneTY = 0;
  private zoneAlpha = 0;
  private zoneShown = false;
  // Curse pulse phase (rad); its frequency ramps up as the timer runs out.
  private cursePhase = 0;

  private theme: Theme = THEMES[0];
  private tileColors: THREE.Color[] = [];
  private pieceRise = new Float32Array(0); // 1 = settled; <1 = rising in animation
  private prevPieceState = new Uint8Array(0);
  private pixelRatioCap = 2;
  private dummy = new THREE.Object3D();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private qStretch = new THREE.Quaternion();
  private vTmp = new THREE.Vector3();
  private warnColor = new THREE.Color();
  private specColor = new THREE.Color();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.pixelRatioCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(this.fx.points);
    this.scene.add(this.fx.ringGroup);

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 160);
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(0, 0, 0);

    this.hemi = new THREE.HemisphereLight(0x9fb4ff, 0x1a1f33, 0.8);
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(10, 22, 8);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -17;
    this.sun.shadow.camera.right = 17;
    this.sun.shadow.camera.top = 17;
    this.sun.shadow.camera.bottom = -17;
    this.sun.shadow.camera.far = 60;
    this.scene.add(this.sun);

    // Skybox dome; colors are retinted per theme in setup().
    this.skyMat = makeSkyMaterial();
    const sky = new THREE.Mesh(new THREE.IcosahedronGeometry(80, 2), this.skyMat);
    sky.renderOrder = -2;
    this.scene.add(sky);

    // Abyss grid far below the arena.
    this.abyssMat = makeAbyssMaterial();
    const abyss = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), this.abyssMat);
    abyss.rotation.x = -Math.PI / 2;
    abyss.position.y = -24;
    abyss.renderOrder = -1;
    this.scene.add(abyss);

    // Pool of power orbs (several lie around the map at once), reused across rounds.
    const orbGeo = new THREE.IcosahedronGeometry(0.32, 1);
    for (let i = 0; i < MAX_ORBS; i++) {
      const orb = new THREE.Mesh(
        orbGeo,
        new THREE.MeshStandardMaterial({ color: 0xffc93c, emissive: 0xffaa00, emissiveIntensity: 1.4, roughness: 0.3 }),
      );
      orb.visible = false;
      const light = new THREE.PointLight(0xffb300, 8, 6);
      orb.add(light);
      // Billboard glyph floating just above the orb so you can read what it is.
      const glyph = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.orbGlyphTex[0], transparent: true, depthTest: true, depthWrite: false }),
      );
      glyph.scale.setScalar(0.62);
      glyph.position.set(0, 0.62, 0);
      orb.add(glyph);
      this.scene.add(orb);
      this.orbs.push(orb);
      this.orbLights.push(light);
      this.orbGlyphs.push(glyph);
    }

    // Rey de la colina zone ring, reused across rounds (hidden outside KOTH).
    this.zoneMat = makeZoneMaterial();
    this.zoneMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.zoneMat);
    this.zoneMesh.rotation.x = -Math.PI / 2;
    this.zoneMesh.scale.setScalar(ZONE_RADIUS * 2);
    this.zoneMesh.visible = false;
    this.scene.add(this.zoneMesh);

    // "VOS" tag over the local player (drawn on top so it's never occluded).
    this.youMarker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: makeYouMarkerTexture('VOS'), transparent: true, depthTest: false, depthWrite: false }),
    );
    this.youMarker.scale.set(1.9, 0.95, 1);
    this.youMarker.renderOrder = 10;
    this.youMarker.visible = false;
    this.scene.add(this.youMarker);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /** Skin index per player slot; call before setup(). Empty = auto variety. */
  setSkins(skins: number[]): void {
    this.playerSkins = skins;
  }

  /** Live feel knob (dev tuning panel). Persists immediately. */
  setTune(key: string, value: number): void {
    this.tune[key] = value;
    saveTune(this.tune);
  }

  /**
   * Which slot the local human controls (−1 to hide the tag) and the label to
   * float over it — the player's username, or "VOS" when unset.
   */
  setLocalPlayer(slot: number, name = ''): void {
    this.localSlot = slot;
    const mat = this.youMarker.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.map = makeYouMarkerTexture(name);
    mat.needsUpdate = true;
  }

  private applyCameraMode(): void {
    // Only the isométrica view uses this fixed base (it frames the whole arena);
    // the follow cams compute their position per frame in render().
    this.cameraBase.set(0, this.arenaExt * 1.78, this.arenaExt * 1.66);
  }

  /**
   * Heading (world yaw) the third-person chase cam sits behind, so movement
   * input can be made camera-relative (W = into the screen). Returns null in
   * the other camera modes, where WASD stays world-relative.
   */
  chaseControlYaw(): number | null {
    return this.cameraMode === 2 ? this.chaseYaw : null;
  }

  /** Cycle isométrica → desde arriba → tercera persona. Returns the label. */
  cycleCamera(): string {
    this.cameraMode = (this.cameraMode + 1) % 3;
    this.applyCameraMode();
    this.camInit = false; // re-seat the follow smoothing for the new mode
    return ['ISOMÉTRICA', 'DESDE ARRIBA', 'TERCERA PERSONA'][this.cameraMode];
  }

  /** Runtime quality knobs: shadow map toggle and device pixel ratio cap. */
  setQuality(q: { shadows: boolean; pixelRatioCap: number }): void {
    this.pixelRatioCap = q.pixelRatioCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatioCap));
    if (this.renderer.shadowMap.enabled !== q.shadows) {
      this.renderer.shadowMap.enabled = q.shadows;
      this.sun.castShadow = q.shadows;
      // Materials cache their shadow defines; force a recompile.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m) return;
        for (const mm of Array.isArray(m) ? m : [m]) mm.needsUpdate = true;
      });
    }
  }

  /**
   * Cosmetic squash impulse on player i: the ball dips its vertical scale by
   * ≈amount (e.g. 0.25) and springs back. Safe to call with any index.
   */
  squash(i: number, amount: number): void {
    if (i < 0 || i >= this.sqV.length) return;
    this.sqV[i] -= amount * SPRING_W * Math.E;
  }

  /** (Re)build meshes for a fresh round from the sim's initial snapshot. */
  setup(sim: Sim, themeOverride?: number): void {
    this.theme = THEMES[themeOverride ?? sim.level] ?? THEMES[0];
    this.scene.background = null;
    this.renderer.setClearColor(this.theme.bg, 1);
    this.scene.fog = new THREE.Fog(this.theme.bg, 36, 80);
    this.hemi.color.set(this.theme.sky);
    this.hemi.groundColor.set(this.theme.ground);
    (this.skyMat.uniforms.uSkyTop.value as THREE.Color).setHex(this.theme.skyTop);
    (this.skyMat.uniforms.uSkyBottom.value as THREE.Color).setHex(this.theme.skyBottom);
    (this.skyMat.uniforms.uAccent.value as THREE.Color).setHex(this.theme.sky);
    (this.abyssMat.uniforms.uBeam.value as THREE.Color).setHex(this.theme.beam);
    (this.abyssMat.uniforms.uBg.value as THREE.Color).setHex(this.theme.bg);

    if (this.pieces) {
      this.scene.remove(this.pieces);
      this.pieces.geometry.dispose();
      (this.pieces.material as THREE.Material).dispose();
    }
    for (let i = 0; i < this.playerRoots.length; i++) {
      this.scene.remove(this.playerRoots[i]);
      this.playerMeshes[i].geometry.dispose();
      this.playerMats[i].map?.dispose();
      this.playerMats[i].bumpMap?.dispose();
      this.playerMats[i].dispose();
    }
    for (let i = 0; i < this.cdRings.length; i++) {
      this.scene.remove(this.cdRings[i]);
      this.cdRings[i].geometry.dispose();
      this.cdRingMats[i].dispose();
    }
    for (const s of this.shields) {
      this.scene.remove(s);
      s.geometry.dispose();
      (s.material as THREE.Material).dispose();
    }
    for (const h of this.hazardMeshes) {
      this.scene.remove(h);
      h.geometry.dispose();
      (h.material as THREE.Material).dispose();
    }
    this.playerRoots = [];
    this.playerDeforms = [];
    this.playerMeshes = [];
    this.playerMats = [];
    this.faces = [];
    this.cdRings = [];
    this.cdRingMats = [];
    this.shields = [];
    this.hazardMeshes = [];

    const state = sim.curr;
    const pieceGeo = new THREE.BoxGeometry(PIECE_SIZE.x, PIECE_SIZE.y, PIECE_SIZE.z);
    const pieceMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
    this.pieces = new THREE.InstancedMesh(pieceGeo, pieceMat, sim.pieceCount);
    this.pieces.castShadow = true;
    this.pieces.receiveShadow = true;

    const colorA = new THREE.Color(this.theme.tileA);
    const colorB = new THREE.Color(this.theme.tileB);
    this.tileColors = [];
    for (let i = 0; i < sim.pieceCount; i++) {
      const base = sim.pieceBase(i);
      const gx = Math.round(state[base] / 1.5);
      const gz = Math.round(state[base + 2] / 1.5);
      const color = (gx + gz) % 2 === 0 ? colorA : colorB;
      this.tileColors.push(color);
      this.pieces.setColorAt(i, color);
    }
    this.pieces.instanceColor!.needsUpdate = true;
    this.scene.add(this.pieces);
    // Rise-in animation state: seed prev states so existing tiles don't animate.
    this.pieceRise = new Float32Array(sim.pieceCount).fill(1);
    this.prevPieceState = new Uint8Array(sim.pieceCount);
    for (let i = 0; i < sim.pieceCount; i++) this.prevPieceState[i] = pieceStateOf(state[sim.pieceBase(i) + 7]);

    // Auto-fit the camera to the arena: levels now span very different sizes.
    let ext = 8;
    for (let i = 0; i < sim.pieceCount; i++) {
      const pb = sim.pieceBase(i);
      ext = Math.max(ext, Math.abs(state[pb]), Math.abs(state[pb + 2]));
    }
    ext += 1.5;
    this.arenaExt = ext;
    this.applyCameraMode();
    this.scene.fog = new THREE.Fog(this.theme.bg, ext * 3.3, ext * 7.3);
    this.sun.shadow.camera.left = -(ext + 4);
    this.sun.shadow.camera.right = ext + 4;
    this.sun.shadow.camera.top = ext + 4;
    this.sun.shadow.camera.bottom = -(ext + 4);
    this.sun.shadow.camera.updateProjectionMatrix();

    const sphereGeo = new THREE.SphereGeometry(PLAYER_RADIUS, 32, 24);
    for (let i = 0; i < sim.playerCount; i++) {
      const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      // Local player wears their chosen skin; the rest get spread-out variety.
      const skin = this.playerSkins[i] ?? (i * 7) % SKIN_COUNT;
      const mat = makeSkinMaterial(skin, color, i + 1);
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const deform = new THREE.Group();
      deform.add(mesh);
      const root = new THREE.Group();
      root.add(deform);
      // Face rides on the root (position + squash, but NOT the rolling spin or
      // velocity stretch) so the eyes stay upright and readable.
      const face = makeFace();
      root.add(face.group);
      this.faces.push(face);
      this.scene.add(root);
      this.playerRoots.push(root);
      this.playerDeforms.push(deform);
      this.playerMeshes.push(mesh);
      this.playerMats.push(mat);

      const ring = makeCooldownRing(color);
      ring.mesh.scale.setScalar(1.9);
      this.scene.add(ring.mesh);
      this.cdRings.push(ring.mesh);
      this.cdRingMats.push(ring.mat);

      // Translucent shield bubble, hidden until the player grabs an ESCUDO.
      const bubble = new THREE.Mesh(
        new THREE.SphereGeometry(PLAYER_RADIUS * 1.5, 20, 16),
        new THREE.MeshBasicMaterial({
          color: 0x8affc0,
          transparent: true,
          opacity: 0.28,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      bubble.visible = false;
      this.scene.add(bubble);
      this.shields.push(bubble);
    }

    // Reset cosmetic animation state for the new round.
    this.sqS = new Float32Array(sim.playerCount).fill(1);
    this.sqV = new Float32Array(sim.playerCount);
    this.stretchK = new Float32Array(sim.playerCount).fill(1);
    this.prevVy = new Float32Array(sim.playerCount);
    this.prevCdFrac = new Float32Array(sim.playerCount).fill(1);
    this.ringPulse = new Float32Array(sim.playerCount);
    this.lastSimFrame = state[0];
    this.zoneShown = false;
    this.zoneAlpha = 0;
    this.zoneMesh.visible = false;
    this.cursePhase = 0;

    for (let i = 0; i < sim.hazardCount; i++) {
      const base = sim.hazardBase(i);
      const geo = new THREE.BoxGeometry(state[base + 7] * 2, state[base + 8] * 2, state[base + 9] * 2);
      const mat = new THREE.MeshStandardMaterial({
        map: this.hazardTex,
        color: 0xffffff,
        emissive: this.theme.beam,
        emissiveIntensity: 0.28,
        roughness: 0.55,
        metalness: 0.1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.hazardMeshes.push(mesh);
    }

    this.lookTarget.set(0, 0, 0);
    this.camInit = false; // re-seat the follow cams on the new arena
  }

  /** Interpolate between the two most recent sim snapshots and draw. */
  update(sim: Sim, alpha: number, timeMs: number): void {
    const { prev, curr } = sim;
    const dts = this.lastUpdateMs < 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (timeMs - this.lastUpdateMs) / 1000));
    this.lastUpdateMs = timeMs;
    const tickChanged = curr[0] !== this.lastSimFrame;
    let cx = 0;
    let cz = 0;
    let aliveCount = 0;
    this.youMarker.visible = false; // set true below when the local ball is alive

    // Curse pulse (MALDITO): flicker speeds up as m1 (ticks left) drops below
    // the panic threshold. Phase accumulation keeps the ramp continuous.
    const mb = sim.modeBase();
    const simMode = curr[mb] | 0;
    const curseTicks = simMode === MODE_MALDITO ? curr[mb + 2] : Number.POSITIVE_INFINITY;
    const curseUrgency = Math.min(1, Math.max(0, 1 - curseTicks / CURSE_PANIC_TICKS));
    this.cursePhase += dts * (7 + 26 * curseUrgency);
    const cursePulse = 0.5 + 0.5 * Math.sin(this.cursePhase);

    for (let i = 0; i < sim.playerCount; i++) {
      const base = sim.playerBase(i);
      const root = this.playerRoots[i];
      const deform = this.playerDeforms[i];
      const mesh = this.playerMeshes[i];
      const flags = curr[base + 7] | 0;
      const alive = (flags & FLAG_ALIVE) !== 0;
      const cursed = (flags & FLAG_CURSED) !== 0;
      root.visible = alive || curr[base + 1] > -8;
      this.lerpInto(root.position, mesh.quaternion, prev, curr, base, alpha);
      // Levels pick ball sizes and MEGA pickups grow them mid-round.
      const ballR = ballRadiusFrom(flags);
      mesh.scale.setScalar(ballR / PLAYER_RADIUS);

      const vx = (curr[base] - prev[base]) * 60;
      const vy = (curr[base + 1] - prev[base + 1]) * 60;
      const vz = (curr[base + 2] - prev[base + 2]) * 60;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const cdFrac = 1 - dashCooldownFrom(flags) / DASH_COOLDOWN_TICKS;

      if (tickChanged) {
        // Landing: was falling fast last tick, grounded now → squash + dust.
        if (alive && this.prevVy[i] < LANDING_VY && vy > -0.5) {
          this.squash(i, Math.min(0.32, -this.prevVy[i] * 0.02));
          this.fx.burst(root.position.x, curr[base + 1] - PLAYER_RADIUS + 0.1, root.position.z, DUST_COLOR, {
            count: 8,
            speed: 1.6,
            up: 0.7,
            gravity: 6,
            life: 340,
          });
        }
        this.prevVy[i] = vy;
        if (this.prevCdFrac[i] < 0.999 && cdFrac >= 0.999) this.ringPulse[i] = 1;
        this.prevCdFrac[i] = cdFrac;
      }

      if (alive) {
        cx += curr[base];
        cz += curr[base + 2];
        aliveCount++;

        // Speed trail: spawn faint particles behind fast balls.
        if (Math.sqrt(vx * vx + vz * vz) > TRAIL_MIN_SPEED) {
          this.fx.burst(root.position.x, root.position.y, root.position.z, PLAYER_COLORS[i % PLAYER_COLORS.length], {
            count: 2,
            speed: 0.4,
            up: 0.3,
            gravity: 0.5,
            life: 320,
          });
        }

        // Curse drip: dark embers oozing off the ball, denser near detonation.
        if (cursed) {
          this.fx.burst(
            root.position.x + (Math.random() - 0.5) * 0.8,
            root.position.y + (Math.random() - 0.2) * 0.6,
            root.position.z + (Math.random() - 0.5) * 0.8,
            CURSE_DRIP_COLOR,
            { count: curseUrgency > 0.01 ? 2 : 1, speed: 0.5, up: -1.3, gravity: 3.5, life: 520 },
          );
        }
      }

      // Squash spring: critically damped toward 1 (0.82 while braced).
      const target = (flags & FLAG_BRACED) !== 0 ? 0.82 : 1;
      this.sqV[i] += (-(this.sqS[i] - target) * SPRING_W * SPRING_W - 2 * SPRING_W * this.sqV[i]) * dts;
      this.sqS[i] += this.sqV[i] * dts;
      const s = Math.min(1.45, Math.max(0.55, this.sqS[i]));
      const sInv = 1 / Math.sqrt(s);
      root.scale.set(sInv, s, sInv);

      // Continuous stretch along the velocity while moving fast, volume-conserving.
      let kTarget = 1;
      if (alive && speed > STRETCH_MIN_SPEED) {
        kTarget = Math.min(1.22, 1 + speed * 0.018);
        this.vTmp.set(vx, vy, vz).multiplyScalar(1 / speed);
        this.qStretch.setFromUnitVectors(UP, this.vTmp);
      } else {
        this.qStretch.identity();
      }
      this.stretchK[i] += (kTarget - this.stretchK[i]) * Math.min(1, dts * 14);
      const k = this.stretchK[i];
      const kInv = 1 / Math.sqrt(k);
      deform.quaternion.slerp(this.qStretch, Math.min(1, dts * 12));
      deform.scale.set(kInv, k, kInv);

      // Dash cooldown ring under the ball (hidden if dead or glowing with power).
      this.ringPulse[i] = Math.max(0, this.ringPulse[i] - dts * 3);
      const ringVisible = alive && (flags & FLAG_HAS_POWER) === 0;
      this.cdRings[i].visible = ringVisible;
      if (ringVisible) {
        const pulse = this.ringPulse[i];
        this.cdRings[i].position.set(root.position.x, root.position.y - ballR + 0.05, root.position.z);
        this.cdRings[i].scale.setScalar(1.9 * (ballR / PLAYER_RADIUS));
        this.cdRings[i].scale.setScalar(1.9 * (1 + 0.4 * pulse * pulse));
        this.cdRingMats[i].uniforms.uFrac.value = cdFrac;
        this.cdRingMats[i].uniforms.uAlpha.value = 0.55 + 0.45 * pulse;
      }

      // Shield bubble follows the ball while the ESCUDO is up.
      const shielded = alive && hasShield(flags);
      this.shields[i].visible = shielded;
      if (shielded) {
        this.shields[i].position.copy(root.position);
        const s = (ballR / PLAYER_RADIUS) * (1 + 0.05 * Math.sin(timeMs * 0.006));
        this.shields[i].scale.setScalar(s);
      }

      // Cursed aura beats every other glow; then power orb, then dash ready.
      const mat = this.playerMats[i];
      if (cursed) {
        mat.emissive.setHex(CURSE_COLOR);
        mat.emissiveIntensity = 0.65 + 1.05 * cursePulse;
      } else if (flags & FLAG_HAS_POWER) {
        mat.emissive.setHex(0xffaa00);
        mat.emissiveIntensity = 0.9 + 0.4 * Math.sin(timeMs * 0.012);
      } else if (flags & FLAG_DASH_READY) {
        mat.emissive.setHex(PLAYER_COLORS[i % PLAYER_COLORS.length]);
        mat.emissiveIntensity = 0.22;
      } else {
        // Restore the skin's baked glow (Slime/Neón/Galaxia/Lava) instead of
        // killing it every frame; plain skins baked 0 so they stay matte.
        mat.emissive.setHex((mat.userData.baseEmissive as number) ?? 0);
        mat.emissiveIntensity = (mat.userData.baseEmissiveIntensity as number) ?? 0;
      }

      // Face: turns to look where the ball is heading, expression follows mood.
      const face = this.faces[i];
      if (face) {
        // Local eye/brow offsets are ~unit vectors, so scaling by ballR seats
        // them right on the ball surface (any size).
        face.group.scale.setScalar(ballR);

        const hsp = Math.sqrt(vx * vx + vz * vz);
        const cxw = root.position.x;
        const czw = root.position.z;
        const offCentre = cxw * cxw + czw * czw > 1; // avoid noise near the middle
        // Every ball — you included — faces where it's going; standing still it
        // turns to look at the arena CENTRE, so nobody (not even you) ends up
        // staring off the map.
        let targetYaw = face.yaw;
        if (hsp > 1.5) targetYaw = Math.atan2(vx, vz);
        else if (offCentre) targetYaw = Math.atan2(-cxw, -czw);
        const d = Math.atan2(Math.sin(targetYaw - face.yaw), Math.cos(targetYaw - face.yaw));
        face.yaw += d * Math.min(1, dts * (hsp > 1.5 ? 8 : 1.6));

        // Third-person chase heading (local only). It EASES (never snaps), and
        // it refuses to whip 180° when you back up — that reversal was the
        // "everything rotates" feeling. Idle → look toward centre.
        if (i === this.localSlot) {
          let ct = this.chaseYaw;
          if (hsp > 1.5) {
            ct = Math.atan2(vx, vz);
            const off = Math.atan2(Math.sin(ct - this.chaseYaw), Math.cos(ct - this.chaseYaw));
            if (Math.abs(off) > 1.9) ct = this.chaseYaw; // reversing → hold, don't spin
          } else if (offCentre) {
            ct = Math.atan2(-cxw, -czw);
          }
          const cd = Math.atan2(Math.sin(ct - this.chaseYaw), Math.cos(ct - this.chaseYaw));
          this.chaseYaw += cd * Math.min(1, dts * 2.5);
        }
        // A small fixed tilt (a stopped, camera-facing head reads better); the
        // head itself does the looking, so the pupils just sit forward.
        const targetPitch = tuneVal(this.tune, 'facePitch');
        face.pitch += (targetPitch - face.pitch) * Math.min(1, dts * 8);
        face.group.rotation.set(face.pitch, face.yaw, 0);
        const lx = 0;
        const ly = 0;

        const braced = (flags & FLAG_BRACED) !== 0;
        const hasPower = (flags & FLAG_HAS_POWER) !== 0;
        const ouch = !braced && this.sqS[i] < 0.86;
        let tBrowY = 0;
        let tBrowA = 0;
        let tEyeSY = 1;
        let tPupil = 1;
        if (cursed) {
          tBrowY = 0.1; tBrowA = -0.38; tEyeSY = 1.28; tPupil = 0.6; // pánico
        } else if (braced) {
          tBrowY = -0.03; tBrowA = 0.5; tEyeSY = 0.55; // apretando los dientes
        } else if (ouch) {
          tBrowA = 0.32; tEyeSY = 0.38; tPupil = 1.2; // ojos exprimidos
        } else if (hasPower) {
          tBrowY = 0.08; tEyeSY = 1.16; tPupil = 1.1; // envalentonado
        } else if (hsp > 8) {
          tBrowA = 0.2; tEyeSY = 0.85; // concentrado
        }
        const kk = Math.min(1, dts * 12);
        face.browY += (tBrowY - face.browY) * kk;
        face.browAngle += (tBrowA - face.browAngle) * kk;
        face.eyeSY += (tEyeSY - face.eyeSY) * kk;
        face.pupilS += (tPupil - face.pupilS) * kk;

        // Occasional blink (never mid-panic).
        face.blink -= dts;
        if (face.blink <= 0 && !cursed) {
          face.closing = 1;
          face.blink = 2.4 + Math.random() * 3.2;
        }
        face.closing = Math.max(0, face.closing - dts * 9);
        const lidY = face.eyeSY * (1 - 0.9 * face.closing);
        const esz = tuneVal(this.tune, 'eyeSz');
        face.eyeL.scale.set(esz, esz * 1.15 * lidY, esz * 0.54);
        face.eyeR.scale.set(esz, esz * 1.15 * lidY, esz * 0.54);

        const jit = cursed ? (Math.random() - 0.5) * 0.05 : 0;
        const pupilScale = 0.14 * face.pupilS * (face.closing > 0.5 ? 0.2 : 1);
        // Strong vertical pupil travel so "looking up" (heading away) actually
        // reads — the ball's eyes are foreshortened from the high camera.
        const pv = tuneVal(this.tune, 'pupV');
        face.pupilL.position.set(-EX + lx * 0.11 + jit, EY + ly * pv, EZ + 0.08);
        face.pupilR.position.set(EX + lx * 0.11 + jit, EY + ly * pv, EZ + 0.08);
        face.pupilL.scale.setScalar(pupilScale);
        face.pupilR.scale.setScalar(pupilScale);
        face.browL.position.set(-EX, EY + 0.3 + face.browY, EZ);
        face.browR.position.set(EX, EY + 0.3 + face.browY, EZ);
        face.browL.rotation.z = face.browAngle;
        face.browR.rotation.z = -face.browAngle;
      }

      if (i === this.localSlot) this.localAlive = alive;
      // "VOS" tag floats over the local player's ball.
      if (i === this.localSlot && alive) {
        this.youMarker.visible = true;
        this.youMarker.position.set(
          root.position.x,
          root.position.y + ballR + 1.0 + 0.1 * Math.sin(timeMs * 0.005),
          root.position.z,
        );
      }
    }
    if (tickChanged) this.lastSimFrame = curr[0];

    // The camera gently follows the action's center of mass.
    if (aliveCount > 0) {
      const tx = (cx / aliveCount) * 0.35;
      const tz = (cz / aliveCount) * 0.35;
      this.lookTarget.x += (tx - this.lookTarget.x) * 0.06;
      this.lookTarget.z += (tz - this.lookTarget.z) * 0.06;
    }

    if (this.pieces) {
      for (let i = 0; i < sim.pieceCount; i++) {
        const base = sim.pieceBase(i);
        const packed = curr[base + 7];
        const state = pieceStateOf(packed);
        const special = pieceSpecialOf(packed);
        if (state === PIECE_GONE) {
          this.dummy.position.set(0, -1000, 0);
          this.dummy.quaternion.identity();
        } else {
          // A tile that just went GONE→solid rose in — animate it up from below.
          if (this.prevPieceState[i] === PIECE_GONE) this.pieceRise[i] = 0;
          this.lerpInto(this.dummy.position, this.dummy.quaternion, prev, curr, base, alpha);
          if (this.pieceRise[i] < 1) {
            this.pieceRise[i] = Math.min(1, this.pieceRise[i] + dts / 0.45);
            const e = 1 - (1 - this.pieceRise[i]) ** 2; // ease-out
            this.dummy.position.y -= (1 - e) * 2.4;
          } else if (state === PIECE_WARNING) {
            // Shake and flash before dropping (render-only, sim is untouched).
            this.dummy.position.x += Math.sin(timeMs * 0.09 + i) * 0.05;
            this.dummy.position.z += Math.cos(timeMs * 0.11 + i * 2) * 0.05;
          }
        }
        this.prevPieceState[i] = state;
        this.dummy.updateMatrix();
        this.pieces.setMatrixAt(i, this.dummy.matrix);

        const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.02 + i);
        let target: THREE.Color;
        if (state === PIECE_WARNING) {
          target = this.warnColor.set(this.theme.warn).lerp(this.tileColors[i], pulse * 0.5);
        } else if (special === SPECIAL_BOOST) {
          // Flowing beam-colored pulse so speed lanes read as moving.
          const flow = 0.5 + 0.5 * Math.sin(timeMs * 0.006 - (curr[base] + curr[base + 2]) * 0.6);
          target = this.specColor.set(this.theme.beam).lerp(this.tileColors[i], 0.45 + 0.35 * flow);
        } else if (special === SPECIAL_BOUNCY) {
          const soft = 0.55 + 0.25 * Math.sin(timeMs * 0.003 + i);
          target = this.specColor.set(0xffffff).lerp(this.tileColors[i], soft);
        } else {
          target = this.tileColors[i];
        }
        this.pieces.setColorAt(i, target);
      }
      this.pieces.instanceMatrix.needsUpdate = true;
      this.pieces.instanceColor!.needsUpdate = true;
    }

    for (let i = 0; i < sim.hazardCount; i++) {
      const base = sim.hazardBase(i);
      const mesh = this.hazardMeshes[i];
      this.lerpInto(mesh.position, mesh.quaternion, prev, curr, base, alpha);
    }

    // Several orbs may be on the map; each state slot is [x, y, z, 0|1+type].
    const orbsBase = sim.orbsBase();
    for (let k = 0; k < MAX_ORBS; k++) {
      const b = orbsBase + k * 4;
      const active = curr[b + 3] > 0.5;
      const orb = this.orbs[k];
      orb.visible = active;
      if (active) {
        // Spawn pop: it just went active → scale up with an elastic overshoot,
        // drop in from above and spin fast, settling over ~0.5s. No more
        // appearing out of nowhere.
        if (!this.prevOrbActive[k]) this.orbSpawn[k] = 0;
        this.prevOrbActive[k] = 1;
        if (this.orbSpawn[k] < 1) this.orbSpawn[k] = Math.min(1, this.orbSpawn[k] + dts / 0.5);
        const sp = this.orbSpawn[k];
        const back = 2.4; // easeOutBack overshoot
        const eb = sp >= 1 ? 1 : 1 + (back + 1) * (sp - 1) ** 3 + back * (sp - 1) ** 2;
        orb.scale.setScalar(Math.max(0.001, eb));
        const dropIn = (1 - sp) ** 2 * 2.2; // falls the last bit into place
        const spinUp = (1 - sp) * 11; // whirl that decelerates as it lands
        const orbType = ((Math.round(curr[b + 3]) - 1) % ORB_INFO.length + ORB_INFO.length) % ORB_INFO.length;
        const orbColor = ORB_INFO[orbType]?.color ?? 0xffc93c;
        const om = orb.material as THREE.MeshStandardMaterial;
        om.color.setHex(orbColor);
        om.emissive.setHex(orbColor);
        this.orbLights[k].color.setHex(orbColor);
        this.orbLights[k].intensity = 8 + (1 - sp) * 9; // bright flash on arrival, settles to 8
        orb.position.set(curr[b], curr[b + 1] + 0.15 * Math.sin(timeMs * 0.004 + k) + dropIn, curr[b + 2]);
        orb.rotation.y = timeMs * 0.002 + k + spinUp;
        // Point the type glyph at this orb; a gentle bob keeps it lively.
        const glyph = this.orbGlyphs[k];
        const gm = glyph.material as THREE.SpriteMaterial;
        if (gm.map !== this.orbGlyphTex[orbType]) {
          gm.map = this.orbGlyphTex[orbType];
          gm.needsUpdate = true;
        }
        glyph.position.y = 0.66 + 0.05 * Math.sin(timeMs * 0.004 + k);
      } else {
        this.prevOrbActive[k] = 0; // reset so it pops again next time it spawns
      }
    }

    // Rey de la colina zone: follow m0/m1 smoothly; the sim parks z at -1000
    // while the zone is inactive.
    const zoneOn = simMode === MODE_KOTH && curr[mb + 2] > -900;
    if (zoneOn) {
      const zx = curr[mb + 1];
      const zz = curr[mb + 2];
      if (zx !== this.zoneTX || zz !== this.zoneTZ || !this.zoneShown) {
        this.zoneTX = zx;
        this.zoneTZ = zz;
        this.zoneTY = this.zoneFloorY(sim, curr, zx, zz);
      }
      if (!this.zoneShown) {
        this.zonePos.set(zx, this.zoneTY, zz);
        this.zoneShown = true;
      } else {
        const k = Math.min(1, dts * 7);
        this.zonePos.x += (this.zoneTX - this.zonePos.x) * k;
        this.zonePos.y += (this.zoneTY - this.zonePos.y) * k;
        this.zonePos.z += (this.zoneTZ - this.zonePos.z) * k;
      }
    }
    this.zoneAlpha += ((zoneOn ? 1 : 0) - this.zoneAlpha) * Math.min(1, dts * 6);
    if (!zoneOn && this.zoneAlpha < 0.02) this.zoneShown = false;
    this.zoneMesh.visible = this.zoneShown && this.zoneAlpha > 0.02;
    if (this.zoneMesh.visible) {
      this.zoneMesh.position.set(this.zonePos.x, this.zonePos.y + 0.07, this.zonePos.z);
      this.zoneMat.uniforms.uAlpha.value = this.zoneAlpha;
      this.zoneMat.uniforms.uTime.value = timeMs * 0.001;
    }
  }

  /** Top of the arena surface under the zone (max tile top near zx/zz). */
  private zoneFloorY(sim: Sim, curr: Float32Array, zx: number, zz: number): number {
    let y = -Infinity;
    for (let i = 0; i < sim.pieceCount; i++) {
      const base = sim.pieceBase(i);
      const state = pieceStateOf(curr[base + 7]);
      if (state !== PIECE_STATIC && state !== PIECE_WARNING) continue;
      if (Math.abs(curr[base] - zx) > 1.2 || Math.abs(curr[base + 2] - zz) > 1.2) continue;
      y = Math.max(y, curr[base + 1] + PIECE_SIZE.y / 2);
    }
    return Number.isFinite(y) ? y : 0.05;
  }

  render(dtMs: number, timeMs: number): void {
    this.fx.update(dtMs);
    this.skyMat.uniforms.uTime.value = timeMs * 0.001;
    this.abyssMat.uniforms.uTime.value = timeMs * 0.001;

    if (this.cameraMode === 0) {
      // ISOMÉTRICA: framing the whole arena, gentle look at the crowd.
      const e = this.arenaExt;
      this.camera.position
        .set(0, e * tuneVal(this.tune, 'isoH'), e * tuneVal(this.tune, 'isoD'))
        .add(this.fx.shakeOffset(this.shakeTmp, timeMs));
      this.camera.lookAt(this.lookTarget.x, 0, this.lookTarget.z);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    // Follow cams track the local player (or the crowd's centre in attract).
    const dts = Math.min(0.05, Math.max(1 / 240, dtMs / 1000));
    // Follow your ball while you're in; once you're out, drift to the crowd.
    const local = this.localSlot >= 0 && this.localAlive ? this.playerRoots[this.localSlot] : undefined;
    const fx = local ? local.position.x : this.lookTarget.x;
    const fy = local ? Math.max(0, local.position.y) : 0;
    const fz = local ? local.position.z : this.lookTarget.z;
    if (!this.camInit) {
      this.camFocus.set(fx, fy, fz);
      this.camInit = true;
    }
    // Ease the focus toward the ball so the follow is smooth, not twitchy.
    this.camFocus.x += (fx - this.camFocus.x) * Math.min(1, dts * 6);
    this.camFocus.y += (fy - this.camFocus.y) * Math.min(1, dts * 4);
    this.camFocus.z += (fz - this.camFocus.z) * Math.min(1, dts * 6);
    const shake = this.fx.shakeOffset(this.shakeTmp, timeMs);

    if (this.cameraMode === 1) {
      // DESDE ARRIBA: high and looking down, but tilted ~15° off vertical (a pure
      // top-down view whips around from the sensitive lookAt — that was the jitter).
      const h = Math.max(12, this.arenaExt * tuneVal(this.tune, 'topH'));
      this.camera.position.set(this.camFocus.x, this.camFocus.y + h, this.camFocus.z + h * 0.26);
      this.camera.position.addScaledVector(shake, 0.3);
      this.camera.lookAt(this.camFocus.x, this.camFocus.y, this.camFocus.z);
    } else {
      // TERCERA PERSONA: chase cam locked BEHIND the ball's heading, so you
      // always see its back and W drives it into the screen. Controls turn
      // camera-relative in main.ts (via chaseControlYaw) so W/A/S/D match.
      const hx = Math.sin(this.chaseYaw);
      const hz = Math.cos(this.chaseYaw);
      const back = tuneVal(this.tune, 'tpBack');
      const high = tuneVal(this.tune, 'tpHigh');
      this.camera.position.set(this.camFocus.x - hx * back, this.camFocus.y + high, this.camFocus.z - hz * back);
      this.camera.position.addScaledVector(shake, 0.4);
      this.camera.lookAt(this.camFocus.x + hx * 2.5, this.camFocus.y + 0.7, this.camFocus.z + hz * 2.5);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private lerpInto(
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    prev: Float32Array,
    curr: Float32Array,
    base: number,
    alpha: number,
  ): void {
    pos.set(
      prev[base] + (curr[base] - prev[base]) * alpha,
      prev[base + 1] + (curr[base + 1] - prev[base + 1]) * alpha,
      prev[base + 2] + (curr[base + 2] - prev[base + 2]) * alpha,
    );
    this.qa.set(prev[base + 3], prev[base + 4], prev[base + 5], prev[base + 6]);
    this.qb.set(curr[base + 3], curr[base + 4], curr[base + 5], curr[base + 6]);
    quat.slerpQuaternions(this.qa, this.qb, alpha);
  }
}
