import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { makeWav, makeMix, makeBeat, makeTones, MIX, analyseInPage, placementInPage, levelsInPage, orbitIsCorrect, orbitPeriodInPage, earLevelsInPage } from '../fixtures.mjs';

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
  await page.selectOption('#motion', 'circle'); // this test checks the circle's left/right pattern
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
    await page.selectOption('#motion', 'circle');
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

test('live 8D: "Follow the song" asks for the permission, remembers the choice and shows the tempo', async ({ page }) => {
  await page.addInitScript(() => {
    window.__live = { running: true, apps: ['com.spotify.music'], follow: { beats: 0, onBeat: false, bpm: 0 } };
    window.__perm = { granted: false, asked: 0, settings: 0 };
    window.Android8D = {
      liveSupported: () => true,
      liveStatus: () => JSON.stringify(window.__live),
      canListen: () => window.__perm.granted,
      requestListen: () => { window.__perm.asked++; },
      openAppSettings: () => { window.__perm.settings++; },
      saveSettings: (json) => { window.__saved = json; },
      loadSettings: () => '',
    };
  });
  await page.goto('');
  const box = page.locator('#liveFollow');
  await expect(box).not.toBeChecked();

  // Refused: stays off, and ticking again asks again.
  await box.click();
  await expect.poll(() => page.evaluate(() => window.__perm.asked)).toBe(1);
  await expect(box).not.toBeChecked();
  await page.evaluate(() => window.__android8dListen(false, true));
  await expect(page.locator('#liveFollowNote')).toContainText('asked again');
  await box.click();
  await expect.poll(() => page.evaluate(() => window.__perm.asked)).toBe(2);

  // Refused for good: the next tick opens Settings instead of asking.
  await page.evaluate(() => window.__android8dListen(false, false));
  await expect(page.locator('#liveFollowNote')).toContainText('Settings');
  await box.click();
  await expect.poll(() => page.evaluate(() => window.__perm.settings)).toBe(1);
  expect(await page.evaluate(() => window.__perm.asked)).toBe(2);
  await expect(box).not.toBeChecked();

  // Allowed (back from Settings): ticking turns it on and saves it for the live service.
  await page.evaluate(() => { window.__perm.granted = true; });
  await box.click();
  await expect(box).toBeChecked();
  expect(JSON.parse(await page.evaluate(() => window.__saved)).liveFollow).toBe(true);

  await page.evaluate(() => { window.__live.follow = { beats: 12, onBeat: true, bpm: 124 }; });
  await expect(page.locator('#liveStatus')).toHaveText('On: Spotify · on the beat (124 BPM)');

  await box.click();
  expect(JSON.parse(await page.evaluate(() => window.__saved)).liveFollow).toBe(false);
});

// Follow the music (auto.js)
const beatFile = (opts) => ({ name: 'beat.wav', mimeType: 'audio/wav', buffer: makeBeat(opts) });

test('follow the music: tempo detection is accurate and rejects noise', async ({ page }) => {
  await page.goto('');
  const r = await page.evaluate(async () => {
    const sr = 44100;
    let seed = 5;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const make = (seconds, fill) => {
      const B = new AudioBuffer({ numberOfChannels: 2, length: seconds * sr, sampleRate: sr });
      const L = B.getChannelData(0), R = B.getChannelData(1);
      for (let i = 0; i < L.length; i++) { const v = fill(i / sr); L[i] = v; R[i] = v; }
      return B;
    };
    const drums = (bpm, noise) => make(30, (t) => {
      const beat = 60 / bpm, ph = t % beat, half = t % (beat / 2);
      const kick = (Math.floor(t / beat) % 2 === 0 ? 1 : 0.5) * Math.exp(-ph * 25) * Math.sin(2 * Math.PI * 55 * ph);
      return 0.5 * kick + 0.25 * Math.exp(-half * 120) * rnd() + 0.15 * Math.sin(2 * Math.PI * 220 * t) + noise * rnd();
    });
    const out = {};
    for (const [name, buf] of [['128', drums(128, 0)], ['95', drums(95, 0)], ['swing100noisy', drums(100, 0.3)],
      ['noise', make(20, (t) => 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.1 * rnd())]]) {
      const a = await Auto.analyse(buf);
      out[name] = Auto.plan(a, 8);
    }
    return out;
  });
  expect(r['128'].synced).toBe(true);
  expect(Math.abs(r['128'].bpm - 128)).toBeLessThan(0.3);
  expect(Math.abs(r['95'].bpm - 95)).toBeLessThan(0.3);
  expect(r.swing100noisy.synced).toBe(true);
  expect(Math.abs(r.swing100noisy.bpm - 100)).toBeLessThan(0.5);
  expect(r.noise.synced).toBe(false); // no beat: keep the user's orbit time
  expect(r.noise.base).toBe(8);
});

