import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { makeWav, makeMix, MIX, analyseInPage, placementInPage, levelsInPage, orbitIsCorrect } from '../fixtures.mjs';

const song = (name = 'song.wav', opts) => ({ name, mimeType: 'audio/wav', buffer: makeWav(opts) });

async function loadSong(page, file) {
  await page.setInputFiles('#file', file);
  await expect(page.locator('#controls')).toBeVisible();
  await expect(page.locator('#dropTitle')).toHaveText(file.name);
  await expect(page.locator('#status')).toHaveText('');
}

async function exportAndDownload(page, format) {
  await page.selectOption('#format', format);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
  await expect(page.locator('#status')).toContainText('Done');
  return { name: download.suggestedFilename(), bytes: await readFile(await download.path()) };
}

function collectProblems(page) {
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`${r.status()} ${r.url()}`));
  return problems;
}

test('page loads with no errors or failed requests', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('');
  await loadSong(page, song());
  await page.click('#play');
  await expect(page.locator('#play')).toHaveAttribute('aria-label', 'Pause');
  await page.waitForTimeout(500);
  expect(problems).toEqual([]);
});

test('WAV export orbits front → right → back → left', async ({ page }) => {
  await page.goto('');
  await loadSong(page, song());
  await page.setChecked('#vocals', false); // mono test tone: let all of it orbit
  const { name, bytes } = await exportAndDownload(page, 'wav');
  expect(name).toBe('song (8D).wav');
  const a = await analyseInPage(page, bytes);
  expect(a.channels).toBe(2);
  expect(a.duration).toBeCloseTo(13, 1); // 10 s song + 3 s reverb tail
  expect(orbitIsCorrect(a.pattern), `pattern ${a.pattern}`).toBe(true);
});

test('MP3 export is a valid stereo MP3 with the orbit intact', async ({ page }) => {
  await page.goto('');
  await loadSong(page, song());
  await page.setChecked('#vocals', false); // mono test tone: let all of it orbit
  const { name, bytes } = await exportAndDownload(page, 'mp3-192');
  expect(name).toBe('song (8D).mp3');
  expect(bytes.length).toBeGreaterThan(200_000);
  const a = await analyseInPage(page, bytes);
  expect(a.channels).toBe(2);
  expect(a.duration).toBeGreaterThan(12.9);
  expect(orbitIsCorrect(a.pattern), `pattern ${a.pattern}`).toBe(true);
});

test('MP3 export resamples rates MP3 cannot carry (96 kHz → 44.1 kHz)', async ({ page }) => {
  await page.goto('');
  await loadSong(page, song('hires.wav', { sampleRate: 96000 }));
  await page.setChecked('#vocals', false);
  const { bytes } = await exportAndDownload(page, 'mp3-320');
  // MP3 frame header: sync bits, then the sample-rate index (0 = 44.1 kHz for MPEG-1).
  const frame = bytes.indexOf(Buffer.from([0xff, 0xfb]));
  expect(frame).toBeGreaterThanOrEqual(0);
  expect((bytes[frame + 2] >> 2) & 0b11).toBe(0);
  const a = await analyseInPage(page, bytes);
  expect(orbitIsCorrect(a.pattern), `pattern ${a.pattern}`).toBe(true);
});

test('picking the same song again reloads it', async ({ page }, testInfo) => {
  // Must be a real file on disk: in-memory files count as new on every pick,
  // which hides the bug (browsers skip 'change' when the same path is re-picked).
  const path = testInfo.outputPath('same.wav');
  await writeFile(path, makeWav());
  await page.goto('');
  await page.setInputFiles('#file', path);
  await expect(page.locator('#dropTitle')).toHaveText('same.wav');
  await exportAndDownload(page, 'mp3-128'); // leaves "Done — …" in the status line
  await page.setInputFiles('#file', path);
  await expect(page.locator('#status')).toHaveText('', { timeout: 10_000 }); // cleared only by a fresh load
});

// The Android app exposes window.Android8D (MainActivity.SaveBridge). This fake
// behaves the same way: synchronous begin/append, then an async "Save as" result.
const fakeBridge = (answer) => `
  window.__chunks = [];
  window.Android8D = {
    begin(name, mime) { window.__begin = [name, mime]; window.__chunks = []; return true; },
    append(b64) { window.__chunks.push(b64); return true; },
    finish() { setTimeout(() => window.__android8dSaved(${answer}), 50); },
  };`;

