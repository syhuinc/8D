'use strict';

// How it works: the song is summed to mono and fed through a PannerNode whose
// position is driven by two oscillators (sin for X, -cos for Z), so the sound
// travels in a circle around the listener. A little reverb adds the "room"
// feel typical of 8D tracks. The same graph is used for live preview and for
// the offline render that produces the downloadable WAV.

const $ = (id) => document.getElementById(id);

const params = {
  period: 8,      // seconds per full circle
  strength: 1,    // 0 = original stereo, 1 = fully spatialised
  reverb: 0.3,    // wet amount
  height: 0,      // vertical wobble amount
  hrtf: true,
};

const state = {
  ctx: null,
  graph: null,
  buffer: null,
  fileName: '',
  source: null,
  sourceToken: 0,
  playing: false,
  startedAt: 0,   // ctx time at which offset 0 of the current source would have played
  offset: 0,      // playback position (s) when not playing
  orbit: { basePhase: 0, baseTime: 0, freq: 1 / params.period },
};

// ---------- audio graph ----------

function cosineWave(ctx) {
  return new PeriodicWave(ctx, { real: [0, 1], imag: [0, 0] });
}

// Deterministic noise so preview and export use the same reverb.
function makeImpulse(ctx, seconds, decay) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate: ctx.sampleRate });
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = rand() * Math.pow(1 - i / len, decay);
  }
  return ir;
}

function buildGraph(ctx, p) {
  const input = new GainNode(ctx);

  const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const panner = new PannerNode(ctx, {
    panningModel: p.hrtf ? 'HRTF' : 'equalpower',
    distanceModel: 'linear',
    rolloffFactor: 0, // constant loudness all the way round
    positionX: 0, positionY: 0, positionZ: 0,
  });

  const freq = 1 / p.period;
  const oscX = new OscillatorNode(ctx, { type: 'sine', frequency: freq });
  const oscZ = new OscillatorNode(ctx, { periodicWave: cosineWave(ctx), frequency: freq });
  const oscY = new OscillatorNode(ctx, { type: 'sine', frequency: freq / 2 });
  // Listener faces -Z, so Z = -cos starts the sound in front and moves it clockwise.
  const gainZ = new GainNode(ctx, { gain: -1 });
  const gainY = new GainNode(ctx, { gain: p.height });
  oscX.connect(panner.positionX);
  oscZ.connect(gainZ).connect(panner.positionZ);
  oscY.connect(gainY).connect(panner.positionY);

  const spatial = new GainNode(ctx, { gain: p.strength });
  const original = new GainNode(ctx, { gain: 1 - p.strength });
  const bus = new GainNode(ctx);
  input.connect(mono).connect(panner).connect(spatial).connect(bus);
  input.connect(original).connect(bus);

  const dry = new GainNode(ctx, { gain: 1 - p.reverb * 0.4 });
  const wet = new GainNode(ctx, { gain: p.reverb });
  const convolver = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 2.8, 2.5) });
  const master = new GainNode(ctx);
  bus.connect(dry).connect(master);
  bus.connect(convolver).connect(wet).connect(master);
  master.connect(ctx.destination);

  return {
    input, panner, oscillators: [oscX, oscZ, oscY], gainY, spatial, original, dry, wet,
    start(when) { this.oscillators.forEach((o) => o.start(when)); },
  };
}

function ensureContext() {
  if (state.ctx) return state.ctx;
  const ctx = new AudioContext();
  state.ctx = ctx;
  state.graph = buildGraph(ctx, params);
  state.graph.start(ctx.currentTime);
  state.orbit = { basePhase: 0, baseTime: ctx.currentTime, freq: 1 / params.period };
  ctx.suspend(); // oscillators (and the orbit) only advance while playing
  return ctx;
}

// ---------- live parameter updates ----------

function applyParams() {
  const g = state.graph;
  if (!g) return;
  const t = state.ctx.currentTime;
  const smooth = (param, v) => param.setTargetAtTime(v, t, 0.05);

  const freq = 1 / params.period;
  const o = state.orbit;
  if (freq !== o.freq) {
    o.basePhase += 2 * Math.PI * o.freq * (t - o.baseTime);
    o.baseTime = t;
    o.freq = freq;
    // Same instant for all three, so X/Z stay exactly in quadrature.
    g.oscillators[0].frequency.setValueAtTime(freq, t);
    g.oscillators[1].frequency.setValueAtTime(freq, t);
    g.oscillators[2].frequency.setValueAtTime(freq / 2, t);
  }
  smooth(g.gainY.gain, params.height);
  smooth(g.spatial.gain, params.strength);
  smooth(g.original.gain, 1 - params.strength);
  smooth(g.dry.gain, 1 - params.reverb * 0.4);
  smooth(g.wet.gain, params.reverb);
  g.panner.panningModel = params.hrtf ? 'HRTF' : 'equalpower';
}