test('follow the music: the exported orbit is 16 beats long (9.6 s at 100 BPM); off, it is 8 s', async ({ browser }) => {
  const periods = {};
  for (const auto of [true, false]) {
    const page = await browser.newPage();
    await page.goto('');
    await loadSong(page, beatFile({ bpm: 100, seconds: 40 }));
    await page.setChecked('#vocals', false); // mono test track: let it all orbit
    await page.setChecked('#auto', auto);
    if (auto) await page.selectOption('#motion', 'circle');
    if (auto) await expect(page.locator('#autoNote')).toContainText('100 BPM: one circle every 16 beats');
    await setSlider(page, 'reverb', 0);
    const { bytes } = await exportAndDownload(page, 'wav');
    periods[auto ? 'on' : 'off'] = await orbitPeriodInPage(page, bytes, 700, 1, 39);
    await page.close();
  }
  expect(Math.abs(periods.on - 9.6), `follow the music: ${periods.on} s`).toBeLessThan(0.3);
  expect(Math.abs(periods.off - 8), `fixed orbit: ${periods.off} s`).toBeLessThan(0.3);
});

test('follow the music: the orbit turns faster in the loud half than in the quiet half', async ({ page }) => {
  await page.goto('');
  await loadSong(page, beatFile({ bpm: 100, seconds: 60, quietFirstHalf: true }));
  await page.setChecked('#vocals', false);
  await page.selectOption('#motion', 'circle');
  await expect(page.locator('#autoNote')).toContainText('faster in loud parts');
  await setSlider(page, 'reverb', 0);
  await setSlider(page, 'period', 4); // target 4 s -> 8 beats = 4.8 s, so each half holds several circles
  await expect(page.locator('#autoNote')).toContainText('every 8 beats (4.8 s)');
  const { bytes } = await exportAndDownload(page, 'wav');
  const quiet = await orbitPeriodInPage(page, bytes, 700, 1, 28);
  const loud = await orbitPeriodInPage(page, bytes, 700, 33, 59);
  // Quiet half: half speed (9.6 s); loud half: double speed (2.4 s).
  expect(Math.abs(quiet - 9.6), `quiet ${quiet} s, loud ${loud} s`).toBeLessThan(0.5);
  expect(Math.abs(loud - 2.4), `quiet ${quiet} s, loud ${loud} s`).toBeLessThan(0.3);
});

// 3D cues: a circle, not a left-right swing
async function exportTones(page, { hrtf = true, freqs }) {
  await page.goto('');
  await loadSong(page, { name: 'tones.wav', mimeType: 'audio/wav', buffer: makeTones({ freqs, seconds: 10 }) });
  await page.setChecked('#vocals', false); // mono test tones: let them all orbit
  await page.setChecked('#auto', false);   // fixed 8 s orbit: front at 0 s, right at 2 s, back at 4 s
  await page.setChecked('#hrtf', hrtf);
  await setSlider(page, 'reverb', 0);
  return (await exportAndDownload(page, 'wav')).bytes;
}
const both = (e) => 10 * Math.log10(10 ** (e.left / 10) + 10 ** (e.right / 10));

