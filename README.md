# 8D Converter

A browser app that turns a song into "8D audio": the sound slowly circles around your head when you listen on headphones.

Everything runs locally in the browser using the Web Audio API. There is no server, nothing is uploaded and nothing is loaded from a CDN. The only third-party code is the MP3 encoder, which is vendored in `vendor/lamejs/`.

## Use it

Open `index.html` in a browser, or host the folder on any static host. For GitHub Pages: Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`. The site will be at `https://<user>.github.io/<repo>/`. On a free GitHub account the repository must be public. A `.nojekyll` file is included so GitHub serves the files as-is, without a Jekyll build.

1. Choose or drag in an audio file (MP3, WAV, M4A, OGG, or anything else your browser can decode).
2. Press play and adjust the sliders while you listen through headphones.
3. Pick a format (MP3 at 320, 192 or 128 kbps, or lossless WAV) and click **Download 8D version**.

**Compare with original** (under the player) switches between the effect and the untouched song at the same spot, so you can judge the difference. Both effects are level-matched to the song, measured on a stereo pink-noise mix: 8D within 0.1 dB, Spatial within 1 dB. Before this, 8D came out about 3 dB quieter than the song, and a quieter version sounds worse side by side even when it isn't. Very wide stereo still comes out about 2 dB quieter in 8D, because 8D sums the song to mono before moving it.

**Presets** (Classic 8D, Slow & dreamy, Fast spin, Concert hall, Bass 8D) set the sliders in one tap; the active one is highlighted. All settings are remembered on the device.

| Control | What it does |
| --- | --- |
| Effect | 8D (the music travels around your head) or Spatial (it surrounds you, still; see below) |
| Orbit time | Seconds per full circle around your head (2–20 s); with Follow the music, the target that gets fitted to the beat |
| Follow the music | On by default: the movement is synced to the song's beat (see below) |
| Movement | With Follow the music: **Here & there with the beat** (default): the music jumps to a new spot around you on every beat; **Left–right with the beat**: it bounces side to side; **Smooth circle**: one circle takes a whole number of beats and turns twice as fast in loud parts, half as fast in quiet ones. The beat styles move every 2 beats in quiet parts or above 140 BPM. Without a steady beat, the music circles instead |
| Effect strength | Blends between the original stereo mix (0%) and fully rotating sound (100%) |
| Reverb | Adds room sound, which helps the "out of your head" feel |
| Height wobble | Moves the sound slightly up and down while it circles. In Spatial mode: how much treble comes from above |
| Bass boost | Low-shelf boost at 120 Hz, up to +12 dB; a limiter keeps playback from clipping |
| Keep vocals in the center | On by default: the voice stays in the middle of your head and only the music orbits (see below) |
| Vocal strictness | How alike both ears must be to count as voice. Stricter stops instruments sticking to the middle; looser catches slightly off-centre vocals |
| 3D headphone mode | On: HRTF binaural panning (more realistic). Off: simple left/right panning |

## Android app

`android/` is a small native wrapper that bundles the same web app, so it runs fully offline, with no internet permission. The web files are copied in from the repository root at build time, so there is only one copy of the app code. The converter itself needs no permissions; Live 8D (below) adds `MODIFY_AUDIO_SETTINGS` plus the foreground-service and notification permissions. Its optional "Follow the song" adds `RECORD_AUDIO`, which is asked for only when you switch it on.

A bare WebView can't save downloads, so the APK adds two native pieces in `MainActivity.java`:
- **File picker:** handles `<input type=file>`.
- **Save bridge:** `app.js` streams the exported file to the app in base64 chunks, then Android's *Save as* screen opens so you can choose where to save it.

