// Conductor: owns the mode state machine (menu/attract, solo, local, online),
// steps the sim, and routes sim events to audio/music/fx/UI. All gameplay
// truth lives in the WASM sim; everything here is presentation and I/O.
import {
  Sim,
  TICK_MS,
  LEVEL_NAMES,
  EVENT_FLOATS,
  FLAG_ALIVE,
  FLAG_DASH_READY,
  EVT_HIT,
  EVT_DASH,
  EVT_JUMP,
  EVT_TILE_DROP,
  EVT_TILE_WARN,
  EVT_FALL,
  EVT_ORB_SPAWN,
  EVT_ORB_PICKUP,
  EVT_ROUND_END,
  EVT_DASH_HIT,
  EVT_PARRY,
  PIECE_STATIC,
} from './sim';
import { LocalInput } from './input';
import { GameRenderer, PLAYER_COLORS } from './render';
import { AudioEngine } from './audio';
import { MusicEngine } from './music';
import { NetSession, Lockstep, msgStart, msgMap, MSG_INPUT, MSG_HASH, MSG_START, MSG_MAP, offerFromLocation } from './net';
import { UiShell, type Settings } from './ui';
import { renderLevelThumbs } from './minimap';
import { MatchStats } from './stats';
import { MapEditor, listMaps, getMapBytes } from './editor';
import { LEVEL_CUSTOM } from './mapcodec';

const PLAYER_NAMES = ['ROJO', 'AZUL', 'AMARILLO', 'VERDE', 'VIOLETA', 'NARANJA', 'TURQUESA', 'ROSA'];
const TILE_DUST = 0x9aa4c0;
const ORB_GOLD = 0xffc93c;

