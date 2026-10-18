// End-to-end test of the Android app on a connected device or emulator (run in CI).
// Usage: node tests/android/smoke.mjs path/to/app-debug.apk
//
// Needs a *debug* APK (WebView debugging is only enabled there) and the
// Playwright Android driver: `npx playwright install android`.
import { _android as android } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeWav, analyseInPage, orbitIsCorrect } from '../fixtures.mjs';

const PKG = 'io.github.syhuinc.eightd';
const OUT = 'test-results/android';
const apk = process.argv[2];
if (!apk) throw new Error('usage: node tests/android/smoke.mjs <debug apk>');

const DOCS_UI = { pkg: /documentsui/ }; // the system file picker / "Save as" screen
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let device;
let page;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    console.log(results.at(-1));
  } catch (err) {
    results.push(`FAIL  ${name}: ${err.message}`);
    console.log(results.at(-1));
    await debugDump(name);
    throw err;
  }
}

async function debugDump(name) {
  const slug = name.replace(/\W+/g, '-');
  try { await device.screenshot({ path: `${OUT}/${slug}.png` }); } catch {}
  try {
    // Print what's on screen so failures are diagnosable from the CI log alone.
    await device.shell('uiautomator dump /sdcard/ui.xml');
    const xml = (await device.shell('cat /sdcard/ui.xml')).toString();
    const nodes = [...xml.matchAll(/text="([^"]*)"[^>]*resource-id="([^"]*)"[^>]*package="([^"]*)"[^>]*bounds="([^"]*)"/g)]
      .filter((m) => m[1] || m[2]).map((m) => `  ${m[3]} | ${m[2]} | "${m[1]}" ${m[4]}`);
    console.log(`--- screen at failure (${nodes.length} nodes) ---\n${nodes.join('\n')}`);
  } catch (e) { console.log('ui dump failed:', e.message); }
}

async function launch() {
  await device.shell(`am force-stop ${PKG}`);
  await device.shell(`am start -W -n ${PKG}/.MainActivity`);
  const webview = await device.webView({ pkg: PKG }, { timeout: 30_000 });
  page = await webview.page();
  await page.waitForSelector('#drop');
}

async function loadSong(name) {
  // A real file pick needs a file on the device; injecting one through
  // DataTransfer exercises the same 'change' handler the picker triggers.
  const b64 = makeWav().toString('base64');
  await page.evaluate(({ b64, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'audio/wav' }));
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, { b64, name });
  await page.waitForFunction((n) => document.getElementById('dropTitle').textContent === n
    && document.getElementById('status').textContent === '', name, { timeout: 30_000 });
}

const status = () => page.textContent('#status');

async function main() {
  await mkdir(OUT, { recursive: true });
  [device] = await android.devices();
  assert.ok(device, 'no Android device found (is the emulator running?)');
  console.log(`device: ${device.model()} (${device.serial()})`);
  const sdk = (await device.shell('getprop ro.build.version.sdk')).toString().trim();
  const webviewVersion = (await device.shell('dumpsys webviewupdate | grep "Current WebView package"')).toString().trim();
  console.log(`API ${sdk}; ${webviewVersion}`);

  await step('install and launch', async () => {
    await device.installApk(apk);
    await launch();
    assert.equal(await page.title(), '8D Converter');
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await step('content stays clear of the status and navigation bars', async () => {
    const size = (await device.shell('wm size')).toString().match(/(\d+)x(\d+)\s*$/m);
    const screenH = Number(size[2]);
    const { bounds } = await device.info({ clazz: 'android.webkit.WebView' });
    console.log(`  screen height ${screenH}px, WebView bounds ${JSON.stringify(bounds)}`);
    assert.ok(bounds.y > 0, 'WebView starts under the status bar');
    assert.ok(bounds.y + bounds.height < screenH, 'WebView extends under the navigation bar');
  });

  await step('file picker opens, and opens again after being cancelled', async () => {
    for (let i = 0; i < 2; i++) {
      await page.click('#drop');
      await device.wait(DOCS_UI, { timeout: 15_000 });
      await device.input.press('Back');
      await device.wait(DOCS_UI, { state: 'gone', timeout: 15_000 });
      await sleep(500);
    }
  });

  await step('load a song', () => loadSong('song.wav'));

  await step('playback runs', async () => {
    await page.click('#play');
    await page.waitForFunction(() => document.getElementById('cur').textContent >= '0:02', null, { timeout: 15_000 });
    assert.equal(await page.getAttribute('#play', 'aria-label'), 'Pause');
    await page.click('#play');
  });

  await step('MP3 export saves through the "Save as" screen and keeps the orbit', async () => {
    await device.shell('rm -f "/sdcard/Download/song (8D).mp3"');
    await page.selectOption('#format', 'mp3-128');
    await page.click('#export');
    await device.wait(DOCS_UI, { timeout: 60_000 });
    await device.screenshot({ path: `${OUT}/save-dialog.png` });
    await device.tap({ text: /^save$/i });
    await page.waitForFunction(() => /Done|cancelled|failed/.test(document.getElementById('status').textContent), null, { timeout: 30_000 });
    assert.match(await status(), /^Done/);
    const listing = (await device.shell('ls -l /sdcard/Download/')).toString();
    console.log(`  Download/: ${listing.split('\n').filter((l) => l.includes('8D')).join(' | ')}`);
    const b64 = (await device.shell('base64 -w 0 "/sdcard/Download/song (8D).mp3"')).toString().trim();
    const bytes = Buffer.from(b64, 'base64');
    assert.ok(bytes.length > 100_000, `saved file is ${bytes.length} bytes`);
    const a = await analyseInPage(page, bytes);
    console.log(`  saved MP3: ${bytes.length} bytes, ${a.duration.toFixed(2)} s, pattern ${a.pattern}`);
    assert.ok(orbitIsCorrect(a.pattern), `orbit pattern ${a.pattern}`);
  });

  await step('cancelling the "Save as" screen is reported', async () => {
    await page.click('#export');
    await device.wait(DOCS_UI, { timeout: 60_000 });
    await device.input.press('Back');
    await page.waitForFunction(() => document.getElementById('status').textContent === 'Save cancelled.', null, { timeout: 15_000 });
  });

  await step('rotating keeps the loaded song', async () => {
    await page.evaluate(() => { window.__notReloaded = true; });
    await device.shell('settings put system accelerometer_rotation 0');
    await device.shell('settings put system user_rotation 1');
    await sleep(3000);
    assert.equal(await page.evaluate(() => window.__notReloaded), true, 'page was reloaded');
    assert.equal(await page.textContent('#dropTitle'), 'song.wav');
    await device.shell('settings put system user_rotation 0');
    await sleep(1500);
  });

  await step('no page errors so far', async () => assert.deepEqual(errors, []));

  await step('dark mode: page follows the system theme', async () => {
    await device.shell('cmd uimode night yes');
    await launch();
    assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
    await device.screenshot({ path: `${OUT}/dark.png` });
    await device.shell('cmd uimode night no');
  });
}

try {
  await main();
} finally {
  await writeFile(`${OUT}/summary.txt`, results.join('\n') + '\n');
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} steps passed`);
  if (device) device.close();
}
