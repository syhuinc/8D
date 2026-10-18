# 8D Converter

A browser app that turns a song into "8D audio": the sound slowly circles around your head when you listen on headphones.

Everything runs locally in the browser using the Web Audio API. There is no server, nothing is uploaded and nothing is loaded from a CDN. The only third-party code is the MP3 encoder, which is vendored in `vendor/lamejs/`.

## Use it

Open `index.html` in a browser, or host the folder on any static host. For GitHub Pages: Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`. The site will be at `https://<user>.github.io/<repo>/`. On a free GitHub account the repository must be public. A `.nojekyll` file is included so GitHub serves the files as-is, without a Jekyll build.

1. Choose or drag in an audio file (MP3, WAV, M4A, OGG, or anything else your browser can decode).
2. Press play and adjust the sliders while you listen through headphones.
3. Pick a format (MP3 at 320, 192 or 128 kbps, or lossless WAV) and click **Download 8D version**.

| Control | What it does |
| --- | --- |
| Orbit time | Seconds per full circle around your head (2–20 s) |
| Effect strength | Blends between the original stereo mix (0%) and fully rotating sound (100%) |
| Reverb | Adds room sound, which helps the "out of your head" feel |
| Height wobble | Moves the sound slightly up and down while it circles |
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

## How it works

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
- **Memory.** Very long tracks can fail to export on low-memory phones.
- **Copyright.** Converting a song doesn't give you the rights to it. Don't publish 8D versions of music you don't own.

## Third-party code

`vendor/lamejs/lame.min.js` is [lamejs](https://github.com/zhuker/lamejs) 1.2.1, an unmodified JavaScript port of [LAME](https://lame.sourceforge.io/), licensed under the LGPL. See `vendor/lamejs/LICENSE`.