// ---------- playback ----------

function position() {
  if (!state.buffer) return 0;
  if (!state.playing) return state.offset;
  return Math.min(state.ctx.currentTime - state.startedAt, state.buffer.duration);
}

function startSource(offset) {
  stopSource();
  const ctx = state.ctx;
  const src = new AudioBufferSourceNode(ctx, { buffer: state.buffer });
  const token = ++state.sourceToken;
  src.connect(state.graph.input);
  src.onended = () => {
    if (token !== state.sourceToken) return; // stopped by a seek / new file
    state.playing = false;
    state.offset = 0;
    ctx.suspend();
    render();
  };
  src.start(ctx.currentTime, offset);
  state.source = src;
  state.startedAt = ctx.currentTime - offset;
}

function stopSource() {
  if (!state.source) return;
  state.sourceToken++;
  try { state.source.stop(); } catch (_) { /* already stopped */ }
  state.source.disconnect();
  state.source = null;
}

async function play() {
  const ctx = ensureContext();
  await ctx.resume();
  startSource(state.offset);
  state.playing = true;
  render();
}

function pause() {
  state.offset = position();
  state.playing = false;
  stopSource();
  state.ctx.suspend();
  render();
}

function seekTo(seconds) {
  state.offset = Math.max(0, Math.min(seconds, state.buffer.duration));
  if (state.playing) startSource(state.offset);
  render();
}

// ---------- loading ----------

async function loadFile(file) {
  if (!file) return;
  setStatus('Decoding…');
  try {
    const ctx = ensureContext();
    const bytes = await file.arrayBuffer();
    const buffer = await ctx.decodeAudioData(bytes);
    if (state.playing) pause();
    stopSource();
    state.buffer = buffer;
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'song';
    state.offset = 0;
    $('dropTitle').textContent = file.name;
    $('dropHint').textContent = 'Tap to choose a different song';
    $('player').hidden = false;
    $('controls').hidden = false;
    $('dur').textContent = fmt(buffer.duration);
    setStatus('');
    render();
  } catch (err) {
    console.error(err);
    setStatus("Couldn't read that file. Your browser may not support this audio format — try MP3 or WAV.");
  }
}

// ---------- export ----------

// Sample rates an MP3 (MPEG-1/2) stream can carry.
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

async function exportFile() {
  const b = state.buffer;
  if (!b) return;
  const [format, kbps] = $('format').value.split('-');
  const btn = $('export');
  btn.disabled = true;
  setStatus('Rendering 8D version… (this can take a little while for long songs)');
  try {
    // Render straight at a rate MP3 supports; the source node resamples for us.
    const rate = format === 'mp3' && !MP3_RATES.includes(b.sampleRate) ? 44100 : b.sampleRate;
    const length = Math.ceil(b.duration * rate) + Math.ceil(rate * 3); // let the reverb ring out
    const off = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: rate });
    const g = buildGraph(off, params);
    const src = new AudioBufferSourceNode(off, { buffer: b });
    src.connect(g.input);
    g.start(0);
    src.start(0);
    const rendered = await off.startRendering();
    normalise(rendered, 0.98);
    const blob = format === 'mp3'
      ? await encodeMp3(rendered, Number(kbps), (f) => setStatus(`Encoding MP3… ${Math.round(f * 100)}%`))
      : encodeWav(rendered);
    download(blob, `${state.fileName} (8D).${format}`);
    setStatus(`Done — ${(blob.size / 1048576).toFixed(1)} MB ${format.toUpperCase()} saved.`);
  } catch (err) {
    console.error(err);
    setStatus('Export failed: ' + (err && err.message ? err.message : err) + '. Long songs can run out of memory on phones.');
  } finally {
    btn.disabled = false;
  }
}

function normalise(buffer, ceiling) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  }
  if (peak <= ceiling) return;
  const k = ceiling / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= k;
  }
}

function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const dataSize = frames * channels * 2;
  const out = new DataView(new ArrayBuffer(44 + dataSize));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + dataSize, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, channels, true); out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * channels * 2, true); out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out.setInt16(o, toInt16(data[c][i]), true);
      o += 2;
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}

