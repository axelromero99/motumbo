// WebRTC lockstep netcode. Zero servers: signaling is a copy/paste code
// exchange, then a reliable ordered DataChannel carries tiny input packets.
// The sim is bit-deterministic, so peers only exchange inputs plus a periodic
// state hash that acts as a desync tripwire.

export const INPUT_DELAY = 4;

// Wire format (little-endian):
//   INPUT: u8 type=0, u8 round, u32 tick, u32 word
//   HASH:  u8 type=1, u8 round, u32 tick, u32 hash
//   START: u8 type=2, u8 round, u32 seed, u8 level, u8 resetWins, u8 winTarget
//   MAP:   u8 type=3, u16 len, bytes (custom map blob; sent before a START
//          with level 20 = LEVEL_CUSTOM — the channel is ordered, so arrival
//          order is safe)
export const MSG_INPUT = 0;
export const MSG_HASH = 1;
export const MSG_START = 2;
export const MSG_MAP = 3;
export const MSG_NAME = 4; // u8 type, u8 len, utf-8 name — exchanged on connect

export function msgName(name: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(name.slice(0, 18));
  const buf = new ArrayBuffer(2 + bytes.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG_NAME);
  v.setUint8(1, bytes.length);
  new Uint8Array(buf, 2).set(bytes);
  return buf;
}

export function msgMap(bytes: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(3 + bytes.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG_MAP);
  v.setUint16(1, bytes.length, true);
  new Uint8Array(buf, 3).set(bytes);
  return buf;
}

export function msgInput(round: number, tick: number, word: number): ArrayBuffer {
  const buf = new ArrayBuffer(10);
  const v = new DataView(buf);
  v.setUint8(0, MSG_INPUT);
  v.setUint8(1, round);
  v.setUint32(2, tick, true);
  v.setUint32(6, word, true);
  return buf;
}

export function msgHash(round: number, tick: number, hash: number): ArrayBuffer {
  const buf = new ArrayBuffer(10);
  const v = new DataView(buf);
  v.setUint8(0, MSG_HASH);
  v.setUint8(1, round);
  v.setUint32(2, tick, true);
  v.setUint32(6, hash, true);
  return buf;
}

export function msgStart(
  round: number,
  seed: number,
  level: number,
  resetWins: boolean,
  winTarget: number,
  mode: number,
  modeParam: number,
  botCount: number,
  botDifficulty: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(13);
  const v = new DataView(buf);
  v.setUint8(0, MSG_START);
  v.setUint8(1, round);
  v.setUint32(2, seed, true);
  v.setUint8(6, level);
  v.setUint8(7, resetWins ? 1 : 0);
  v.setUint8(8, winTarget);
  v.setUint8(9, mode);
  v.setUint8(10, modeParam);
  v.setUint8(11, botCount); // extra bots filling slots 2..2+botCount-1
  v.setUint8(12, botDifficulty);
  return buf;
}

function encodeCode(desc: RTCSessionDescriptionInit): string {
  return btoa(JSON.stringify({ t: desc.type, s: desc.sdp }));
}

/** Throws Error with a user-readable Spanish message on malformed input. */
function decodeCode(code: string, expectedType: 'offer' | 'answer'): RTCSessionDescriptionInit {
  let parsed: { t?: string; s?: string };
  try {
    parsed = JSON.parse(atob(code.trim()));
  } catch {
    throw new Error('El código está incompleto o cortado — copialo entero y probá de nuevo.');
  }
  if (!parsed.t || !parsed.s) {
    throw new Error('Eso no parece un código de TUMBO.');
  }
  if (parsed.t !== expectedType) {
    throw new Error(
      expectedType === 'answer'
        ? 'Ese es un código de invitación, no una respuesta. Pegá el código que te devolvió tu rival.'
        : 'Ese es un código de respuesta. Pedile a tu rival el código de invitación.',
    );
  }
  return { type: parsed.t as RTCSdpType, sdp: parsed.s };
}

/** Shareable URL that lands the guest directly in the join flow. */
export function inviteLink(offerCode: string): string {
  return `${location.origin}${location.pathname}#j=${encodeURIComponent(offerCode)}`;
}

/** Offer code embedded in the current URL, if any. */
export function offerFromLocation(): string | null {
  if (location.hash.startsWith('#join=')) {
    return decodeURIComponent(location.hash.slice(6));
  }
  if (location.hash.startsWith('#j=')) {
    return decodeURIComponent(location.hash.slice(3));
  }
  return null;
}

