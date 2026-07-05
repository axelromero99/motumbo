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
  EVT_CURSE,
  EVT_ZONE,
  EVT_MODE_POINT,
  EVT_SHIELD,
  EVT_SHOCK,
  ORB_INFO,
  PIECE_STATIC,
  pieceStateOf,
  FLAG_CURSED,
  MODE_SUMO,
  MODE_KOTH,
  MODE_COSECHA,
  MODE_MALDITO,
  MODE_NAMES,
} from './sim';
import { LocalInput } from './input';
import { GameRenderer, PLAYER_COLORS } from './render';
import { AudioEngine } from './audio';
import { MusicEngine } from './music';
import { NetSession, Lockstep, msgStart, msgMap, msgName, MSG_INPUT, MSG_HASH, MSG_START, MSG_MAP, MSG_NAME } from './net';
import { RoomSignal, randomRoomCode, normalizeRoomCode } from './signal';
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
  // One-time migration from the old "tumbo.*" name so saved maps, settings,
  // username and stats survive the rename to MOTUMBO. Runs before anything
  // reads localStorage.
  try {
    for (const k of ['settings.v1', 'username', 'maps.v1', 'stats.v1']) {
      const oldK = `tumbo.${k}`;
      const newK = `motumbo.${k}`;
      const old = localStorage.getItem(oldK);
      if (old !== null && localStorage.getItem(newK) === null) localStorage.setItem(newK, old);
    }
  } catch {
    // localStorage unavailable — nothing to migrate.
  }

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
  let gameMode = MODE_SUMO;
  let gameModeParam = 0;
  let botDifficulty = 1;
  let netBotCount = 0; // extra bots in an online room (host-chosen, 0-2)
  let remoteName = ''; // the online opponent's chosen name
  let quickMatching = false; // in the slither-style auto-matchmaking flow
  let quickMatchFellBack = false; // a human connected → stop the bot/search flow
  let quickBotsRunning = false; // playing bots while STILL searching the lobby
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
  let roomSignal: RoomSignal | null = null;
  let connectTimeout = 0;
  let lastNetProgress = 0;
  let desyncShown = false;

  const isNetGuest = (): boolean => mode === 'net' && !isHost;

  const displayName = (i: number): string => {
    if (botSlots.includes(i)) return `${PLAYER_NAMES[i]} BOT`;
    // Slither-style names: your chosen name for you, the peer's for them.
    const isLocalHuman = (mode === 'net' && i === mySlot) || (intent === 'solo' && mode !== 'net' && i === 0);
    if (isLocalHuman) return `${ui.username || PLAYER_NAMES[i]} (vos)`;
    if (mode === 'net' && i === 1 - mySlot && remoteName) return remoteName;
    return PLAYER_NAMES[i];
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
        return { level: LEVEL_CUSTOM, theme: bytes[1] % 20, bytes, name: (meta?.name ?? 'CUSTOM').toUpperCase() };
      }
      levelChoice = 0;
    }
    const lvl = levelChoice === 'random' ? randomSeed() % sim.levelCount : (levelChoice as number) % sim.levelCount;
    // Generated levels (20-69) reuse the 20 visual/musical themes cyclically.
    return { level: lvl, theme: lvl % 20, bytes: null, name: LEVEL_NAMES[lvl] };
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
    onPlay: () => audio.uiClick(),
    onOnline: () => audio.uiClick(),
    onQuickMatch: () => void startQuickMatch(),
    onCreateRoom: () => void createRoom(),
    onJoinRoom: (code: string) => void joinRoom(code),
    onCancelOnline: () => teardownOnline(),
    onStartMatch: (
      level: number | 'random' | { custom: string },
      target: number,
      m = MODE_SUMO,
      mParam = 0,
      botDiff = 1,
      rivals: 'bots' | 'humano' = 'bots',
      onlineBots = 0,
    ) => {
      audio.uiClick();
      levelChoice = level;
      winTarget = target;
      gameMode = m;
      gameModeParam = mParam;
      botDifficulty = botDiff;
      // With a live session the match is online; otherwise RIVALES decides.
      if (session) {
        if (isHost) {
          netBotCount = Math.max(0, Math.min(2, onlineBots));
          hostStartMatch();
        }
      } else {
        intent = rivals === 'bots' ? 'solo' : 'local';
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
    // Order matters for lockstep: setMode consumes the sim RNG stream, so it
    // must happen at the same point on every peer.
    if (gameMode !== MODE_SUMO) sim.setMode(gameMode, gameModeParam);
    for (const slot of botSlots) sim.setBot(slot, botDifficulty);
    renderer.setup(sim, spec.theme);
    renderer.setLocalPlayer(localHumanSlot(), ui.username);
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
    renderer.setLocalPlayer(-1); // attract mode is all bots — no "VOS" tag
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
    // Only couch 2-player splits the keyboard; SOLO gets WASD + arrows both.
    input.dualLocal = intent === 'local';
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
      else if (type === MSG_NAME) {
        const len = v.getUint8(1);
        remoteName = new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset + 2, len)).slice(0, 18);
        if (mode === 'net') updateScorebar(true);
      } else if (type === MSG_MAP && !isHost) {
        const len = v.getUint16(1, true);
        pendingGuestMap = new Uint8Array(v.buffer.slice(v.byteOffset + 3, v.byteOffset + 3 + len));
      } else if (type === MSG_START && !isHost) {
        const round = v.getUint8(1);
        const netSeed = v.getUint32(2, true);
        const lvl = v.getUint8(6);
        const doReset = v.getUint8(7) === 1;
        winTarget = v.getUint8(8);
        gameMode = v.getUint8(9);
        gameModeParam = v.getUint8(10);
        // Bots the host added to the room; the guest sets the SAME slots so
        // both sims stay bit-identical.
        netBotCount = v.getUint8(11);
        botDifficulty = v.getUint8(12);
        if (doReset) resetNetMatch();
        roundId = round;
        const spec: RoundSpec =
          lvl === LEVEL_CUSTOM && pendingGuestMap
            ? { level: LEVEL_CUSTOM, theme: pendingGuestMap[1] % 20, bytes: pendingGuestMap, name: 'MAPA DEL ANFITRIÓN' }
            : { level: lvl, theme: lvl % 20, bytes: null, name: LEVEL_NAMES[lvl] ?? 'CUSTOM' };
        startNetRound(netSeed, spec, round);
      }
    };
    s.onClose = () => {
      if (mode === 'net') {
        ui.toast('❌ se cortó la conexión');
        quitToTitle();
      } else if (!quickMatching) {
        // During quick-match we may be playing bots while still searching — a
        // dropped handshake there isn't an error to surface.
        ui.setRoomState('error', 'Se cortó la conexión. Volvé a intentar.');
      }
    };
    return s;
  };

  function teardownOnline(): void {
    roomSignal?.close();
    roomSignal = null;
    session?.close();
    session = null;
    lockstep = null;
    quickMatching = false;
    quickBotsRunning = false;
    window.clearTimeout(connectTimeout);
  }

  // Slither-style quick match: find any waiting player in ~5s, else drop into
  // a bot game instantly. Either way you're playing fast.
  async function startQuickMatch(): Promise<void> {
    teardownOnline();
    audio.uiClick();
    quickMatching = true;
    quickMatchFellBack = false;
    quickBotsRunning = false;
    intent = 'net-host';
    levelChoice = 'random';
    gameMode = MODE_SUMO;
    gameModeParam = 0;
    winTarget = 5;
    session = wireSession();
    const rs = new RoomSignal();
    roomSignal = rs;
    const armTimeout = (): void => {
      window.clearTimeout(connectTimeout);
      // If the WebRTC handshake stalls (NAT), don't hang — fall to bots while
      // the lobby search keeps running for another rival.
      connectTimeout = window.setTimeout(() => startQuickBots(), 12000);
    };
    // Play NOW: after a short grace with no rival, drop into a bot game — but
    // keep searching the lobby, so a rival who shows up later still swaps us in.
    window.setTimeout(() => startQuickBots(), 3500);
    try {
      await rs.quickMatch(
        {
          onRole: (host) => {
            isHost = host;
            mySlot = host ? 0 : 1;
            ui.setRoomState('connecting', '¡rival encontrado! conectando…');
          },
          makeOffer: async () => {
            armTimeout();
            return await session!.createOfferCode();
          },
          onAnswer: (answer) => void session!.acceptAnswerCode(answer),
          makeAnswer: async (offer) => {
            armTimeout();
            return await session!.acceptOfferCode(offer);
          },
          onError: () => startQuickBots(),
          onNoPeer: () => {
            // Searched the pool a long time with nobody — settle into bots.
            roomSignal?.close();
            roomSignal = null;
            startQuickBots();
          },
        },
        90000, // keep the pool open ~90 s (slither-style: rivals can join anytime)
      );
    } catch {
      startQuickBots();
    }
  }

  // Play a bot game immediately WITHOUT tearing down the lobby search: a rival
  // who shows up later still connects and swaps us into the online match via
  // onChannelOpen (quickMatching stays true so that path stays armed).
  const startQuickBots = (): void => {
    if (quickBotsRunning || quickMatchFellBack) return;
    quickBotsRunning = true;
    intent = 'solo';
    levelChoice = 'random';
    gameMode = MODE_SUMO;
    gameModeParam = 0;
    winTarget = 5;
    botDifficulty = 1;
    startMatch();
    ui.toast('sin rival aún — jugás con bots (seguimos buscando)');
  };

  async function createRoom(): Promise<void> {
    teardownOnline();
    isHost = true;
    mySlot = 0;
    intent = 'net-host';
    session = wireSession();
    roomSignal = new RoomSignal();
    const code = randomRoomCode();
    try {
      await roomSignal.host(code, {
        makeOffer: async () => {
          ui.setRoomState('connecting', '¡rival encontrado! conectando…');
          connectTimeout = window.setTimeout(() => {
            ui.setRoomState('error', 'No se pudo conectar (NAT restrictivo). Probá con el hotspot del celular.');
          }, 15000);
          return await session!.createOfferCode();
        },
        onAnswer: (answer) => void session!.acceptAnswerCode(answer),
        onError: (msg) => ui.setRoomState('error', msg),
      });
      ui.setRoomState('waiting', undefined, code);
    } catch (err) {
      ui.setRoomState('error', err instanceof Error ? err.message : String(err));
    }
  }

  async function joinRoom(raw: string): Promise<void> {
    const code = normalizeRoomCode(raw);
    if (!code) {
      ui.setRoomState('error', 'Ese código no parece de MOTUMBO (son 4 letras/números).');
      return;
    }
    teardownOnline();
    isHost = false;
    mySlot = 1;
    intent = 'net-host';
    session = wireSession();
    roomSignal = new RoomSignal();
    try {
      await roomSignal.join(code, {
        makeAnswer: async (offer) => {
          ui.setRoomState('connecting', '¡sala encontrada! conectando…');
          connectTimeout = window.setTimeout(() => {
            ui.setRoomState('error', 'No se pudo conectar (NAT restrictivo). Probá con el hotspot del celular.');
          }, 15000);
          return await session!.acceptOfferCode(offer);
        },
        onError: (msg) => ui.setRoomState('error', msg),
      });
    } catch (err) {
      ui.setRoomState('error', err instanceof Error ? err.message : String(err));
    }
  }

  const onChannelOpen = (): void => {
    roomSignal?.close();
    roomSignal = null;
    quickMatchFellBack = true; // a human connected; cancel the bot fallback
    quickBotsRunning = false;
    window.clearTimeout(connectTimeout);
    // Exchange chosen names so both sides show real nicknames.
    remoteName = '';
    session?.send(msgName(ui.username || (isHost ? 'ANFITRIÓN' : 'RIVAL')));
    playerCount = 2;
    botSlots = [];
    wins = [0, 0];
    matchOver = false;
    stats.reset(2);
    if (quickMatching) {
      // Quick match: no lobby screen — the host fills to 4 with bots and both
      // drop straight into a round.
      quickMatching = false;
      if (isHost) {
        netBotCount = 2;
        botDifficulty = 1;
        ui.setRoomState('connected', '¡emparejado!');
        hostStartMatch();
      } else {
        ui.setRoomState('connected', '¡emparejado! arranca en breve…');
      }
    } else if (isHost) {
      netBotCount = 0;
      ui.setRoomState('connected', '¡conectados! elegí la arena');
      ui.show('setup');
    } else {
      ui.setRoomState('connected', 'el anfitrión elige la arena…');
    }
  };

  // Online player layout: humans on slots 0 (host) and 1 (guest), then
  // netBotCount deterministic bots on slots 2.. — they cost zero bytes on the
  // wire because both peers compute their inputs from the same sim.
  const resetNetMatch = (): void => {
    matchOver = false;
    wins = new Array(2 + netBotCount).fill(0);
    stats.reset(2 + netBotCount);
  };

  const startNetRound = (netSeed: number, spec: RoundSpec, round: number): void => {
    mode = 'net';
    input.dualLocal = false; // one human at this keyboard; arrows also drive them
    playerCount = 2 + netBotCount;
    botSlots = [];
    for (let s = 2; s < playerCount; s++) botSlots.push(s);
    // Safety: keep the score array sized to the field (match start / count change).
    if (wins.length !== playerCount) {
      wins = new Array(playerCount).fill(0);
      stats.reset(playerCount);
    }
    initRound(netSeed, spec);
    lockstep = new Lockstep(session!, mySlot, round);
    lastNetProgress = performance.now();
    ui.show('none');
    help.innerHTML = helpText();
    updateScorebar(true);
  };

  const hostStartMatch = (): void => {
    roundId = 0;
    resetNetMatch();
    const netSeed = randomSeed();
    const spec = resolveRound();
    if (spec.bytes) session!.send(msgMap(spec.bytes));
    session!.send(msgStart(0, netSeed, spec.level, true, winTarget, gameMode, gameModeParam, netBotCount, botDifficulty));
    startNetRound(netSeed, spec, 0);
  };

  const hostNextRound = (resetWins: boolean): void => {
    if (!session) return;
    if (resetWins) resetNetMatch();
    roundId = (roundId + 1) & 0xff;
    const netSeed = randomSeed();
    const spec = resolveRound();
    if (spec.bytes) session.send(msgMap(spec.bytes));
    session.send(
      msgStart(roundId, netSeed, spec.level, resetWins, winTarget, gameMode, gameModeParam, netBotCount, botDifficulty),
    );
    startNetRound(netSeed, spec, roundId);
  };

  // Deep link: ?#j=<offer> lands straight in the join flow.
  // Deep link: #room=CODE lands straight in the join flow.
  const roomLink = location.hash.match(/^#room=([A-Za-z0-9-]{4,12})/i);

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

  input.onCamera = () => {
    ui.toast(`📷 cámara: ${renderer.cycleCamera()}`);
  };

  function helpText(): string {
    const p1 =
      'P1 <kbd>WASD</kbd> · dash <kbd>Shift</kbd> · salto <kbd>Espacio</kbd> · anclarse <kbd>Ctrl</kbd>';
    const cam = '<kbd>C</kbd> cámara';
    if (mode === 'net') return `${p1} &nbsp;|&nbsp; ${cam} · <kbd>Esc</kbd> pausa`;
    if (intent === 'solo') return `${p1} &nbsp;|&nbsp; ${cam} · <kbd>Esc</kbd> pausa · <kbd>R</kbd> revancha`;
    return (
      `${p1} &nbsp;|&nbsp; P2 <kbd>Flechas</kbd> · <kbd>Shift der.</kbd> · <kbd>Ctrl der.</kbd> · <kbd>.</kbd>` +
      ` &nbsp;|&nbsp; ${cam} · <kbd>Esc</kbd> pausa`
    );
  }

  // ---------------------------------------------------------------------
  // Sim event dispatch
  // ---------------------------------------------------------------------

  const trauma = (amount: number): void => {
    renderer.fx.addTrauma(reducedMotion ? Math.min(amount, 0.1) : amount);
  };

  // Full-screen color wash for win/lose beats.
  const flashEl = $('flash');
  let flashTimer = 0;
  const flash = (css: string): void => {
    flashEl.style.background = css;
    flashEl.style.opacity = '1';
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => (flashEl.style.opacity = '0'), 120);
  };
  const localHumanSlot = (): number => (mode === 'net' ? mySlot : 0);

  // World-space flourish at round/match end (the results title does the text).
  const playOutcome = (localWon: boolean, isMatch: boolean): void => {
    if (localWon) {
      renderer.fx.confetti(0, 0, 12);
      if (isMatch) window.setTimeout(() => renderer.fx.confetti(0, 0, 13), 350);
      flash('radial-gradient(circle at 50% 42%, rgba(255,224,130,0.55), rgba(255,180,40,0) 62%)');
    } else {
      flash('radial-gradient(circle at 50% 46%, rgba(0,0,0,0) 34%, rgba(190,24,44,0.5) 100%)');
    }
  };

  const showResults = (championIdx: number | null, roundWinner: number): void => {
    // youWon only in couch when the human's ball is the winner is fuzzy; leave
    // it undefined there so we don't wrongly say "PERDISTE".
    const youWon = roundWinner < 0 ? undefined : mode === 'local' && intent === 'local' ? undefined : isWinnerLocal(roundWinner);
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
      youWon,
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
        case EVT_JUMP: {
          const dbl = a > 0.5; // a=1 → mid-air double jump
          if (!attract) audio.jump(dbl);
          if (dbl) {
            // A little burst ring under the ball where the second hop kicks off.
            renderer.fx.ring(x, y - 0.4, z, 0xbfe3ff, 1.6);
            renderer.fx.burst(x, y - 0.3, z, 0xbfe3ff, { count: 12, speed: 2.2, up: 0.6, life: 380 });
          } else {
            renderer.fx.burst(x, y - 0.5, z, TILE_DUST, { count: 6, speed: 1.2, up: 0.5, life: 300 });
          }
          if (b >= 0) renderer.squash(b, dbl ? 0.45 : 0.3);
          break;
        }
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
            // Immediate "you're out" wash when the local human is eliminated.
            if (b === localHumanSlot() && !matchOver) flash('radial-gradient(circle at 50% 46%, rgba(0,0,0,0) 40%, rgba(190,24,44,0.45) 100%)');
          }
          renderer.fx.burst(x, Math.max(y, -6), z, pcolor, { count: 36, speed: 4, up: 4, life: 800 });
          renderer.fx.ring(x, 0.2, z, pcolor, 5);
          break;
        case EVT_ORB_SPAWN: {
          // `a` is the orb type; `b >= 0` means it was knocked out of a carrier.
          if (!attract) (b >= 0 ? audio.orbLoose() : audio.orbSpawn());
          const spawnColor = ORB_INFO[a]?.color ?? ORB_GOLD;
          renderer.fx.burst(x, y, z, spawnColor, { count: 12, speed: 1.4, up: 0.8, gravity: 1, life: 500 });
          break;
        }
        case EVT_ORB_PICKUP: {
          if (!attract) audio.orbPickup();
          const info = ORB_INFO[a];
          renderer.fx.burst(x, y, z, info?.color ?? ORB_GOLD, { count: 28, speed: 3, up: 2, gravity: 3, life: 650 });
          if (!attract && b >= 0 && info) {
            // The local player gets the full "what it does"; rivals get a tag.
            ui.toast(
              b === localHumanSlot()
                ? `${info.icon} ${info.name} — ${info.desc}`
                : `${info.icon} ${info.name} · ${PLAYER_NAMES[b]}`,
            );
          }
          break;
        }
        case EVT_SHIELD:
          if (!attract) audio.parry();
          renderer.fx.ring(x, y, z, 0x8affc0, 3);
          renderer.fx.burst(x, y, z, 0x8affc0, { count: 22, speed: 3, life: 450 });
          break;
        case EVT_SHOCK:
          if (!attract) {
            audio.dash(true);
            renderer.fx.addTrauma(0.3);
            renderer.fx.addPunch(0, 0);
          }
          renderer.fx.ring(x, y, z, 0xff8a3d, 6);
          renderer.fx.burst(x, y, z, 0xff8a3d, { count: 40, speed: 5, up: 2, life: 600 });
          break;
        case EVT_CURSE:
          if (!attract) {
            audio.orbLoose();
            renderer.fx.addTrauma(0.15);
            if (b < 0) ui.toast(`💀 ${PLAYER_NAMES[a]} arranca MALDITO`);
            else ui.toast(`💀 la maldición pasó a ${PLAYER_NAMES[a]}`);
          }
          renderer.fx.burst(x, y, z, 0xd0342c, { count: 22, speed: 2.5, up: 2, life: 550 });
          break;
        case EVT_ZONE:
          if (!attract) audio.orbSpawn();
          renderer.fx.ring(x, y, z, 0xffd24d, 4);
          break;
        case EVT_MODE_POINT:
          if (!attract) audio.dashReady();
          renderer.fx.burst(x, y, z, 0xffd24d, { count: 8, speed: 1.5, up: 1.5, gravity: 2, life: 400 });
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
          const localWon = winner >= 0 && isWinnerLocal(winner);
          if (winner >= 0) {
            wins[winner]++;
            stats.recordRound(isWinnerLocal(winner));
            if (wins[winner] >= winTarget) {
              matchOver = true;
              championIdx = winner;
              audio.champion();
              stats.recordMatch(isWinnerLocal(winner));
              ui.setLifetimeLine(stats.summaryLine());
              playOutcome(localWon, true);
            } else {
              audio.roundEnd();
              playOutcome(localWon, false);
              if (mode === 'local' || isHost) restartAt = performance.now() + 3600;
            }
          } else {
            audio.roundEnd();
            if (mode === 'local' || isHost) restartAt = performance.now() + 3600;
          }
          showResults(championIdx, winner);
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

  const modeScoreText = (i: number): string | undefined => {
    if (gameMode === MODE_KOTH) return `${Math.floor(sim.score(i) / 60)}/${gameModeParam}s`;
    if (gameMode === MODE_COSECHA) return `${sim.score(i)}/${gameModeParam}`;
    return undefined;
  };

  const updateScorebar = (force: boolean): void => {
    const alive = sim.aliveMask;
    let scoreKey = '';
    if (gameMode === MODE_KOTH) {
      // KOTH score is in ticks; the HUD shows whole seconds, so key on seconds.
      for (let i = 0; i < playerCount; i++) scoreKey += `${Math.floor(sim.score(i) / 60)},`;
    } else if (gameMode === MODE_COSECHA) {
      // COSECHA score is a raw orb count — key on it directly (÷60 kept it at 0
      // forever, so the scorebar never refreshed as players collected orbs).
      for (let i = 0; i < playerCount; i++) scoreKey += `${sim.score(i)},`;
    } else if (gameMode === MODE_MALDITO) {
      scoreKey = String(sim.curr[sim.modeBase() + 1]);
    }
    const key = `${wins.join(',')}|${alive}|${scoreKey}`;
    if (!force && key === lastScoreKey) return;
    lastScoreKey = key;
    ui.updateScorebar(
      wins.map((w, i) => ({
        color: PLAYER_COLORS[i % PLAYER_COLORS.length],
        wins: w,
        alive: (alive & (1 << i)) !== 0,
        you: (mode === 'net' && i === mySlot) || (intent === 'solo' && mode !== 'net' && i === 0),
        score: modeScoreText(i),
        cursed: (sim.curr[sim.playerBase(i) + 7] & FLAG_CURSED) !== 0,
      })),
      winTarget,
    );
  };

  // ---------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------

  startAttract();
  ui.show('title');
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('done');
    window.setTimeout(() => boot.remove(), 400);
  }
  if (roomLink) {
    ui.show('online');
    void joinRoom(roomLink[1]);
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
        if (pieceStateOf(sim.curr[sim.pieceBase(i) + 7]) === PIECE_STATIC) standing++;
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
        countdownEl.textContent = '¡MOTUMBO!';
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
      const gm = gameMode !== MODE_SUMO ? ` · ${MODE_NAMES[gameMode]}` : '';
      status.textContent = `${modeTag} · ${currentLevelName}${gm}`;
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
