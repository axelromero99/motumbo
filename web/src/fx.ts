// Particles, shockwave rings and camera shake. Purely cosmetic — never touches the sim.
import * as THREE from 'three';

const MAX_PARTICLES = 2000;
const RING_POOL = 8;
const RING_LIFE_MS = 460;
const PUNCH_DECAY_MS = 110;

function makeDotTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

function makeRingTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0)');
  grad.addColorStop(0.74, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.85, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

export interface BurstOptions {
  count?: number;
  speed?: number;
  up?: number;
  gravity?: number;
  life?: number;
}

export class FxSystem {
  readonly points: THREE.Points;
  /** Contains the pooled shockwave rings; must be added to the scene alongside `points`. */
  readonly ringGroup = new THREE.Group();

  private positions: Float32Array;
  private velocities: Float32Array;
  private colors: Float32Array;
  private baseColors: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private gravity: Float32Array;
  private cursor = 0;
  private trauma = 0;
  private tmpColor = new THREE.Color();
  private density = 1;

  private ringMeshes: THREE.Mesh[] = [];
  private ringMats: THREE.MeshBasicMaterial[] = [];
  private ringLife = new Float32Array(RING_POOL);
  private ringMaxScale = new Float32Array(RING_POOL);
  private ringCursor = 0;

  private punchX = 0;
  private punchZ = 0;

  constructor() {
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.velocities = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.baseColors = new Float32Array(MAX_PARTICLES * 3);
    this.life = new Float32Array(MAX_PARTICLES);
    this.maxLife = new Float32Array(MAX_PARTICLES);
    this.gravity = new Float32Array(MAX_PARTICLES);
    this.positions.fill(1e6);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.16,
      map: makeDotTexture(),
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;

    // Pooled horizontal shockwave rings (oldest gets recycled).
    const ringTex = makeRingTexture();
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < RING_POOL; i++) {
      const rmat = new THREE.MeshBasicMaterial({
        map: ringTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0,
      });
      const mesh = new THREE.Mesh(ringGeo, rmat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      this.ringGroup.add(mesh);
      this.ringMeshes.push(mesh);
      this.ringMats.push(rmat);
    }
  }

  /** Global particle density multiplier (0..1) for quality scaling. */
  setDensity(d: number): void {
    this.density = Math.min(1, Math.max(0, d));
  }

  burst(x: number, y: number, z: number, color: number, opts: BurstOptions = {}): void {
    const { speed = 3, up = 1.5, gravity = 9, life = 600 } = opts;
    const count = Math.round((opts.count ?? 12) * this.density);
    if (count <= 0) return;
    this.tmpColor.setHex(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      const a = Math.random() * Math.PI * 2;
      const r = speed * (0.3 + Math.random() * 0.7);
      this.positions[i * 3] = x;
      this.positions[i * 3 + 1] = y;
      this.positions[i * 3 + 2] = z;
      this.velocities[i * 3] = Math.cos(a) * r;
      this.velocities[i * 3 + 1] = up * (0.4 + Math.random());
      this.velocities[i * 3 + 2] = Math.sin(a) * r;
      this.baseColors[i * 3] = this.tmpColor.r;
      this.baseColors[i * 3 + 1] = this.tmpColor.g;
      this.baseColors[i * 3 + 2] = this.tmpColor.b;
      this.life[i] = life * (0.6 + Math.random() * 0.4);
      this.maxLife[i] = this.life[i];
      this.gravity[i] = gravity;
    }
  }

  /** Expanding ground shockwave ring at (x, y, z). Scale eases out to maxScale while fading. */
  ring(x: number, y: number, z: number, color: number, maxScale = 3): void {
    const i = this.ringCursor;
    this.ringCursor = (this.ringCursor + 1) % RING_POOL;
    this.ringLife[i] = RING_LIFE_MS;
    this.ringMaxScale[i] = maxScale;
    const mesh = this.ringMeshes[i];
    mesh.position.set(x, y + 0.06, z);
    mesh.scale.setScalar(0.001);
    mesh.visible = true;
    this.ringMats[i].color.setHex(color);
    this.ringMats[i].opacity = 0.9;
  }

  /** Festive confetti rain over the arena (win celebration). */
  confetti(cx: number, cz: number, extent: number): void {
    const palette = [0xff5964, 0x35a7ff, 0xffe74c, 0x6bf178, 0xb388ff, 0xff9f1c, 0x2ec4b6, 0xffffff];
    const n = Math.round(150 * this.density);
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;
      this.positions[i * 3] = cx + (Math.random() * 2 - 1) * extent;
      this.positions[i * 3 + 1] = 11 + Math.random() * 7;
      this.positions[i * 3 + 2] = cz + (Math.random() * 2 - 1) * extent;
      this.velocities[i * 3] = (Math.random() * 2 - 1) * 1.6;
      this.velocities[i * 3 + 1] = -1 - Math.random() * 2.5;
      this.velocities[i * 3 + 2] = (Math.random() * 2 - 1) * 1.6;
      this.tmpColor.setHex(palette[(Math.random() * palette.length) | 0]);
      this.baseColors[i * 3] = this.tmpColor.r;
      this.baseColors[i * 3 + 1] = this.tmpColor.g;
      this.baseColors[i * 3 + 2] = this.tmpColor.b;
      this.life[i] = 2200 + Math.random() * 1600;
      this.maxLife[i] = this.life[i];
      this.gravity[i] = 2.6;
    }
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Directional camera punch (world-space XZ), decays exponentially in update(). */
  addPunch(dx: number, dz: number): void {
    this.punchX += dx;
    this.punchZ += dz;
    const m = Math.hypot(this.punchX, this.punchZ);
    const cap = 1.2;
    if (m > cap) {
      this.punchX *= cap / m;
      this.punchZ *= cap / m;
    }
  }

  /** Advance particles/rings and decay shake and punch. dt in milliseconds. */
  update(dt: number): void {
    const dts = dt / 1000;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = 1e6;
        this.colors[i * 3] = 0;
        this.colors[i * 3 + 1] = 0;
        this.colors[i * 3 + 2] = 0;
        continue;
      }
      this.velocities[i * 3 + 1] -= this.gravity[i] * dts;
      this.positions[i * 3] += this.velocities[i * 3] * dts;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dts;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dts;
      // Additive blending: fading to black fades the particle out.
      const k = this.life[i] / this.maxLife[i];
      this.colors[i * 3] = this.baseColors[i * 3] * k;
      this.colors[i * 3 + 1] = this.baseColors[i * 3 + 1] * k;
      this.colors[i * 3 + 2] = this.baseColors[i * 3 + 2] * k;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;

    for (let i = 0; i < RING_POOL; i++) {
      if (this.ringLife[i] <= 0) continue;
      this.ringLife[i] -= dt;
      const mesh = this.ringMeshes[i];
      if (this.ringLife[i] <= 0) {
        mesh.visible = false;
        this.ringMats[i].opacity = 0;
        continue;
      }
      const t = 1 - this.ringLife[i] / RING_LIFE_MS;
      const ease = 1 - (1 - t) ** 3;
      mesh.scale.setScalar(Math.max(0.001, this.ringMaxScale[i] * ease));
      this.ringMats[i].opacity = 0.9 * (1 - t);
    }

    this.trauma = Math.max(0, this.trauma - dt / 520);
    const decay = Math.exp(-dt / PUNCH_DECAY_MS);
    this.punchX *= decay;
    this.punchZ *= decay;
  }

  /** Camera offset for the current shake level plus directional punch. */
  shakeOffset(out: THREE.Vector3, timeMs: number): THREE.Vector3 {
    // Kept deliberately gentle: a big high-frequency amplitude reads as the whole
    // map "vibrating" rather than a punchy kick. The directional punch does the
    // impact feel; this is just seasoning.
    const s = this.trauma * this.trauma * 0.26;
    out.set(
      Math.sin(timeMs * 0.061) * s,
      Math.sin(timeMs * 0.083 + 2) * s,
      Math.sin(timeMs * 0.071 + 4) * s,
    );
    out.x += this.punchX;
    out.z += this.punchZ;
    return out;
  }
}
