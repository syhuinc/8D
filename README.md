# 8D Converter

A browser app that turns a song into "8D audio": the sound slowly circles around your head when you listen on headphones.

Everything runs locally in the browser using the Web Audio API. There is no server, nothing is uploaded and nothing is loaded from a CDN. The only third-party code is the MP3 encoder, which is vendored in `vendor/lamejs/`.

## Use it

Open `index.html` in a browser, or host the folder on any static host. For GitHub Pages: Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`. The site will be at `https://<user>.github.io/<repo>/`. On a free GitHub account the repository must be public. A `.nojekyll` file is included so GitHub serves the files as-is, without a Jekyll build.

1. Choose or drag in an audio file (MP3, WAV, M4A, OGG, or anything else your browser can decode).
2. Press play and adjust the sliders while you listen through headphones.
3. Pick a format (MP3 at 320, 192 or 128 kbps, or lossless WAV) and click **Download 8D version**.

**Presets** (Classic 8D, Slow & dreamy, Fast spin, Concert hall, Bass 8D) set the sliders in one tap; the active one is highlighted. All settings are remembered on the device.

| Control | What it does |
| --- | --- |
| Orbit time | Seconds per full circle around your head (2–20 s) |
| Effect strength | Blends between the original stereo mix (0%) and fully rotating sound (100%) |
| Reverb | Adds room sound, which helps the "out of your head" feel |
| Height wobble | Moves the sound slightly up and down while it circles |
| Bass boost | Low-shelf boost at 120 Hz, up to +12 dB; a limiter keeps playback from clipping |
| Keep vocals in the center | On by default: the voice stays in the middle of your head and only the music orbits (see below) |
| Vocal strictness | How alike both ears must be to count as voice. Stricter stops instruments sticking to the middle; looser catches slightly off-centre vocals |
| 3D headphone mode | On: HRTF binaural panning (more realistic). Off: simple left/right panning |

## Android app

`android/` is a small native wrapper that bundles the same web app, so it runs fully offline. It asks for no permissions, not even internet access. The web files are copied in from the repository root at build time, so there is only one copy of the app code.

A bare WebView can't save downloads, so the APK adds two native pieces in `MainActivity.java`:
- **File picker:** handles `<input type=file>`.
- **Save bridge:** `app.js` streams the exported file to the app in base64 chunks, then Android's *Save as* screen opens so you can choose where to save it.

The app supports Android 7.0 (API 24) and later.

### Build

Requires JDK 17+ and the Android SDK (`ANDROID_HOME`) with `platforms;android-36` and `build-tools;35.0.0`.

```sh
cd android
./gradlew assembleRelease \
  -PreleaseKeystore=/path/to/key.jks -PreleaseKeystorePassword=... \
  -PreleaseKeyAlias=... -PreleaseKeyPassword=...
# -> app/build/outputs/apk/release/app-release.apk
```

Without the signing properties the release APK is unsigned, and Android won't install an unsigned APK. To install an update over an existing install, it must be signed with the same key as the first one.

## Testing

`.github/workflows/ci.yml` runs two jobs on every push and pull request.

**Web (Chromium):** `npm ci && npx playwright install chromium && npm test`

- WAV and MP3 exports are decoded back and checked for the orbit: right-heavy around 2 s, left-heavy around 6 s.
- A 96 kHz source is checked to come out as a 44.1 kHz MP3.
- Picking the same file twice must reload it.
- The page must load with no failed requests or errors.
- A fake Android bridge must receive exactly the bytes a browser download would, and cancelling must be reported.
- **Vocals mode:** a synthetic stereo song (centred voice, left-leaning guitar, right-leaning piano) is exported, and each instrument's pitch is measured per ear, per second. The voice must stay balanced while guitar and piano orbit. With the mode off, the voice must orbit too, which shows the measurement can tell the difference. Mono songs must show the "can't separate" note. A slightly off-centre synth must stay in the middle on "loose" and orbit on "strict".
- **Presets** must set the sliders and highlight correctly. **Settings** must survive a reload. **Bass boost** must lift 55 Hz by more than 9 dB relative to the voice.

**Android:** builds debug and release APKs, runs lint, then boots an Android 15 emulator and runs `tests/android/smoke.mjs` against the debug APK:

- Content must stay clear of the system bars.
- The file picker must open, and open again after being cancelled.
- Playback must run.
- An MP3 export of the synthetic song is saved through the real *Save as* screen, then read back from `Download/`. The voice must be centred while guitar and piano orbit.
- Cancelling the save must be reported.
- Rotating must not reload the page.
- Settings must survive a full app restart.
- Dark mode must reach the page.

WebView debugging, which the Android test relies on, is only switched on in debug builds. CI saves the APKs, the lint report and the emulator screenshots as artifacts on each run.

## How it works

**Vocals mode** (`vocals.js`): lead vocals are almost always mixed dead-centre, identical in both channels. The song is analysed in short overlapping slices (2048-point FFT, 75% overlap). In each slice and frequency bin, left and right are compared for level and phase. Bins that match, inside the vocal range (about 150 Hz to 9 kHz, with soft edges), form a mono "centre" track. During playback and export that track plays in sync with the song. It goes straight to the middle with its own mono reverb, so sung notes don't drift, and it is subtracted from what orbits, so nothing is doubled or lost. Bass below the vocal range and cymbals above it keep orbiting. Separation takes about 1.6 s per minute of audio on a desktop; phones are slower.

Then, for the part that orbits:

1. The song is summed to mono.
2. A `PannerNode` places it in 3D space. Two oscillators drive its X and Z position (`sin` and `-cos`), so the source moves in a circle around the listener: front → right → behind → left.
3. A generated impulse response feeds a `ConvolverNode` to add reverb.
4. For export, the same graph is rendered in an `OfflineAudioContext`, peak-normalised, then encoded as 16-bit WAV or as MP3 with [lamejs](https://github.com/zhuker/lamejs). The encoder is loaded only on the first MP3 export. Encoding runs in chunks so the page stays responsive.

## Limitations

- **Headphones only.** On speakers the effect falls apart.
- **Local files only.** It can't pull songs from Spotify, Apple Music or YouTube. Those streams are DRM-protected and their terms of service forbid downloading.
- **Export speed.** MP3 encoding is pure JavaScript. A 4-minute song took about 35 s to render and encode in headless Chromium on a server, and phones will likely be slower. The result is about 5.6 MB at 192 kbps, against about 43 MB as WAV.
- **MP3 sample rate.** Sources at rates MP3 can't carry (for example 96 kHz) are resampled to 44.1 kHz.
- **Mono source.** The rotating part is mono, so the original stereo image is lost at 100% strength. That's normal for 8D.
- **Vocal separation is mix-based, not AI.** Anything else mixed dead-centre in the vocal range (often snare, lead guitar or synth leads) stays in the middle with the voice. Mono songs can't be separated at all; the app says so. Clean separation needs a neural model such as Demucs, which would add a model download of tens of megabytes and minutes of processing per song on a phone.
- **Low bass barely moves.** Below about 150 Hz the head hardly shadows sound, so even in normal 8D mode the bass orbit is faint.
- **Memory.** Very long tracks can fail to export on low-memory phones.
- **Copyright.** Converting a song doesn't give you the rights to it. Don't publish 8D versions of music you don't own.

## Third-party code

`vendor/lamejs/lame.min.js` is [lamejs](https://github.com/zhuker/lamejs) 1.2.1, an unmodified JavaScript port of [LAME](https://lame.sourceforge.io/), licensed under the LGPL. See `vendor/lamejs/LICENSE`.
