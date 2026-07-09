// Reliability test for web/src/relay.ts: run two RelayTransports across a LOSSY,
// REORDERING link (drops a fraction of packets, delivers the rest after random
// jitter) and assert every message still arrives EXACTLY ONCE, IN ORDER, both ways.
// That's the guarantee lockstep depends on — a single lost input tick would hang
// the game, so the relay must recover every drop on its own.
//
// Run: node --experimental-transform-types scripts/test-relay.mjs
import { RelayTransport } from '../web/src/relay.ts';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msg = (n) => {
  const b = new ArrayBuffer(4);
  new DataView(b).setUint32(0, n, true);
  return b;
};

// A link that loses `loss` fraction of packets and delivers survivors after 5-40ms
// (so they arrive out of order). `dst` is a late-bound getter for the peer.
function lossyLink(dst, loss) {
  return (packet) => {
    if (Math.random() < loss) return; // dropped on the floor
    setTimeout(() => dst().receive(packet), 5 + Math.random() * 35);
  };
}

async function run(name, loss, count) {
  let A, B;
  A = new RelayTransport(lossyLink(() => B, loss));
  B = new RelayTransport(lossyLink(() => A, loss));
  const gotA = [];
  const gotB = [];
  A.onMessage = (dv) => gotA.push(dv.getUint32(0, true));
  B.onMessage = (dv) => gotB.push(dv.getUint32(0, true));

  // Fire messages both ways at ~60 Hz, like lockstep inputs.
  for (let i = 0; i < count; i++) {
    A.send(msg(i));
    B.send(msg(i));
    await sleep(16);
  }
  // Let retransmits drain.
  await sleep(2500);
  A.close();
  B.close();

  const ordered = (arr) => arr.length === count && arr.every((v, i) => v === i);
  const okB = ordered(gotB);
  const okA = ordered(gotA);
  const detail = okA && okB ? '' : ` A=${gotA.length}/${count} B=${gotB.length}/${count}`;
  console.log(`  ${okA && okB ? '✓' : '✗'} ${name}: all ${count} msgs in order both ways (loss ${Math.round(loss * 100)}%)${detail}`);
  if (!okA || !okB) {
    process.exitCode = 1;
    // Show the first gap for debugging.
    const firstGap = (arr) => { for (let i = 0; i < arr.length; i++) if (arr[i] !== i) return i; return arr.length; };
    console.log(`    A first gap @${firstGap(gotA)}, B first gap @${firstGap(gotB)}`);
  }
}

console.log('relay.ts reliable-over-lossy transport');
await run('30% loss', 0.3, 120);
await run('60% loss', 0.6, 120);

if (process.exitCode) console.log('\nRELAY TESTS FAILED');
else console.log('\nRELAY OK — every message delivered once, in order, despite heavy packet loss.');
process.exit(process.exitCode || 0);