type Mode = 'menu' | 'local' | 'net';
type Intent = 'solo' | 'local' | 'net-host';

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

  const sim = await Sim.create();
  const renderer = new GameRenderer(app);
  const input = new LocalInput();
  const audio = new AudioEngine();
  const music = new MusicEngine();
  const stats = new MatchStats();

  // ---------------------------------------------------------------------
  // Session state
  // ---------------------------------------------------------------------

  let mode: Mode = 'menu';
  let intent: Intent = 'local';
  let seed = 1;
  let levelChoice: number | 'random' | { custom: string } | 'test' = 0;
  let testBytes: Uint8Array | null = null;
  let testTheme = 0;
  let pendingGuestMap: Uint8Array | null = null;
  let currentLevel = 0;
  let currentTheme = 0;
  let currentLevelName = LEVEL_NAMES[0];
  let winTarget = 5;
  let playerCount = 2;
  let botSlots: number[] = [];
  let wins: number[] = [];
  let matchOver = false;
  let paused = false;
  let timeScale = 1;
  let slowmoUntil = 0;
  let restartAt = 0;
  let lastCountShown = -1;
  let acc = 0;
  let crumbleToastShown = false;
  let lastScoreKey = '';
  let prevLocalDashReady = true;
  let reducedMotion = false;
  let attractTimer = 0;
  let attractLevel = 0;

  // Netplay state.
  let session: NetSession | null = null;
  let lockstep: Lockstep | null = null;
  let isHost = false;
  let mySlot = 0;
  let roundId = 0;
  let currentOfferCode = '';
  let connectTimeout = 0;
  let lastNetProgress = 0;
  let desyncShown = false;

  const isNetGuest = (): boolean => mode === 'net' && !isHost;

  const displayName = (i: number): string => {
    const you = (mode === 'net' && i === mySlot) || (intent === 'solo' && i === 0 && mode !== 'net') ? ' (vos)' : '';
    const bot = botSlots.includes(i) ? ' BOT' : '';
    return `${PLAYER_NAMES[i]}${bot}${you}`;
  };

  interface RoundSpec {
    level: number;
    theme: number;
    bytes: Uint8Array | null;
    name: string;
  }

  const resolveRound = (): RoundSpec => {
    if (levelChoice === 'test' && testBytes) {
      return { level: LEVEL_CUSTOM, theme: testTheme, bytes: testBytes, name: 'PRUEBA DEL EDITOR' };
    }
    if (typeof levelChoice === 'object') {
      const id = levelChoice.custom;
      const bytes = getMapBytes(id);
      if (bytes) {
        const meta = listMaps().find((m) => m.id === id);
        return { level: LEVEL_CUSTOM, theme: bytes[1] & 7, bytes, name: (meta?.name ?? 'CUSTOM').toUpperCase() };
      }
      levelChoice = 0;
    }
    const lvl = levelChoice === 'random' ? randomSeed() % sim.levelCount : (levelChoice as number) % sim.levelCount;
    return { level: lvl, theme: lvl, bytes: null, name: LEVEL_NAMES[lvl] };
  };

  // ---------------------------------------------------------------------
  // UI shell
  // ---------------------------------------------------------------------

  const applySettings = (s: Settings): void => {
    audio.setMasterVolume(s.volMaster);
    music.setVolume(s.volMusic);
    renderer.setQuality({ shadows: s.shadows, pixelRatioCap: 2 });
    renderer.fx.setDensity(s.particles);
    reducedMotion = s.reducedMotion;
  };

  const ui = new UiShell({
    onSolo: () => {
      audio.uiClick();
      intent = 'solo';
      ui.show('setup');
    },
    onLocal: () => {
      audio.uiClick();
      intent = 'local';
      ui.show('setup');
    },
    onOnline: (host: boolean) => {
      audio.uiClick();
      void beginOnline(host);
    },
    onConnectClicked: (code: string) => void connectWithCode(code),
    // UiShell already wrote code/link to the clipboard; we just confirm.
    onCopyCode: () => ui.toast('código copiado'),
    onInviteLink: () => ui.toast('link de invitación copiado'),
    onStartMatch: (level: number | 'random' | { custom: string }, target: number) => {
      audio.uiClick();
      levelChoice = level;
      winTarget = target;
      if (mode === 'net' || intent === 'net-host') {
        if (isHost) hostStartMatch();
      } else {
        startMatch();
      }
    },
    onEditor: () => {
      audio.uiClick();
      ui.show('none');
      editor.open();
    },
    onEditMap: (id: string) => {
      audio.uiClick();
      ui.show('none');
      editor.open(id);
    },
    onResume: () => setPaused(false),
    onQuitToTitle: () => quitToTitle(),
    onSettingsChanged: applySettings,
  });

  const editor = new MapEditor({
    onPlayTest: (bytes: Uint8Array, theme: number) => {
      editor.close();
      testBytes = bytes;
      testTheme = theme;
      levelChoice = 'test';
      intent = 'solo';
      winTarget = 3;
      startMatch();
    },
    onExit: () => {
      editor.close();
      ui.show('title');
    },
    onMapsChanged: () => ui.setCustomMaps(listMaps()),
  });
  ui.setCustomMaps(listMaps());
  applySettings(ui.settings);
  ui.setLifetimeLine(stats.summaryLine());

  // Browsers require a user gesture before audio can start.
  const unlock = (): void => audio.unlock();
  window.addEventListener('keydown', unlock);
  window.addEventListener('pointerdown', unlock);
  audio.onUnlock = () => {
    if (audio.context && audio.musicDestination) {
      music.attach(audio.context, audio.musicDestination);
      music.setVolume(ui.settings.volMusic);
    }
  };

  // Level thumbnails: cheap sim inits at boot, then hand the sim to attract.
  ui.setLevelThumbs(renderLevelThumbs(sim), LEVEL_NAMES);

  // ---------------------------------------------------------------------
  // Round / match lifecycle
  // ---------------------------------------------------------------------

  const resetRoundLocals = (): void => {
    banner.style.display = 'none';
    timeScale = 1;
    slowmoUntil = 0;
    restartAt = 0;
    lastCountShown = -1;
    acc = 0;
    desyncShown = false;
    crumbleToastShown = false;
    lastScoreKey = '';
    prevLocalDashReady = true;
  };

  const initRound = (roundSeed: number, spec: RoundSpec): void => {
    currentLevel = spec.level;
    currentTheme = spec.theme;
    currentLevelName = spec.name;
    if (spec.bytes) sim.loadCustomMap(spec.bytes);
    sim.init(roundSeed, playerCount, spec.level);
    for (const slot of botSlots) sim.setBot(slot, slot === playerCount - 1 ? 2 : 1);
    renderer.setup(sim, spec.theme);
    stats.onRoundStart(0);
    resetRoundLocals();
  };

  const startAttract = (): void => {
    mode = 'menu';
    playerCount = 4;
    botSlots = [0, 1, 2, 3];
    wins = [0, 0, 0, 0];
    matchOver = false;
    attractLevel = (attractLevel + 1) % sim.levelCount;
    currentLevel = attractLevel;
    currentTheme = attractLevel;
    currentLevelName = LEVEL_NAMES[attractLevel];
    sim.init(randomSeed(), 4, attractLevel);
    for (const slot of botSlots) sim.setBot(slot, 2);
    renderer.setup(sim);
    resetRoundLocals();
    attractTimer = performance.now() + 45000;
  };

  const startMatch = (): void => {
    mode = 'local';
    if (intent === 'solo') {
      playerCount = 4;
      botSlots = [1, 2, 3];
    } else {
      playerCount = 2;
      botSlots = [];
    }
    wins = new Array(playerCount).fill(0);
    matchOver = false;
    stats.reset(playerCount);
    initRound(seed++, resolveRound());
    ui.show('none');
    help.innerHTML = helpText();
    updateScorebar(true);
  };

  const startLocalRound = (): void => {
    if (matchOver) {
      wins.fill(0);
      matchOver = false;
      stats.reset(playerCount);
    }
    initRound(seed++, resolveRound());
    ui.show('none');
  };

  const quitToTitle = (): void => {
    session?.close();
    session = null;
    lockstep = null;
    paused = false;
    ui.setLifetimeLine(stats.summaryLine());
    startAttract();
    ui.show('title');
  };

  const setPaused = (value: boolean): void => {
    if (mode === 'menu') return;
    paused = value;
    ui.show(paused ? 'pause' : 'none');
    if (!paused) acc = 0;
  };

  // ---------------------------------------------------------------------
  // Online flow
  // ---------------------------------------------------------------------

  const wireSession = (): NetSession => {
    const s = new NetSession();
    s.onOpen = () => onChannelOpen();
    s.onMessage = (v: DataView) => {
      const type = v.getUint8(0);
      if (type === MSG_INPUT) lockstep?.onRemoteInput(v.getUint8(1), v.getUint32(2, true), v.getUint32(6, true));
      else if (type === MSG_HASH) lockstep?.onRemoteHash(v.getUint8(1), v.getUint32(2, true), v.getUint32(6, true));
      else if (type === MSG_MAP && !isHost) {
        const len = v.getUint16(1, true);
        pendingGuestMap = new Uint8Array(v.buffer.slice(v.byteOffset + 3, v.byteOffset + 3 + len));
      } else if (type === MSG_START && !isHost) {
        const round = v.getUint8(1);
        const netSeed = v.getUint32(2, true);
        const lvl = v.getUint8(6);
        if (v.getUint8(7) === 1) {
          matchOver = false;
          wins = [0, 0];
          stats.reset(2);
        }
        winTarget = v.getUint8(8);
        roundId = round;
        const spec: RoundSpec =
          lvl === LEVEL_CUSTOM && pendingGuestMap
            ? { level: LEVEL_CUSTOM, theme: pendingGuestMap[1] & 7, bytes: pendingGuestMap, name: 'MAPA DEL ANFITRIÓN' }
            : { level: lvl, theme: lvl, bytes: null, name: LEVEL_NAMES[lvl] ?? 'CUSTOM' };
        startNetRound(netSeed, spec, round);
      }
    };
    s.onClose = () => {
      if (mode === 'net') {
        ui.toast('❌ se cortó la conexión');
        quitToTitle();
      } else {
        ui.setOnlineState('error', 'Se cortó la conexión. Volvé a intentar.');
      }
    };
    return s;
  };

  async function beginOnline(host: boolean): Promise<void> {
    session?.close();
    isHost = host;
    mySlot = host ? 0 : 1;
    intent = 'net-host';
    session = wireSession();
    if (host) {
      ui.setOnlineState('creating', 'generando tu código…');
      try {
        currentOfferCode = await session.createOfferCode();
        ui.setOfferCode(currentOfferCode);
        ui.setOnlineState('offer-ready', 'Mandale el código o el link a tu rival y pegá su respuesta.');
      } catch (err) {
        ui.setOnlineState('error', String(err));
      }
    } else {
      ui.setOnlineState('idle', 'Pegá el código o abrí el link que te mandaron.');
    }
  }

  async function connectWithCode(code: string): Promise<void> {
    if (!session || !code.trim()) return;
    try {
      if (isHost) {
        ui.setOnlineState('connecting', 'conectando…');
        await session.acceptAnswerCode(code);
        connectTimeout = window.setTimeout(() => {
          ui.setOnlineState(
            'error',
            'No se pudo conectar (probablemente un NAT restrictivo). Probá con el hotspot del celular.',
          );
        }, 12000);
      } else {
        ui.setOnlineState('creating', 'generando tu respuesta…');
        currentOfferCode = await session.acceptOfferCode(code);
        ui.setOfferCode(currentOfferCode);
        ui.setOnlineState('answer-ready', 'Mandale este código de respuesta al anfitrión.');
      }
    } catch (err) {
      ui.setOnlineState('error', err instanceof Error ? err.message : String(err));
    }
  }

  const onChannelOpen = (): void => {
    window.clearTimeout(connectTimeout);
    playerCount = 2;
    botSlots = [];
    wins = [0, 0];
    matchOver = false;
    stats.reset(2);
    if (isHost) {
      ui.setOnlineState('connected', 'conectados ✔ elegí nivel y arrancamos');
      ui.show('setup');
    } else {
      ui.setOnlineState('connected', 'conectados ✔ el anfitrión elige el nivel…');
    }
  };

  const startNetRound = (netSeed: number, spec: RoundSpec, round: number): void => {
    mode = 'net';
    playerCount = 2;
    botSlots = [];
    initRound(netSeed, spec);
    lockstep = new Lockstep(session!, mySlot, round);
    lastNetProgress = performance.now();
    ui.show('none');
    help.innerHTML = helpText();
    updateScorebar(true);
  };

  const hostStartMatch = (): void => {
    roundId = 0;
    wins = [0, 0];
    matchOver = false;
    stats.reset(2);
    const netSeed = randomSeed();
    const spec = resolveRound();
    if (spec.bytes) session!.send(msgMap(spec.bytes));
    session!.send(msgStart(0, netSeed, spec.level, true, winTarget));
    startNetRound(netSeed, spec, 0);
  };

  const hostNextRound = (resetWins: boolean): void => {
    if (!session) return;
    if (resetWins) {
      wins.fill(0);
      matchOver = false;
      stats.reset(2);
    }
    roundId = (roundId + 1) & 0xff;
    const netSeed = randomSeed();
    const spec = resolveRound();
    if (spec.bytes) session.send(msgMap(spec.bytes));
    session.send(msgStart(roundId, netSeed, spec.level, resetWins, winTarget));
    startNetRound(netSeed, spec, roundId);
  };

  // Deep link: ?#j=<offer> lands straight in the join flow.
  const linkedOffer = offerFromLocation();

  // ---------------------------------------------------------------------
  // Input routing
  // ---------------------------------------------------------------------

  input.onReset = () => {
    if (paused || mode === 'menu') return;
    if (mode === 'local') startLocalRound();
    else if (mode === 'net' && isHost) hostNextRound(matchOver);
  };
  input.onSelectLevel = (l: number) => {
    if (paused || mode === 'menu') return;
    if (mode === 'local') {
      levelChoice = l % sim.levelCount;
      startLocalRound();
    } else if (mode === 'net' && isHost) {
      levelChoice = l % sim.levelCount;
      hostNextRound(matchOver);
    }
  };
  input.onPause = () => {
    if (mode === 'menu') return;
    setPaused(!paused);
  };

  function helpText(): string {
    const p1 =
      'P1 <kbd>WASD</kbd> · dash <kbd>Shift</kbd> · salto <kbd>Espacio</kbd> · anclarse <kbd>Ctrl</kbd>';
    if (mode === 'net') return `${p1} &nbsp;|&nbsp; <kbd>Esc</kbd> pausa`;
    if (intent === 'solo') return `${p1} &nbsp;|&nbsp; <kbd>Esc</kbd> pausa · <kbd>R</kbd> revancha`;
    return (
      `${p1} &nbsp;|&nbsp; P2 <kbd>Flechas</kbd> · <kbd>Shift der.</kbd> · <kbd>Ctrl der.</kbd> · <kbd>.</kbd>` +
      ' &nbsp;|&nbsp; <kbd>Esc</kbd> pausa'
    );
  }

  // ---------------------------------------------------------------------
  // Sim event dispatch
  // ---------------------------------------------------------------------

  const trauma = (amount: number): void => {
    renderer.fx.addTrauma(reducedMotion ? Math.min(amount, 0.1) : amount);
  };

  const showResults = (championIdx: number | null): void => {
    ui.showResults({
      rows: wins.map((w, i) => ({
        name: displayName(i),
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        wins: w,
        aliveTicks: stats.aliveTicks(i),
        shoves: stats.shoves(i),
        kos: stats.kos(i),
        winner: championIdx === i,
      })),
      winTarget,
      champion: championIdx,
      nextInMs: championIdx === null && restartAt > 0 ? restartAt - performance.now() : null,
    });
  };

  const handleEvents = (events: Float32Array): void => {
    const attract = mode === 'menu';
    for (let e = 0; e < events.length; e += EVENT_FLOATS) {
      const type = events[e];
      const x = events[e + 1];
      const y = events[e + 2];
      const z = events[e + 3];
      const a = events[e + 4];
      const b = events[e + 5];
      const pcolor = b >= 0 ? PLAYER_COLORS[b % PLAYER_COLORS.length] : 0xffffff;
      if (!attract) stats.onEvent(type, a, b, sim.frame);

      switch (type) {
        case EVT_HIT:
          if (!attract) audio.hit(a);
          renderer.fx.burst(x, y, z, 0xffffff, { count: Math.min(24, Math.floor(a * 2.5)), speed: a * 0.5, life: 450 });
          if (a > 5 && !attract) trauma(Math.min(0.45, a * 0.035));
          if (b >= 0) renderer.squash(b, Math.min(0.5, a * 0.05));
          break;
        case EVT_DASH:
          if (!attract) audio.dash(a > 0.5);
          renderer.fx.burst(x, y, z, a > 0.5 ? ORB_GOLD : pcolor, { count: a > 0.5 ? 26 : 10, speed: 2.5, life: 380 });
          if (!attract) trauma(a > 0.5 ? 0.18 : 0.06);
          if (b >= 0) renderer.squash(b, 0.35);
          break;
        case EVT_JUMP:
          if (!attract) audio.jump();
          renderer.fx.burst(x, y - 0.5, z, TILE_DUST, { count: 6, speed: 1.2, up: 0.5, life: 300 });
          if (b >= 0) renderer.squash(b, 0.3);
          break;
        case EVT_TILE_WARN:
          if (!attract) {
            audio.tileWarn();
            if (!crumbleToastShown) {
              crumbleToastShown = true;
              ui.toast('⚠ ¡SE DERRUMBA!');
            }
          }
          break;
        case EVT_TILE_DROP:
          if (!attract) audio.tileDrop();
          renderer.fx.burst(x, y + 0.4, z, TILE_DUST, { count: 14, speed: 1.6, up: 1, life: 550 });
          renderer.fx.ring(x, y + 0.4, z, TILE_DUST, 2);
          if (!attract) trauma(0.08);
          break;
        case EVT_DASH_HIT: {
          renderer.fx.ring(x, y, z, 0xffffff, 2.5);
          if (b >= 0) renderer.squash(b, 0.55);
          if (!attract) {
            trauma(0.12);
            renderer.fx.addPunch(x * 0.04, z * 0.04);
          }
          break;
        }
        case EVT_PARRY:
          if (!attract) audio.parry();
          renderer.fx.ring(x, y, z, 0xffffff, 4);
          renderer.fx.burst(x, y, z, 0xffffff, { count: 30, speed: 4, life: 500 });
          if (!attract) trauma(0.3);
          if (a >= 0) renderer.squash(a, 0.6);
          if (b >= 0) renderer.squash(b, 0.4);
          break;
        case EVT_FALL:
          if (!attract) {
            audio.fall();
            music.duck(500);
            trauma(0.3);
            renderer.fx.addPunch(x * 0.05, z * 0.05);
          }
          renderer.fx.burst(x, Math.max(y, -6), z, pcolor, { count: 36, speed: 4, up: 4, life: 800 });
          renderer.fx.ring(x, 0.2, z, pcolor, 5);
          break;
        case EVT_ORB_SPAWN:
          if (!attract) (a > 0.5 ? audio.orbLoose() : audio.orbSpawn());
          renderer.fx.burst(x, y, z, ORB_GOLD, { count: 12, speed: 1.4, up: 0.8, gravity: 1, life: 500 });
          break;
        case EVT_ORB_PICKUP:
          if (!attract) audio.orbPickup();
          renderer.fx.burst(x, y, z, ORB_GOLD, { count: 28, speed: 3, up: 2, gravity: 3, life: 650 });
          break;
        case EVT_ROUND_END: {
          const winner = a;
          if (attract) {
            restartAt = performance.now() + 3000;
            break;
          }
          trauma(0.25);
          music.duck(900);
          if (!reducedMotion) {
            timeScale = 0.3;
            slowmoUntil = performance.now() + 1300;
          }
          let championIdx: number | null = null;
          if (winner >= 0) {
            wins[winner]++;
            stats.recordRound(isWinnerLocal(winner));
            if (wins[winner] >= winTarget) {
              matchOver = true;
              championIdx = winner;
              audio.champion();
              stats.recordMatch(isWinnerLocal(winner));
              ui.setLifetimeLine(stats.summaryLine());
            } else {
              audio.roundEnd();
              if (mode === 'local' || isHost) restartAt = performance.now() + 3600;
            }
          } else {
            audio.roundEnd();
            if (mode === 'local' || isHost) restartAt = performance.now() + 3600;
          }
          showResults(championIdx);
          break;
        }
      }
    }
  };

  const isWinnerLocal = (winner: number): boolean => {
    if (mode === 'net') return winner === mySlot;
    if (intent === 'solo') return winner === 0;
    return true; // couch play: every human counts
  };

  const updateScorebar = (force: boolean): void => {
    const alive = sim.aliveMask;
    const key = `${wins.join(',')}|${alive}`;
    if (!force && key === lastScoreKey) return;
    lastScoreKey = key;
    ui.updateScorebar(
      wins.map((w, i) => ({
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        wins: w,
        alive: (alive & (1 << i)) !== 0,
        you: (mode === 'net' && i === mySlot) || (intent === 'solo' && mode !== 'net' && i === 0),
      })),
      winTarget,
    );
  };

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------

  startAttract();
  ui.show('title');
  if (linkedOffer) {
    ui.show('online');
    void beginOnline(false).then(() => connectWithCode(linkedOffer));
  }

  let last = performance.now();

  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    if (slowmoUntil > 0 && now >= slowmoUntil) {
      timeScale = 1;
      slowmoUntil = 0;
    }
    if (restartAt > 0 && now >= restartAt) {
      restartAt = 0;
      if (mode === 'menu') startAttract();
      else if (mode === 'local') startLocalRound();
      else if (mode === 'net' && isHost) hostNextRound(false);
    }
    if (mode === 'menu' && now >= attractTimer) startAttract();

    const dt = now - last;
    last = now;
    if (!paused) acc += dt * timeScale;
    // Cap catch-up work after a background tab pause.
    if (acc > 250) acc = 250;

    if (paused) {
      acc = 0;
    } else if (mode === 'local' || mode === 'menu') {
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

    // Music follows the round's dramatic arc (attract mode included).
    {
      let standing = 0;
      for (let i = 0; i < sim.pieceCount; i++) {
        if (sim.curr[sim.pieceBase(i) + 7] === PIECE_STATIC) standing++;
      }
      let aliveCount = 0;
      for (let i = 0; i < playerCount; i++) if (sim.aliveMask & (1 << i)) aliveCount++;
      music.setState({
        level: currentTheme,
        aliveCount,
        playerCount,
        crumbleRatio: sim.pieceCount > 0 ? 1 - standing / sim.pieceCount : 0,
        countdown: sim.frame < sim.countdownTicks,
        roundOver: sim.winner !== -1,
      });
    }

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

      // Dash-ready blip for the local player.
      const localSlot = mode === 'net' ? mySlot : 0;
      const flags = sim.curr[sim.playerBase(localSlot) + 7];
      const ready = (flags & FLAG_DASH_READY) !== 0 && (flags & FLAG_ALIVE) !== 0;
      if (ready && !prevLocalDashReady) audio.dashReady();
      prevLocalDashReady = ready;

      updateScorebar(false);
      const modeTag = mode === 'net' ? (isHost ? 'ONLINE · anfitrión' : 'ONLINE') : intent === 'solo' ? 'SOLO' : 'LOCAL';
      status.textContent = `${modeTag} · ${currentLevelName}`;
    } else {
      status.textContent = '';
      countdownEl.style.display = 'none';
    }
  };
  requestAnimationFrame(frame);
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="color:#f88;padding:2rem">${String(err)}</pre>`;
});
