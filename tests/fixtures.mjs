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
