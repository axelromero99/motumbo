# TUMBO

Juego multijugador de sumo físico 3D en el navegador. Jugadores-esfera se empujan
fuera de una plataforma que se desmorona; el último en pie gana la ronda.

## Stack y arquitectura

- **`sim/tumbo.c`** — TODO el gameplay vive acá, en C, compilado a WASM con Emscripten.
  Usa Box3D (motor de física de Erin Catto, MIT, vendorizado en `vendor/box3d`).
  Es la fuente de verdad determinista para el multiplayer lockstep: JS solo escribe
  inputs empaquetados (uint32 por jugador) y lee un buffer de floats con el estado.
- **`web/`** — Vite + TypeScript + Three.js. Solo presentación e I/O:
  `sim.ts` (wrapper WASM), `render.ts` (Three), `input.ts` (teclado), `main.ts` (loop).
  Fixed timestep 60Hz con interpolación de render.
- **Netcode (`web/src/net.ts`)** — lockstep por WebRTC DataChannel (confiable+ordenado),
  input delay de 4 ticks, señalización por copiar/pegar código (sin servidores, STUN de
  Google), hash de estado cada 60 ticks como detector de desync. El host (slot 0) elige
  seed/nivel/revanchas vía mensaje START (con roundId para descartar paquetes viejos).
  Mensajes binarios de 8-10 bytes. Verificado con `scripts/test-lockstep.mjs` (dos
  instancias WASM reales + red simulada con latencia y peers a distinta velocidad).
  Limitación conocida: sin TURN, NATs simétricos pueden fallar. Para jugar por internet
  hay que deployar el build estático (localhost solo sirve para 2 pestañas / LAN).

## Reglas de determinismo (no romper)

- Nada de gameplay en JS: ninguna posición, velocidad ni decisión de juego se calcula fuera de `tumbo.c`.
- Tick fijo 1/60s, 4 substeps. El RNG es PCG32 dentro de la sim, sembrado en `tumbo_init`.
- Box3D compila con `-msimd128 -msse2` (WASM SIMD es determinista); un solo worker (`workerCount=1`).

## Build

- Toolchain portable (sin admin) en `C:\Users\user1\dev\tools`: CMake, Ninja, emsdk.
- `scripts\build-sim.ps1` — compila el sim a WASM y copia `tumbo.js`/`tumbo.wasm` a `web/src/gen/`.
- `cd web; npm run dev` — dev server.
- `scripts\setup.ps1` — clona `vendor/box3d` e instala npm deps en un clon fresco.
- `.github/workflows/build-wasm.yml` compila el WASM en CI (plan B sin toolchain local).

## Entorno Windows (importante)

Smart App Control bloquea binarios sin firma (error 4551), incluido el clang.exe de
emsdk. Para compilar localmente hay que desactivarlo (Seguridad de Windows → Control
de aplicaciones y navegador) o usar WSL2. El tooling web (node/vite) no está afectado.

## Layout del estado compartido C→JS

Header de 8 floats: `[frame, aliveMask, playerCount, pieceCount, winner, levelId, hazardCount, powerupActive]`.
Luego 8 floats por jugador (`x y z qx qy qz qw flags`; flags: 1=vivo, 2=dash listo, 4=con power),
8 por pieza (`x y z qx qy qz qw estado`; 1=estática, 2=cayendo, 3=aviso, 0=eliminada),
12 por hazard (`x y z qx qy qz qw sx sy sz tipo _`) y 4 del power-up (`x y z activo`).
`winner`: -1 en curso, -2 empate, si no índice del ganador.

## Eventos de gameplay (sim → presentación)

`tumbo_events_ptr()`/`tumbo_event_count()`: buffer de eventos del tick (6 floats:
`tipo x y z a b`), limpiado en cada `tumbo_step`. Tipos: 0 HIT (a=velocidad),
1 DASH (a=con power, b=jugador), 2 JUMP, 3 TILE_DROP, 4 TILE_WARN, 5 FALL,
6 ORB_SPAWN, 7 ORB_PICKUP, 8 ROUND_END (a=ganador). JS los consume para audio
sintetizado (`audio.ts`), partículas/screen-shake (`fx.ts`) y flujo de match
(`main.ts`: countdown 180 ticks con inputs congelados, primero a 5 rondas,
slow-mo al final de ronda). Los golpes de dash aplican knockback extra en el sim.

## Niveles

`tumbo_init(seed, players, level)` — 0 CLÁSICA (disco), 1 ANILLO (donut),
2 PUENTES (5 islas + puentes que caen primero), 3 RULETA (disco + barra giratoria
kinemática + desmoronamiento aleatorio por PCG). Teclas 1-4 en el juego.
