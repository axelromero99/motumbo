// Unit test for web/src/signal.ts WITHOUT a real broker or browser. We stand up
// in-process mock MQTT brokers (one per BROKERS url) speaking just enough of
// MQTT 3.1.1 (CONNECT/CONNACK, SUBSCRIBE, PUBLISH qos0 with + wildcards, PING),
// plug a fake global WebSocket into them, then run many RoomSignal.quickMatch
// clients at once and assert: everyone pairs mutually, nobody is orphaned, and a
// client reachable on only ONE broker still pairs with a client on only the OTHER
// as long as they share one. Mocked WebRTC (offer/answer are opaque tokens).
//
// Run: node --experimental-transform-types scripts/test-signal.mjs
// ---- mock MQTT brokers -----------------------------------------------------

function topicMatches(filter, topic) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] === '+') {
      if (t[i] === undefined) return false;
      continue;
    }
    if (f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function mqttPublishPacket(topic, payload) {
  const tb = enc.encode(topic);
  const pb = enc.encode(payload);
  const body = new Uint8Array(2 + tb.length + pb.length);
  body[0] = tb.length >> 8;
  body[1] = tb.length & 0xff;
  body.set(tb, 2);
  body.set(pb, 2 + tb.length);
  // remaining-length varint
  const rl = [];
  let n = body.length;
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    rl.push(b);
  } while (n > 0);
  const out = new Uint8Array(1 + rl.length + body.length);
  out[0] = 0x30;
  out.set(rl, 1);
  out.set(body, 1 + rl.length);
  return out;
}

class Broker {
  constructor(url) {
    this.url = url;
    this.subs = new Map(); // ws -> Set<filter>
    this.up = true;
  }
  detach(ws) {
    this.subs.delete(ws);
  }
  handle(ws, data) {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const type = buf[0] >> 4;
    // parse remaining length
    let mul = 1;
    let len = 0;
    let o = 1;
    for (;;) {
      const b = buf[o++];
      len += (b & 0x7f) * mul;
      mul *= 128;
      if ((b & 0x80) === 0) break;
    }
    const body = buf.subarray(o, o + len);
    if (type === 1) {
      // CONNECT → register + CONNACK (accepted)
      if (!this.subs.has(ws)) this.subs.set(ws, new Set());
      ws._deliver(new Uint8Array([0x20, 0x02, 0x00, 0x00]));
    } else if (type === 8) {
      // SUBSCRIBE: [id_hi,id_lo, (topiclen, topic, qos)...]
      let p = 2;
      const set = this.subs.get(ws);
      while (p < body.length) {
        const tl = (body[p] << 8) | body[p + 1];
        const topic = dec.decode(body.subarray(p + 2, p + 2 + tl));
        p += 2 + tl + 1; // + qos byte
        set?.add(topic);
      }
    } else if (type === 3) {
      // PUBLISH qos0: [topiclen, topic, payload]
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      const payload = dec.decode(body.subarray(2 + tl));
      const pkt = mqttPublishPacket(topic, payload);
      for (const [cws, filters] of this.subs) {
        for (const f of filters) {
          if (topicMatches(f, topic)) {
            cws._deliver(pkt);
            break;
          }
        }
      }
    }
    // PINGREQ / DISCONNECT: ignore
  }
}

const brokers = new Map(); // url -> Broker
function brokerFor(url) {
  if (!brokers.has(url)) brokers.set(url, new Broker(url));
  return brokers.get(url);
}

// Per-client reachability filter: some tests block a client from some brokers.
let reachable = () => true;
let clientSeq = 0;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = 'arraybuffer';
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this._client = curClient; // capture SYNCHRONOUSLY at construction time
    this._broker = brokerFor(url);
    this._closed = false;
    queueMicrotask(() => {
      if (this._closed) return;
      if (!reachable(this._client, url) || !this._broker.up) {
        this._closed = true;
        this.onerror?.(new Error('blocked'));
        this.onclose?.();
        return;
      }
      this.onopen?.();
    });
  }
  send(data) {
    if (this._closed) return;
    // If not yet CONNACKed we still forward; broker handles CONNECT (ignored).
    this._broker.handle(this, data);
  }
  _deliver(bytes) {
    if (this._closed) return;
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    this._broker.detach(this);
    this.onclose?.();
  }
}

