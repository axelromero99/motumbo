// Three.js presentation layer. Reads interpolated snapshots of the sim state
// buffer and never writes anything back — rendering must not affect the sim.
import * as THREE from 'three';
import {
  Sim,
  PIECE_GONE,
  PIECE_WARNING,
  FLAG_ALIVE,
  FLAG_DASH_READY,
  FLAG_HAS_POWER,
  FLAG_BRACED,
  DASH_COOLDOWN_TICKS,
  dashCooldownFrom,
} from './sim';
import { FxSystem } from './fx';

export const PLAYER_COLORS = [0xff5964, 0x35a7ff, 0xffe74c, 0x6bf178, 0xb388ff, 0xff9f1c, 0x2ec4b6, 0xf72585];
const PIECE_SIZE = { x: 1.48, y: 0.8, z: 1.48 };
const PLAYER_RADIUS = 0.6;
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

// One visual identity per level, same order as LEVEL_NAMES:
// CLÁSICA, ANILLO, PUENTES, RULETA, PIRÁMIDE, HERRADURA, PASARELA, TARIMAS.
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

// Gradient dome (skyBottom → skyTop) with cheap hashed twinkling stars.
function makeSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSkyTop: { value: new THREE.Color(0x04060e) },
      uSkyBottom: { value: new THREE.Color(0x1c2750) },
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
      uniform float uTime;
      varying vec3 vDir;

      float hash(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
      }

      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(uSkyBottom, uSkyTop, pow(h, 1.35));

        // Twinkling stars: one candidate per direction-grid cell.
        vec3 g = d * 42.0;
        vec3 cell = floor(g);
        float rnd = hash(cell);
        if (rnd > 0.955) {
          vec3 off = vec3(hash(cell + 1.7), hash(cell + 3.1), hash(cell + 5.3)) - 0.5;
          float dist = length(fract(g) - 0.5 - off * 0.55);
          float star = smoothstep(0.14, 0.0, dist);
          float tw = 0.5 + 0.5 * sin(uTime * (1.5 + rnd * 4.0) + rnd * 100.0);
          col += star * tw * smoothstep(-0.05, 0.25, d.y) * (0.35 + 0.65 * hash(cell + 9.2));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Abyss floor: an animated grid drifting toward the center, fading to bg.
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

      void main() {
        vec2 p = vWorld.xz;
        float r = length(p);
        vec2 dir = p / max(r, 0.0001);
        // Sampling further out over time makes the pattern flow toward the center.
        vec2 uv = p / 3.0 + dir * uTime * 0.6;
        vec2 grid = abs(fract(uv - 0.5) - 0.5) / fwidth(uv);
        float line = 1.0 - min(min(grid.x, grid.y), 1.0);
        float fade = exp(-r * 0.05);
        vec3 col = mix(uBg, uBeam, line * fade * 0.85);
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

export class GameRenderer {
  readonly fx = new FxSystem();

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private cameraBase = new THREE.Vector3(0, 16, 15);
  private lookTarget = new THREE.Vector3(0, 0, 0);
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

  // Cosmetic per-player animation state (springs never touch the sim).
  private sqS = new Float32Array(0);
  private sqV = new Float32Array(0);
  private stretchK = new Float32Array(0);
  private prevVy = new Float32Array(0);
  private prevCdFrac = new Float32Array(0);
  private ringPulse = new Float32Array(0);
  private lastSimFrame = -1;
  private lastUpdateMs = -1;

  private hazardMeshes: THREE.Mesh[] = [];
  private orb: THREE.Mesh;
  private orbLight: THREE.PointLight;
  private theme: Theme = THEMES[0];
  private tileColors: THREE.Color[] = [];
  private pixelRatioCap = 2;
  private dummy = new THREE.Object3D();
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private qStretch = new THREE.Quaternion();
  private vTmp = new THREE.Vector3();
  private warnColor = new THREE.Color();

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
    this.sun.shadow.camera.left = -12;
    this.sun.shadow.camera.right = 12;
    this.sun.shadow.camera.top = 12;
    this.sun.shadow.camera.bottom = -12;
    this.sun.shadow.camera.far = 50;
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
  setup(sim: Sim): void {
    this.theme = THEMES[sim.level] ?? THEMES[0];
    this.scene.background = null;
    this.renderer.setClearColor(this.theme.bg, 1);
    this.scene.fog = new THREE.Fog(this.theme.bg, 28, 60);
    this.hemi.color.set(this.theme.sky);
    this.hemi.groundColor.set(this.theme.ground);
    (this.skyMat.uniforms.uSkyTop.value as THREE.Color).setHex(this.theme.skyTop);
    (this.skyMat.uniforms.uSkyBottom.value as THREE.Color).setHex(this.theme.skyBottom);
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
      this.playerMats[i].dispose();
    }
    for (let i = 0; i < this.cdRings.length; i++) {
      this.scene.remove(this.cdRings[i]);
      this.cdRings[i].geometry.dispose();
      this.cdRingMats[i].dispose();
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
    this.cdRings = [];
    this.cdRingMats = [];
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
      const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
      const mat = new THREE.MeshStandardMaterial({
        map: makeBallTexture(color, i, i + 1),
        roughness: 0.35,
        metalness: 0.15,
      });
      const mesh = new THREE.Mesh(sphereGeo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const deform = new THREE.Group();
      deform.add(mesh);
      const root = new THREE.Group();
      root.add(deform);
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
    }

    // Reset cosmetic animation state for the new round.
    this.sqS = new Float32Array(sim.playerCount).fill(1);
    this.sqV = new Float32Array(sim.playerCount);
    this.stretchK = new Float32Array(sim.playerCount).fill(1);
    this.prevVy = new Float32Array(sim.playerCount);
    this.prevCdFrac = new Float32Array(sim.playerCount).fill(1);
    this.ringPulse = new Float32Array(sim.playerCount);
    this.lastSimFrame = state[0];

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
    const dts = this.lastUpdateMs < 0 ? 1 / 60 : Math.min(0.05, Math.max(0, (timeMs - this.lastUpdateMs) / 1000));
    this.lastUpdateMs = timeMs;
    const tickChanged = curr[0] !== this.lastSimFrame;
    let cx = 0;
    let cz = 0;
    let aliveCount = 0;

    for (let i = 0; i < sim.playerCount; i++) {
      const base = sim.playerBase(i);
      const root = this.playerRoots[i];
      const deform = this.playerDeforms[i];
      const mesh = this.playerMeshes[i];
      const flags = curr[base + 7] | 0;
      const alive = (flags & FLAG_ALIVE) !== 0;
      root.visible = alive || curr[base + 1] > -8;
      this.lerpInto(root.position, mesh.quaternion, prev, curr, base, alpha);

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
        this.cdRings[i].position.set(root.position.x, root.position.y - PLAYER_RADIUS + 0.05, root.position.z);
        this.cdRings[i].scale.setScalar(1.9 * (1 + 0.4 * pulse * pulse));
        this.cdRingMats[i].uniforms.uFrac.value = cdFrac;
        this.cdRingMats[i].uniforms.uAlpha.value = 0.55 + 0.45 * pulse;
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
    this.skyMat.uniforms.uTime.value = timeMs * 0.001;
    this.abyssMat.uniforms.uTime.value = timeMs * 0.001;
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