test('3D cues: behind the head the sound is muffled (treble drops much more than bass)', async ({ page }) => {
  const bytes = await exportTones(page, { freqs: [500, 8000] });
  const change = {};
  for (const f of [500, 8000]) {
    const front = both(await earLevelsInPage(page, bytes, f, 7.6, 8.4)); // second pass through the front
    const back = both(await earLevelsInPage(page, bytes, f, 3.6, 4.4));
    change[f] = front - back;
  }
  expect(change[8000], `front-to-back drop: 8 kHz ${change[8000].toFixed(1)} dB, 500 Hz ${change[500].toFixed(1)} dB`).toBeGreaterThan(9);
  expect(change[8000] - change[500]).toBeGreaterThan(6);
});

test('3D cues: with simple panning, the far ear still hears the bass (crossfeed)', async ({ page }) => {
  const bytes = await exportTones(page, { hrtf: false, freqs: [200] });
  const side = await earLevelsInPage(page, bytes, 200, 1.8, 2.2); // sound at the right
  const farEar = side.left - side.right;
  expect(farEar, `far ear ${farEar.toFixed(1)} dB`).toBeGreaterThan(-14);
  expect(farEar).toBeLessThan(-5);
});

// Movement with the beat, and bass that moves
/** Left-minus-right level (dB) of `freq` while the music holds its spot on each beat. */
async function heldSides(page, bytes, freq, bpm, beats) {
  const beat = 60 / bpm, out = [];
  for (let k = 1; k <= beats; k++) {
    const e = await earLevelsInPage(page, bytes, freq, k * beat + 0.45 * beat, k * beat + 0.9 * beat);
    out.push(e.left - e.right);
  }
  return out;
}

test('here & there: on a 120 BPM track the music holds a new spot on every beat', async ({ page }) => {
  await page.goto('');
  await loadSong(page, beatFile({ bpm: 120, seconds: 20 }));
  await page.setChecked('#vocals', false); // mono test track
  await expect(page.locator('#autoNote')).toContainText('120 BPM: the music jumps here and there around you on every beat');
  await setSlider(page, 'reverb', 0);
  const { bytes } = await exportAndDownload(page, 'wav');
  const sides = await heldSides(page, bytes, 700, 120, 24);
  const moved = sides.slice(1).filter((d, i) => Math.abs(d - sides[i]) > 3).length;
  expect(moved / (sides.length - 1), `left-minus-right per beat: ${sides.map((d) => d.toFixed(0)).join(' ')}`).toBeGreaterThan(0.6);
  expect(sides.some((d) => d > 4) && sides.some((d) => d < -4)).toBe(true); // both sides are used
});

test('left-right with the beat: the music switches sides on (nearly) every beat', async ({ page }) => {
  await page.goto('');
  await loadSong(page, beatFile({ bpm: 120, seconds: 20 }));
  await page.setChecked('#vocals', false);
  await page.selectOption('#motion', 'bounce');
  await expect(page.locator('#autoNote')).toContainText('bounces left and right on every beat');
  await setSlider(page, 'reverb', 0);
  const { bytes } = await exportAndDownload(page, 'wav');
  const sides = await heldSides(page, bytes, 700, 120, 24);
  const switched = sides.slice(1).filter((d, i) => Math.sign(d) !== Math.sign(sides[i]) && Math.abs(d) > 3).length;
  expect(switched / (sides.length - 1), `left-minus-right per beat: ${sides.map((d) => d.toFixed(0)).join(' ')}`).toBeGreaterThan(0.8);
});

