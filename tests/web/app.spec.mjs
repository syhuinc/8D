import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { makeWav, analyseInPage, orbitIsCorrect } from '../fixtures.mjs';

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

  const web = await browser.newPage();
  await web.goto('');
  await loadSong(web, file);
  const expected = (await exportAndDownload(web, 'mp3-192')).bytes;

  const app = await browser.newPage();
  await app.addInitScript(fakeBridge(true));
  await app.goto('');
  await loadSong(app, file);
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
