// Room signaling over public MQTT brokers (WebSocket). Only the WebRTC
// handshake travels through here — a few KB, then the game is pure P2P and
// the broker is out of the picture. Hand-rolled minimal MQTT 3.1.1 client
// (CONNECT / SUBSCRIBE / PUBLISH qos0 / PING) to keep the game dependency-free.

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

class MqttClient {
  onMessage: ((topic: string, payload: string) => void) | null = null;
  onDown: (() => void) | null = null;

  private ws: WebSocket | null = null;
  private buf = new Uint8Array(0);
  private pktId = 1;
  private pinger = 0;
  private closed = false;

  /** Tries each broker in order; resolves once CONNACK arrives. */
  async connect(): Promise<void> {
    for (const url of BROKERS) {
      try {
        await this.connectOne(url);
        return;
      } catch {
        // try the next broker
      }
    }
    throw new Error('No se pudo conectar al servicio de salas. Reintentá en unos segundos.');
  }

  private connectOne(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('timeout'));
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
          if (!settled) {
            settled = true;
            window.clearTimeout(timer);
            this.ws = ws;
            this.pinger = window.setInterval(() => ws.send(new Uint8Array([0xc0, 0]).buffer as ArrayBuffer), 30000);
            resolve();
          }
        });
      };
      ws.onclose = ws.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error('closed'));
        } else if (!this.closed) {
          this.onDown?.();
        }
      };
    });
  }

  subscribe(topic: string): void {
    const id = this.pktId++;
    const filter = new Uint8Array(mqttString(topic).length + 1);
    filter.set(mqttString(topic), 0);
    filter[filter.length - 1] = 0; // qos 0
    this.ws?.send(packet(0x82, new Uint8Array([id >> 8, id & 0xff]), filter));
  }

  publish(topic: string, payload: string): void {
    this.ws?.send(packet(0x30, mqttString(topic), enc.encode(payload)));
  }

  close(): void {
    this.closed = true;
    window.clearInterval(this.pinger);
    try {
      this.ws?.send(new Uint8Array([0xe0, 0]).buffer as ArrayBuffer); // DISCONNECT
    } catch {
      // ignore
    }
    this.ws?.close();
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
  private mqtt = new MqttClient();
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
    const timer = window.setTimeout(() => {
      if (!this.done) {
        this.close();
        cb.onError('Nadie respondió en esa sala. Revisá el código o pedile al anfitrión que la vuelva a crear.');
      }
    }, 15000);
    this.mqtt.onMessage = (topic, payload) => {
      void (async () => {
        try {
          if (topic === `${base}/offer/${me}`) {
            window.clearTimeout(timer);
            this.done = true;
            const answer = await cb.makeAnswer(payload);
            this.mqtt.publish(`${base}/answer/${me}`, answer);
            // Give the publish a moment to flush before hanging up.
            window.setTimeout(() => this.close(), 800);
          }
        } catch (err) {
          window.clearTimeout(timer);
          cb.onError(err instanceof Error ? err.message : String(err));
        }
      })();
    };
    this.mqtt.subscribe(`${base}/offer/${me}`);
    this.mqtt.publish(`${base}/hello`, me);
  }

  /**
   * Quick match (slither.io style): announce on a shared lobby, pair with the
   * first other player who is also searching, and run the same offer/answer
   * handshake. If no human turns up before `timeoutMs`, calls onNoPeer so the
   * caller can start a bot game instead. The lower peer id becomes host.
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
    timeoutMs = 8000,
  ): Promise<void> {
    await this.mqtt.connect();
    const me = Math.random().toString(36).slice(2, 10);
    const lobby = 'motumbo1/lobby';
    let announceTimer = 0;
    let noPeerTimer = 0;
    const stopSearch = (): void => {
      window.clearInterval(announceTimer);
      window.clearTimeout(noPeerTimer);
    };

    this.mqtt.onDown = () => {
      if (!this.done) cb.onError('Se cortó el servicio de partidas. Probá de nuevo.');
    };
    this.mqtt.onMessage = (topic, payload) => {
      void (async () => {
        try {
          if (this.done) return;
          if (topic === lobby) {
            const peer = payload;
            if (peer === me || peer.length !== me.length) return;
            // Only the lower id initiates; the other waits for the offer.
            if (me < peer) {
              this.done = true;
              stopSearch();
              cb.onRole(true);
              this.mqtt.publish(`motumbo1/q/${peer}/offer`, `${me}|${await cb.makeOffer()}`);
            }
          } else if (topic === `motumbo1/q/${me}/offer`) {
            const sep = payload.indexOf('|');
            const from = payload.slice(0, sep);
            this.done = true;
            stopSearch();
            cb.onRole(false);
            this.mqtt.publish(`motumbo1/q/${from}/answer`, `${me}|${await cb.makeAnswer(payload.slice(sep + 1))}`);
          } else if (topic === `motumbo1/q/${me}/answer`) {
            cb.onAnswer(payload.slice(payload.indexOf('|') + 1));
          }
        } catch (err) {
          cb.onError(err instanceof Error ? err.message : String(err));
        }
      })();
    };

    this.mqtt.subscribe(lobby);
    this.mqtt.subscribe(`motumbo1/q/${me}/offer`);
    this.mqtt.subscribe(`motumbo1/q/${me}/answer`);
    const announce = (): void => {
      if (!this.done) this.mqtt.publish(lobby, me);
    };
    announce();
    announceTimer = window.setInterval(announce, 1200);
    noPeerTimer = window.setTimeout(() => {
      if (!this.done) {
        stopSearch();
        this.close();
        cb.onNoPeer();
      }
    }, timeoutMs);
  }

  close(): void {
    this.mqtt.close();
  }
}