function toInt16(x) {
  const s = Math.max(-1, Math.min(1, x));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

// The encoder (~150 KB) is only fetched the first time someone exports MP3.
let lameLoading = null;
function loadLame() {
  if (window.lamejs) return Promise.resolve();
  lameLoading = lameLoading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/lamejs/lame.min.js';
    s.onload = resolve;
    s.onerror = () => { lameLoading = null; reject(new Error('could not load the MP3 encoder')); };
    document.head.appendChild(s);
  });
  return lameLoading;
}

async function encodeMp3(buffer, kbps, onProgress) {
  await loadLame();
  const enc = new lamejs.Mp3Encoder(2, buffer.sampleRate, kbps);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const block = 1152 * 64; // multiple of the MP3 frame size
  const l16 = new Int16Array(block);
  const r16 = new Int16Array(block);
  const parts = [];
  let lastYield = performance.now();
  for (let i = 0; i < left.length; i += block) {
    const n = Math.min(block, left.length - i);
    for (let j = 0; j < n; j++) {
      l16[j] = toInt16(left[i + j]);
      r16[j] = toInt16(right[i + j]);
    }
    const chunk = enc.encodeBuffer(l16.subarray(0, n), r16.subarray(0, n));
    if (chunk.length) parts.push(chunk);
    // Yield to the browser regularly so the page stays responsive and shows progress.
    if (performance.now() - lastYield > 100) {
      onProgress(i / left.length);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  parts.push(enc.flush());
  return new Blob(parts, { type: 'audio/mpeg' });
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- UI ----------

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const setStatus = (msg) => { $('status').textContent = msg; };

function orbitAngle() {
  if (!state.ctx) return 0;
  const o = state.orbit;
  return o.basePhase + 2 * Math.PI * o.freq * (state.ctx.currentTime - o.baseTime);
}

function drawOrbit() {
  const cv = $('orbit');
  const dpr = window.devicePixelRatio || 1;
  const size = 200;
  if (cv.width !== size * dpr) { cv.width = cv.height = size * dpr; }
  const g = cv.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line');
  const text = css.getPropertyValue('--muted');
  const dot = css.getPropertyValue('--dot');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const c = size / 2, r = 76;

  g.strokeStyle = line; g.lineWidth = 2;
  g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();

  // head seen from above, nose pointing forward (up)
  g.fillStyle = text;
  g.beginPath(); g.arc(c, c, 14, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(c - 5, c - 12); g.lineTo(c, c - 21); g.lineTo(c + 5, c - 12); g.fill();
  g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('front', c, 12);

  const a = orbitAngle();
  const x = c + Math.sin(a) * r * params.strength;
  const y = c - Math.cos(a) * r * params.strength;
  g.fillStyle = dot;
  g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
}

function render() {
  $('play').textContent = state.playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  if (state.buffer) {
    const pos = position();
    $('cur').textContent = fmt(pos);
    if (!seeking) $('seek').value = String(Math.round((pos / state.buffer.duration) * 1000));
  }
  $('periodOut').textContent = `${params.period}s per circle`;
  $('strengthOut').textContent = `${Math.round(params.strength * 100)}%`;
  $('reverbOut').textContent = `${Math.round(params.reverb * 100)}%`;
  $('heightOut').textContent = `${Math.round(params.height * 100)}%`;
  if (!$('player').hidden) drawOrbit();
}

let seeking = false;

function bind() {
  $('file').addEventListener('change', (e) => loadFile(e.target.files[0]));

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });

  $('play').addEventListener('click', () => (state.playing ? pause() : play()));

  const seek = $('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    $('cur').textContent = fmt((seek.value / 1000) * state.buffer.duration);
  });
  seek.addEventListener('change', () => {
    seeking = false;
    seekTo((seek.value / 1000) * state.buffer.duration);
  });

  const slider = (id, key, scale) => $(id).addEventListener('input', (e) => {
    params[key] = Number(e.target.value) * scale;
    applyParams();
    render();
  });
  slider('period', 'period', 1);
  slider('strength', 'strength', 0.01);
  slider('reverb', 'reverb', 0.01);
  slider('height', 'height', 0.01);
  $('hrtf').addEventListener('change', (e) => { params.hrtf = e.target.checked; applyParams(); });

  $('export').addEventListener('click', exportFile);

  const tick = () => { if (state.playing) render(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  render();
}

bind();
