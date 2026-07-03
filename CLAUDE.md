# TUMBO

Juego multijugador de sumo físico 3D en el navegador. Jugadores-esfera se empujan
fuera de una plataforma que se desmorona; el último en pie gana la ronda.

## Stack y arquitectura

- **`sim/tumbo.c`** — TODO el gameplay vive acá, en C, compilado a WASM con Emscripten.
  Usa Box3D (motor de física de Erin Catto, MIT, vendorizado en `vendor/box3d`).
  Es la fuente de verdad determinista para el multiplayer lockstep: JS solo escribe
  inputs empaquetados (uint32 por jugador) y lee un buffer de floats con el estado.
- **`web/`** — Vite + TypeScript + Three.js. Solo presentación e I/O:
  `sim.ts` (wrapper WASM), `render.ts` (Three: skybox/abismo por shader, squash&stretch,
  anillo de cooldown, texturas de bola con patrón+número), `fx.ts` (partículas, shockwaves,
  shake+punch), `audio.ts` (SFX sintetizados, buses), `music.ts` (música procedural
  adaptativa por nivel, capas por tensión), `input.ts` (teclado), `ui.ts` (shell de
  pantallas: título/setup/online/pausa/resultados/opciones, settings en localStorage),
  `minimap.ts` (thumbs de nivel autogenerados), `stats.ts` (stats de match y de por vida),
  `main.ts` (conductor). Fixed timestep 60Hz con interpolación de render. Attract mode:
  detrás del título corre una partida de 4 bots.
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
Luego 8 floats por jugador (`x y z qx qy qz qw flags`; flags: bit0 vivo, bit1 dash listo,
bit2 con power, bits3-8 cooldown de dash, bit9 anclado), 8 por pieza (`x y z qx qy qz qw estado`;
1=estática, 2=cayendo, 3=aviso, 0=eliminada), 12 por hazard (`x y z qx qy qz qw sx sy sz tipo _`;
tipo 0=viga, 1=pistón) y 4 del power-up (`x y z activo`).
`winner`: -1 en curso, -2 empate, si no índice del ganador.

## Mecánicas (todas en el sim)

Mover (fuerzas, control aéreo 45%), dash con cooldown 45 ticks + knockback extra al
golpear, salto (raycast de suelo con categorías), **anclarse** (IN_BRACE=64: frena y
aguanta empujones ×0.35; si el brace tiene ≤8 ticks al recibir un dash = **parry**, el
impulso rebota al atacante), input buffer + coyote time (6 ticks), robo de orbe al
golpear al portador. **Bots deterministas** (`tumbo_set_bot(slot, dif 0-2)` tras init,
idéntico en cada peer): PCG32 propio (seed^0xB07B07), huyen de baldosas condenadas,
van al orbe, dashean hacia el borde, esquivan la viga, bracean contra dashes.

## Eventos de gameplay (sim → presentación)

`tumbo_events_ptr()`/`tumbo_event_count()`: buffer de eventos del tick (6 floats:
`tipo x y z a b`), limpiado en cada `tumbo_step`. Tipos: 0 HIT (a=velocidad),
1 DASH (a=con power, b=jugador), 2 JUMP, 3 TILE_DROP, 4 TILE_WARN, 5 FALL,
6 ORB_SPAWN, 7 ORB_PICKUP, 8 ROUND_END (a=ganador). JS los consume para audio
sintetizado (`audio.ts`), partículas/screen-shake (`fx.ts`) y flujo de match
(`main.ts`: countdown 180 ticks con inputs congelados, primero a 5 rondas,
slow-mo al final de ronda). Los golpes de dash aplican knockback extra en el sim.

## Niveles (20) y modos (4)

`tumbo_init(seed, players, level)` — 0 CLÁSICA, 1 ANILLO, 2 PUENTES, 3 RULETA,
4 PIRÁMIDE, 5 HERRADURA, 6 PASARELA, 7 TARIMAS, 8 CRUZ, 9 ASPAS (molinete espiral),
10 GEMELAS (2 discos + puente), 11 PANAL (pads 2×2 con huecos), 12 DIANA (anillos
concéntricos), 13 VOLCÁN (cráter que crece: derrumbe centro→afuera), 14 ZIGURAT
(4 terrazas hasta 2.4m), 15 TORRES (campo + 2 torres refugio), 16 RULETA DOBLE
(2 vigas contrarrotantes), 17 FÁBRICA (4 pistones), 18 MARTILLO (bloque orbitante,
hazard tipo 2 con órbita analítica), 19 CALLES (retícula, derrumbe aleatorio).
Hazards: 0 viga (a=vel), 1 pistón Z (a=vel, b=fase), 2 orbitador (a=ω, b=fase,
c=radio), 3 pistón X. Todos inertes durante el countdown. LEVEL_CUSTOM=20.

**Modos** (`tumbo_set_mode(mode, param)` tras init, idéntico en cada peer; consume
el RNG del mundo): 0 SUMO, 1 REY DE LA COLINA (zona se muda c/10s, puntuás SOLO
adentro, param=segundos), 2 COSECHA (param=orbes), 3 MALDITO (papa caliente por
contacto, param=segundos de mecha; al vencer explota con onda expansiva). Sección
de modo al final del estado: [mode, m0, m1, m2] + 8 scores (KOTH: m0/m1=zona x/z;
MALDITO: m0=maldito, m1=ticks). Flags: bit10=maldito. Eventos: 9 DASH_HIT, 10 PARRY,
11 CURSE (a=nuevo, b=anterior), 12 ZONE (movida), 13 MODE_POINT (a=jugador, b=score).
Teclas 1-8 atajo de nivel; el START de red lleva [level, resetWins, winTarget, mode,
modeParam].

## Mapas custom (nivel 8)

El mapa es un blob de bytes (layout en `web/src/mapcodec.ts`, espejado en
`BuildCustomLevel` de tumbo.c): baldosas en grilla 15×15 con 3 alturas, hasta 8
spawns, velocidad de derrumbe y barra giratoria opcional. JS lo escribe con
`sim.loadCustomMap(bytes)` ANTES de `tumbo_init(seed, players, 8)`; en online el
host lo manda con MSG_MAP antes del START (canal ordenado). Editor visual en
`web/src/editor.ts` (pantalla propia, storage 'tumbo.maps.v1', export/import
base64 para compartir). Bytes inválidos caen a CLÁSICA — nunca rompe.
