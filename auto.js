'use strict';

// "Follow the music": analyse a song's beat and loudness, then plan the orbit
// around it. One circle takes a whole number of beats and starts in front of
// the listener on a beat; it turns faster in loud parts and slower in quiet ones.
//
// The plan becomes a "motion" track (the sound's x/y/z position over time)
// that app.js plays in sync with the song, exactly like the vocal track, so
// preview, seeking and export always line up.
//
// Tempo detection is reliable for steady beats (pop, EDM, hip-hop) and not for
// free-tempo music; when unsure we keep the user's orbit time and only follow
// the loudness.

const Auto = (() => {
  const N = 1024;              // FFT size for the onset analysis
  const HOP = 512;             // ~86 analysis frames per second at 44.1 kHz
  const MIN_BPM = 70, MAX_BPM = 180;
  const MIN_CONFIDENCE = 0.15; // beat self-correlation (see estimateTempo); noise stays near 0
  const MIN_DYNAMICS_DB = 4;   // songs with less loudness variation keep a steady speed
  const ANGLE_RATE = 100;      // angle samples per second (for the plan and the orbit view)
  const MOTION_RATE = 8000;    // sample rate of the motion track (lowest every browser accepts)

  async function analyse(buffer, onProgress = () => {}) {
    const sr = buffer.sampleRate;
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
    const frames = Math.max(0, Math.floor((buffer.length - N) / HOP) + 1);
    const fps = sr / HOP;
    const fft = Vocals.makeFft(N);
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    // Onsets are measured in 12 log-spaced bands (30 Hz - 10 kHz), not per FFT
    // bin: random noise averages out within a band, a drum hit doesn't.
    const BANDS = 12;
    const bandOf = new Int8Array(N / 2 + 1).fill(-1);
    for (let k = 1; k <= N / 2; k++) {
      const f = (k * sr) / N;
      if (f >= 30 && f < 10000) bandOf[k] = Math.min(BANDS - 1, Math.floor((BANDS * Math.log(f / 30)) / Math.log(10000 / 30)));
    }
    const band = new Float64Array(BANDS);
    const prev = new Float64Array(BANDS);
    const flux = new Float32Array(frames);  // how much the spectrum grew: onsets
    const power = new Float32Array(frames); // for loudness

    let lastYield = performance.now();
    for (let f = 0; f < frames; f++) {
      const start = f * HOP;
      for (let i = 0; i < N; i++) {
        re[i] = 0.5 * (left[start + i] + right[start + i]) * win[i];
        im[i] = 0;
      }
      fft(re, im, false);
      let rise = 0, p = 0;
      band.fill(0);
      for (let k = 1; k <= N / 2; k++) {
        const e = re[k] * re[k] + im[k] * im[k];
        p += e;
        if (bandOf[k] >= 0) band[bandOf[k]] += e;
      }
      for (let b = 0; b < BANDS; b++) {
        const m = Math.log(1e-10 + band[b]); // loudness of the band
        if (f > 0 && m > prev[b]) rise += m - prev[b];
        prev[b] = m;
      }
      flux[f] = rise;
      power[f] = p;
      if (performance.now() - lastYield > 50) {
        onProgress(f / frames);
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    onProgress(1);
    const onset = onsetEnvelope(flux, fps);
    return { duration: buffer.duration, ...estimateTempo(onset, fps), loudness: loudnessCurve(power, fps) };
  }

  /** Spectral flux minus its local average, so only sudden changes remain. */
  function onsetEnvelope(flux, fps) {
    const w = Math.round(fps * 0.5);
    const sum = new Float64Array(flux.length + 1);
    for (let i = 0; i < flux.length; i++) sum[i + 1] = sum[i] + flux[i];
    const out = new Float32Array(flux.length);
    for (let i = 0; i < flux.length; i++) {
      const a = Math.max(0, i - w), b = Math.min(flux.length, i + w + 1);
      out[i] = Math.max(0, flux[i] - (sum[b] - sum[a]) / (b - a));
    }
    return out;
  }

  /** Tempo by autocorrelation of the onset envelope; beat phase by comb alignment. */
  function estimateTempo(onset, fps) {
    const minLag = Math.floor((fps * 60) / MAX_BPM);
    const maxLag = Math.ceil((fps * 60) / MIN_BPM);
    const none = { bpm: null, confidence: 0, beatTime: 0 };
    if (onset.length < maxLag * 6) return none;
    const ac = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = 0; i + lag < onset.length; i++) s += onset[i] * onset[i + lag];
      ac[lag] = s / (onset.length - lag);
    }
    let best = -1, bestScore = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      // Mild preference for 90-150 BPM avoids picking half or double the tempo.
      const octaves = Math.log2((fps * 60) / lag / 120);
      const score = ac[lag] * Math.exp(-0.5 * (octaves / 0.7) ** 2);
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    if (best < 0 || bestScore <= 0) return none;
    // Sub-frame precision from the neighbouring lags.
    const a = ac[best - 1], b = ac[best], c = ac[best + 1];
    const denom = a - 2 * b + c;
    let lag = best + (denom < 0 ? (0.5 * (a - c)) / denom : 0);

    // Refine with the peaks 2, 4 and 8 beats apart: a frame's error spread
    // over 8 beats is 8x smaller, which keeps a 4-minute song on the beat.
    const acAt = (L) => {
      let s = 0;
      for (let i = 0; i + L < onset.length; i++) s += onset[i] * onset[i + L];
      return s / (onset.length - L);
    };
    for (const k of [2, 4, 8]) {
      const center = Math.round(lag * k);
      if (center + 3 > onset.length / 2) break;
      let peak = center, peakVal = -1;
      const vals = {};
      for (let L = center - 3; L <= center + 3; L++) {
        vals[L] = acAt(L);
        if (vals[L] > peakVal) { peakVal = vals[L]; peak = L; }
      }
      if (peak === center - 3 || peak === center + 3) break; // no clear peak: keep what we have
      const pa = vals[peak - 1], pb = vals[peak], pc = vals[peak + 1];
      const d = pa - 2 * pb + pc;
      lag = (peak + (d < 0 ? (0.5 * (pa - pc)) / d : 0)) / k;
    }

    // Confidence: a real beat repeats, so the onset pattern correlates with
    // itself shifted by 1, 2, 3 and 4 beats. Average that correlation (0..1).
    // Noise stays near 0 at every shift; a steady beat stays well above it.
    let m = 0;
    for (let i = 0; i < onset.length; i++) m += onset[i];
    m /= onset.length;
    let variance = 0;
    for (let i = 0; i < onset.length; i++) variance += (onset[i] - m) ** 2;
    variance /= onset.length;
    const corrAt = (L) => {
      let s = 0;
      for (let i = 0; i + L < onset.length; i++) s += (onset[i] - m) * (onset[i + L] - m);
      return s / (onset.length - L) / Math.max(1e-30, variance);
    };
    let corr = 0;
    for (let k = 1; k <= 4; k++) {
      const L = Math.round(lag * k);
      corr += Math.max(corrAt(L - 1), corrAt(L), corrAt(L + 1));
    }
    const confidence = corr / 4;

    let bestPhase = 0, phaseScore = -1;
    for (let p = 0; p < lag; p += 0.5) {
      let s = 0;
      for (let t = p; t < onset.length; t += lag) s += onset[Math.round(t)] || 0;
      if (s > phaseScore) { phaseScore = s; bestPhase = p; }
    }
    return { bpm: (60 * fps) / lag, confidence, beatTime: bestPhase / fps };
  }

  /** Loudness (dB) per second, smoothed over about 4 s. */
  function loudnessCurve(power, fps) {
    const seconds = Math.max(1, Math.ceil(power.length / fps));
    const raw = new Float32Array(seconds);
    for (let s = 0; s < seconds; s++) {
      let sum = 0, n = 0;
      for (let f = Math.floor(s * fps); f < Math.min(power.length, Math.floor((s + 1) * fps)); f++, n++) sum += power[f];
      raw[s] = 10 * Math.log10(sum / Math.max(1, n) + 1e-12);
    }
    const out = new Float32Array(seconds);
    for (let s = 0; s < seconds; s++) {
      let sum = 0, n = 0;
      for (let k = Math.max(0, s - 2); k <= Math.min(seconds - 1, s + 2); k++, n++) sum += raw[k];
      out[s] = sum / n;
    }
    return out;
  }

  const percentile = (values, q) => {
    const sorted = Array.from(values).sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };

  /**
   * The orbit for this song: a list of { t, period } speed changes, decided
   * once per bar (4 beats, or 4 s without a beat), plus the time that should
   * be "in front".
   */
  function plan(a, targetPeriod) {
    const synced = a.bpm !== null && a.confidence >= MIN_CONFIDENCE;
    const beat = synced ? 60 / a.bpm : null;
    let base = targetPeriod, beatsPerCircle = null;
    if (synced) {
      let bestErr = Infinity;
      for (const beats of [4, 8, 16, 32, 64]) {
        const err = Math.abs(Math.log(beats * beat / targetPeriod));
        if (beats * beat >= 2 && beats * beat <= 32 && err < bestErr) { bestErr = err; beatsPerCircle = beats; }
      }
      if (beatsPerCircle) base = beatsPerCircle * beat;
    }
    const db = a.loudness;
    const p10 = percentile(db, 0.1), p90 = percentile(db, 0.9);
    const dynamic = p90 - p10 >= MIN_DYNAMICS_DB;
    const step = synced ? 4 * beat : 4;
    const anchor = synced ? a.beatTime : 0;
    const segments = [];
    for (let t = anchor - Math.ceil(anchor / step) * step; t < a.duration; t += step) {
      let mult = 1;
      if (dynamic) {
        let sum = 0, n = 0;
        for (let s = Math.max(0, Math.floor(t)); s < Math.min(db.length, Math.ceil(t + step)); s++, n++) sum += db[s];
        const e = n ? (sum / n - p10) / (p90 - p10) : 0.5;
        mult = e > 0.7 ? 0.5 : e < 0.3 ? 2 : 1; // loud: twice as fast; quiet: half as fast
      }
      const period = Math.min(32, Math.max(2, base * mult));
      if (!segments.length || segments[segments.length - 1].period !== period) segments.push({ t, period });
    }
    return { synced, bpm: synced ? a.bpm : null, beatsPerCircle, base, dynamic, anchor, segments };
  }

  /** Orbit angle (radians) every 1/ANGLE_RATE s; 0 = front, at the anchor beat. */
  function angles(p, duration) {
    const n = Math.ceil(duration * ANGLE_RATE) + 2;
    const out = new Float32Array(n);
    let angle = 0, seg = 0;
    for (let i = 0; i < n; i++) {
      const t = i / ANGLE_RATE;
      while (seg + 1 < p.segments.length && p.segments[seg + 1].t <= t) seg++;
      out[i] = angle;
      angle += (2 * Math.PI) / (ANGLE_RATE * p.segments[seg].period);
    }
    const shift = angleAt(out, p.anchor);
    for (let i = 0; i < n; i++) out[i] -= shift;
    return out;
  }

  function angleAt(table, t) {
    const x = Math.max(0, Math.min(table.length - 1.001, t * ANGLE_RATE));
    const i = Math.floor(x);
    return table[i] + (table[i + 1] - table[i]) * (x - i);
  }

  /**
   * The motion track: channel 0 = x (right), 1 = y (up, scaled by Height
   * wobble in the graph), 2 = z. The listener faces -z, so z = -cos puts
   * angle 0 in front and turns clockwise, like the manual orbit.
   */
  function motionBuffer(table, duration) {
    const length = Math.ceil(duration * MOTION_RATE) + 1;
    const buf = new AudioBuffer({ numberOfChannels: 3, length, sampleRate: MOTION_RATE });
    const x = buf.getChannelData(0), y = buf.getChannelData(1), z = buf.getChannelData(2);
    for (let j = 0; j < length; j++) {
      const a = angleAt(table, j / MOTION_RATE);
      x[j] = Math.sin(a);
      y[j] = Math.sin(a / 2);
      z[j] = -Math.cos(a);
    }
    return buf;
  }

  /** One line for the page explaining what "follow the music" decided. */
  function describe(p) {
    const speed = p.dynamic ? 'faster in loud parts, slower in quiet ones' : 'steady speed (the loudness hardly changes)';
    if (p.synced) {
      return `${Math.round(p.bpm)} BPM: one circle every ${p.beatsPerCircle} beats (${p.base.toFixed(1)} s), starting on the beat; ${speed}.`;
    }
    return `No steady beat found, so the circle keeps your orbit time; ${speed}.`;
  }

  return { analyse, plan, angles, angleAt, motionBuffer, describe };
})();
