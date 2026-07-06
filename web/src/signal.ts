// Room signaling over public MQTT brokers (WebSocket). Only the WebRTC
// handshake travels through here — a few KB, then the game is pure P2P and
// the broker is out of the picture. Hand-rolled minimal MQTT 3.1.1 client
// (CONNECT / SUBSCRIBE / PUBLISH qos0 / PING) to keep the game dependency-free.
//
// Transport is MULTI-BROKER on purpose: each client connects to EVERY broker at
// once and publishes/subscribes on all of them, deduping incoming messages. A
// single-broker client picked "the first broker that answered" independently on
// each device, so two players could land on different brokers and never see each
// other — matchmaking "found sometimes, not others". Fanning out fixes that: two
// peers pair as long as they share ANY one live broker.

const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://test.mosquitto.org:8081'];
const CONNECT_TIMEOUT_MS = 6000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O/1/I

export function randomRoomCode(): string {
  const out: string[] = [];
  const rnd = new Uint8Array(4);
  crypto.getRandomValues(rnd);
  for (const b of rnd) out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
  return out.join('');
}

export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase().replace(/^MOTUMBO-?/, '').replace(/[^A-Z0-9]/g, '');
  return code.length === 4 && [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

// ---------------------------------------------------------------------------
// Minimal MQTT 3.1.1 over WebSocket
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const dec = new TextDecoder();

function mqttString(s: string): Uint8Array {
  const bytes = enc.encode(s);
  const out = new Uint8Array(2 + bytes.length);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

// Exact-size packet; we always send its .buffer (TS: WebSocket wants a plain
// ArrayBuffer, and these are never views over shared memory).
function packet(type: number, ...parts: Uint8Array[]): ArrayBuffer {
  let len = 0;
  for (const p of parts) len += p.length;
  // Remaining-length varint.
  const rl: number[] = [];
  let n = len;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    rl.push(b);
  } while (n > 0);
  const out = new Uint8Array(1 + rl.length + len);
  out[0] = type;
  out.set(rl, 1);
  let o = 1 + rl.length;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.buffer as ArrayBuffer;
}

/** One physical MQTT-over-WebSocket connection to a single broker. */
class MqttConn {
  ready = false;
  onMessage: ((topic: string, payload: string) => void) | null = null;
  onReady: (() => void) | null = null;
  onDown: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private pktId = 1;
  private pinger = 0;
  private closed = false;
  private downFired = false;

  constructor(private url: string) {}

  /** onDown fires at most once — a failed WebSocket raises BOTH onerror and
   *  onclose, and double-counting would make MultiMqtt think every broker died. */
  private fireDown(): void {
    if (this.downFired || this.closed) return;
    this.downFired = true;
    this.onDown?.();
  }

  /** Fire-and-forget connect; calls onReady on CONNACK, onDown on failure/drop. */
  connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch {
      this.fireDown();
      return;
    }
    ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => {
      if (!this.ready) {
        try {
          ws.close();
        } catch {
          // ignore
        }
        this.fireDown();
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      const clientId = `motumbo_${Math.random().toString(36).slice(2, 12)}`;
      ws.send(
        packet(
          0x10,
          mqttString('MQTT'),
          new Uint8Array([4, 0x02, 0, 60]), // level 4, clean session, keepalive 60s
          mqttString(clientId),
        ),
      );
    };
    ws.onmessage = (e) => {
      this.feed(new Uint8Array(e.data as ArrayBuffer), () => {
        if (!this.ready) {
          this.ready = true;
          clearTimeout(timer);
          this.ws = ws;
          this.pinger = setInterval(() => {
            try {
              ws.send(new Uint8Array([0xc0, 0]).buffer as ArrayBuffer);
            } catch {
              // ignore
            }
          }, 30000) as unknown as number;
          this.onReady?.();
        }
      });
    };
    ws.onclose = ws.onerror = () => {
      clearTimeout(timer);
      this.ready = false;
      clearInterval(this.pinger);
      this.fireDown();
    };
  }

  subscribe(topic: string): void {
    if (!this.ready || !this.ws) return;
    const id = this.pktId++;
    const filter = new Uint8Array(mqttString(topic).length + 1);
    filter.set(mqttString(topic), 0);
    filter[filter.length - 1] = 0; // qos 0
    this.ws.send(packet(0x82, new Uint8Array([id >> 8, id & 0xff]), filter));
  }

  publish(topic: string, payload: string): void {
    if (!this.ready || !this.ws) return;
    this.ws.send(packet(0x30, mqttString(topic), enc.encode(payload)));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pinger);
    try {
      this.ws?.send(new Uint8Array([0xe0, 0]).buffer as ArrayBuffer); // DISCONNECT
    } catch {
      // ignore
    }
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
  }

  /** Incremental parser: WebSocket frames may split/merge MQTT packets. */
  private feed(chunk: Uint8Array, onConnack: () => void): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;

    for (;;) {
      if (this.buf.length < 2) return;
      // Remaining-length varint.
      let mul = 1;
      let len = 0;
      let o = 1;
      for (;;) {
        if (o >= this.buf.length) return;
        const b = this.buf[o++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if ((b & 0x80) === 0) break;
        if (o > 5) {
          this.buf = new Uint8Array(0);
          return;
        }
      }
      if (this.buf.length < o + len) return;
      const type = this.buf[0] >> 4;
      const body = this.buf.subarray(o, o + len);
      this.buf = this.buf.slice(o + len);

      if (type === 2) {
        // CONNACK: byte 1 must be 0 (accepted)
        if (body.length >= 2 && body[1] === 0) onConnack();
      } else if (type === 3) {
        const tlen = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + tlen));
        const payload = dec.decode(body.subarray(2 + tlen)); // qos0: no packet id
        this.onMessage?.(topic, payload);
      }
      // PINGRESP (13) / SUBACK (9): nothing to do.
    }
  }
}