test('the voice stays centred while the music jumps here and there', async ({ page }) => {
  await page.goto('');
  await loadSong(page, mixFile()); // its 4 Hz vocal rhythm reads as 120 BPM
  await expect(page.locator('#autoNote')).toContainText('here and there');
  const { bytes } = await exportAndDownload(page, 'wav');
  const p = await placementInPage(page, bytes, [MIX.voice[1], MIX.guitar[0]]);
  expect(isCentred(p[MIX.voice[1]]), `voice ${p[MIX.voice[1]]}`).toBe(true);
  const g = p[MIX.guitar[0]];
  expect((g.match(/L/g) || []).length >= 2 && (g.match(/R/g) || []).length >= 2, `guitar ${g}`).toBe(true);
});

test('the bass moves too: at the side, a 60 Hz tone is much louder in the near ear', async ({ page }) => {
  await page.goto('');
  await loadSong(page, { name: 'bass.wav', mimeType: 'audio/wav', buffer: makeTones({ freqs: [60], seconds: 10, amplitude: 0.4 }) });
  await page.setChecked('#auto', false); // fixed 8 s circle: right at 2 s, left at 6 s
  await setSlider(page, 'reverb', 0);
  const { bytes } = await exportAndDownload(page, 'wav');
  const right = await earLevelsInPage(page, bytes, 60, 1.7, 2.3);
  const left = await earLevelsInPage(page, bytes, 60, 5.7, 6.3);
  const atRight = right.right - right.left, atLeft = left.left - left.right;
  expect(atRight, `at the right: near ear +${atRight.toFixed(1)} dB; at the left: +${atLeft.toFixed(1)} dB`).toBeGreaterThan(8);
  expect(atLeft).toBeGreaterThan(8);
});

// Spatial mode (buildSpatialGraph)

test('spatial: the voice stays centred, guitar and piano keep their sides, and nothing moves', async ({ page }) => {
  await page.goto('');
  await loadSong(page, mixFile());
  await page.selectOption('#mode', 'spatial');
  await expect(page.locator('#export')).toHaveText('Download Spatial version');
  const { name, bytes } = await exportAndDownload(page, 'wav');
  expect(name).toBe('mix (Spatial).wav');
  const p = await placementInPage(page, bytes, [MIX.voice[1], MIX.guitar[0], MIX.piano[0]]);
  expect(isCentred(p[MIX.voice[1]]), `voice ${p[MIX.voice[1]]}`).toBe(true);
  // Guitar is mixed left, piano right: they stay there every second (no orbit).
  expect((p[MIX.guitar[0]].match(/L/g) || []).length, `guitar ${p[MIX.guitar[0]]}`).toBeGreaterThanOrEqual(9);
  expect((p[MIX.piano[0]].match(/R/g) || []).length, `piano ${p[MIX.piano[0]]}`).toBeGreaterThanOrEqual(9);
  const diffs = [];
  for (let t = 1; t < 9; t++) {
    const e = await earLevelsInPage(page, bytes, MIX.guitar[0], t, t + 1);
    diffs.push(e.left - e.right);
  }
  expect(Math.max(...diffs) - Math.min(...diffs), `guitar left-right per second: ${diffs.map((d) => d.toFixed(1))}`).toBeLessThan(1);
});

