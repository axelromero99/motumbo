// QA screenshot harness. Jumps straight into a scenario via the #dev deep-link
// (no menu clicking), optionally drives the ball, and saves a screenshot with a
// real GPU so Three.js actually renders (headless SwiftShader renders black).
//
// Needs Playwright: `npm i -D playwright` (browsers download once). Run the dev
// server first (`npm run dev`), then e.g.:
//   node scripts/shot.mjs --level 76 --cam 2 --mode cosecha --wait 6000 --out saltos.png
//   node scripts/shot.mjs --level CLÁSICA --drive w --wait 1500 --out away.png
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const base = opt('url', 'http://localhost:5173');
const level = opt('level', '0');
const cam = opt('cam', '0');
const mode = opt('mode', 'sumo');
const bots = opt('bots', '1');
const wait = Number(opt('wait', '4500'));
const drive = opt('drive', ''); // e.g. "wwd" — keys held in sequence, 500ms each
const out = opt('out', 'shot.png');

const hash = `#dev=level=${encodeURIComponent(level)}&cam=${cam}&mode=${mode}&bots=${bots}`;
const browser = await chromium.launch({
  headless: false, // headed + real GPU: Three renders black under SwiftShader
  ignoreDefaultArgs: ['--disable-gpu', '--use-gl=swiftshader'],
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(base + '/' + hash, { waitUntil: 'load' });
await page.waitForTimeout(wait);
for (const key of drive) {
  await page.keyboard.down(key);
  await page.waitForTimeout(500);
  await page.keyboard.up(key);
}
await page.screenshot({ path: out });
await browser.close();
console.log(`shot -> ${out}  (level=${level} cam=${cam} mode=${mode})  errors=${errs.length}`);
if (errs.length) console.log('  ' + errs.slice(0, 3).join('\n  '));