/**
 * Fans one logical connection out across every broker. Subscribe/publish hit all
 * live brokers; incoming messages are deduped by (topic|payload). Resolves once
 * ANY broker is ready; onDown fires only when they're ALL down.
 */
class MultiMqtt {
  onMessage: ((topic: string, payload: string) => void) | null = null;
  onDown: (() => void) | null = null;

  private conns: MqttConn[] = [];
  private subs = new Set<string>();
  private seen = new Set<string>();
  private closed = false;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let downCount = 0;
      const total = BROKERS.length;
      this.conns = BROKERS.map((url) => {
        const c = new MqttConn(url);
        c.onReady = () => {
          for (const t of this.subs) c.subscribe(t); // replay subs on late joiners
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        c.onMessage = (topic, payload) => {
          const key = `${topic} ${payload}`;
          if (this.seen.has(key)) return; // same message via a second broker
          this.seen.add(key);
          if (this.seen.size > 400) this.seen.clear(); // handshakes are short
          this.onMessage?.(topic, payload);
        };
        c.onDown = () => {
          downCount++;
          if (downCount >= total && !this.closed) {
            if (!settled) {
              settled = true;
              reject(new Error('No se pudo conectar al servicio de salas. Reintentá en unos segundos.'));
            } else {
              this.onDown?.();
            }
          }
        };
        c.connect();
        return c;
      });
    });
  }

  subscribe(topic: string): void {
    this.subs.add(topic);
    for (const c of this.conns) c.subscribe(topic);
  }

  publish(topic: string, payload: string): void {
    for (const c of this.conns) c.publish(topic, payload);
  }

  close(): void {
    this.closed = true;
    for (const c of this.conns) c.close();
    this.conns = [];
  }
}

// ---------------------------------------------------------------------------
// Room protocol: hello -> offer -> answer, then everyone hangs up.
// ---------------------------------------------------------------------------

