// End-to-end test of the Android app on a connected device or emulator (run in CI).
// Usage: node tests/android/smoke.mjs path/to/app-debug.apk
//
// Needs a *debug* APK (WebView debugging is only enabled there) and adb on PATH.
import { _android as android } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { makeMix, MIX, placementInPage, orbitIsCorrect } from '../fixtures.mjs';

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
const focusedWindow = async () => (await sh('dumpsys window | grep mCurrentFocus')).trim();
const pickerShowing = async () => /documentsui/i.test(await focusedWindow()); // system picker / "Save as"
const pressBack = () => sh('input keyevent KEYCODE_BACK');

async function waitUntil(check, what, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`timed out after ${timeout / 1000}s waiting for ${what} (focus: ${await focusedWindow()})`);
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
    const webview = (await screenNodes()).find((n) => n.class === 'android.webkit.WebView');
    assert.ok(webview, 'WebView not found on screen');
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

  await step('MP3 export saves through the "Save as" screen; voice centred, music orbits', async () => {
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
    // Vocals mode is on by default: voice centred, instruments orbiting.
    const p = await placementInPage(page, bytes, [MIX.voice[1], MIX.guitar[0], MIX.piano[0]]);
    console.log(`  saved MP3: ${bytes.length} bytes; L/R per second: ${JSON.stringify(p)}`);
    assert.ok((p[MIX.voice[1]].match(/=/g) || []).length >= 9, `voice not centred: ${p[MIX.voice[1]]}`);
    assert.ok(orbitIsCorrect(p[MIX.guitar[0]]), `guitar not orbiting: ${p[MIX.guitar[0]]}`);
    assert.ok(orbitIsCorrect(p[MIX.piano[0]]), `piano not orbiting: ${p[MIX.piano[0]]}`);
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
   * Test player's per-0.25 s levels (dB) of its left (440 Hz) and right (660 Hz)
   * tones, measured on its own session ('') or on the device's final mix ('mix_').
   */
  async function playerLevels(where) {
    const log = (await device.shell('logcat -d -s TESTPLAYER:I')).toString();
    return [...log.matchAll(new RegExp(`level t=([\\d.]+).*? ${where}left440=(-?[\\d.]+) ${where}right660=(-?[\\d.]+)`, 'g'))]
      .map((m) => ({ t: +m[1], l: +m[2], r: +m[3] }));
  }
  async function effectChain() {
    const dump = (await device.shell('dumpsys media.audio_flinger')).toString();
    return dump.split('\n').filter((l) => /Effect ID|Session|Name:|Enabled|state:/i.test(l) && l.length < 160).slice(0, 40).join('\n');
  }
  const swing = (xs) => Math.max(...xs) - Math.min(...xs);
  function correlation(a, b) {
    const ma = a.reduce((x, y) => x + y) / a.length, mb = b.reduce((x, y) => x + y) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < a.length; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return sab / Math.sqrt(saa * sbb + 1e-12);
  }

  if (testPlayerApk) await step("live 8D moves another app's sound between the ears, and stops cleanly", async () => {
    await launch();
    await page.evaluate(() => Android8D.liveStart());
    await page.waitForFunction(() => JSON.parse(Android8D.liveStatus()).running, null, { timeout: 15_000 });
    await device.installApk(testPlayerApk);
    await device.shell('pm grant io.github.syhuinc.eightd.testplayer android.permission.RECORD_AUDIO');
    await device.shell('logcat -c');
    await device.shell('am start -W -n io.github.syhuinc.eightd.testplayer/.PlayerActivity');
    await sleep(2000);
    const status = JSON.parse(await page.evaluate(() => Android8D.liveStatus()));
    console.log(`  live status: ${JSON.stringify(status)}`);
    assert.ok(status.apps.includes('io.github.syhuinc.eightd.testplayer'), 'live mode did not attach to the player');

    await device.shell('logcat -c');
    await sleep(16_500); // two circles at 8 s each
    const own = await playerLevels('');
    const mix = await playerLevels('mix_');
    if (own.length) console.log(`  player's own session: swing left ${swing(own.map((x) => x.l)).toFixed(1)} dB, right ${swing(own.map((x) => x.r)).toFixed(1)} dB`);
    if (mix.length) console.log(`  final output mix:     swing left ${swing(mix.map((x) => x.l)).toFixed(1)} dB, right ${swing(mix.map((x) => x.r)).toFixed(1)} dB`);
    console.log(`  effect chain (audio_flinger):\n${await effectChain()}`);
    const engine = (await device.shell('logcat -d -s 8DLIVE:*')).toString().trim().split('\n').slice(-6).join('\n');
    console.log(`  engine log:\n${engine}`);
    // The final mix is what is heard; its meter is auto-scaled, so judge the
    // left-minus-right difference (in dB), which is what 8D changes.
    const where = 'mix_';
    const on = mix;
    const diff = (xs) => xs.map((x) => x.l - x.r);
    const perSecond = [];
    for (let s = 0; s < 16; s++) {
      const w = on.filter((x) => x.t >= on[0].t + s && x.t < on[0].t + s + 1);
      if (w.length) perSecond.push(`${(w.reduce((a, x) => a + x.l, 0) / w.length).toFixed(0)}/${(w.reduce((a, x) => a + x.r, 0) / w.length).toFixed(0)}`);
    }
    const onSwing = swing(diff(on));
    const corr = correlation(on.map((x) => x.l), on.map((x) => x.r));
    console.log(`  live on: ${on.length} readings; left/right dB per second: ${perSecond.join(' ')}`);
    console.log(`  live on: left-minus-right swings ${onSwing.toFixed(1)} dB; left/right correlation ${corr.toFixed(2)}`);
    assert.ok(on.length >= 40, 'too few level readings from the final mix');
    assert.ok(onSwing > 16, 'the sound did not move between the ears');
    assert.ok(corr < -0.3, 'left and right did not move in opposite directions');

    await page.evaluate(() => Android8D.liveStop());
    await sleep(1500);
    await device.shell('logcat -c');
    await sleep(6000);
    const off = await playerLevels(where);
    const offSwing = swing(diff(off));
    console.log(`  live off: left-minus-right swings ${offSwing.toFixed(1)} dB`);
    assert.ok(off.length >= 10, 'too few level readings after stopping');
    assert.ok(offSwing < 4, 'the sound kept moving after live 8D was stopped');
    assert.equal(JSON.parse(await page.evaluate(() => Android8D.liveStatus())).running, false);
  });
}

try {
  await main();
} finally {
  await writeFile(`${OUT}/summary.txt`, results.join('\n') + '\n');
  console.log(`\n${results.filter((r) => r.startsWith('PASS')).length}/${results.length} steps passed`);
  if (device) device.close();
}
