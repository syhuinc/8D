'use strict';

// Vocal (centre) extraction for "keep vocals in the centre" mode.
//
// Lead vocals are almost always mixed dead centre: identical in both channels.
// For each short-time frequency bin we measure how similar left and right are
// (in level and phase); bins that match, inside the vocal frequency range, are
// treated as "centre". The result is a mono track that stays in the middle of
// the head; app.js subtracts it from what orbits, so nothing is lost or doubled.
//
// Limits: anything else mixed dead centre in the vocal range (often snare,
// lead guitar) stays with the voice, and mono songs barely separate at all.
// Proper separation needs a neural model; this is the fast, offline version.

const Vocals = (() => {
  const N = 2048;          // FFT size (~46 ms at 44.1 kHz)
  const HOP = N / 4;       // 75 % overlap
  const SMOOTH = 0.6;      // per-frame smoothing of the channel statistics
  const SIM_LO = 0.7;      // L/R similarity below this: not centre
  const SIM_HI = 0.95;     // ... above this: fully centre
  const BAND = [100, 150, 9000, 12000]; // vocal band with soft edges (Hz)

  function makeFft(n) {
    const bits = Math.log2(n);
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    // In-place radix-2 FFT; the inverse is unscaled.
    return (re, im, inverse) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      const sign = inverse ? 1 : -1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = start + j;
            const b = a + half;
            const wr = cos[k];
            const wi = sign * sin[k];
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  function bandWeights(sampleRate) {
    const [lo0, lo1, hi0, hi1] = BAND.map(Math.log);
    const w = new Float32Array(N / 2 + 1);
    for (let k = 1; k <= N / 2; k++) {
      const f = Math.log((k * sampleRate) / N);
      const up = Math.min(1, Math.max(0, (f - lo0) / (lo1 - lo0)));
      const down = Math.min(1, Math.max(0, (hi1 - f) / (hi1 - hi0)));
      w[k] = up * down;
    }
    return w;
  }

  /**
   * Returns the centre (vocal) track as a mono Float32Array, scaled like a
   * Web Audio stereo→mono downmix, i.e. relative to (L + R) / 2.
   * Yields to the browser regularly; onProgress receives 0..1.
   */
  async function extractCenter(left, right, sampleRate, onProgress = () => {}) {
    const len = left.length;
    const out = new Float32Array(len);
    const fft = makeFft(N);
    const half = N / 2;
    const win = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    const olaGain = 1 / (1.5 * N); // Hann² at 75 % overlap sums to 1.5; inverse FFT is unscaled
    const band = bandWeights(sampleRate);
    const sll = new Float64Array(half + 1);
    const srr = new Float64Array(half + 1);
    const slr = new Float64Array(half + 1);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    const cRe = new Float64Array(half + 1);
    const cIm = new Float64Array(half + 1);

    let lastYield = performance.now();
    for (let start = HOP - N; start < len; start += HOP) {
      // Pack both channels into one complex FFT: z = L + iR.
      for (let i = 0; i < N; i++) {
        const idx = start + i;
        const inside = idx >= 0 && idx < len;
        re[i] = inside ? left[idx] * win[i] : 0;
        im[i] = inside ? right[idx] * win[i] : 0;
      }
      fft(re, im, false);

      for (let k = 0; k <= half; k++) {
        const m = (N - k) & (N - 1);
        const zr = re[k], zi = im[k], cr = re[m], ci = -im[m]; // Z[k], conj(Z[N-k])
        const lr = (zr + cr) / 2, li = (zi + ci) / 2;           // left spectrum
        const rr = (zi - ci) / 2, ri = (cr - zr) / 2;           // right spectrum
        sll[k] = SMOOTH * sll[k] + (1 - SMOOTH) * (lr * lr + li * li);
        srr[k] = SMOOTH * srr[k] + (1 - SMOOTH) * (rr * rr + ri * ri);
        slr[k] = SMOOTH * slr[k] + (1 - SMOOTH) * (lr * rr + li * ri);
        // 1 when L and R match in level and phase, 0 when unrelated or opposed.
        const similarity = (2 * slr[k]) / (sll[k] + srr[k] + 1e-20);
        let mask = Math.min(1, Math.max(0, (similarity - SIM_LO) / (SIM_HI - SIM_LO)));
        mask = mask * mask * (3 - 2 * mask) * band[k];
        cRe[k] = (mask * (lr + rr)) / 2;
        cIm[k] = (mask * (li + ri)) / 2;
      }

      // Hermitian spectrum → real centre signal.
      for (let k = 0; k <= half; k++) { re[k] = cRe[k]; im[k] = cIm[k]; }
      im[0] = 0; im[half] = 0;
      for (let k = half + 1; k < N; k++) { re[k] = cRe[N - k]; im[k] = -cIm[N - k]; }
      fft(re, im, true);
      for (let i = 0; i < N; i++) {
        const idx = start + i;
        if (idx >= 0 && idx < len) out[idx] += re[i] * win[i] * olaGain;
      }

      if (performance.now() - lastYield > 50) {
        onProgress(Math.max(0, start) / len);
        await new Promise((r) => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }
    onProgress(1);
    return out;
  }

  return { extractCenter };
})();