**Sharing a song to the app:** choose 8D Converter under "Share" or "Open with" in Files, a chat app or a music app that offers it. MainActivity copies the song to its cache (the other app's read grant only lasts while the activity runs), then the page reads it through the bridge in base64 pieces and loads it like a picked file. This works whether the app was open or closed. Streaming apps such as Spotify and Apple Music don't share their audio files, so this is for songs you have as files.

The app supports Android 7.0 (API 24) and later.

### Live 8D for other apps (beta, Android 9+)

Music apps announce their audio session so equalizer apps can process it (`AudioEffect.ACTION_OPEN_AUDIO_EFFECT_CONTROL_SESSION`). `LiveService` is a foreground service with a Stop notification. It attaches Android's `DynamicsProcessing` effect to each announced session, with three bands per ear (below 200 Hz, 200 Hz–5 kHz, above 5 kHz), and animates it 25 times a second:
- **The far ear gets quieter**, by up to 12 dB at the sides, and the highs lose a further 8 dB of treble (head shadow).
- **Behind the head** the highs are muffled (-12 dB) and the moving bands drop 2.5 dB. Per-ear volume alone is heard as a left-right swing; this front/back contrast turns it into a circle.
- **With "Keep vocals in the center" on** (the default, shared with the converter), only the bass and high bands move. The 200 Hz–5 kHz band, where the voice is, stays equal in both ears, so the voice stays in the middle. Guitar and keys in that range stay centred too. With it off, everything moves.
- **Gains only ever go down.** Version 1.6 briefly boosted the front by +2 dB; if a phone's effect rejects a boost, the app would drop the session.

**"Process all audio" (experiment)** attaches one effect to the device's output mix instead (session 0), for apps that don't announce their session. On the Android 15 emulator the effect is accepted without error but **does nothing**: 0.0 dB of movement. That is the long-deprecated global session, which current Android ignores. Some phones may still honour it; the UI says so plainly. While it's on, the normal per-app connections are released, so it is only worth trying when an app never appears in the log.

**"Follow the song"** (off by default) moves the sound on the kick and bass hits instead of circling at a fixed speed:
- **Permission.** Android asks *"Allow 8D Converter to record audio?"* when you tick the box. That is the permission Android requires for an audio `Visualizer`. The app reads the music app's own sound, not the microphone, and nothing is recorded or saved. If you refuse twice, Android stops asking, and the next tick opens the app's Settings page instead. With the permission, the service runs as a foreground service of the microphone type: Android 11+ only lets a background app listen that way, and Android 14+ only allows that type once the permission is granted. Some phones may show a microphone indicator while it runs.
- **Hearing the beat.** A `Visualizer` on each attached session sits before our effect, so it hears the original. 25 times a second, the bass level (bins up to 160 Hz) is read from its FFT. A hit is a rise of more than 4 dB and well above the usual rise over the last 2 s (mean + 2.5 × mean deviation), at most one every 250 ms. The tempo is the median gap between the last 8 hits.
- **Movement.** It uses the shared Movement setting, with the same spots as the converter. Here & there cycles 12 spots; Left–right alternates 80° right and 80° left; Smooth circle takes one step per hit, sized for about one circle per orbit time. Each move glides the short way round in at most 0.3 s (35% of a beat).
- **Fallback.** After 3 s without a hit (a quiet intro or a pause) it circles on its own at the orbit time. If a session gives only silence for 5 s, the log says so: the app may be paused, or it may not let other apps listen. [Whether Apple Music, Spotify and others allow it on real phones is untested.]

**"What Live 8D sees"** in the Live card lists recent announcements, attaches and errors, so problems can be diagnosed on the phone.

It uses the saved Orbit time and Effect strength. The audio itself is never captured or re-played, so there is no added latency. Stopping releases the effects and the music sounds normal again.

What it can't do, and why:
- **It works per ear and per band.** It can't move a sound from one ear to the other, so a hard-left instrument fades rather than travels. It keeps the voice centred only by leaving the whole voice frequency range still. "Follow the song" reacts to bass hits after they are played (it reads 25 times a second; the exact delay on phones is unmeasured), whereas the converter plans moves ahead of time from the whole song. It is lighter than converting a file.
- **It only reaches apps that announce their session.** By community reports Spotify does; others vary. Apps that don't announce their session aren't processed.
- **No capture-based approach.** Capturing and re-playing other apps' audio was considered and rejected. It needs a protected permission granted over ADB to silence the originals, and Spotify, Chrome and SoundCloud block capture anyway.

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
- **Follow the music:** tempo detection must be accurate to 0.3 BPM on drum tracks (0.5 with heavy noise) and must reject plain noise. The exported orbit of a 100 BPM track must measure 9.6 s (16 beats) with the feature on and 8 s with it off. A track with a quiet half and a loud half must orbit at 9.6 s and 2.4 s respectively, with the target set to 4 s. Orbit lengths are measured from the exported audio.
- **3D cues:** from front to back, an 8 kHz tone must drop by more than 9 dB, and by at least 6 dB more than a 500 Hz tone. With simple panning, the far ear must still get a 200 Hz tone at -5 to -14 dB at the side. Removing either feature makes its test fail; without the cues, the back measured 6 dB brighter than the front.
- **Movement:** on a 120 BPM track, Here & there must hold a different spot on more than 60% of beats, using both sides. Left–right must switch sides on more than 80% of beats. The voice must stay centred while the guitar jumps sides. A 60 Hz bass tone must be more than 8 dB louder in the near ear at each side. All are mutation-checked.
- **Presets** must set the sliders and highlight correctly. **Settings** must survive a reload. **Bass boost** must lift 55 Hz by more than 9 dB relative to the voice.

**Android:** builds debug and release APKs, runs lint, then boots an Android 15 emulator and runs `tests/android/smoke.mjs` against the debug APK:

- Content must stay clear of the system bars.
- The file picker must open, and open again after being cancelled.
- Playback must run.
- An MP3 export of the synthetic song is saved through the real *Save as* screen, then read back from `Download/`. With the default settings, the voice must be centred while guitar and piano move to both sides.
- Cancelling the save must be reported.
- Rotating must not reload the page.
- Settings must survive a full app restart.
- Dark mode must reach the page.
- **Live 8D:** `android/testplayer`, a test-only app, plays tones in the voice band (440 Hz left, 660 Hz right) and the highs (7 kHz left, 9 kHz right) over a louder centred 1 kHz reference, which keeps the 8-bit auto-scaled meter below its ceiling. It announces its session. On the device's final output mix, the strength of the 8 s orbit rhythm in the left-minus-right level is measured:
  - with vocals centred, the highs must move (measured about 20 dB) while the voice band stays still (about 0.8 dB);
  - with vocals mode off, the voice band must move too (about 11 dB);
  - with "Follow the song" on (permission granted with `pm grant`), Movement Left–right, and a 120 BPM kick added to the test player: the service must report 110–130 BPM and about 21 hits in 10.5 s, and the highs must flip sides once per beat, measured as the 1 s rhythm in the left-minus-right level, while the voice band stays still;
  - after Stop, everything is still.

  "Process all audio" is measured and reported, not required; on the emulator it measured 0.0 dB.
- **Sharing:** the test player's `ShareActivity` shares a 6 s WAV through its own content provider (`ACTION_SEND` with a read grant), as a chat app would. It must open in the converter both while the app is open and when it was closed.

WebView debugging, which the Android test relies on, is only switched on in debug builds. CI saves the APKs, the lint report and the emulator screenshots as artifacts on each run.

## How it works

**Vocals mode** (`vocals.js`): lead vocals are almost always mixed dead-centre, identical in both channels. The song is analysed in short overlapping slices (2048-point FFT, 75% overlap). In each slice and frequency bin, left and right are compared for level and phase. Bins that match, inside the vocal range (about 150 Hz to 9 kHz, with soft edges), form a mono "centre" track. During playback and export that track plays in sync with the song. It goes straight to the middle with its own mono reverb, so sung notes don't drift, and it is subtracted from what orbits, so nothing is doubled or lost. Bass below the vocal range and cymbals above it keep orbiting. Separation takes about 1.6 s per minute of audio on a desktop; phones are slower.

**Spatial mode** (`buildSpatialGraph` in `app.js`) is the alternative to 8D: nothing moves, and the song surrounds you as if you were sitting among speakers. It is an upmix of the stereo song, then binaural (HRTF) rendering of 9 virtual speakers, a 7.1.2-style layout:
- **Centre (0°):** the voice, when "Keep vocals in the center" is on (the vocals-mode centre track).
- **Front (±30°):** the rest of the left and right channels. A sound mixed hard left comes from a speaker front-left instead of from inside your left ear: measured on pink noise, it is 8 dB louder in the left ear, not only in the left ear.
- **Sides (±100°):** each side again, 15 ms later and softened above 7 kHz, like a reflection off that side's wall. An earlier version fed them the left-minus-right difference, as some upmixers do, but that sent an inverted copy of right-hand sounds out of the left side. A sustained piano note mixed right then sounded centred. The tests caught it.
- **Rear (±145°):** the room echo (Reverb), starting 20 ms late. The voice's echo is mono and equal in both rear speakers, so it can't pull the voice sideways.
- **Height (±60°, 50° up):** the treble above 4 kHz, from above (the Height slider; it adds about 5 dB above 5 kHz at 100%).
- **Bass** below 150 Hz bypasses the speakers as plain stereo.

The speakers' total is trimmed to the song's loudness (within about 1 dB on pink noise). Effect strength blends with the original stereo.

What it is not: Apple's Spatial Audio plays songs mixed in Dolby Atmos, where each instrument is a separate object with its own position, and with AirPods it tracks your head. This mode starts from an ordinary stereo file, so it can only spread what the stereo mix contains, and it has no head tracking. Whether it sounds "out of your head" varies from person to person, because HRTF is a generic head; that can't be measured by the tests. It is file conversion only: Live 8D stays 8D.

**Follow the music** (`auto.js`) works like this:
- **Onsets.** The song is analysed in 1024-point frames. Onsets are the rise in loudness across 12 log-spaced bands, from 30 Hz to 10 kHz. Bands rather than FFT bins keep random noise from swamping the drums.
- **Tempo.** Found by autocorrelating the onsets between 70 and 180 BPM, with a mild preference for 90–150. It is refined using the peaks 2, 4 and 8 beats apart, so a 4-minute song stays on the beat.
- **Confidence.** The onset pattern's average correlation with itself shifted by 1–4 beats. Plain noise scores about 0.0–0.05; test beats, even buried in heavy noise, score 0.29–0.86. Below 0.15 there is no beat sync: the circle keeps your orbit time and only follows the loudness.
- **Circle length.** One circle is the number of beats (4, 8, 16, 32 or 64) closest to your orbit time.
- **Loudness.** Measured per second and smoothed over about 4 s. Bar by bar, the top 30% of the song's range turns twice as fast and the bottom 30% half as fast. Songs with less than 4 dB of variation keep a steady speed.
- **Beat movement.** Here & there cycles through 12 spots around the head with big jumps between them (fixed, so preview and export match). Left–right alternates between 80° right and 80° left, passing through the front. Each move glides the short way round in at most 0.3 s (35% of a beat), then holds.
- **Playback.** The result is a motion track (x/y/z position over time) that plays in sync with the song, like the vocal track, so preview, seeking and export match.

Analysing a 4-minute song takes about 1.2 s on a desktop. Live 8D's "Follow the song" is a simpler, real-time version of this (see Live 8D above).

Then, for the part that orbits:

1. The song is summed to mono.
2. A `PannerNode` places it in 3D space. Two oscillators drive its X and Z position (`sin` and `-cos`), so the source moves in a circle around the listener: front → right → behind → left. With Follow the music, the motion track drives the position instead.
3. **Behind-the-head cues.** Through headphones, front and back sound alike, so a plain circle is heard as a left-right swing. Measured on the export, the browser's generic HRTF even made the back about 6 dB *brighter* at 8 kHz than the front, which is the opposite of real hearing. The front/back position therefore also drives a low-pass filter (18.5 kHz in front, 3.5 kHz behind) and a 3 dB level dip behind. Now 8 kHz drops by more than 9 dB from front to back, while 500 Hz barely changes.
4. **The bass moves too.** Below 150 Hz the head barely shadows sound, so through HRTF the bass stayed put (0.1 dB between the ears at the side). It is split off with a 4th-order crossover and panned plainly left-right by the same position, at 85% depth: now 18 dB at the side.
5. **Crossfeed, simple panning only.** With 3D mode off, a little of each side's bass (below about 700 Hz, -9 dB, 0.3 ms later) reaches the other ear, so nothing sits entirely in one ear. It is off in 3D mode: HRTF output already contains the far-ear signal, and adding a second copy made them interfere, putting some pitches on the wrong side.
6. A generated impulse response feeds a `ConvolverNode` to add reverb.
7. For export, the same graph is rendered in an `OfflineAudioContext`, peak-normalised, then encoded as 16-bit WAV or as MP3 with [lamejs](https://github.com/zhuker/lamejs). The encoder is loaded only on the first MP3 export. Encoding runs in chunks so the page stays responsive.

## Limitations

- **Headphones only.** On speakers the effect falls apart.
- **Local files only.** It can't pull songs from Spotify, Apple Music or YouTube. Those streams are DRM-protected and their terms of service forbid downloading.
- **Export speed.** MP3 encoding is pure JavaScript. A 4-minute song took about 35 s to render and encode in headless Chromium on a server, and phones will likely be slower. The result is about 5.6 MB at 192 kbps, against about 43 MB as WAV.
- **MP3 sample rate.** Sources at rates MP3 can't carry (for example 96 kHz) are resampled to 44.1 kHz.
- **Mono source.** The rotating part is mono, so the original stereo image is lost at 100% strength. That's normal for 8D.
- **Vocal separation is mix-based, not AI.** Anything else mixed dead-centre in the vocal range (often snare, lead guitar or synth leads) stays in the middle with the voice. Mono songs can't be separated at all; the app says so. Clean separation needs a neural model such as Demucs, which would add a model download of tens of megabytes and minutes of processing per song on a phone.
- **Memory.** Very long tracks can fail to export on low-memory phones.
- **Copyright.** Converting a song doesn't give you the rights to it. Don't publish 8D versions of music you don't own.

## Third-party code

`vendor/lamejs/lame.min.js` is [lamejs](https://github.com/zhuker/lamejs) 1.2.1, an unmodified JavaScript port of [LAME](https://lame.sourceforge.io/), licensed under the LGPL. See `vendor/lamejs/LICENSE`.