test('Android save bridge receives exactly the bytes a browser would download', async ({ browser }) => {
  const file = song();

  // Vocals mode off: its reverb path can differ by ±1 LSB between runs (convolver
  // rounding), and this test is about the transfer, not the audio.
  const web = await browser.newPage();
  await web.goto('');
  await loadSong(web, file);
  await web.setChecked('#vocals', false);
  const expected = (await exportAndDownload(web, 'mp3-192')).bytes;

  const app = await browser.newPage();
  await app.addInitScript(fakeBridge(true));
  await app.goto('');
  await loadSong(app, file);
  await app.setChecked('#vocals', false);
  await app.selectOption('#format', 'mp3-192');
  await app.click('#export');
  await expect(app.locator('#status')).toContainText('Done');
  const { begin, chunks } = await app.evaluate(() => ({ begin: window.__begin, chunks: window.__chunks }));
  expect(begin).toEqual(['song (8D).mp3', 'audio/mpeg']);
  const received = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
  expect(received.equals(expected)).toBe(true);
});

test('Android save bridge: cancelling the save dialog is reported', async ({ page }) => {
  await page.addInitScript(fakeBridge(false));
  await page.goto('');
  await loadSong(page, song());
  await page.selectOption('#format', 'mp3-128');
  await page.click('#export');
  await expect(page.locator('#status')).toHaveText('Save cancelled.');
  await expect(page.locator('#export')).toBeEnabled();
});

test('theme: follows the system, and data-theme (set by the Android app) overrides it', async ({ page }) => {
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const DARK = 'rgb(19, 19, 21)', LIGHT = 'rgb(246, 245, 242)';
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('');
  expect(await bg()).toBe(DARK);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  expect(await bg()).toBe(LIGHT);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  expect(await bg()).toBe(DARK);
});

test('theme: the page asks the Android app before first paint', async ({ page }) => {
  await page.addInitScript(() => { window.Android8D = { isDarkTheme: () => true }; });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(19, 19, 21)');
});

// Vocals mode: centre (voice) stays put, everything else orbits.
const isCentred = (p) => (p.match(/=/g) || []).length >= 9;

async function exportMix(page, vocals) {
  await page.goto('');
  await loadSong(page, { name: 'mix.wav', mimeType: 'audio/wav', buffer: makeMix() });
  await page.setChecked('#vocals', vocals);
  await expect(page.locator('#export')).toBeEnabled();
  const { bytes } = await exportAndDownload(page, 'wav');
  return placementInPage(page, bytes, [...MIX.voice, MIX.guitar[0], MIX.piano[0]]);
}

test('vocals mode: the voice stays centred while guitar and piano orbit', async ({ page }) => {
  const p = await exportMix(page, true);
  for (const f of MIX.voice) expect(isCentred(p[f]), `voice ${f} Hz: ${p[f]}`).toBe(true);
  for (const f of [MIX.guitar[0], MIX.piano[0]]) expect(orbitIsCorrect(p[f]), `${f} Hz: ${p[f]}`).toBe(true);
});

test('vocals mode off: the voice orbits too (control for the test above)', async ({ page }) => {
  const p = await exportMix(page, false);
  for (const f of MIX.voice) expect(isCentred(p[f]), `voice ${f} Hz: ${p[f]}`).toBe(false);
});

test('vocals mode explains that mono songs cannot be separated', async ({ page }) => {
  await page.goto('');
  await loadSong(page, song()); // identical channels
  await expect(page.locator('#vocalsNote')).toContainText('mono');
  await loadSong(page, { name: 'mix.wav', mimeType: 'audio/wav', buffer: makeMix() });
  await expect(page.locator('#vocalsNote')).not.toContainText('mono');
});

const mixFile = () => ({ name: 'mix.wav', mimeType: 'audio/wav', buffer: makeMix() });
async function setSlider(page, id, value) {
  await page.fill(`#${id}`, String(value));
  await page.dispatchEvent(`#${id}`, 'input');
  await page.dispatchEvent(`#${id}`, 'change');
}

