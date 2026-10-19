// Shared helpers for the web and Android tests.

/** A stereo 16-bit WAV: 440 Hz tone plus deterministic noise, identical in both channels. */
export function makeWav({ sampleRate = 44100, seconds = 10 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  let seed = 1;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < frames; i++) {
    const s = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sampleRate) + 0.1 * noise();
    const v = Math.round(Math.max(-1, Math.min(1, s)) * 32767);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  return buf;
}

/**
 * Runs in the page: decodes audio bytes (base64) and reports, for each second,
 * which ear is louder ('L', 'R' or '=' when roughly balanced).
 */
export async function analyseInPage(page, bytes) {
  return page.evaluate(async (b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const ctx = new OfflineAudioContext(2, 1, 44100);
    const buf = await ctx.decodeAudioData(data);
    const L = buf.getChannelData(0), R = buf.getChannelData(1), sr = buf.sampleRate;
    let pattern = '';
    for (let s = 0; s + 0.5 <= Math.min(10, buf.duration); s++) {
      let l = 0, r = 0;
      for (let i = s * sr; i < (s + 0.5) * sr; i++) { l += L[i] * L[i]; r += R[i] * R[i]; }
      pattern += r > l * 1.4 ? 'R' : l > r * 1.4 ? 'L' : '=';
    }
    return { sampleRate: sr, channels: buf.numberOfChannels, duration: buf.duration, pattern };
  }, Buffer.from(bytes).toString('base64'));
}

/**
 * With an 8 s orbit starting in front and moving clockwise, seconds 1-3 should
 * be right-heavy and 5-7 left-heavy. 0 and 4 are front/back, where either ear can win slightly.
 */
export function orbitIsCorrect(pattern) {
  return /^.RRR.LLL/.test(pattern);
}

/**
 * A stereo test "song" with known placement and pitches:
 * voice (centre, 523/1047/1570 Hz, syllable rhythm), guitar (mostly left,
 * 659/1319 Hz), piano (mostly right, 880/1760 Hz), bass (centre, 55/110 Hz),
 * and a slightly off-centre synth (60/40, 740 Hz) for the strictness setting.
 */
export const MIX = { voice: [523.25, 1046.5, 1569.75], guitar: [659.25, 1318.5], piano: [880, 1760], bass: [55, 110], synth: [740] };
export function makeMix({ sampleRate = 44100, seconds = 10 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  const sum = (fs, t, a) => fs.reduce((s, f, i) => s + (a / (i + 1)) * Math.sin(2 * Math.PI * f * t), 0);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const voice = sum(MIX.voice, t, 0.16) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t));
    const guitar = sum(MIX.guitar, t, 0.12);
    const piano = sum(MIX.piano, t, 0.1);
    const bass = sum(MIX.bass, t, 0.14);
    const synth = sum(MIX.synth, t, 0.1);
    const l = voice + 0.85 * guitar + 0.25 * piano + bass + 0.6 * synth;
    const r = voice + 0.25 * guitar + 0.85 * piano + bass + 0.4 * synth;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r)) * 32767), 46 + i * 4);
  }
  return buf;
}

/**
 * Runs in the page: for each frequency, which ear is louder in each second
 * ('L', 'R' or '=' when within ±2 dB), measured with a Goertzel filter.
 */
export async function placementInPage(page, bytes, freqs) {
  return page.evaluate(async ({ b64, freqs }) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const buf = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(data);
    const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.getChannelData(1);
    const power = (x, f, from, n) => {
      const w = 2 * Math.cos((2 * Math.PI * f) / sr);
      let s1 = 0, s2 = 0;
      for (let i = from; i < from + n; i++) { const s0 = x[i] + w * s1 - s2; s2 = s1; s1 = s0; }
      return s1 * s1 + s2 * s2 - w * s1 * s2;
    };
    const out = {};
    for (const f of freqs) {
      let pattern = '';
      for (let s = 0; s < 10; s++) {
        const from = Math.round(s * sr), n = Math.round(0.5 * sr);
        const l = power(L, f, from, n), r = power(R, f, from, n);
        pattern += r > l * 1.585 ? 'R' : l > r * 1.585 ? 'L' : '=';
      }
      out[f] = pattern;
    }
    return out;
  }, { b64: Buffer.from(bytes).toString('base64'), freqs });
}

