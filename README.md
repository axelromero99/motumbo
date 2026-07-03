# TUMBO

**Physics sumo party game in the browser.** Shove your rivals off a crumbling arena — last ball standing wins. 20 arenas, 4 game modes, a map editor, deterministic bots, and serverless 1v1 online multiplayer.

**[▶ Play it now](https://destap.github.io/tumbo/)** · ![ci](https://github.com/destap/tumbo/actions/workflows/ci.yml/badge.svg)

<!-- TODO: grabar y commitear docs/tumbo.gif, luego descomentar -->
<!-- ![gameplay](docs/tumbo.gif) -->

## Why this is interesting (for engineers)

The entire game simulation lives in **one deterministic C file** ([`sim/tumbo.c`](sim/tumbo.c)) compiled to WebAssembly, built on [Box3D](https://github.com/erincatto/box3d) (Erin Catto's 3D physics engine). JavaScript only renders, plays audio, and moves bytes.

That single design decision buys everything else:

- **Serverless multiplayer.** Peers connect over a WebRTC DataChannel and exchange **only inputs** — one 10-byte packet per tick (`type, round, tick, u32 input word`). Both simulations replay the same inputs and stay bit-identical: lockstep with a 4-tick input delay, no game server, no state sync. Signaling is a copy/paste code or invite link — zero infrastructure.
- **Desync tripwire.** Every 60 ticks each peer hashes its physics state (FNV-1a over player kinematics) and cross-checks. In testing it has never fired — and if it ever does, it will say so loudly instead of drifting silently.
- **Bots cost zero bandwidth.** The AI is part of the simulation (its own PCG32 stream, so enabling bots never perturbs world randomness). Every peer computes the same bot inputs locally.
- **Maps are data, not code.** The level editor emits a compact byte blob (~700 bytes max) mirrored between TypeScript and C. It's what gets saved, shared as a base64 code, and sent to your opponent before an online round.
- **Zero assets.** Music (20 generative themes with tension layers), SFX, ball textures, skybox, minimaps — all synthesized at runtime. The whole game is ~340 KB gzipped, physics engine included.

### Verified, not vibes

CI runs the determinism suite on every push:

- [`scripts/test-sim.mjs`](scripts/test-sim.mjs) — every arena, every game mode, an all-bot match and a custom map, each run twice and compared hash-by-hash.
- [`scripts/test-lockstep.mjs`](scripts/test-lockstep.mjs) — two real WASM instances exchanging inputs through a simulated network with variable latency and one peer running ~14% slower: all state checkpoints must match bit-for-bit.

There's also [`scripts/test-bots.mjs`](scripts/test-bots.mjs), a manual AI-tuning harness measuring bot survival time and self-elimination rate (it's how the bots went from dying at 3.8s to fighting through 14s rounds).

## Architecture

```
┌────────────────────── browser A ──────────────────────┐      ┌─── browser B ───┐
│  input.ts ──► uint32 word                             │      │                 │
│                  │ (scheduled +4 ticks, sent to peer) │◄────►│  WebRTC         │
│                  ▼                                    │ 10 B │  DataChannel    │
│  ┌─────────── sim/tumbo.c (WASM) ────────────┐        │ /tick│                 │
│  │ Box3D physics · levels · modes · bots ·   │        │      │  same sim,      │
│  │ crumble · events · PCG32 · state hash     │        │      │  same inputs,   │
│  └──────┬─────────────────────┬──────────────┘        │      │  same bits      │
│         ▼ state buffer        ▼ event buffer          │      └─────────────────┘
│  render.ts (Three.js)   audio.ts / music.ts / fx.ts   │
└───────────────────────────────────────────────────────┘
```

Determinism rules: fixed 60 Hz tick with 4 substeps, all game math in C (`-ffp-contract=off`, WASM SIMD), RNG seeded at init, one physics worker. No gameplay value is ever computed in JS.

## Run it locally

```
scripts\setup.ps1      # clones vendor/box3d, installs web deps
scripts\build-sim.ps1  # C -> WASM (needs CMake + Ninja + Emscripten; see below)
cd web
npm run dev
```

Tests:

```
node scripts/test-sim.mjs
node scripts/test-lockstep.mjs
```

The toolchain is portable (no admin): CMake, Ninja and [emsdk](https://github.com/emscripten-core/emsdk) anywhere on your PATH. CI (`.github/workflows/ci.yml`) is the reference build if you get stuck.

## Known limitations

- **No TURN server** — WebRTC with public STUN only, so a small but real fraction of pairings (symmetric/restrictive NATs) can't connect. A TURN relay would fix it at the cost of "serverless".
- **Desktop only** — keyboard controls; touch support is on the roadmap.
- Online is 1v1 for now (the lockstep core generalizes to N players; host-relay is designed but not built).

## Stack

C17 · [Box3D](https://github.com/erincatto/box3d) (vendored) · Emscripten · TypeScript · Three.js · Vite · WebRTC · WebAudio

---

## Español

Juego de sumo físico: empujá a tus rivales fuera de una arena que se desmorona. **Toda la simulación vive en un archivo C determinista** compilado a WASM — JS solo presenta. Por eso el multiplayer no necesita servidores (solo viajan inputs de 10 bytes por WebRTC), los bots funcionan online gratis (son parte de la simulación) y los mapas del editor se comparten como un código de texto.

- **Jugar**: [destap.github.io/tumbo](https://destap.github.io/tumbo/) — SOLO contra bots, LOCAL de a 2, u ONLINE con link de invitación.
- **Correr local**: `scripts\setup.ps1`, `scripts\build-sim.ps1`, `cd web && npm run dev`.
- **Tests de determinismo**: `node scripts/test-sim.mjs` (20 arenas + modos + bots + mapas custom, bit-idénticos) y `node scripts/test-lockstep.mjs` (dos instancias WASM con red simulada con latencia).

Licencia MIT. Física: Box3D de Erin Catto (MIT).