export interface HostCallbacks {
  /** A guest knocked; produce the WebRTC offer code for them. */
  makeOffer(): Promise<string>;
  /** The guest answered; feed it to the RTCPeerConnection. */
  onAnswer(answerCode: string): void;
  onError(message: string): void;
}

export interface GuestCallbacks {
  /** The host sent its offer; produce the answer code. */
  makeAnswer(offerCode: string): Promise<string>;
  onError(message: string): void;
}

export class RoomSignal {
  private mqtt = new MultiMqtt();
  private done = false;

  async host(code: string, cb: HostCallbacks): Promise<void> {
    await this.mqtt.connect();
    this.mqtt.onDown = () => {
      if (!this.done) cb.onError('Se cortó el servicio de salas. Creá la sala de nuevo.');
    };
    const base = `motumbo1/${code}`;
    let busyWith: string | null = null;
    this.mqtt.onMessage = (topic, payload) => {
      void (async () => {
        try {
          if (topic === `${base}/hello` && busyWith === null) {
            busyWith = payload; // first guest wins; it's a 1v1
            this.mqtt.publish(`${base}/offer/${payload}`, await cb.makeOffer());
          } else if (topic === `${base}/answer/${busyWith}`) {
            this.done = true;
            cb.onAnswer(payload);
            this.close();
          }
        } catch (err) {
          cb.onError(err instanceof Error ? err.message : String(err));
        }
      })();
    };
    this.mqtt.subscribe(`${base}/hello`);
    this.mqtt.subscribe(`${base}/answer/+`);
  }

  async join(code: string, cb: GuestCallbacks): Promise<void> {
    await this.mqtt.connect();
    this.mqtt.onDown = () => {
      if (!this.done) cb.onError('Se cortó el servicio de salas. Probá de nuevo.');
    };
    const base = `motumbo1/${code}`;
    const me = Math.random().toString(36).slice(2, 10);
    const timer = setTimeout(() => {
      if (!this.done) {
        this.close();
        cb.onError('Nadie respondió en esa sala. Revisá el código o pedile al anfitrión que la vuelva a crear.');
      }
    }, 15000);
    this.mqtt.onMessage = (topic, payload) => {
      void (async () => {
        try {
          if (topic === `${base}/offer/${me}`) {
            clearTimeout(timer);
            clearInterval(helloRetry);
            this.done = true;
            const answer = await cb.makeAnswer(payload);
            this.mqtt.publish(`${base}/answer/${me}`, answer);
            // Give the publish a moment to flush before hanging up.
            setTimeout(() => this.close(), 800);
          }
        } catch (err) {
          clearTimeout(timer);
          clearInterval(helloRetry);
          cb.onError(err instanceof Error ? err.message : String(err));
        }
      })();
    };
    this.mqtt.subscribe(`${base}/offer/${me}`);
    // Re-announce a few times: a broker that connects a beat late (multi-broker)
    // or a subscribe that lands after the first hello would otherwise miss us.
    const sayHello = (): void => {
      if (!this.done) this.mqtt.publish(`${base}/hello`, me);
    };
    sayHello();
    const helloRetry = setInterval(sayHello, 1500);
    setTimeout(() => clearInterval(helloRetry), 12000);
  }

