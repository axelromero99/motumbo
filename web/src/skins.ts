// Ball skins — a data-driven catalogue (community-extendable: add an entry to
// SKINS and it shows up in the picker). Each skin paints an equirectangular
// canvas (256×128) that wraps the ball, plus a MeshStandard material style.
// The player number is overlaid on every skin so balls stay identifiable.
import * as THREE from 'three';

const W = 256;
const H = 128;

type Ctx = CanvasRenderingContext2D;
type DrawFn = (g: Ctx, col: THREE.Color) => void;
type MatFn = (col: THREE.Color) => THREE.MeshStandardMaterialParameters;

export interface SkinDef {
  name: string;
  cat: 'bandera' | 'patrón' | 'material';
  draw: DrawFn;
  mat: MatFn;
}

// ---- shared helpers -------------------------------------------------------

// Grayscale bump map for material skins (linear color space — it's data).
const bumpCache: Record<string, THREE.CanvasTexture> = {};
function bump(kind: 'fur' | 'stone' | 'metal' | 'slime'): THREE.CanvasTexture {
  if (bumpCache[kind]) return bumpCache[kind];
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, 256, 128);
  if (kind === 'fur') {
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * 256;
      const y = Math.random() * 128;
      const a = Math.random() * Math.PI * 2;
      g.strokeStyle = Math.random() < 0.5 ? '#c8c8c8' : '#4a4a4a';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.cos(a) * 5, y + Math.sin(a) * 5);
      g.stroke();
    }
  } else if (kind === 'stone') {
    for (let i = 0; i < 900; i++) {
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
  const t = new THREE.CanvasTexture(c);
  bumpCache[kind] = t;
  return t;
}

const hex = (c: THREE.Color): string => `#${c.getHexString()}`;
const bands = (g: Ctx, cols: string[], vertical = false): void => {
  const n = cols.length;
  for (let i = 0; i < n; i++) {
    g.fillStyle = cols[i];
    if (vertical) g.fillRect((W / n) * i, 0, W / n + 1, H);
    else g.fillRect(0, (H / n) * i, W, H / n + 1);
  }
};
const disc = (g: Ctx, cx: number, r: number, col: string): void => {
  g.fillStyle = col;
  g.beginPath();
  g.arc(cx, H / 2, r, 0, 7);
  g.fill();
};
// A shape drawn on BOTH ball hemispheres (x=64 and x=192) so it's always seen.
const both = (g: Ctx, f: (cx: number) => void): void => {
  f(64);
  f(192);
};

// ---- the catalogue --------------------------------------------------------

const glossy = (col: THREE.Color): THREE.MeshStandardMaterialParameters => ({ roughness: 0.34, metalness: 0.12, color: col });

export const SKINS: SkinDef[] = [
  // ---------- 12 banderas (ignoran el color de equipo) ----------
  { name: 'Argentina', cat: 'bandera', draw: (g) => { bands(g, ['#75aadb', '#ffffff', '#75aadb']); both(g, (cx) => disc(g, cx, 15, '#f6b40e')); }, mat: glossy },
  { name: 'Uruguay', cat: 'bandera', draw: (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); for (let i = 1; i < 9; i += 2) { g.fillStyle = '#0038a8'; g.fillRect(0, (H / 9) * i, W, H / 9); } both(g, (cx) => disc(g, cx - 40, 12, '#fcd116')); }, mat: glossy },
  { name: 'Brasil', cat: 'bandera', draw: (g) => { g.fillStyle = '#009c3b'; g.fillRect(0, 0, W, H); both(g, (cx) => { g.fillStyle = '#ffdf00'; g.beginPath(); g.moveTo(cx - 34, 64); g.lineTo(cx, 30); g.lineTo(cx + 34, 64); g.lineTo(cx, 98); g.closePath(); g.fill(); disc(g, cx, 15, '#002776'); }); }, mat: glossy },
  { name: 'España', cat: 'bandera', draw: (g) => { g.fillStyle = '#aa151b'; g.fillRect(0, 0, W, H); g.fillStyle = '#f1bf00'; g.fillRect(0, H * 0.28, W, H * 0.44); }, mat: glossy },
  { name: 'Italia', cat: 'bandera', draw: (g) => bands(g, ['#009246', '#ffffff', '#ce2b37'], true), mat: glossy },
  { name: 'Francia', cat: 'bandera', draw: (g) => bands(g, ['#0055a4', '#ffffff', '#ef4135'], true), mat: glossy },
  { name: 'Alemania', cat: 'bandera', draw: (g) => bands(g, ['#000000', '#dd0000', '#ffce00']), mat: glossy },
  { name: 'Japón', cat: 'bandera', draw: (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); both(g, (cx) => disc(g, cx, 24, '#bc002d')); }, mat: glossy },
  { name: 'México', cat: 'bandera', draw: (g) => { bands(g, ['#006847', '#ffffff', '#ce1126'], true); both(g, (cx) => disc(g, cx, 12, '#8a5a2b')); }, mat: glossy },
  { name: 'Colombia', cat: 'bandera', draw: (g) => { g.fillStyle = '#fcd116'; g.fillRect(0, 0, W, H); g.fillStyle = '#003893'; g.fillRect(0, H / 2, W, H / 4); g.fillStyle = '#ce1126'; g.fillRect(0, (H * 3) / 4, W, H / 4); }, mat: glossy },
  { name: 'Chile', cat: 'bandera', draw: (g) => { g.fillStyle = '#fff'; g.fillRect(0, 0, W, H); g.fillStyle = '#d52b1e'; g.fillRect(0, H / 2, W, H / 2); both(g, (cx) => { g.fillStyle = '#0039a6'; g.fillRect(cx - 44, 0, 40, H / 2); g.fillStyle = '#fff'; g.font = '900 30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('★', cx - 24, 32); }); }, mat: glossy },
  { name: 'Japón Sol', cat: 'bandera', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); both(g, (cx) => { for (let k = 0; k < 16; k++) { const a = (k * Math.PI) / 8; g.fillStyle = k % 2 ? '#ffffff' : '#ffe36e'; g.beginPath(); g.moveTo(cx, 64); g.lineTo(cx + Math.cos(a) * 60, 64 + Math.sin(a) * 60); g.lineTo(cx + Math.cos(a + 0.4) * 60, 64 + Math.sin(a + 0.4) * 60); g.closePath(); g.fill(); } disc(g, cx, 14, '#e60026'); }); }, mat: glossy },

  // ---------- 10 patrones (usan el color de equipo) ----------
  ...([
    ['Rayas', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; for (let i = 0; i < 8; i += 2) g.fillRect(32 * i, 0, 32, H); }],
    ['Lunares', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; for (let r = 0; r < 4; r++) for (let col = 0; col < 6; col++) { g.beginPath(); g.arc(col * 44 + (r % 2) * 22, r * 34 + 16, 11, 0, 7); g.fill(); } }],
    ['Bandas', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; for (let y = 0; y < H; y += 42) g.fillRect(0, y, W, 20); }],
    ['Damero', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 0) g.fillRect(x * 32, y * 32, 32, 32); }],
    ['Diagonal', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.strokeStyle = d; g.lineWidth = 16; for (let x = -96; x < W; x += 48) { g.beginPath(); g.moveTo(x, -8); g.lineTo(x + 80, 136); g.stroke(); } }],
    ['Onda', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.strokeStyle = d; g.lineWidth = 14; g.beginPath(); for (let x = 0; x <= W; x += 4) { const y = 64 + Math.sin((x / W) * Math.PI * 4) * 34; x === 0 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke(); }],
    ['Aros', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.strokeStyle = d; g.lineWidth = 9; for (const cx of [64, 192]) for (const r of [36, 54]) { g.beginPath(); g.arc(cx, 64, r, 0, 7); g.stroke(); } }],
    ['Triángulos', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; for (let x = 0; x < W; x += 52) { g.beginPath(); g.moveTo(x, 96); g.lineTo(x + 22, 32); g.lineTo(x + 44, 96); g.closePath(); g.fill(); } }],
    ['Estrellas', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; g.font = '30px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; for (let r = 0; r < 4; r++) for (let col = 0; col < 8; col++) g.fillText('★', col * 32 + (r % 2) * 16, r * 32 + 18); }],
    ['Camuflaje', (g: Ctx, c: string, d: string) => { g.fillStyle = c; g.fillRect(0, 0, W, H); g.fillStyle = d; for (let i = 0; i < 40; i++) { g.beginPath(); g.arc(Math.random() * W, Math.random() * H, 8 + Math.random() * 16, 0, 7); g.fill(); } }],
  ] as [string, (g: Ctx, c: string, d: string) => void][]).map(([name, fn]): SkinDef => ({
    name,
    cat: 'patrón',
    draw: (g, col) => fn(g, hex(col), hex(col.clone().multiplyScalar(0.55))),
    mat: glossy,
  })),

  // ---------- 8 materiales (usan el color de equipo) ----------
  { name: 'Metal', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); }, mat: (col) => ({ color: col, roughness: 0.28, metalness: 0.95, bumpMap: bump('metal'), bumpScale: 0.015 }) },
  { name: 'Peluda', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); }, mat: (col) => ({ color: col, roughness: 1, metalness: 0, bumpMap: bump('fur'), bumpScale: 0.09 }) },
  { name: 'Slime', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); }, mat: (col) => ({ color: col, roughness: 0.05, metalness: 0.1, emissive: col.clone().multiplyScalar(0.4), emissiveIntensity: 0.45, bumpMap: bump('slime'), bumpScale: 0.05 }) },
  { name: 'Neón', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); }, mat: (col) => ({ color: col, roughness: 0.5, metalness: 0.2, emissive: col, emissiveIntensity: 0.6 }) },
  { name: 'Piedra', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); }, mat: (col) => ({ color: col, roughness: 1, metalness: 0.05, bumpMap: bump('stone'), bumpScale: 0.08 }) },
  { name: 'Cromo', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col); g.fillRect(0, 0, W, H); }, mat: (col) => ({ color: col, roughness: 0.1, metalness: 1 }) },
  { name: 'Galaxia', cat: 'material', draw: (g, col) => { g.fillStyle = hex(col.clone().multiplyScalar(0.4)); g.fillRect(0, 0, W, H); g.fillStyle = '#fff'; for (let i = 0; i < 90; i++) { g.globalAlpha = Math.random(); g.beginPath(); g.arc(Math.random() * W, Math.random() * H, Math.random() * 1.6, 0, 7); g.fill(); } g.globalAlpha = 1; }, mat: (col) => ({ color: col, roughness: 0.4, metalness: 0.35, emissive: col.clone().multiplyScalar(0.18), emissiveIntensity: 0.35 }) },
  { name: 'Lava', cat: 'material', draw: (g) => { g.fillStyle = '#1a0a05'; g.fillRect(0, 0, W, H); for (let i = 0; i < 24; i++) { g.strokeStyle = i % 2 ? '#ff5a1e' : '#ffb03a'; g.lineWidth = 2 + Math.random() * 3; g.beginPath(); let x = Math.random() * W, y = Math.random() * H; g.moveTo(x, y); for (let k = 0; k < 4; k++) { x += (Math.random() - 0.5) * 40; y += (Math.random() - 0.5) * 30; g.lineTo(x, y); } g.stroke(); } }, mat: (col) => ({ color: new THREE.Color(0x552211), emissive: new THREE.Color(0xff4400), emissiveIntensity: 0.7, roughness: 0.7 }) },
];

