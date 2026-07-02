// Particles and camera shake. Purely cosmetic — never touches the sim.
import * as THREE from 'three';

const MAX_PARTICLES = 2000;

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

export interface BurstOptions {
  count?: number;
  speed?: number;
  up?: number;
  gravity?: number;
  life?: number;
}

export class FxSystem {
  readonly points: THREE.Points;
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
  }

  burst(x: number, y: number, z: number, color: number, opts: BurstOptions = {}): void {
    const { count = 12, speed = 3, up = 1.5, gravity = 9, life = 600 } = opts;
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

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Advance particles and decay shake. dt in milliseconds. */
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

    this.trauma = Math.max(0, this.trauma - dt / 700);
  }

  /** Camera offset for the current shake level. */
  shakeOffset(out: THREE.Vector3, timeMs: number): THREE.Vector3 {
    const s = this.trauma * this.trauma * 0.55;
    out.set(
      Math.sin(timeMs * 0.061) * s,
      Math.sin(timeMs * 0.083 + 2) * s,
      Math.sin(timeMs * 0.071 + 4) * s,
    );
    return out;
  }
}