test('spatial engine: as loud as the song, one-sided sounds reach both ears, symmetric, height adds treble', async ({ page }) => {
  await page.goto('');
  const r = await page.evaluate(async () => {
    const sr = 44100, secs = 5;
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const pink = () => { // Paul Kellet's filter: roughly music's spectrum
      const a = new Float32Array(sr * secs);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < a.length; i++) {
        const w = rnd();
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        a[i] = 0.03 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362); b6 = w * 0.115926;
      }
      return a;
    };
    const n1 = pink(), n2 = pink();
    const run = async (left, right, extra = {}) => {
      const off = new OfflineAudioContext({ numberOfChannels: 2, length: sr * secs, sampleRate: sr });
      const g = buildGraph(off, { ...params, mode: 'spatial', strength: 1, reverb: 0.3, height: 0, bass: 0, hrtf: true, ...extra });
      const B = new AudioBuffer({ numberOfChannels: 2, length: sr * secs, sampleRate: sr });
      B.copyToChannel(left, 0);
      B.copyToChannel(right, 1);
      const src = new AudioBufferSourceNode(off, { buffer: B });
      src.connect(g.input);
      src.start(0);
      if (extra.trebleOnly) { // measure only above 5 kHz
        g.output.disconnect();
        g.output.connect(new BiquadFilterNode(off, { type: 'highpass', frequency: 5000 })).connect(off.destination);
      }
      const out = await off.startRendering();
      const energy = (x) => { let s = 0; for (let i = sr; i < 4 * sr; i++) s += x[i] ** 2; return s; };
      const l = energy(out.getChannelData(0)), rr = energy(out.getChannelData(1));
      return { ild: 10 * Math.log10(l / rr), loud: 10 * Math.log10((l + rr) / (energy(left) + energy(right))), total: l + rr };
    };
    const silent = new Float32Array(sr * secs);
    const stereo = await run(n1, n2);
    const unprocessed = await run(n1, n2, { strength: 0 });
    return {
      loud: stereo.loud - unprocessed.loud, // relative, so the limiter's make-up gain cancels out
      leftIld: (await run(n1, silent)).ild,
      rightIld: (await run(silent, n1)).ild,
      heightTreble: 10 * Math.log10((await run(n1, n2, { height: 1, trebleOnly: true })).total / (await run(n1, n2, { trebleOnly: true })).total),
    };
  });
  expect(Math.abs(r.loud), `loudness change ${r.loud.toFixed(1)} dB`).toBeLessThan(2);
  // Original: a left-only sound is in the left ear only. Spatial: from a speaker front-left, so both ears hear it.
  expect(r.leftIld, `left-only sound: ${r.leftIld.toFixed(1)} dB louder in the left ear`).toBeGreaterThan(3);
  expect(r.leftIld).toBeLessThan(15);
  expect(Math.abs(r.leftIld + r.rightIld), `left ${r.leftIld.toFixed(1)}, right ${r.rightIld.toFixed(1)}`).toBeLessThan(1);
  expect(r.heightTreble, `height raised the treble by ${r.heightTreble.toFixed(1)} dB`).toBeGreaterThan(1);
});

test('spatial: the orbit settings hide, the choice is remembered, and switching while playing works', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('');
  await expect(page.locator('#orbitControls')).toBeVisible();
  await loadSong(page, mixFile());
  await page.click('#play');
  await page.selectOption('#mode', 'spatial');
  await expect(page.locator('#orbitControls')).toBeHidden();
  await expect(page.locator('#heightName')).toHaveText('Height (sound from above)');
  await expect(page.locator('#modeNote')).toContainText('voice in front');
  await page.click('#hrtf'); // panning model switch on the spatial graph
  await page.click('#hrtf');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => state.playing)).toBe(true);
  await page.reload();
  await expect(page.locator('#mode')).toHaveValue('spatial');
  await expect(page.locator('#orbitControls')).toBeHidden();
  await page.selectOption('#mode', '8d');
  await expect(page.locator('#orbitControls')).toBeVisible();
  await expect(page.locator('#export')).toHaveText('Download 8D version');
  expect(problems).toEqual([]);
});

// Loudness and "Compare with original"