// Track which client is currently constructing sockets (for reachability).
let curClient = null;
globalThis.WebSocket = FakeWebSocket;

// ---- load signal.ts --------------------------------------------------------

const mod = await import(new URL('../web/src/signal.ts', import.meta.url).href);
const { RoomSignal } = mod;

// ---- harness ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQuickMatch(n, { block, wait = 2000, timeoutMs = 4000, graceMs = 6000 } = {}) {
  reachable = block || (() => true);
  brokers.clear();
  const clients = [];
  for (let i = 0; i < n; i++) {
    const id = `C${i}`;
    const rs = new RoomSignal();
    const rec = { id, rs, role: null, partner: null, noPeer: false, error: null, completed: false };
    clients.push(rec);
    curClient = id; // reachability sees this during connect()
    // Each client's sockets are tagged with its id via the closure below.
    rs.quickMatch(
      {
        onRole: (host) => {
          rec.role = host ? 'host' : 'guest';
        },
        makeOffer: async () => `off:${id}`,
        makeAnswer: async (offer) => {
          rec.partner = offer.slice(4); // "off:C3" -> host id
          rec.completed = true;
          // Simulate the DataChannel opening a beat AFTER the answer flushes — that's
          // what ends the search in the real app (offer/answer alone is a candidate).
          // Must lag the publish or we'd close the broker before the answer is sent.
          setTimeout(() => rec.rs.confirmConnected(), 40);
          return `ans:${id}`;
        },
        onAnswer: (answer) => {
          rec.partner = answer.slice(4); // "ans:C7" -> guest id
          rec.completed = true;
          setTimeout(() => rec.rs.confirmConnected(), 40); // host: link opens next
        },
        onError: (m) => {
          rec.error = m;
        },
        onNoPeer: () => {
          rec.noPeer = true;
        },
        onRetry: () => {
          rec.retries = (rec.retries || 0) + 1;
        },
      },
      timeoutMs,
      graceMs,
    ).catch((e) => {
      rec.error = e instanceof Error ? e.message : String(e);
    });
    // Wait a tick so this client's WebSockets construct under its curClient tag.
    await sleep(5);
  }
  // Let the handshakes play out.
  await sleep(wait);
  // Close everyone so the MQTT ping intervals don't keep node alive.
  for (const c of clients) {
    try {
      c.rs.close();
    } catch {
      // ignore
    }
  }
  return clients;
}

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.log(`  ✗ ${name} ${detail}`);
    process.exitCode = 1;
  }
}

// Reachability tags sockets by the *constructing* client. Because construction
// is synchronous inside quickMatch->connect, curClient is correct per client.

console.log('signal.ts quick-match pairing');

// 1) Two searchers pair mutually.
{
  const c = await runQuickMatch(2);
  const [a, b] = c;
  check('2 peers: both completed', a.completed && b.completed);
  check('2 peers: mutual', a.partner === b.id && b.partner === a.id, `a→${a.partner} b→${b.partner}`);
  check('2 peers: one host one guest', a.role !== b.role && a.role && b.role, `${a.role}/${b.role}`);
  check('2 peers: no orphan/noPeer', !a.noPeer && !b.noPeer && !a.error && !b.error);
}

// 2) FOUR searchers → two clean pairs, nobody orphaned (the old code stranded one
//    per extra peer into a bot game). Generous window: lock contention among 4 can
//    take an extra claim→release cycle, and grace stays high so a slow-but-real pair
//    isn't miscounted as an orphan.
{
  const c = await runQuickMatch(4, { wait: 3500, timeoutMs: 12000, graceMs: 10000 });
  const done = c.filter((x) => x.completed).length;
  const orphans = c.filter((x) => x.noPeer || x.error).length;
  check('4 peers: all 4 completed', done === 4, `done=${done}`);
  check('4 peers: no orphans', orphans === 0, `orphans=${orphans}`);
  // every partner link is reciprocal
  const byId = Object.fromEntries(c.map((x) => [x.id, x]));
  const mutual = c.every((x) => x.partner && byId[x.partner]?.partner === x.id);
  check('4 peers: all links reciprocal', mutual);
}

