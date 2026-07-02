import {
  Sim,
  TICK_MS,
  LEVEL_NAMES,
  EVENT_FLOATS,
  EVT_HIT,
  EVT_DASH,
  EVT_JUMP,
  EVT_TILE_DROP,
  EVT_TILE_WARN,
  EVT_FALL,
  EVT_ORB_SPAWN,
  EVT_ORB_PICKUP,
  EVT_ROUND_END,
} from './sim';
import { LocalInput } from './input';
import { GameRenderer, PLAYER_COLORS } from './render';
import { AudioEngine } from './audio';
import { NetSession, Lockstep, msgStart, MSG_INPUT, MSG_HASH, MSG_START } from './net';

const PLAYER_NAMES = ['ROJO', 'AZUL', 'AMARILLO', 'VERDE', 'VIOLETA', 'NARANJA', 'TURQUESA', 'ROSA'];
const WIN_TARGET = 5;
const TILE_DUST = 0x9aa4c0;

const HELP_LOCAL =
  'P1 <kbd>WASD</kbd> · dash <kbd>Shift izq.</kbd> · salto <kbd>Espacio</kbd> &nbsp;|&nbsp; ' +
  'P2 <kbd>Flechas</kbd> · dash <kbd>Shift der.</kbd> · salto <kbd>Ctrl der.</kbd> &nbsp;|&nbsp; ' +
  '<kbd>1</kbd>–<kbd>4</kbd> nivel · <kbd>R</kbd> revancha';
const HELP_NET =
  '<kbd>WASD</kbd> mover · dash <kbd>Shift izq.</kbd> · salto <kbd>Espacio</kbd>' +
  ' &nbsp;|&nbsp; el anfitrión elige nivel (<kbd>1</kbd>–<kbd>4</kbd>) y revancha (<kbd>R</kbd>)';

type Mode = 'menu' | 'local' | 'net';

function randomSeed(): number {
  return (Math.random() * 0xffffffff) >>> 0;
}

