// Three.js presentation layer. Reads interpolated snapshots of the sim state
// buffer and never writes anything back — rendering must not affect the sim.
import * as THREE from 'three';
import { Sim, PIECE_GONE, PIECE_WARNING, FLAG_ALIVE, FLAG_DASH_READY, FLAG_HAS_POWER } from './sim';
import { FxSystem } from './fx';

export const PLAYER_COLORS = [0xff5964, 0x35a7ff, 0xffe74c, 0x6bf178, 0xb388ff, 0xff9f1c, 0x2ec4b6, 0xf72585];
const PIECE_SIZE = { x: 1.48, y: 0.8, z: 1.48 };
const PLAYER_RADIUS = 0.6;
const TRAIL_MIN_SPEED = 7.5;

interface Theme {
  bg: number;
  tileA: number;
  tileB: number;
  warn: number;
  beam: number;
  ground: number;
  sky: number;
}

// One visual identity per level: CLÁSICA, ANILLO, PUENTES, RULETA.
const THEMES: Theme[] = [
  { bg: 0x0b0e1a, tileA: 0x2e3a6e, tileB: 0x3d4c8f, warn: 0xff4040, beam: 0xffffff, ground: 0x1a1f33, sky: 0x9fb4ff },
  { bg: 0x160a06, tileA: 0x33201a, tileB: 0x4a2a1c, warn: 0xff7b00, beam: 0xffffff, ground: 0x33140a, sky: 0xffb38a },
  { bg: 0x0e1626, tileA: 0xd8e3f0, tileB: 0xaebfdc, warn: 0xff5964, beam: 0xffffff, ground: 0x25314d, sky: 0xcfe0ff },
  { bg: 0x150823, tileA: 0x3d2352, tileB: 0x582f78, warn: 0xff2e93, beam: 0x00e5ff, ground: 0x2a1440, sky: 0xe08aff },
];

