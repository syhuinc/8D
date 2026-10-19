// End-to-end test of the Android app on a connected device or emulator (run in CI).
// Usage: node tests/android/smoke.mjs path/to/app-debug.apk
//
// Needs a *debug* APK (WebView debugging is only enabled there) and adb on PATH.
import { _android as android } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeMix, MIX, placementInPage } from '../fixtures.mjs';

const PKG = 'io.github.syhuinc.eightd';
const OUT = 'test-results/android';
const apk = process.argv[2];
const testPlayerApk = process.argv[3]; // optional: android/testplayer debug APK, for the live 8D step
if (!apk) throw new Error('usage: node tests/android/smoke.mjs <debug apk> [testplayer apk]');

// Screen inspection goes through plain adb tools (dumpsys / uiautomator / input)
// rather than Playwright's Android selector driver, which holds the single
// UiAutomation connection and makes `uiautomator dump` return nothing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let device;
let page;

const sh = async (cmd) => (await device.shell(cmd)).toString();

/** Fails instead of hanging if the app's page stops answering (e.g. a frozen process). */
function withTimeout(promise, what, ms = 15_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s ${what}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
const focusedWindow = async () => (await sh('dumpsys window | grep mCurrentFocus')).trim();
const pickerShowing = async () => /documentsui/i.test(await focusedWindow()); // system picker / "Save as"
const pressBack = () => sh('input keyevent KEYCODE_BACK');

async function waitUntil(check, what, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await dismissNotResponding();
    await sleep(500);
  }
  throw new Error(`timed out after ${timeout / 1000}s waiting for ${what} (focus: ${await focusedWindow()})`);
}

/**
 * A cold emulator sometimes shows "<system app> isn't responding" (seen once
 * for the file picker). A person would press Wait; so does the test.
 */
async function dismissNotResponding() {
  for (let i = 0; i < 5 && /Application Not Responding/.test(await focusedWindow()); i++) {
    const wait = (await screenNodes()).find((n) => /^wait$/i.test(n.text) && n.box);
    console.log(`  (system "not responding" dialog; pressing ${wait ? 'Wait' : 'Back'})`);
    if (wait) await sh(`input tap ${(wait.box.x1 + wait.box.x2) >> 1} ${(wait.box.y1 + wait.box.y2) >> 1}`);
    else await pressBack();
    await sleep(1000);
  }
}

/** All on-screen nodes as attribute maps, plus parsed bounds. */
async function screenNodes() {
  const xml = await sh('uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml');
  return [...xml.matchAll(/<node ([^>]*?)\/?>/g)].map((m) => {
    const a = Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (b) a.box = { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] };
    return a;
  });
}