test('presets set the sliders and show which one is active', async ({ page }) => {
  await page.goto('');
  await loadSong(page, song());
  await expect(page.locator('[data-preset="classic"]')).toHaveAttribute('aria-pressed', 'true'); // defaults
  await page.click('[data-preset="bass"]');
  await expect(page.locator('#bass')).toHaveValue('9');
  await expect(page.locator('#bassOut')).toHaveText('+9 dB');
  await expect(page.locator('[data-preset="bass"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-preset="classic"]')).toHaveAttribute('aria-pressed', 'false');
  await setSlider(page, 'reverb', 41); // a manual change means no preset matches
  await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
});

test('settings are remembered after reloading', async ({ page }) => {
  await page.goto('');
  await loadSong(page, song());
  await page.click('[data-preset="dreamy"]');
  await page.setChecked('#hrtf', false);
  await page.selectOption('#format', 'wav');
  await page.reload();
  await loadSong(page, song());
  await expect(page.locator('#period')).toHaveValue('14');
  await expect(page.locator('#reverb')).toHaveValue('55');
  await expect(page.locator('#hrtf')).not.toBeChecked();
  await expect(page.locator('#format')).toHaveValue('wav');
  await expect(page.locator('[data-preset="dreamy"]')).toHaveAttribute('aria-pressed', 'true');
});

test('bass boost raises the low end and leaves the voice alone', async ({ browser }) => {
  const levels = [];
  for (const bass of [0, 12]) {
    const page = await browser.newPage();
    await page.goto('');
    await loadSong(page, mixFile());
    await setSlider(page, 'bass', bass);
    const { bytes } = await exportAndDownload(page, 'wav');
    levels.push(await levelsInPage(page, bytes, [55, MIX.voice[1]]));
    await page.close();
  }
  const [off, on] = levels;
  // Peak normalisation pulls the whole mix down when the bass gets louder,
  // so compare the bass relative to the voice.
  const lift = (on[55] - on[MIX.voice[1]]) - (off[55] - off[MIX.voice[1]]);
  expect(lift, `bass rose ${lift.toFixed(1)} dB relative to the voice`).toBeGreaterThan(9);
});

test('vocal strictness decides whether a slightly off-centre sound stays in the middle', async ({ browser }) => {
  const placement = {};
  for (const [name, focus] of [['loose', 0], ['strict', 100]]) {
    const page = await browser.newPage();
    await page.goto('');
    await loadSong(page, mixFile());
    await setSlider(page, 'vocalFocus', focus);
    await expect(page.locator('#export')).toBeEnabled(); // re-separation finished
    const { bytes } = await exportAndDownload(page, 'wav');
    placement[name] = await placementInPage(page, bytes, [MIX.synth[0], MIX.voice[1]]);
    await page.close();
  }
  const synth = MIX.synth[0], voice = MIX.voice[1];
  expect(isCentred(placement.loose[synth]), `loose, synth: ${placement.loose[synth]}`).toBe(true);
  expect(orbitIsCorrect(placement.strict[synth]), `strict, synth: ${placement.strict[synth]}`).toBe(true);
  expect(isCentred(placement.strict[voice]), `strict, voice: ${placement.strict[voice]}`).toBe(true); // the real centre stays
});

test('live 8D card: hidden on the website', async ({ page }) => {
  await page.goto('');
  await expect(page.locator('#live')).toBeHidden();
});

test('live 8D card: in the app, starts and stops live mode and shows which apps it processes', async ({ page }) => {
  await page.addInitScript(() => {
    window.__live = { running: false, apps: [] };
    window.Android8D = {
      liveSupported: () => true,
      liveStatus: () => JSON.stringify(window.__live),
      liveStart: () => { window.__live.running = true; },
      liveStop: () => { window.__live = { running: false, apps: [] }; },
    };
  });
  await page.goto('');
  await expect(page.locator('#live')).toBeVisible();
  await expect(page.locator('#liveStatus')).toHaveText('Off');
  await page.click('#liveToggle');
  await expect(page.locator('#liveStatus')).toHaveText('On: now press play in your music app');
  await expect(page.locator('#liveToggle')).toHaveText('Stop live 8D');
  await page.evaluate(() => { window.__live.apps = ['com.spotify.music', 'org.example.player']; });
  await expect(page.locator('#liveStatus')).toHaveText('On: Spotify, org.example.player');
  await page.click('#liveToggle');
  await expect(page.locator('#liveStatus')).toHaveText('Off');
});
