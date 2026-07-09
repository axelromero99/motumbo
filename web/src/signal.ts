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
//
// The broker also doubles as a LAST-RESORT game relay: when WebRTC can't punch
// the NAT (symmetric NAT, no TURN), quickMatch keeps this MQTT link open and hands
// main.ts a RelayLink (raw publish + inbox subscription) it wraps in a reliable
// RelayTransport, so two players connect even across restrictive networks — at the
// cost of broker latency. signal.ts stays free of the transport itself (and of any
// non-node-resolvable import) so it can run under the node test harness.

/** Raw broker pipe to the paired peer, wrapped by main.ts into a reliable channel. */
export interface RelayLink {
  /** Publish one packet to the peer's relay inbox. */
  sendRaw(packet: string): void;
  /** Register the handler fed with packets arriving on our inbox. */
  setReceiver(handler: (packet: string) => void): void;
  isHost: boolean;
}

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

// Opt-in matchmaking trace: set globalThis.__MM_DEBUG = true (the e2e tests do)
// to log pairing/handshake/retry transitions. Silent in normal play.
function mmlog(...a: unknown[]): void {
  if ((globalThis as { __MM_DEBUG?: boolean }).__MM_DEBUG) console.log('[mm]', ...a);
}

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
  // Per-publish nonce (frames every message). Cross-broker COPIES of one publish
  // share the nonce and dedup; genuine RE-SENDS (re-announce, re-claim, hello
  // retry) get a fresh nonce so they're NOT swallowed — without this, matchmaking
  // retries died silently because their payloads are byte-identical each time.
  private pubTag = Math.random().toString(36).slice(2, 8);
  private pubSeq = 0;

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
        c.onMessage = (topic, framed) => {
          // Dedup on the framed string (nonce + payload): a second broker's COPY of
          // one publish collapses, but a re-send with a fresh nonce does not — that's
          // what lets a failed handshake's retry find its peer again.
          const key = topic + ' ' + framed;
          if (this.seen.has(key)) return;
          this.seen.add(key);
          if (this.seen.size > 3000) this.seen.clear(); // a 5-min search sends many
          const bar = framed.indexOf('|');
          this.onMessage?.(topic, bar >= 0 ? framed.slice(bar + 1) : framed);
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
    // Frame with a unique nonce so every broker gets the SAME string for one
    // logical publish (dedups on the receiver) while re-sends get a fresh nonce
    // (so they survive the dedup). Receiver strips everything up to the first '|'.
    const framed = this.pubTag + this.pubSeq++ + '|' + payload;
    for (const c of this.conns) c.publish(topic, framed);
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
  // quickMatch installs these so main.ts can drive the retry loop from the
  // WebRTC side: confirmConnected() when the DataChannel truly opens (the ONLY
  // thing that ends the search), retryNow() when an attempt's connection dies.
  private onConfirm: (() => void) | null = null;
  private onAbort: (() => void) | null = null;

  /** The DataChannel opened for real — stop searching for good. */
  confirmConnected(): void {
    this.onConfirm?.();
  }

  /** This attempt's WebRTC died — drop the peer and re-enter the pool. */
  retryNow(): void {
    this.onAbort?.();
  }

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
   * only if free, and only then do offer/answer flow. The lower peer becomes host.
   *
   * Resilience (this is what makes it feel like real matchmaking): a lobby pair is
   * only a CANDIDATE. The search does NOT end when offer/answer are exchanged — it
   * ends only when main.ts calls confirmConnected() because the DataChannel really
   * opened. Every attempt gets a watchdog; if the P2P link doesn't confirm in time
   * (NAT with no TURN, ICE failure, a peer that vanished), abortAttempt() drops the
   * partner, tells main.ts to throw away the dead session (onRetry), and re-enters
   * the pool to find a DIFFERENT peer. So a failed handshake never strands anyone,
   * and because the pool stays open across whole bot matches, a rival who shows up
   * a minute later still pairs you in — "connect on the next game" for free.
   *
   *   onNoPeer  fires ONCE after a short grace with nobody → main starts a bot game
   *             while WE KEEP SEARCHING (it is NOT the end of the search).
   *   onRetry   an attempt failed → main drops its half-open NetSession; the next
   *             makeOffer/makeAnswer must build a fresh one.
   *   poolMs    hard cap on the whole search (spans several bot matches); when it
   *             elapses with no connection, the search closes quietly.
   */
  async quickMatch(
    cb: {
      makeOffer(): Promise<string>;
      onAnswer(answer: string): void;
      makeAnswer(offer: string): Promise<string>;
      onRole(isHost: boolean): void;
      onError(message: string): void;
      onNoPeer(): void;
      onRetry?(): void;
      // WebRTC couldn't connect to this partner — here's a raw broker link to relay
      // the game through instead (works if MQTT is up). main.ts wraps it in a
      // RelayTransport and must NOT close the RoomSignal (the relay rides its MQTT).
      onRelay?(link: RelayLink): void;
    },
    poolMs = 300000, // ~5 min: outlives the current match and the next one
    graceMs = 3500, // play-now grace before onNoPeer (bots) — search lives on
  ): Promise<void> {
    await this.mqtt.connect();
    // FIXED 8-char id (short randoms could be <8 chars and the length guard below
    // would drop them). Pad to guarantee 8.
    const me = (Math.random().toString(36).slice(2) + '00000000').slice(0, 8);
    const lobby = 'motumbo1/lobby';
    const q = (id: string, kind: string): string => `motumbo1/q/${id}/${kind}`;
    mmlog(me, 'searching');

    let announceTimer = 0;
    let poolTimer = 0;
    let noPeerFired = false;
    // The peer we're locking/handshaking with, plus a release timer so a stalled
    // partner doesn't strand us before the handshake even starts.
    let partner: string | null = null;
    let lockTimer = 0;
    // A full offer/answer handshake is in flight; block new pairings until it
    // either confirms (confirmConnected) or is aborted (watchdog / dead session).
    let attempting = false;
    let attemptTimer = 0;
    let iAmHost = false; // decided by the pairing (ok=host, offer=guest)
    // Relay fallback: when WebRTC to this partner fails, we don't abandon them —
    // we relay through MQTT. committed pins which transport won this attempt so a
    // late WebRTC open can't fight a live relay (and vice-versa).
    let committed: 'none' | 'webrtc' | 'relay' = 'none';
    let relayTried = false;
    let relayTimer = 0; // proactive: fall back if WebRTC hasn't confirmed in time
    let relayInitTimer = 0; // host: re-send relay-init until the guest acks
    let relayGiveupTimer = 0; // relay handshake itself stalled → re-hunt
    let relayReceiver: ((packet: string) => void) | null = null; // main's inbox handler
    const relayIn = q(me, 'rd'); // our relayed-data inbox

    const releaseLock = (): void => {
      partner = null;
      clearTimeout(lockTimer);
    };
    const lockTo = (peer: string): void => {
      partner = peer;
      clearTimeout(lockTimer);
      // Release fast if the claim→ok stalls (target busy) so we retry another peer
      // quickly. This is only the PRE-handshake lock — beginAttempt pins the partner
      // for the actual offer/answer via its own longer watchdog.
      lockTimer = setTimeout(releaseLock, 3000) as unknown as number;
    };
    const stopSearch = (): void => {
      clearInterval(announceTimer);
      clearTimeout(poolTimer);
      clearTimeout(lockTimer);
      clearTimeout(attemptTimer);
      clearTimeout(relayTimer);
      clearTimeout(relayInitTimer);
      clearTimeout(relayGiveupTimer);
    };

    const announce = (): void => {
      // Pause announcing mid-handshake so a third searcher doesn't claim us.
      if (!this.done && !attempting) this.mqtt.publish(lobby, me);
    };

    // Last resort: abandon this partner entirely and hunt for a fresh one. Only
    // reached if BOTH WebRTC and the relay fallback failed with them (partner gone).
    const reHunt = (): void => {
      if (this.done || !attempting) return;
      mmlog(me, 'giving up on', partner, '→ back to pool');
      attempting = false;
      committed = 'none';
      relayTried = false;
      clearTimeout(attemptTimer);
      clearTimeout(relayTimer);
      clearTimeout(relayInitTimer);
      clearTimeout(relayGiveupTimer);
      releaseLock();
      cb.onRetry?.(); // main tears down the half-open session; next attempt rebuilds
      announce(); // re-enter the pool right away
    };

    // Adopt the broker relay for this partner. Keeps the MQTT link OPEN (the relay
    // rides it) — unlike the WebRTC path, we do NOT close(). done stops the search.
    const commitRelay = (host: boolean): void => {
      if (this.done || committed !== 'none' || !partner) return;
      committed = 'relay';
      this.done = true;
      const peer = partner;
      stopSearch();
      mmlog(me, 'RELAY connected with', peer, host ? '(host)' : '(guest)');
      cb.onRelay?.({
        sendRaw: (pkt) => this.mqtt.publish(q(peer, 'rd'), pkt),
        setReceiver: (fn) => {
          relayReceiver = fn;
        },
        isHost: host,
      });
    };

    // WebRTC to this partner didn't come up → try relaying through the broker with
    // the SAME partner (guaranteed if MQTT is alive) before abandoning them. Host
    // proposes (relay-init), guest waits for it; whoever's silent long enough re-hunts.
    const startRelayFallback = (): void => {
      if (this.done || committed !== 'none' || !attempting || !partner || relayTried) return;
      relayTried = true;
      clearTimeout(relayTimer);
      const peer = partner;
      mmlog(me, 'WebRTC stalled →', iAmHost ? 'offering relay to' : 'awaiting relay from', peer);
      if (iAmHost) {
        const sendInit = (): void => {
          if (committed === 'none' && !this.done) this.mqtt.publish(q(peer, 'ri'), me);
        };
        sendInit();
        relayInitTimer = setInterval(sendInit, 1500) as unknown as number;
        relayGiveupTimer = setTimeout(reHunt, 8000) as unknown as number;
      } else {
        relayGiveupTimer = setTimeout(reHunt, 10000) as unknown as number;
      }
    };

    const beginAttempt = (): void => {
      mmlog(me, 'begin attempt with', partner);
      attempting = true;
      clearTimeout(lockTimer); // pin the partner for the whole handshake
      clearTimeout(relayTimer);
      // Prefer WebRTC (low latency). If it hasn't confirmed in ~15s — a silent stall
      // that connectionState never flagged — fall back to the broker relay. A real
      // failure trips retryNow() sooner and takes the same path. Aborting mid-flight
      // would kill a handshake about to succeed, so this is generous on purpose.
      relayTimer = setTimeout(startRelayFallback, 15000) as unknown as number;
    };

    // main.ts drives these off the real WebRTC channel.
    this.onConfirm = () => {
      if (this.done) return;
      committed = 'webrtc';
      mmlog(me, 'CONFIRMED WebRTC with', partner);
      this.done = true;
      stopSearch();
      this.close(); // WebRTC won — the broker is no longer needed
    };
    this.onAbort = () => {
      mmlog(me, 'retryNow() from main (WebRTC died) → relay fallback');
      startRelayFallback();
    };

    this.mqtt.onDown = () => {
      if (!this.done) cb.onError('Se cortó el servicio de partidas. Probá de nuevo.');
    };
    this.mqtt.onMessage = (topic, payload) => {
      void (async () => {
        try {
          // Relayed game bytes flow AFTER done=true (relay committed), so route them
          // before any guard.
          if (topic === relayIn) {
            relayReceiver?.(payload);
            return;
          }
          // The host needs the guest's answer to finish WebRTC — this runs even
          // while attempting (that's the whole point of the handshake). Accept it
          // ONLY from the peer we're handshaking with, so a late answer from an
          // aborted attempt can't clobber a freshly rebuilt session.
          if (topic === q(me, 'answer')) {
            const sep = payload.indexOf('|');
            if (!this.done && attempting && payload.slice(0, sep) === partner) {
              cb.onAnswer(payload.slice(sep + 1));
            }
            return;
          }
          // Relay coordination runs DURING an attempt (WebRTC failed, still committed
          // to this partner). Host proposes 'ri', guest accepts with 'ra'.
          if (topic === q(me, 'ri')) {
            if (!this.done && attempting && committed === 'none' && payload === partner) {
              this.mqtt.publish(q(partner, 'ra'), me); // ack so the host can commit too
              commitRelay(false);
            }
            return;
          }
          if (topic === q(me, 'ra')) {
            if (!this.done && attempting && committed === 'none' && iAmHost && payload === partner) {
              commitRelay(true);
            }
            return;
          }
          if (this.done || attempting) return; // one candidate at a time
          if (topic === lobby) {
            const peer = payload;
            if (peer === me || peer.length !== me.length) return;
            // Lower id initiates. Claim the peer if we're free; the ok locks it.
            if (me < peer && partner === null) {
              lockTo(peer);
              this.mqtt.publish(q(peer, 'claim'), me);
            }
          } else if (topic === q(me, 'claim')) {
            // A lower id wants to pair with us. Accept only if we're free; otherwise
            // reject at once so the claimer retries another peer immediately instead
            // of waiting out its lock timer (snappy 3+ player pairing).
            const from = payload;
            if (partner === null) {
              mmlog(me, 'claimed by', from, '→ ok');
              lockTo(from);
              this.mqtt.publish(q(from, 'ok'), me); // we're the guest, wait for the offer
            } else if (from !== partner) {
              this.mqtt.publish(q(from, 'no'), me); // busy — try someone else
            }
          } else if (topic === q(me, 'no')) {
            // Our claim was rejected (target already taken) → free up and re-hunt now.
            if (payload === partner) {
              mmlog(me, 'rejected by', payload, '→ re-hunt');
              releaseLock();
              announce();
            }
          } else if (topic === q(me, 'ok')) {
            // Our claim was accepted → we host: send the offer.
            const from = payload;
            if (partner === from) {
              iAmHost = true;
              beginAttempt();
              cb.onRole(true);
              this.mqtt.publish(q(from, 'offer'), `${me}|${await cb.makeOffer()}`);
            }
          } else if (topic === q(me, 'offer')) {
            const sep = payload.indexOf('|');
            const from = payload.slice(0, sep);
            iAmHost = false;
            lockTo(from);
            beginAttempt();
            cb.onRole(false);
            this.mqtt.publish(q(from, 'answer'), `${me}|${await cb.makeAnswer(payload.slice(sep + 1))}`);
          }
        } catch {
          // A WebRTC/build error in THIS attempt isn't fatal — try the broker relay
          // with the same partner. Only a dead broker (onDown) surfaces as an error.
          startRelayFallback();
        }
      })();
    };

    this.mqtt.subscribe(lobby);
    this.mqtt.subscribe(q(me, 'claim'));
    this.mqtt.subscribe(q(me, 'no'));
    this.mqtt.subscribe(q(me, 'ok'));
    this.mqtt.subscribe(q(me, 'offer'));
    this.mqtt.subscribe(q(me, 'answer'));
    this.mqtt.subscribe(q(me, 'ri')); // relay-init (guest hears)
    this.mqtt.subscribe(q(me, 'ra')); // relay-ack (host hears)
    this.mqtt.subscribe(relayIn); // relayed game bytes
    announce();
    announceTimer = setInterval(announce, 1000) as unknown as number;
    // Soft "nobody yet" so main can drop into bots FAST — but the search lives on.
    setTimeout(() => {
      if (!this.done && !noPeerFired) {
        noPeerFired = true;
        cb.onNoPeer();
      }
    }, graceMs);
    poolTimer = setTimeout(() => {
      if (!this.done) {
        stopSearch();
        this.close();
      }
    }, poolMs) as unknown as number;
  }

  close(): void {
    // done stops any in-flight quickMatch handler and neuters late
    // confirm/abort calls from main.ts after teardown.
    this.done = true;
    this.onConfirm = null;
    this.onAbort = null;
    this.mqtt.close();
  }
}