async function tapNode(match, what) {
  let node;
  await waitUntil(async () => (node = (await screenNodes()).find(match)), what);
  await sh(`input tap ${(node.box.x1 + node.box.x2) >> 1} ${(node.box.y1 + node.box.y2) >> 1}`);
}

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await dismissNotResponding(); // a busy emulator can leave a system ANR dialog on top
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
  try { await device.screenshot({ path: `${OUT}/${name.replace(/\W+/g, '-')}.png` }); } catch {}
  try {
    console.log(`--- focus: ${await focusedWindow()}`);
    const nodes = (await screenNodes()).filter((n) => n.text || n['content-desc'] || n['resource-id'])
      .map((n) => `  ${n.package} | ${n['resource-id']} | "${n.text || n['content-desc']}" ${n.bounds}`);
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
  const b64 = makeMix().toString('base64'); // stereo: centred voice + panned instruments
  await page.evaluate(({ b64, name }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'audio/wav' }));
    const input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
  }, { b64, name });
  // Loaded, and vocals mode has finished separating (export is enabled again).
  await page.waitForFunction((n) => document.getElementById('dropTitle').textContent === n
    && !document.getElementById('export').disabled
    && document.getElementById('status').textContent === '', name, { timeout: 60_000 });
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
    let webview;
    await waitUntil(async () => (webview = (await screenNodes()).find((n) => n.class === 'android.webkit.WebView')), 'the app on screen');
    console.log(`  screen height ${screenH}px, WebView bounds ${webview.bounds}`);
    assert.ok(webview.box.y1 > 0, 'WebView starts under the status bar');
    assert.ok(webview.box.y2 < screenH, 'WebView extends under the navigation bar');
  });

  await step('file picker opens, and opens again after being cancelled', async () => {
    for (let i = 0; i < 2; i++) {
      await page.click('#drop');
      await waitUntil(pickerShowing, `the file picker (attempt ${i + 1})`);
      await pressBack();
      await waitUntil(async () => !(await pickerShowing()), 'the picker to close');
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

  await step('MP3 export saves through the "Save as" screen; voice centred, music moves', async () => {
    await device.shell('rm -f "/sdcard/Download/song (8D).mp3"');
    await page.selectOption('#format', 'mp3-128');
    await page.click('#export');
    await waitUntil(pickerShowing, 'the "Save as" screen', 60_000);
    await sleep(1500);
    await device.screenshot({ path: `${OUT}/save-dialog.png` });
    await tapNode((n) => /^save$/i.test(n.text) && n.enabled === 'true', 'an enabled Save button');
    await page.waitForFunction(() => /Done|cancelled|failed/.test(document.getElementById('status').textContent), null, { timeout: 30_000 });
    assert.match(await status(), /^Done/);
    const listing = (await device.shell('ls -l /sdcard/Download/')).toString();
    console.log(`  Download/: ${listing.split('\n').filter((l) => l.includes('8D')).join(' | ')}`);
    const b64 = (await device.shell('base64 -w 0 "/sdcard/Download/song (8D).mp3"')).toString().trim();
    const bytes = Buffer.from(b64, 'base64');
    assert.ok(bytes.length > 100_000, `saved file is ${bytes.length} bytes`);
    // Defaults: vocals centred; the music jumps here and there with the beat
    // (the test song's 4 Hz vocal rhythm reads as 120 BPM).
    const p = await placementInPage(page, bytes, [MIX.voice[1], MIX.guitar[0], MIX.piano[0]]);
    console.log(`  saved MP3: ${bytes.length} bytes; L/R per second: ${JSON.stringify(p)}`);
    const bothSides = (x) => (x.match(/L/g) || []).length >= 2 && (x.match(/R/g) || []).length >= 2;
    assert.ok((p[MIX.voice[1]].match(/=/g) || []).length >= 9, `voice not centred: ${p[MIX.voice[1]]}`);
    assert.ok(bothSides(p[MIX.guitar[0]]), `guitar not moving around: ${p[MIX.guitar[0]]}`);
    assert.ok(bothSides(p[MIX.piano[0]]), `piano not moving around: ${p[MIX.piano[0]]}`);
  });

  await step('cancelling the "Save as" screen is reported', async () => {
    await page.click('#export');
    await waitUntil(pickerShowing, 'the "Save as" screen', 60_000);
    await pressBack();
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

  await step('settings survive an app restart', async () => {
    await page.click('[data-preset="dreamy"]');
    assert.equal(await page.inputValue('#period'), '14');
    await launch(); // force-stop + start: a fresh WebView
    assert.equal(await page.inputValue('#period'), '14', 'orbit time not remembered');
    assert.equal(await page.inputValue('#reverb'), '55', 'reverb not remembered');
    await loadSong('song.wav'); // a restart starts with no song; the steps after need one
    await page.click('[data-preset="classic"]'); // and default settings
  });

  const pageBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const DARK = 'rgb(19, 19, 21)', LIGHT = 'rgb(246, 245, 242)';

  await step('dark mode switched while open: page restyles live and keeps the song', async () => {
    assert.equal(await pageBg(), LIGHT);
    await page.evaluate(() => { window.__notReloaded = true; });
    await device.shell('cmd uimode night yes');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 15_000 });
    assert.equal(await pageBg(), DARK);
    assert.equal(await page.evaluate(() => window.__notReloaded), true, 'page was reloaded');
    assert.equal(await page.textContent('#dropTitle'), 'song.wav');
    await sleep(1000);
    await device.screenshot({ path: `${OUT}/dark-live.png` });
    await device.shell('cmd uimode night no');
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 15_000 });
    assert.equal(await pageBg(), LIGHT);
  });

  await step('dark mode at launch: page starts dark', async () => {
    await device.shell('cmd uimode night yes');
    await launch();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await pageBg(), DARK);
    await sleep(1000);
    await device.screenshot({ path: `${OUT}/dark-launch.png` });
    await device.shell('cmd uimode night no');
  });

  /**
   * Test player's per-0.25 s levels (dB) of a left-ear tone and a right-ear
   * tone, measured on its own session ('') or on the device's final mix ('mix_').
   * Voice band: 440 (left) / 660 (right). Highs: 7000 / 9000.
   */
  async function playerLevels(where, leftHz, rightHz) {
    const log = (await device.shell('logcat -d -s TESTPLAYER:I')).toString();
    const re = new RegExp(`level t=([\\d.]+).*? ${where}f${leftHz}=(-?[\\d.]+).*? ${where}f${rightHz}=(-?[\\d.]+)`, 'g');
    return [...log.matchAll(re)].map((m) => ({ t: +m[1], l: +m[2], r: +m[3] }));
  }
  async function effectChain() {
    const dump = (await device.shell('dumpsys media.audio_flinger')).toString();
    return dump.split('\n').filter((l) => /Effect ID|Session|Name:|Enabled|state:/i.test(l) && l.length < 160).slice(0, 40).join('\n');
  }
  const swing = (xs) => Math.max(...xs) - Math.min(...xs);
  /**
   * How strongly the left-minus-right difference follows the orbit (dB):
   * the amplitude of its component at 1/period Hz. The meter is 8-bit and
   * noisy, but noise mostly cancels out of this, while a real orbit adds up.
   */
  function orbitStrength(xs, period = 8) {
    const d = xs.map((x) => x.l - x.r);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    let re = 0, im = 0;
    xs.forEach((x, i) => {
      const w = (2 * Math.PI * x.t) / period;
      re += (d[i] - mean) * Math.cos(w);
      im += (d[i] - mean) * Math.sin(w);
    });
    return (2 * Math.hypot(re, im)) / xs.length;
  }
  function correlation(a, b) {
    const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb + 1e-12);
  }

  if (testPlayerApk) await step("live 8D: voice band stays centred while bass and highs move; everything moves when vocals mode is off; stops cleanly", async () => {
    await launch();
    await withTimeout(page.evaluate(() => Android8D.liveStart()), 'starting live 8D');
    await page.waitForFunction(() => JSON.parse(Android8D.liveStatus()).running, null, { timeout: 15_000 });
    await device.installApk(testPlayerApk);
    await device.shell('pm grant io.github.syhuinc.eightd.testplayer android.permission.RECORD_AUDIO');
    await device.shell('logcat -c');
    await device.shell('am start -W -n io.github.syhuinc.eightd.testplayer/.PlayerActivity');
    await sleep(2000);
    const status = JSON.parse(await withTimeout(page.evaluate(() => Android8D.liveStatus()), 'reading live status'));
    console.log(`  live status: ${JSON.stringify(status.apps)}; log:\n    ${(status.log || []).slice(0, 6).join('\n    ')}`);
    assert.ok(status.apps.includes('io.github.syhuinc.eightd.testplayer'), 'live mode did not attach to the player');

    // Measure one stretch of two orbits; report voice band and highs.
    const measure = async (label) => {
      await device.shell('logcat -c');
      await sleep(16_500);
      const voice = await playerLevels('mix_', 440, 660), highs = await playerLevels('mix_', 7000, 9000);
      const v = orbitStrength(voice), h = orbitStrength(highs);
      console.log(`  ${label}: orbit rhythm voice band ${v.toFixed(1)} dB, highs ${h.toFixed(1)} dB (${voice.length} readings)`);
      assert.ok(voice.length >= 40 && highs.length >= 40, 'too few level readings from the final mix');
      return { v, h };
    };

    const centred = await measure('vocals centred (default)');
    assert.ok(centred.h > 1.5, 'the highs did not move around the head');
    assert.ok(centred.v < centred.h / 3, 'the voice band moved although vocals should stay centred');

    // Turn "Keep vocals in the center" off: the service reads settings every 2 s.
    await withTimeout(page.evaluate(() => { params.vocals = false; saveSettings(); }), 'changing settings');
    await sleep(3000);
    const everything = await measure('vocals mode off');
    assert.ok(everything.v > 1.5, 'with vocals mode off, the voice band should move too');
    await withTimeout(page.evaluate(() => { params.vocals = true; saveSettings(); }), 'restoring settings');

    // "Process all audio": whether the emulator allows an effect on the output mix is unknown; report it.
    await withTimeout(page.evaluate(() => { params.liveAll = true; saveSettings(); }), 'enabling all audio');
    await sleep(3000);
    const all = JSON.parse(await withTimeout(page.evaluate(() => Android8D.liveStatus()), 'reading live status'));
    console.log(`  process all audio: attached to ${JSON.stringify(all.apps)}; log: ${(all.log || []).slice(0, 4).join(' | ')}`);
    if (all.apps.includes('all audio')) await measure('process all audio (reported, not required)');
    await withTimeout(page.evaluate(() => { params.liveAll = false; saveSettings(); }), 'disabling all audio');
    await sleep(3000);

    await withTimeout(page.evaluate(() => Android8D.liveStop()), 'stopping live 8D');
    await sleep(1500);
    const off = await measure('after Stop');
    assert.ok(off.h < centred.h / 3, 'the sound kept moving after live 8D was stopped');
    // Ask Android, not the page: once live mode stops, Android 14+ freezes the app's process.
    const services = (await sh('dumpsys activity services io.github.syhuinc.eightd')).toString();
    assert.ok(!/LiveService/.test(services), 'LiveService is still running after Stop');
  });
}

try {
  await main();
} finally {
  await writeFile(`${OUT}/summary.txt`, results.join('\n') + '\n');
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} steps passed`);
  if (device) device.close();
}