async function main(): Promise<void> {
  const $ = (id: string): HTMLElement => document.getElementById(id)!;
  const app = $('app');
  const status = $('status');
  const banner = $('banner');
  const countdownEl = $('countdown');
  const netwait = $('netwait');
  const help = $('help');
  const menu = $('menu');
  const netPanel = $('net-panel');
  const netInstructions = $('net-instructions');
  const netStatus = $('net-status');
  const netOut = $('net-out') as HTMLTextAreaElement;
  const netIn = $('net-in') as HTMLTextAreaElement;

  const sim = await Sim.create();
  const renderer = new GameRenderer(app);
  const input = new LocalInput();
  const audio = new AudioEngine();

  // Browsers require a user gesture before audio can start.
  const unlock = (): void => audio.unlock();
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);

  let mode: Mode = 'menu';
  let seed = 1;
  let level = 0;
  const playerCount = 2;
  const wins = new Array<number>(playerCount).fill(0);
  let matchOver = false;
  let timeScale = 1;
  let slowmoUntil = 0;
  let restartAt = 0;
  let lastCountShown = -1;
  let acc = 0;

  // Netplay state.
  let session: NetSession | null = null;
  let lockstep: Lockstep | null = null;
  let isHost = false;
  let mySlot = 0;
  let roundId = 0;
  let lastNetProgress = 0;
  let desyncShown = false;

  const colorName = (i: number): string => {
    const you = mode === 'net' && i === mySlot ? ' (vos)' : '';
    return `<span style="color:#${PLAYER_COLORS[i].toString(16).padStart(6, '0')}">${PLAYER_NAMES[i]}${you}</span>`;
  };

  const scoreLine = (): string => wins.map((w, i) => `${colorName(i)}&nbsp;${w}`).join(' &nbsp;·&nbsp; ');

  const resetRoundLocals = (): void => {
    banner.style.display = 'none';
    timeScale = 1;
    slowmoUntil = 0;
    restartAt = 0;
    lastCountShown = -1;
    acc = 0;
    desyncShown = false;
  };

  const startLocalRound = (): void => {
    if (matchOver) {
      wins.fill(0);
      matchOver = false;
    }
    sim.init(seed++, playerCount, level);
    renderer.setup(sim);
    resetRoundLocals();
  };

  const startNetRound = (netSeed: number, lvl: number, round: number): void => {
    level = lvl;
    roundId = round;
    sim.init(netSeed, playerCount, lvl);
    renderer.setup(sim);
    lockstep = new Lockstep(session!, mySlot, round);
    lastNetProgress = performance.now();
    resetRoundLocals();
    menu.style.display = 'none';
    mode = 'net';
    help.innerHTML = HELP_NET;
  };

  const hostNextRound = (resetWins: boolean): void => {
    if (!session) return;
    if (resetWins) {
      wins.fill(0);
      matchOver = false;
    }
    roundId = (roundId + 1) & 0xff;
    const netSeed = randomSeed();
    session.send(msgStart(roundId, netSeed, level, resetWins));
    startNetRound(netSeed, level, roundId);
  };

  // Boot with an idle arena behind the menu.
  sim.init(1, playerCount, 0);
  renderer.setup(sim);

  input.onReset = () => {
    if (mode === 'local') startLocalRound();
    else if (mode === 'net' && isHost) hostNextRound(matchOver);
  };
  input.onSelectLevel = (l: number) => {
    if (mode === 'local') {
      level = l % sim.levelCount;
      startLocalRound();
    } else if (mode === 'net' && isHost) {
      level = l % sim.levelCount;
      hostNextRound(matchOver);
    }
  };

  // ---------------------------------------------------------------------
  // Menu / signaling UI
  // ---------------------------------------------------------------------

  const wireSession = (): NetSession => {
    const s = new NetSession();
    s.onMessage = (v: DataView) => {
      const type = v.getUint8(0);
      if (type === MSG_INPUT) lockstep?.onRemoteInput(v.getUint8(1), v.getUint32(2, true), v.getUint32(6, true));
      else if (type === MSG_HASH) lockstep?.onRemoteHash(v.getUint8(1), v.getUint32(2, true), v.getUint32(6, true));
      else if (type === MSG_START && !isHost) {
        const round = v.getUint8(1);
        const netSeed = v.getUint32(2, true);
        const lvl = v.getUint8(6);
        if (v.getUint8(7) === 1) {
          wins.fill(0);
          matchOver = false;
        }
        startNetRound(netSeed, lvl, round);
      }
    };
    s.onClose = () => {
      if (mode === 'net') {
        mode = 'menu';
        lockstep = null;
        menu.style.display = 'flex';
        netStatus.textContent = '❌ conexión perdida';
      }
    };
    return s;
  };

  $('btn-local').addEventListener('click', () => {
    menu.style.display = 'none';
    mode = 'local';
    help.innerHTML = HELP_LOCAL;
    startLocalRound();
  });

  $('btn-host').addEventListener('click', async () => {
    isHost = true;
    mySlot = 0;
    session = wireSession();
    session.onOpen = () => {
      roundId = 0;
      const netSeed = randomSeed();
      wins.fill(0);
      matchOver = false;
      session!.send(msgStart(0, netSeed, level, true));
      startNetRound(netSeed, level, 0);
    };
    netPanel.hidden = false;
    netInstructions.innerHTML =
      '1) Copiá tu código y mandáselo al rival.<br>2) Pegá abajo el código que te devuelva y tocá <b>Conectar</b>.';
    netStatus.textContent = 'generando código…';
    netOut.value = await session.createOfferCode();
    netStatus.textContent = 'código listo ✔';
  });

  $('btn-join').addEventListener('click', () => {
    isHost = false;
    mySlot = 1;
    session = wireSession();
    session.onOpen = () => {
      netStatus.textContent = 'conectado ✔ esperando al anfitrión…';
    };
    netPanel.hidden = false;
    netOut.value = '';
    netInstructions.innerHTML =
      '1) Pegá abajo el código del anfitrión y tocá <b>Conectar</b>.<br>2) Copiá el código generado y mandáselo.';
    netStatus.textContent = '';
  });

  $('btn-connect').addEventListener('click', async () => {
    if (!session || !netIn.value.trim()) return;
    try {
      if (isHost) {
        netStatus.textContent = 'conectando…';
        await session.acceptAnswerCode(netIn.value);
      } else {
        netStatus.textContent = 'generando respuesta…';
        netOut.value = await session.acceptOfferCode(netIn.value);
        netStatus.textContent = 'respuesta lista ✔ mandásela al anfitrión';
      }
    } catch {
      netStatus.textContent = '⚠ código inválido, revisalo';
    }
  });

  $('btn-copy').addEventListener('click', () => {
    netOut.select();
    void navigator.clipboard.writeText(netOut.value);
  });

  // ---------------------------------------------------------------------
  // Gameplay event dispatch (sound / particles / match flow)
  // ---------------------------------------------------------------------

  const handleEvents = (events: Float32Array): void => {
    for (let e = 0; e < events.length; e += EVENT_FLOATS) {
      const type = events[e];
      const x = events[e + 1];
      const y = events[e + 2];
      const z = events[e + 3];
      const a = events[e + 4];
      const b = events[e + 5];
      const pcolor = b >= 0 ? PLAYER_COLORS[b % PLAYER_COLORS.length] : 0xffffff;

      switch (type) {
        case EVT_HIT:
          audio.hit(a);
          renderer.fx.burst(x, y, z, 0xffffff, { count: Math.min(24, Math.floor(a * 2.5)), speed: a * 0.5, life: 450 });
          if (a > 5) renderer.fx.addTrauma(Math.min(0.45, a * 0.035));
          break;
        case EVT_DASH:
          audio.dash(a > 0.5);
          renderer.fx.burst(x, y, z, a > 0.5 ? 0xffaa00 : pcolor, { count: a > 0.5 ? 26 : 10, speed: 2.5, life: 380 });
          renderer.fx.addTrauma(a > 0.5 ? 0.18 : 0.06);
          break;
        case EVT_JUMP:
          audio.jump();
          renderer.fx.burst(x, y - 0.5, z, TILE_DUST, { count: 6, speed: 1.2, up: 0.5, life: 300 });
          break;
        case EVT_TILE_WARN:
          audio.tileWarn();
          break;
        case EVT_TILE_DROP:
          audio.tileDrop();
          renderer.fx.burst(x, y + 0.4, z, TILE_DUST, { count: 14, speed: 1.6, up: 1, life: 550 });
          renderer.fx.addTrauma(0.08);
          break;
        case EVT_FALL:
          audio.fall();
          renderer.fx.burst(x, Math.max(y, -6), z, pcolor, { count: 36, speed: 4, up: 4, life: 800 });
          renderer.fx.addTrauma(0.3);
          break;
        case EVT_ORB_SPAWN:
          audio.orbSpawn();
          renderer.fx.burst(x, y, z, 0xffc93c, { count: 12, speed: 1.4, up: 0.8, gravity: 1, life: 500 });
          break;
        case EVT_ORB_PICKUP:
          audio.orbPickup();
          renderer.fx.burst(x, y, z, 0xffc93c, { count: 28, speed: 3, up: 2, gravity: 3, life: 650 });
          break;
        case EVT_ROUND_END: {
          const winner = a;
          renderer.fx.addTrauma(0.25);
          timeScale = 0.3;
          slowmoUntil = performance.now() + 1300;
          if (winner >= 0) {
            wins[winner]++;
            if (wins[winner] >= WIN_TARGET) {
              matchOver = true;
              audio.champion();
              const again = mode === 'net' && !isHost ? 'el anfitrión decide la revancha' : 'R para nuevo match';
              banner.innerHTML = `🏆 CAMPEÓN ${colorName(winner)} 🏆<br><small>${again}</small>`;
            } else {
              audio.roundEnd();
              banner.innerHTML = `GANA ${colorName(winner)}`;
              if (mode === 'local' || isHost) restartAt = performance.now() + 3200;
            }
          } else {
            audio.roundEnd();
            banner.innerHTML = 'EMPATE';
            if (mode === 'local' || isHost) restartAt = performance.now() + 3200;
          }
          banner.style.display = 'block';
          break;
        }
      }
    }
  };

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------

  let last = performance.now();

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    if (slowmoUntil > 0 && now >= slowmoUntil) {
      timeScale = 1;
      slowmoUntil = 0;
    }
    if (restartAt > 0 && now >= restartAt) {
      restartAt = 0;
      if (mode === 'local') startLocalRound();
      else if (mode === 'net' && isHost) hostNextRound(false);
    }

    const dt = now - last;
    last = now;
    acc += dt * timeScale;
    // Cap catch-up work after a background tab pause.
    if (acc > 250) acc = 250;

    if (mode === 'local') {
      while (acc >= TICK_MS) {
        const events = sim.step(input.words);
        acc -= TICK_MS;
        handleEvents(events);
      }
    } else if (mode === 'net' && lockstep) {
      let blocked = false;
      while (acc >= TICK_MS) {
        lockstep.scheduleLocal(input.words[0]);
        if (!lockstep.canStep()) {
          blocked = true;
          acc = Math.min(acc, TICK_MS * 2);
          break;
        }
        const events = sim.step(lockstep.buildWords());
        const checkpoint = (lockstep.tick + 1) % 60 === 0 ? sim.hash() : null;
        lockstep.advance(checkpoint);
        acc -= TICK_MS;
        handleEvents(events);
      }
      if (!blocked) lastNetProgress = now;
      netwait.style.display = now - lastNetProgress > 400 ? 'block' : 'none';
      if (lockstep.desync && !desyncShown) {
        desyncShown = true;
        banner.innerHTML = '⚠ DESYNC DETECTADO<br><small>esto no debería pasar — avisá al dev</small>';
        banner.style.display = 'block';
      }
    }

    renderer.update(sim, acc / TICK_MS, now);
    renderer.render(dt, now);

    if (mode !== 'menu') {
      // Round-start countdown display.
      const framesLeft = sim.countdownTicks - sim.frame;
      if (framesLeft > 0) {
        const count = Math.ceil(framesLeft / 60);
        countdownEl.textContent = String(count);
        countdownEl.style.display = 'block';
        if (count !== lastCountShown) {
          lastCountShown = count;
          audio.countdown(false);
        }
      } else if (framesLeft > -40) {
        if (lastCountShown !== 0) {
          lastCountShown = 0;
          audio.countdown(true);
        }
        countdownEl.textContent = '¡TUMBO!';
        countdownEl.style.display = 'block';
      } else {
        countdownEl.style.display = 'none';
      }

      const modeTag = mode === 'net' ? (isHost ? 'ONLINE (anfitrión)' : 'ONLINE') : 'LOCAL';
      status.innerHTML = `${modeTag} &nbsp;·&nbsp; ${LEVEL_NAMES[level]} &nbsp;·&nbsp; primero a ${WIN_TARGET} &nbsp;·&nbsp; ${scoreLine()}`;
    } else {
      status.innerHTML = '';
      countdownEl.style.display = 'none';
    }
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f88;padding:2rem">${String(err)}</pre>`;
});