export const SKIN_COUNT = SKINS.length;

function overlayNumber(g: Ctx, num: string): void {
  g.font = '900 58px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const cx of [64, 192] as const) {
    g.lineWidth = 9;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText(num, cx, 66);
    g.fillStyle = '#ffffff';
    g.fillText(num, cx, 66);
  }
}

/** Build a ball material for a skin, tinted by the team color, with the number. */
export function makeSkinMaterial(skinIndex: number, colorHex: number, playerNumber: number): THREE.MeshStandardMaterial {
  const skin = SKINS[((skinIndex % SKIN_COUNT) + SKIN_COUNT) % SKIN_COUNT];
  const col = new THREE.Color(colorHex);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d')!;
  skin.draw(g, col);
  overlayNumber(g, String(playerNumber));
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const params = skin.mat(col);
  params.map = tex;
  // The canvas already carries every colour (team tint for patterns/materials,
  // absolute colours for flags). MeshStandardMaterial renders map × color, so
  // leaving color = the team tint double-multiplies it — flags come out a muddy
  // team-tinted blob, patterns/materials come out color². Force white so the map
  // shows exactly as painted.
  params.color = new THREE.Color(0xffffff);
  const material = new THREE.MeshStandardMaterial(params);
  // Remember the baked emissive so the per-frame aura (curse/power/dash) can
  // restore it instead of zeroing the glow on Slime/Neón/Galaxia/Lava.
  material.userData.baseEmissive = material.emissive.getHex();
  material.userData.baseEmissiveIntensity = material.emissiveIntensity;
  return material;
}

/** Small round thumbnail (data URL) of a skin for the picker UI. */
export function skinThumbnail(skinIndex: number, colorHex: number, size = 56): string {
  const skin = SKINS[((skinIndex % SKIN_COUNT) + SKIN_COUNT) % SKIN_COUNT];
  const full = document.createElement('canvas');
  full.width = W;
  full.height = H;
  skin.draw(full.getContext('2d')!, new THREE.Color(colorHex));
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  g.save();
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2, 0, 7);
  g.clip();
  // Sample the front hemisphere (around x=64) so the motif reads.
  g.drawImage(full, 20, 20, 88, 88, 0, 0, size, size);
  g.restore();
  return c.toDataURL();
}
