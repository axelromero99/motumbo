// End-to-end online matchmaking test with TWO REAL browsers — the honest "two
// different PCs press JUGAR" check. Each browser is its own Chromium process, so
// this exercises the whole stack for real: the MQTT lobby on the public brokers,
// the claim→ok→offer→answer handshake, WebRTC ICE/DTLS, and — crucially — the
// lockstep round ACTUALLY RUNNING afterward (both sims advancing in step). It also
// blocks WebRTC entirely to prove the broker-relay fallback carries a live match,
// which is what lets two players connect across restrictive NATs with no TURN.
//
// Observability: with globalThis.__MM_DEBUG the app publishes window.__mmMode /
// __mmTick / __mmRelay each frame. A round is LIVE only when both peers reach
// mode 'net' AND their tick has advanced well past the countdown — that can only
// happen if both are exchanging inputs in lockstep, over WebRTC or the relay.
//
// LOCAL only (like scripts/smoke-render.mjs): needs a running dev server and reaches
// the public brokers, so it's NOT part of `npm test`/CI. Start the dev server, then:
//   node scripts/test-matchmaking-e2e.mjs [url]
// Default url: http://localhost:5174/  (MOTUMBO's dev port; 5173 is taken).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../web/package.json', import.meta.url));
const { chromium } = require('playwright'); // resolved from web/node_modules

const URL_ = process.argv[2] || process.env.MM_URL || 'http://localhost:5174/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;

// Count RTCPeerConnections and (when sabotage is on) kill the first N of them a
// beat after creation, simulating a NAT WebRTC can never punch. Nothing in
// production code is touched.
function instrument(sabotageFirst) {
  const w = window;
  w.__pc = 0;
  const Native = w.RTCPeerConnection;
  if (!Native) return;
  w.RTCPeerConnection = function (...args) {
    const pc = new Native(...args);
    const n = ++w.__pc;
    if (n <= sabotageFirst) setTimeout(() => { try { pc.close(); } catch {} }, 2500);
    return pc;
  };
  w.RTCPeerConnection.prototype = Native.prototype;
}

async function openPc(label, sabotageFirst) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await (await browser.newContext()).newPage();
  const trace = [];
  page.on('console', (m) => { if (m.text().includes('[mm]')) trace.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', (e) => trace.push(`[${label}] PAGEERROR ${e.message}`));
  await page.addInitScript(() => { globalThis.__MM_DEBUG = true; });
  await page.addInitScript(instrument, sabotageFirst);
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  return { browser, page, label, trace };
}

const state = (p) =>
  p.evaluate(() => ({ mode: window.__mmMode, tick: window.__mmTick ?? -1, relay: !!window.__mmRelay, pcs: window.__pc ?? 0 })).catch(() => null);
// Live only if BOTH are in a net round whose lockstep has advanced past the
// countdown — impossible unless both are feeding inputs to each other.
const roundLive = (a, b) => a?.mode === 'net' && b?.mode === 'net' && a.tick > 60 && b.tick > 60;

async function play(a, b, watchMs) {
  await a.page.click('#btn-quickplay');
  await sleep(300);
  await b.page.click('#btn-quickplay');
  const t0 = Date.now();
  while (Date.now() - t0 < watchMs) {
    if (roundLive(await state(a.page), await state(b.page))) return (Date.now() - t0) / 1000;
    await sleep(1000);
  }
  return null;
}

function check(name, cond, detail = '') {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) failed = 1;
}

console.log(`matchmaking e2e (two real browsers) → ${URL_}`);

// 1) Happy path: two fresh PCs press JUGAR and the online round RUNS over WebRTC.
{
  const A = await openPc('A', 0);
  const B = await openPc('B', 0);
  const secs = await play(A, B, 45000);
  const [a, b] = [await state(A.page), await state(B.page)];
  check('online round runs after JUGAR (both in lockstep)', secs !== null, `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  check('used direct WebRTC, not the relay', a?.relay === false && b?.relay === false, `relay A=${a?.relay} B=${b?.relay}`);
  if (secs !== null) console.log(`    round live in ~${secs.toFixed(1)}s over WebRTC`);
  await A.browser.close();
  await B.browser.close();
}

// 2) WebRTC blocked (symmetric NAT, no TURN): every PeerConnection is killed, so
//    the match must fall back to the BROKER RELAY and still run a live round.
{
  const A = await openPc('A', 99);
  const B = await openPc('B', 99);
  const secs = await play(A, B, 55000);
  const [a, b] = [await state(A.page), await state(B.page)];
  check('online round runs even when WebRTC is blocked', secs !== null, `A=${JSON.stringify(a)} B=${JSON.stringify(b)}`);
  check('fell back to the broker relay', a?.relay === true && b?.relay === true, `relay A=${a?.relay} B=${b?.relay}`);
  if (secs !== null) console.log(`    round live in ~${secs.toFixed(1)}s over the relay`);
  if (secs === null) for (const l of [...A.trace, ...B.trace]) console.log('    ' + l);
  await A.browser.close();
  await B.browser.close();
}

console.log(failed ? '\nMATCHMAKING E2E FAILED' : '\nMATCHMAKING E2E OK — the round runs over WebRTC, and over the broker relay when WebRTC is blocked.');
process.exit(failed);