// 3) THREE searchers → exactly one pair, and the odd one out falls back to bots
//    (onNoPeer) while it KEEPS searching (new resilient behavior). We don't assert
//    that the paired two never fire onNoPeer — in the real app a slow pair legitimately
//    plays a beat of bots before swapping in — only that the lonely peer is the one
//    left unpaired and signalled to bots.
{
  const c = await runQuickMatch(3, { wait: 2500, timeoutMs: 8000, graceMs: 300 });
  const done = c.filter((x) => x.completed);
  const lonely = c.filter((x) => !x.completed);
  check('3 peers: exactly 2 paired', done.length === 2, `done=${done.length}`);
  check('3 peers: odd one out falls back to bots', lonely.length === 1 && lonely[0].noPeer, `lonely=${lonely.map((x) => x.id + (x.noPeer ? '(bots)' : '(stranded!)'))}`);
}

// 4) BROKER SPLIT: A reachable only on broker[0], B only on broker[1]. They share
//    NO broker → must NOT pair (correctly), and each reports noPeer. This proves
//    the multi-broker fan-out is what lets same-broker peers meet.
{
  const B0 = 'wss://broker.emqx.io:8084/mqtt';
  const c = await runQuickMatch(2, {
    block: (client, url) => (client === 'C0' ? url === B0 : url !== B0),
  });
  const paired = c.filter((x) => x.completed).length;
  check('split brokers: no false pairing', paired === 0, `paired=${paired}`);
}

// 5) PARTIAL overlap: A on both brokers, B only on broker[1]. They share broker[1]
//    → they DO pair even though A also uses broker[0]. This is the real win.
{
  const B0 = 'wss://broker.emqx.io:8084/mqtt';
  const c = await runQuickMatch(2, {
    block: (client, url) => (client === 'C0' ? true : url !== B0),
  });
  const [a, b] = c;
  check('overlap brokers: still pair', a.completed && b.completed, `a=${a.completed} b=${b.completed}`);
  if (!(a.completed && b.completed)) {
    console.log('    DEBUG overlap:', JSON.stringify(c.map((x) => ({ id: x.id, role: x.role, done: x.completed, err: x.error, np: x.noPeer }))));
  }
}

// 6) RELAY FALLBACK: when WebRTC can't connect, retryNow() must NOT abandon the
//    peer — the matchmaker relays the game through the broker instead. Both sides
//    end up with a RelayLink, exactly one as host. (This also exercises the ri/ra
//    coordination and the per-publish nonce, since those messages repeat.)
{
  reachable = () => true;
  brokers.clear();
  const mk = (id) => {
    const rs = new RoomSignal();
    const rec = { id, rs, role: null, relay: false, relayHost: null };
    curClient = id;
    rs.quickMatch(
      {
        onRole: (h) => {
          rec.role = h ? 'host' : 'guest';
        },
        makeOffer: async () => `off:${id}`,
        makeAnswer: async () => `ans:${id}`,
        onAnswer: () => {},
        onError: () => {},
        onNoPeer: () => {},
        onRetry: () => {},
        onRelay: (link) => {
          rec.relay = true;
          rec.relayHost = link.isHost;
        },
      },
      30000,
      9000, // grace high so it doesn't interfere
    );
    return rec;
  };
  const A = mk('R0');
  await sleep(5);
  const B = mk('R1');
  await sleep(1600); // pair (offer/answer exchanged; no confirmConnected yet)
  // Both WebRTC links "die" → main.ts calls retryNow(); the matchmaker must relay.
  A.rs.retryNow();
  B.rs.retryNow();
  await sleep(1200); // ri → ra → both commit to the relay
  check('relay fallback: both got a relay link', A.relay && B.relay, `A=${A.relay} B=${B.relay}`);
  check('relay fallback: exactly one relay host', A.relayHost !== B.relayHost && A.relayHost !== null, `A=${A.relayHost} B=${B.relayHost}`);
  A.rs.close();
  B.rs.close();
}

if (process.exitCode) console.log('\nSIGNAL TESTS FAILED');
else console.log('\nSIGNAL OK — quick-match pairs, survives broker splits, and relays when WebRTC fails.');
// Any stray broker timers are cleared by close(); exit promptly regardless.
process.exit(process.exitCode || 0);