  /**
   * Quick match (slither.io style): announce on a shared lobby and pair with
   * another searcher. Pairing uses a two-step claim→ok LOCK before any WebRTC so
   * a peer can't be orphaned: the lower id claims the higher, the higher accepts
   * only if free, and only then do offer/answer flow. A claim that isn't accepted
   * (target already taken) is released and retried, so 3+ searchers all pair up
   * instead of one being stranded into a bot game. The lower peer becomes host.
   */
  async quickMatch(
    cb: {
      makeOffer(): Promise<string>;
      onAnswer(answer: string): void;
      makeAnswer(offer: string): Promise<string>;
      onRole(isHost: boolean): void;
      onError(message: string): void;
      onNoPeer(): void;
    },
    timeoutMs = 22000,
  ): Promise<void> {
    await this.mqtt.connect();
    // FIXED 8-char id (short randoms could be <8 chars and the length guard below
    // would drop them). Pad to guarantee 8.
    const me = (Math.random().toString(36).slice(2) + '00000000').slice(0, 8);
    const lobby = 'motumbo1/lobby';
    const q = (id: string, kind: string): string => `motumbo1/q/${id}/${kind}`;

    let announceTimer = 0;
    let noPeerTimer = 0;
    // The peer we're currently locking with (claim sent, or ok sent), plus a
    // release timer so a stalled partner doesn't strand us forever.
    let partner: string | null = null;
    let lockTimer = 0;
    const releaseLock = (): void => {
      partner = null;
      clearTimeout(lockTimer);
    };
    const lockTo = (peer: string): void => {
      partner = peer;
      clearTimeout(lockTimer);
      lockTimer = setTimeout(releaseLock, 3000) as unknown as number; // free up if it stalls
    };
    const stopSearch = (): void => {
      clearInterval(announceTimer);
      clearTimeout(noPeerTimer);
      clearTimeout(lockTimer);
    };

    this.mqtt.onDown = () => {
      if (!this.done) cb.onError('Se cortó el servicio de partidas. Probá de nuevo.');
    };
    this.mqtt.onMessage = (topic, payload) => {
      void (async () => {
        try {
          // The host sets done when it sends the offer, but STILL needs the guest's
          // answer to finish WebRTC — so this must run even when done. (The original
          // put this behind the done-guard, so no quick match ever actually
          // connected: the host ignored every answer and both sides fell to bots.)
          if (topic === q(me, 'answer')) {
            cb.onAnswer(payload.slice(payload.indexOf('|') + 1));
            return;
          }
          if (this.done) return;
          if (topic === lobby) {
            const peer = payload;
            if (peer === me || peer.length !== me.length) return;
            // Lower id initiates. Claim the peer if we're free; the ok locks it.
            if (me < peer && partner === null) {
              lockTo(peer);
              this.mqtt.publish(q(peer, 'claim'), me);
            }
          } else if (topic === q(me, 'claim')) {
            // A lower id wants to pair with us. Accept only if we're free.
            const from = payload;
            if (partner === null) {
              lockTo(from);
              this.mqtt.publish(q(from, 'ok'), me); // we're the guest, wait for the offer
            }
          } else if (topic === q(me, 'ok')) {
            // Our claim was accepted → we host: send the offer.
            const from = payload;
            if (partner === from) {
              this.done = true;
              stopSearch();
              cb.onRole(true);
              this.mqtt.publish(q(from, 'offer'), `${me}|${await cb.makeOffer()}`);
            }
          } else if (topic === q(me, 'offer')) {
            const sep = payload.indexOf('|');
            const from = payload.slice(0, sep);
            this.done = true;
            stopSearch();
            cb.onRole(false);
            this.mqtt.publish(q(from, 'answer'), `${me}|${await cb.makeAnswer(payload.slice(sep + 1))}`);
          }
        } catch (err) {
          cb.onError(err instanceof Error ? err.message : String(err));
        }
      })();
    };

    this.mqtt.subscribe(lobby);
    this.mqtt.subscribe(q(me, 'claim'));
    this.mqtt.subscribe(q(me, 'ok'));
    this.mqtt.subscribe(q(me, 'offer'));
    this.mqtt.subscribe(q(me, 'answer'));
    const announce = (): void => {
      if (!this.done) this.mqtt.publish(lobby, me);
    };
    announce();
    announceTimer = setInterval(announce, 1200) as unknown as number;
    noPeerTimer = setTimeout(() => {
      if (!this.done) {
        stopSearch();
        this.close();
        cb.onNoPeer();
      }
    }, timeoutMs) as unknown as number;
  }

  close(): void {
    this.mqtt.close();
  }
}