function waitIceComplete(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

export class NetSession {
  onMessage: ((view: DataView) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  private pc: RTCPeerConnection;
  private channel: RTCDataChannel | null = null;

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pc.addEventListener('connectionstatechange', () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'disconnected' || s === 'closed') this.onClose?.();
    });
  }

  /** Host side: returns the offer code to hand to the guest. */
  async createOfferCode(): Promise<string> {
    this.attachChannel(this.pc.createDataChannel('tumbo', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitIceComplete(this.pc);
    return encodeCode(this.pc.localDescription!);
  }

  /** Guest side: consumes the host's offer, returns the answer code. */
  async acceptOfferCode(code: string): Promise<string> {
    this.pc.addEventListener('datachannel', (e) => this.attachChannel(e.channel));
    await this.pc.setRemoteDescription(decodeCode(code, 'offer'));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitIceComplete(this.pc);
    return encodeCode(this.pc.localDescription!);
  }

  /** Host side: consumes the guest's answer. The channel opens shortly after. */
  async acceptAnswerCode(code: string): Promise<void> {
    await this.pc.setRemoteDescription(decodeCode(code, 'answer'));
  }

  send(buf: ArrayBuffer): void {
    if (this.channel?.readyState === 'open') this.channel.send(buf);
  }

  close(): void {
    this.onClose = null;
    this.channel?.close();
    this.pc.close();
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => this.onOpen?.());
    channel.addEventListener('close', () => this.onClose?.());
    channel.addEventListener('message', (e) => this.onMessage?.(new DataView(e.data as ArrayBuffer)));
  }
}

/**
 * Lockstep tick gate. Local inputs are scheduled INPUT_DELAY ticks in the
 * future and sent to the peer; tick T only advances when both sides' inputs
 * for T are known. One instance per round (tick starts at 0).
 */
export class Lockstep {
  tick = 0;
  desync = false;
  /** Highest remote input tick seen — diagnostics / catch-up heuristics. */
  remoteTop = -1;

  private local = new Map<number, number>();
  private remote = new Map<number, number>();
  private myHashes = new Map<number, number>();
  private theirHashes = new Map<number, number>();
  private words = new Uint32Array(8);

  constructor(
    private session: NetSession,
    private mySlot: number,
    private round: number,
  ) {
    // The first DELAY ticks have no player input on either side.
    for (let t = 0; t < INPUT_DELAY; t++) {
      this.local.set(t, 0);
      this.remote.set(t, 0);
    }
  }

  /** Sample the local input word once per pending tick (idempotent). */
  scheduleLocal(word: number): void {
    const target = this.tick + INPUT_DELAY;
    if (!this.local.has(target)) {
      this.local.set(target, word);
      this.session.send(msgInput(this.round, target, word));
    }
  }

  canStep(): boolean {
    return this.local.has(this.tick) && this.remote.has(this.tick);
  }

  /** Input words for the sim at the current tick (slot 0 = host). */
  buildWords(): Uint32Array {
    const mine = this.local.get(this.tick)!;
    const theirs = this.remote.get(this.tick)!;
    this.words.fill(0);
    this.words[this.mySlot] = mine;
    this.words[1 - this.mySlot] = theirs;
    return this.words;
  }

  /** Call after sim.step(). Pass the state hash on hash-check boundaries. */
  advance(hash: number | null): void {
    this.local.delete(this.tick - 2);
    this.remote.delete(this.tick - 2);
    this.tick += 1;

    if (hash !== null) {
      this.myHashes.set(this.tick, hash);
      this.session.send(msgHash(this.round, this.tick, hash));
      const theirs = this.theirHashes.get(this.tick);
      if (theirs !== undefined && theirs !== hash) this.desync = true;
      // Prune old checkpoints.
      this.myHashes.delete(this.tick - 600);
      this.theirHashes.delete(this.tick - 600);
    }
  }

  onRemoteInput(round: number, tick: number, word: number): void {
    if (round !== this.round) return;
    this.remote.set(tick, word);
    if (tick > this.remoteTop) this.remoteTop = tick;
  }

  onRemoteHash(round: number, tick: number, hash: number): void {
    if (round !== this.round) return;
    const mine = this.myHashes.get(tick);
    if (mine !== undefined) {
      if (mine !== hash) this.desync = true;
    } else {
      this.theirHashes.set(tick, hash);
    }
  }
}