/** Runs in the page: overall level (dB) of each frequency, both ears together. */
export async function levelsInPage(page, bytes, freqs) {
  return page.evaluate(async ({ b64, freqs }) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const buf = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(data);
    const sr = buf.sampleRate, n = Math.min(buf.length, sr * 10);
    const out = {};
    for (const f of freqs) {
      const w = 2 * Math.cos((2 * Math.PI * f) / sr);
      let p = 0;
      for (const x of [buf.getChannelData(0), buf.getChannelData(1)]) {
        let s1 = 0, s2 = 0;
        for (let i = 0; i < n; i++) { const s0 = x[i] + w * s1 - s2; s2 = s1; s1 = s0; }
        p += s1 * s1 + s2 * s2 - w * s1 * s2;
      }
      out[f] = 10 * Math.log10(p + 1e-30);
    }
    return out;
  }, { b64: Buffer.from(bytes).toString('base64'), freqs });
}

/**
 * A mono drum track: kick on every beat (accent on odd beats), hi-hat on
 * eighths, and a steady 700 Hz pad that the tests use to follow the orbit.
 * With quietFirstHalf, the first half plays at a quarter of the level.
 */
export function makeBeat({ bpm = 100, seconds = 30, quietFirstHalf = false, sampleRate = 44100 } = {}) {
  const frames = Math.round(sampleRate * seconds);
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + frames * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 4, 28); buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * 4, 40);
  let seed = 11;
  const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  const beat = 60 / bpm;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate, ph = t % beat, half = t % (beat / 2);
    const kick = (Math.floor(t / beat) % 2 === 0 ? 1 : 0.6) * Math.exp(-ph * 25) * Math.sin(2 * Math.PI * 55 * ph);
    const hat = 0.2 * Math.exp(-half * 120) * noise();
    const pad = 0.15 * Math.sin(2 * Math.PI * 700 * t);
    const level = quietFirstHalf && t < seconds / 2 ? 0.25 : 1;
    const v = Math.round(Math.max(-1, Math.min(1, level * (0.5 * kick + hat + pad))) * 32767);
    buf.writeInt16LE(v, 44 + i * 4);
    buf.writeInt16LE(v, 46 + i * 4);
  }
  return buf;
}

/**
 * Runs in the page: how long one orbit takes (s) between `from` and `to`,
 * from the left-minus-right level of one frequency every 0.1 s, via the
 * autocorrelation between 1.5 and 20 s: the shortest lag that comes within
 * 85% of the strongest, because a repeating pattern also matches itself
 * two or three cycles later.
 */
export async function orbitPeriodInPage(page, bytes, freq, from, to) {
  return page.evaluate(async ({ b64, freq, from, to }) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;
    const buf = await new OfflineAudioContext(2, 1, 44100).decodeAudioData(data);
    const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.getChannelData(1);
    const power = (x, start, n) => {
      const w = 2 * Math.cos((2 * Math.PI * freq) / sr);
      let s1 = 0, s2 = 0;
      for (let i = start; i < start + n; i++) { const s0 = x[i] + w * s1 - s2; s2 = s1; s1 = s0; }
      return s1 * s1 + s2 * s2 - w * s1 * s2;
    };
    const step = 0.1, n = Math.round(step * sr);
    const d = [];
    for (let t = from; t + step <= to; t += step) {
      const start = Math.round(t * sr);
      d.push(10 * Math.log10((power(L, start, n) + 1e-12) / (power(R, start, n) + 1e-12)));
    }
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const ac = {};
    let best = 0;
    for (let lag = Math.round(1.5 / step); lag <= Math.min(Math.round(20 / step), d.length - 10); lag++) {
      let s = 0;
      for (let i = 0; i + lag < d.length; i++) s += (d[i] - mean) * (d[i + lag] - mean);
      ac[lag] = s / (d.length - lag);
      best = Math.max(best, ac[lag]);
    }
    // First local maximum that is close to the strongest one.
    const lags = Object.keys(ac).map(Number);
    for (const lag of lags) {
      if (ac[lag] >= 0.85 * best && ac[lag] >= (ac[lag - 1] ?? -Infinity) && ac[lag] >= (ac[lag + 1] ?? -Infinity)) return lag * step;
    }
    return NaN;
  }, { b64: Buffer.from(bytes).toString('base64'), freq, from, to });
}
