// Lockstep protocol simulation: two real WASM sim instances exchanging inputs
// over a fake network with latency, one peer deliberately slower than the
// other. Verifies both peers stay hash-identical at every checkpoint.
// Usage: node scripts/test-lockstep.mjs
import createMotumbo from '../web/src/gen/motumbo.js';

const INPUT_DELAY = 4;
const SEED = 777;
const LEVEL = 3; // ruleta: hazard + random crumble, the most state to diverge
const ITERATIONS = 4000;

function scriptedWord(slot, tick) {
  const dirs = [1, 8, 2, 4];
  let word = dirs[(slot * 2 + (tick >> 5)) % 4];
  if ((tick + slot * 17) % 100 === 0) word |= 16;
  if ((tick + slot * 31) % 80 === 0) word |= 32;
  return word;
}

class Peer {
  constructor(module, slot) {
    this.M = module;
    this.slot = slot;
    this.tick = 0;
    this.local = new Map();
    this.remote = new Map();
    this.hashes = [];
    this.inputsBase = module._motumbo_inputs_ptr() >> 2;
    for (let t = 0; t < INPUT_DELAY; t++) {
      this.local.set(t, 0);
      this.remote.set(t, 0);
    }
    module._motumbo_init(SEED, 2, LEVEL);
  }

  schedule(send) {
    const target = this.tick + INPUT_DELAY;
    if (!this.local.has(target)) {
      const word = scriptedWord(this.slot, target);
      this.local.set(target, word);
      send({ tick: target, word });
    }
  }

  canStep() {
    return this.local.has(this.tick) && this.remote.has(this.tick);
  }

  step() {
    const mine = this.local.get(this.tick);
    const theirs = this.remote.get(this.tick);
    this.M.HEAPU32[this.inputsBase + this.slot] = mine;
    this.M.HEAPU32[this.inputsBase + (1 - this.slot)] = theirs;
    this.M._motumbo_step();
    this.local.delete(this.tick - 2);
    this.remote.delete(this.tick - 2);
    this.tick++;
    if (this.tick % 60 === 0) this.hashes.push(this.M._motumbo_hash() >>> 0);
  }
}

const A = new Peer(await createMotumbo(), 0);
const B = new Peer(await createMotumbo(), 1);

// In-flight messages: delivered when the global iteration reaches deliverAt.
const toB = [];
const toA = [];

for (let iter = 0; iter < ITERATIONS; iter++) {
  const latency = 2 + (iter % 5); // 2..6 iterations of one-way latency

  // Deliver due messages.
  while (toB.length && toB[0].at <= iter) B.remote.set(toB[0].m.tick, toB.shift().m.word);
  while (toA.length && toA[0].at <= iter) A.remote.set(toA[0].m.tick, toA.shift().m.word);

  // Peer A runs full speed; peer B skips every 7th iteration (slower machine).
  A.schedule((m) => toB.push({ at: iter + latency, m }));
  if (A.canStep()) A.step();

  if (iter % 7 !== 0) {
    B.schedule((m) => toA.push({ at: iter + latency, m }));
    if (B.canStep()) B.step();
  }
}

const checkpoints = Math.min(A.hashes.length, B.hashes.length);
let mismatches = 0;
for (let i = 0; i < checkpoints; i++) {
  if (A.hashes[i] !== B.hashes[i]) mismatches++;
}

console.log(`peer A: tick ${A.tick} (${A.hashes.length} checkpoints)`);
console.log(`peer B: tick ${B.tick} (${B.hashes.length} checkpoints)`);
console.log(`checkpoints comparados: ${checkpoints}, desyncs: ${mismatches}`);
console.log(`drift entre peers: ${Math.abs(A.tick - B.tick)} ticks (acotado por el input delay + latencia)`);

if (mismatches === 0 && checkpoints > 30) {
  console.log('LOCKSTEP OK — ambos peers bit-identicos en todos los checkpoints');
  process.exit(0);
} else {
  console.log('LOCKSTEP FALLO');
  process.exit(1);
}