test('8D and Spatial are as loud as the song (within 1.5 dB on a typical stereo mix), so comparing is fair', async ({ page }) => {
  await page.goto('');
  const r = await page.evaluate(async () => {
    const sr = 44100, secs = 5;
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
    const pink = () => {
      const a = new Float32Array(sr * secs);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < a.length; i++) {
        const w = rnd();
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        a[i] = 0.03 * (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362); b6 = w * 0.115926;
      }
      return a;
    };
    const a = pink(), b = pink();
    const left = a.map((x, i) => 0.7 * x + 0.3 * b[i]), right = b.map((x, i) => 0.7 * x + 0.3 * a[i]); // partly correlated, like a mix
    const loudness = async (extra) => {
      const off = new OfflineAudioContext({ numberOfChannels: 2, length: sr * secs, sampleRate: sr });
      const g = buildGraph(off, { ...params, strength: 1, reverb: 0.3, height: 0, bass: 0, hrtf: true, auto: false, ...extra });
      const B = new AudioBuffer({ numberOfChannels: 2, length: sr * secs, sampleRate: sr });
      B.copyToChannel(left, 0);
      B.copyToChannel(right, 1);
      const src = new AudioBufferSourceNode(off, { buffer: B });
      src.connect(g.input);
      g.start(0);
      src.start(0);
      const out = await off.startRendering();
      let e = 0, e0 = 0;
      for (let c = 0; c < 2; c++) {
        const x = out.getChannelData(c), y = B.getChannelData(c);
        for (let i = sr; i < 4 * sr; i++) { e += x[i] ** 2; e0 += y[i] ** 2; }
      }
      return 10 * Math.log10(e / e0); // relative to the song itself
    };
    return { eightD: await loudness({ mode: '8d' }), spatial: await loudness({ mode: 'spatial' }) };
  });
  expect(Math.abs(r.eightD), `8D: ${r.eightD.toFixed(1)} dB`).toBeLessThan(1.5);
  expect(Math.abs(r.spatial), `Spatial: ${r.spatial.toFixed(1)} dB`).toBeLessThan(1.5);
});

test('compare with original: plays the untouched song at the same position, then switches back', async ({ page }) => {
  const problems = collectProblems(page);
  await page.goto('');
  await loadSong(page, mixFile());
  // Tap into the output: is it the song as-is (left and right differ as in the file), or processed?
  await page.evaluate(() => {
    window.__levels = () => {
      const ctx = state.ctx;
      if (!window.__tap) {
        window.__tap = [0, 1].map(() => new AnalyserNode(ctx, { fftSize: 32768, smoothingTimeConstant: 0 }));
        const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
        state.graph.output.connect(split);
        split.connect(window.__tap[0], 0);
        split.connect(window.__tap[1], 1);
      }
      // Level at 659 Hz (guitar: 0.85 left, 0.25 right in the file) per ear, dB.
      return window.__tap.map((a) => {
        const f = new Float32Array(a.frequencyBinCount);
        a.getFloatFrequencyData(f);
        const k = Math.round((659.25 * a.fftSize) / ctx.sampleRate);
        return Math.max(f[k - 1], f[k], f[k + 1]);
      });
    };
  });
  await page.click('#play');
  await page.evaluate(() => window.__levels()); // start listening
  await page.waitForTimeout(1500);
  const [pl, pr] = await page.evaluate(() => window.__levels());
  await page.click('#compare');
  await expect(page.locator('#compare')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#compare')).toContainText('Hearing the original');
  await page.waitForTimeout(1200);
  const [l, r] = await page.evaluate(() => window.__levels());
  // The file's own balance: 0.85 / 0.25 is 10.6 dB.
  expect(Math.abs(l - r - 10.6), `original left-right ${(l - r).toFixed(1)} dB (processed: ${(pl - pr).toFixed(1)})`).toBeLessThan(1);
  expect(Math.abs(pl - pr - 10.6), `processed left-right ${(pl - pr).toFixed(1)} dB should differ from the file's`).toBeGreaterThan(2);
  expect(await page.evaluate(() => state.playing)).toBe(true);
  // Switching the effect while comparing keeps comparing.
  await page.selectOption('#mode', 'spatial');
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => state.comparing)).toBe(true);
  await page.click('#compare');
  await expect(page.locator('#compare')).toHaveText('Compare with original');
  expect(problems).toEqual([]);
});
