// Render smoke test: boots the game with a real GPU across a few levels and
// fails if the arena comes up (near-)black — the class of bug that shipped once
// when a bad pieceCount threw the camera into the void. A uniformly black frame
// compresses to a tiny PNG, so we screenshot (compositor capture works; in-page
// canvas readback returns black without preserveDrawingBuffer) and threshold the
// byte size. LOCAL only: needs a real GPU (CI's headless SwiftShader can't run
// Three). Start the dev server first, then: node scripts/smoke-render.mjs [url]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:5173';
const levels = [0, 12, 40, 76]; // one per level family
const MIN_PNG = 15000; // bytes; a solid-black 900×640 PNG is only a few KB

const browser = await chromium.launch({
  headless: false,
  ignoreDefaultArgs: ['--disable-gpu', '--use-gl=swiftshader'],
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
let fails = 0;
for (const level of levels) {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } });
  await page.goto(`${base}/#dev=level=${level}`, { waitUntil: 'load' });
  await page.waitForTimeout(4200);
  const buf = await page.screenshot();
  const ok = buf.length >= MIN_PNG;
  console.log(`  nivel ${String(level).padStart(2)}: PNG ${(buf.length / 1024).toFixed(0)}KB ${ok ? 'OK' : 'NEGRO ✗'}`);
  if (!ok) fails++;
  await page.close();
}
await browser.close();
if (fails) {
  console.log(`SMOKE FALLO — ${fails} nivel(es) renderizaron negro.`);
  process.exit(1);
}
console.log('SMOKE OK — todos los niveles renderizan.');
