// Reliable, ordered message channel over an UNRELIABLE qos0 pub/sub link (our
// MQTT brokers). It's the P2P fallback: when WebRTC can't punch through the NAT
// (symmetric NAT, no TURN), we relay the lockstep bytes through the broker instead.
//
// Lockstep needs every input to arrive — a missing tick blocks the game forever —
// but qos0 can drop and reorder. So we run a tiny RUDP-style protocol on top:
//   • every outgoing message gets an incrementing seq;
//   • every ~33ms we (re)send all still-UNACKED messages plus a cumulative ACK of
//     the contiguous prefix we've received;
//   • the peer delivers strictly in seq order and drops duplicates.
// Messages are tiny (≤13 bytes) so retransmitting the unacked window is nearly
// free. From the game's side this is just a Transport, identical to NetSession —
// the only difference the rest of the app sees is a larger input delay (net.ts
// RELAY_INPUT_DELAY) to hide the broker's round-trip.

import type { Transport } from './net';

const FLUSH_MS = 33; // ~30 Hz retransmit/ack cadence; bounded broker load
const IDLE_HEARTBEAT_MS = 400; // keep the link proven-alive when nothing to send
const STALL_MS = 20000; // no packet from the peer this long → declare it dead

// base64 <-> bytes (btoa/atob exist in the browser and in Node ≥16). Packets are
// small, so the char-by-char loops are fine and avoid String.fromCharCode(...spread)
// blowing the stack.
function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class RelayTransport implements Transport {
  onMessage: ((view: DataView) => void) | null = null;
  onOpen: (() => void) | null = null;
  onClose: (() => void) | null = null;

  private outSeq = 0;
  private outBuf: { seq: number; bytes: Uint8Array }[] = []; // unacked, ascending seq
  private inNext = 0; // next in-order seq we still need
  private inAhead = new Map<number, Uint8Array>(); // received but not yet deliverable
  private timer: ReturnType<typeof setInterval>;
  private opened = false;
  private closed = false;
  private lastRecv = now();
  private sinceFlush = 0;
  private ackDirty = false;

  /** sendRaw publishes one base64 packet to the peer's relay inbox. */
  constructor(private sendRaw: (packet: string) => void) {
    this.timer = setInterval(() => this.tick(), FLUSH_MS);
    this.flush(); // announce ourselves immediately so the peer's onOpen fires fast
  }

  send(buf: ArrayBuffer): void {
    if (this.closed) return;
    this.outBuf.push({ seq: this.outSeq++, bytes: new Uint8Array(buf.slice(0)) });
    this.flush(); // go out now; retransmits ride the timer
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
  }

  /** Feed an incoming relay packet (base64) from our inbox topic. */
  receive(packet: string): void {
    if (this.closed) return;
    let data: Uint8Array;
    try {
      data = b64decode(packet);
    } catch {
      return;
    }
    if (data.length < 4) return;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    // Peer's cumulative ack = count of our messages it has in order → drop those.
    const ack = dv.getUint32(0, true);
    while (this.outBuf.length && this.outBuf[0].seq < ack) this.outBuf.shift();
    // Parse carried messages: [seq u32][len u16][bytes]...
    let o = 4;
    while (o + 6 <= data.length) {
      const seq = dv.getUint32(o, true);
      const len = dv.getUint16(o + 4, true);
      o += 6;
      if (o + len > data.length) break;
      if (seq >= this.inNext && !this.inAhead.has(seq)) this.inAhead.set(seq, data.slice(o, o + len));
      o += len;
    }
    this.lastRecv = now();
    if (!this.opened) {
      this.opened = true;
      this.onOpen?.();
    }
    // Deliver everything now contiguous.
    for (;;) {
      const b = this.inAhead.get(this.inNext);
      if (!b) break;
      this.inAhead.delete(this.inNext);
      this.inNext++;
      this.ackDirty = true; // our ack advanced — tell the peer soon
      if (!this.closed) this.onMessage?.(new DataView(b.buffer, b.byteOffset, b.byteLength));
    }
  }

  private tick(): void {
    if (this.closed) return;
    if (now() - this.lastRecv > STALL_MS) {
      this.onClose?.();
      this.close();
      return;
    }
    this.sinceFlush += FLUSH_MS;
    // Retransmit while there's unacked data or a pending ack; otherwise a slow
    // heartbeat so the peer keeps seeing us (and can drop its acked backlog).
    if (this.outBuf.length || this.ackDirty || this.sinceFlush >= IDLE_HEARTBEAT_MS) this.flush();
  }

  private flush(): void {
    if (this.closed) return;
    let size = 4;
    for (const m of this.outBuf) size += 6 + m.bytes.length;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, this.inNext, true); // our cumulative ack
    let o = 4;
    for (const m of this.outBuf) {
      dv.setUint32(o, m.seq, true);
      dv.setUint16(o + 4, m.bytes.length, true);
      buf.set(m.bytes, o + 6);
      o += 6 + m.bytes.length;
    }
    this.sendRaw(b64encode(buf));
    this.sinceFlush = 0;
    this.ackDirty = false;
  }
}