// Striped equirectangular texture so the balls visibly roll.
function makeBallTexture(colorHex: number): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const base = new THREE.Color(colorHex);
  const dark = base.clone().multiplyScalar(0.72);
  g.fillStyle = `#${base.getHexString()}`;
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = `#${dark.getHexString()}`;
  const stripes = 6;
  for (let i = 0; i < stripes; i++) {
    if (i % 2 === 0) g.fillRect((256 / stripes) * i, 0, 256 / stripes, 128);
  }
  g.fillStyle = 'rgba(255,255,255,0.85)';
  for (const [cx, cy, r] of [
    [64, 40, 9],
    [192, 88, 9],
  ] as const) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class GameRenderer {
  readonly fx = new FxSystem();

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private cameraBase = new THREE.Vector3(0, 16, 15);
  private lookTarget = new THREE.Vector3(0, 0, 0);
  private shakeTmp = new THREE.Vector3();
  private hemi: THREE.HemisphereLight;
  private pieces: THREE.InstancedMesh | null = null;
  private players: THREE.Mesh[] = [];
  private playerMats: THREE.MeshStandardMaterial[] = [];
  private hazardMeshes: THREE.Mesh[] = [];
  private orb: THREE.Mesh;
  private orbLight: THREE.PointLight;
  private theme: Theme = THEMES[0];
  private tileColors: THREE.Color[] = [];
  private dummy = new THREE.Object3D();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private warnColor = new THREE.Color();

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.add(this.fx.points);

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.copy(this.cameraBase);
    this.camera.lookAt(0, 0, 0);

    this.hemi = new THREE.HemisphereLight(0x9fb4ff, 0x1a1f33, 0.8);
    this.scene.add(this.hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(10, 22, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -12;
    sun.shadow.camera.right = 12;
    sun.shadow.camera.top = 12;
    sun.shadow.camera.bottom = -12;
    sun.shadow.camera.far = 50;
    this.scene.add(sun);

    // Golden power orb, reused across rounds.
    this.orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 1),
      new THREE.MeshStandardMaterial({ color: 0xffc93c, emissive: 0xffaa00, emissiveIntensity: 1.4, roughness: 0.3 }),
    );
    this.orb.visible = false;
    this.orbLight = new THREE.PointLight(0xffb300, 8, 6);
    this.orb.add(this.orbLight);
    this.scene.add(this.orb);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /** (Re)build meshes for a fresh round from the sim's initial snapshot. */
  setup(sim: Sim): void {
    this.theme = THEMES[sim.level] ?? THEMES[0];
    this.scene.background = new THREE.Color(this.theme.bg);
    this.scene.fog = new THREE.Fog(this.theme.bg, 28, 60);
    this.hemi.color.set(this.theme.sky);
    this.hemi.groundColor.set(this.theme.ground);

    if (this.pieces) {
      this.scene.remove(this.pieces);
      this.pieces.geometry.dispose();
      (this.pieces.material as THREE.Material).dispose();
    }
    for (const p of this.players) {
      this.scene.remove(p);
      p.geometry.dispose();
      (p.material as THREE.Material).dispose();
    }
    for (const h of this.hazardMeshes) {
      this.scene.remove(h);
      h.geometry.dispose();
      (h.material as THREE.Material).dispose();
    }
    this.players = [];
    this.playerMats = [];
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

    const sphereGeo = new THREE.SphereGeometry(PLAYER_RADIUS, 32, 24);
    for (let i = 0; i < sim.playerCount; i++) {
      const mat = new THREE.MeshStandardMaterial({
        map: makeBallTexture(PLAYER_COLORS[i % PLAYER_COLORS.length]),
        roughness: 0.35,
        metalness: 0.15,
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this.players.push(mesh);
      this.playerMats.push(mat);
    }

    for (let i = 0; i < sim.hazardCount; i++) {
      const base = sim.hazardBase(i);
      const geo = new THREE.BoxGeometry(state[base + 7] * 2, state[base + 8] * 2, state[base + 9] * 2);
      const mat = new THREE.MeshStandardMaterial({
        color: this.theme.beam,
        emissive: this.theme.beam,
        emissiveIntensity: 0.35,
        roughness: 0.4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.hazardMeshes.push(mesh);
    }

    this.lookTarget.set(0, 0, 0);
  }

  /** Interpolate between the two most recent sim snapshots and draw. */
  update(sim: Sim, alpha: number, timeMs: number): void {
    const { prev, curr } = sim;
    let cx = 0;
    let cz = 0;
    let aliveCount = 0;

    for (let i = 0; i < sim.playerCount; i++) {
      const base = sim.playerBase(i);
      const mesh = this.players[i];
      const flags = curr[base + 7];
      const alive = (flags & FLAG_ALIVE) !== 0;
      mesh.visible = alive || curr[base + 1] > -8;
      this.lerpInto(mesh.position, mesh.quaternion, prev, curr, base, alpha);

      if (alive) {
        cx += curr[base];
        cz += curr[base + 2];
        aliveCount++;

        // Speed trail: spawn faint particles behind fast balls.
        const vx = (curr[base] - prev[base]) * 60;
        const vz = (curr[base + 2] - prev[base + 2]) * 60;
        if (Math.sqrt(vx * vx + vz * vz) > TRAIL_MIN_SPEED) {
          this.fx.burst(mesh.position.x, mesh.position.y, mesh.position.z, PLAYER_COLORS[i % PLAYER_COLORS.length], {
            count: 2,
            speed: 0.4,
            up: 0.3,
            gravity: 0.5,
            life: 320,
          });
        }
      }

      // Golden glow while carrying the power orb, faint self-glow while dash is ready.
      const mat = this.playerMats[i];
      if (flags & FLAG_HAS_POWER) {
        mat.emissive.setHex(0xffaa00);
        mat.emissiveIntensity = 0.9 + 0.4 * Math.sin(timeMs * 0.012);
      } else if (flags & FLAG_DASH_READY) {
        mat.emissive.setHex(PLAYER_COLORS[i % PLAYER_COLORS.length]);
        mat.emissiveIntensity = 0.22;
      } else {
        mat.emissiveIntensity = 0;
      }
    }

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
        const state = curr[base + 7];
        if (state === PIECE_GONE) {
          this.dummy.position.set(0, -1000, 0);
          this.dummy.quaternion.identity();
        } else {
          this.lerpInto(this.dummy.position, this.dummy.quaternion, prev, curr, base, alpha);
          if (state === PIECE_WARNING) {
            // Shake and flash before dropping (render-only, sim is untouched).
            this.dummy.position.x += Math.sin(timeMs * 0.09 + i) * 0.05;
            this.dummy.position.z += Math.cos(timeMs * 0.11 + i * 2) * 0.05;
          }
        }
        this.dummy.updateMatrix();
        this.pieces.setMatrixAt(i, this.dummy.matrix);

        const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.02 + i);
        const target =
          state === PIECE_WARNING ? this.warnColor.set(this.theme.warn).lerp(this.tileColors[i], pulse * 0.5) : this.tileColors[i];
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

    const orbBase = sim.powerupBase();
    const orbActive = curr[orbBase + 3] > 0.5;
    this.orb.visible = orbActive;
    if (orbActive) {
      this.orb.position.set(curr[orbBase], curr[orbBase + 1] + 0.15 * Math.sin(timeMs * 0.004), curr[orbBase + 2]);
      this.orb.rotation.y = timeMs * 0.002;
    }
  }

  render(dtMs: number, timeMs: number): void {
    this.fx.update(dtMs);
    this.camera.position.copy(this.cameraBase).add(this.fx.shakeOffset(this.shakeTmp, timeMs));
    this.camera.lookAt(this.lookTarget.x, 0, this.lookTarget.z);
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
