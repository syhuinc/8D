'use strict';

// How it works: the song is summed to mono and fed through a PannerNode whose
// position is driven by two oscillators (sin for X, -cos for Z), so the sound
// travels in a circle around the listener. A little reverb adds the "room"
// feel typical of 8D tracks. The same graph is used for live preview and for
// the offline render that produces the downloadable WAV.

const $ = (id) => document.getElementById(id);

const params = {
  mode: '8d',     // '8d': the music travels round; 'spatial': it surrounds you, still (see buildSpatialGraph)
  period: 8,      // seconds per full circle
  strength: 1,    // 0 = original stereo, 1 = fully spatialised
  reverb: 0.3,    // wet amount
  height: 0,      // vertical wobble amount
  hrtf: true,
  vocals: true,   // keep the centre (vocal) track still while the rest orbits
  auto: true,     // follow the music: beat-synced orbit, faster in loud parts (auto.js)
  motion: 'scatter', // with the beat: 'circle', 'bounce' (left-right) or 'scatter' (here & there)
  liveAll: false, // Live 8D: one effect on all audio, for apps that don't announce their session
  liveFollow: false, // Live 8D: listen to the music app's sound and move on the beat (needs permission)
  vocalFocus: 0.5, // vocal strictness, see Vocals.extractCenter
  bass: 0,        // low-shelf boost in dB
  format: 'mp3-192',
};

// One-tap combinations of the settings above.
const PRESETS = {
  classic: { label: 'Classic 8D', period: 8, strength: 1, reverb: 0.3, height: 0, bass: 0 },
  dreamy: { label: 'Slow & dreamy', period: 14, strength: 1, reverb: 0.55, height: 0.3, bass: 3 },
  fast: { label: 'Fast spin', period: 4, strength: 1, reverb: 0.15, height: 0, bass: 4 },
  hall: { label: 'Concert hall', period: 10, strength: 0.9, reverb: 0.7, height: 0.1, bass: 2 },
  bass: { label: 'Bass 8D', period: 8, strength: 1, reverb: 0.25, height: 0, bass: 9 },
};

// Settings are remembered between visits (per device): in the Android app
// through its bridge (SharedPreferences), otherwise in localStorage. Storage
// can be unavailable (private mode, blocked storage), so every access is guarded.
const SETTINGS_KEY = '8d-converter.settings';
const SAVED = ['mode', 'period', 'strength', 'reverb', 'height', 'bass', 'hrtf', 'vocals', 'vocalFocus', 'format', 'auto', 'motion', 'liveAll', 'liveFollow'];

function loadSettings() {
  try {
    const raw = window.Android8D && Android8D.loadSettings ? Android8D.loadSettings() : localStorage.getItem(SETTINGS_KEY);
    const saved = JSON.parse(raw || '{}');
    for (const key of SAVED) {
      if (typeof saved[key] === typeof params[key]) params[key] = saved[key];
    }
  } catch (_) { /* keep defaults */ }
}

function saveSettings() {
  const json = JSON.stringify(Object.fromEntries(SAVED.map((k) => [k, params[k]])));
  try {
    if (window.Android8D && Android8D.saveSettings) Android8D.saveSettings(json);
    else localStorage.setItem(SETTINGS_KEY, json);
  } catch (_) { /* not persisted this time */ }
}

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
  vocalBuffer: null,  // mono centre track of the current song (see vocals.js)
  vocalSource: null,
  vocalJob: 0,
  separating: false,
  analysis: null,     // beat and loudness of the current song (auto.js)
  motionAngles: null, // planned orbit angle over time, for the orbit view
  motionBuffer: null, // the planned sound position, played in sync with the song
  motionSource: null,
  analysing: false,
  comparing: false,   // "Compare with original" is held on
};

// ---------- audio graph ----------

function cosineWave(ctx) {
  return new PeriodicWave(ctx, { real: [0, 1], imag: [0, 0] });
}

// Deterministic noise so preview and export use the same reverb.
function makeImpulse(ctx, seconds, decay, channels = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const ir = new AudioBuffer({ numberOfChannels: channels, length: len, sampleRate: ctx.sampleRate });
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let c = 0; c < channels; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < len; i++) data[i] = rand() * Math.pow(1 - i / len, decay);
  }
  return ir;
}

const CROSSFEED = 0.35; // about -9 dB
// The moving music comes out about 3 dB quieter than the song (it is summed
// to mono, and HRTF and the behind-the-head cues take some level), measured
// on stereo pink noise. Made up here, so 8D isn't quieter than the original:
// a quieter version sounds worse side by side even when it isn't.
const EIGHTD_MAKEUP = 1.4; // +2.9 dB
const BASS_SPLIT = 150;  // Hz: below this the bass is panned plainly (see buildGraph)
const BASS_PAN = 0.85;   // how far the bass swings (1 = fully into one ear)

/**
 * Headphone crossfeed for simple left/right panning: a little of each side's
 * low end (below ~700 Hz, 0.3 ms later) leaks into the other ear, as it would
 * from speakers, so the sound never sits entirely in one ear.
 * Not for HRTF: binaural output already contains the far-ear signal, and
 * adding a second copy makes them interfere (at some pitches the sound then
 * appears on the wrong side; the tests caught this).
 * Returns the output node; `bleed` holds the two gains to switch it.
 */
function crossfeed(ctx, source, amount) {
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  const merge = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  merge.bleed = [];
  source.connect(split);
  for (const [from, to] of [[0, 1], [1, 0]]) {
    split.connect(merge, from, from); // direct
    const filter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 700, Q: 0.5 });
    const level = new GainNode(ctx, { gain: amount });
    split.connect(filter, from);
    filter.connect(new DelayNode(ctx, { delayTime: 0.0003 })).connect(level).connect(merge, 0, to);
    merge.bleed.push(level);
  }
  return merge;
}

function buildGraph(ctx, p) {
  if (p.mode === 'spatial') return buildSpatialGraph(ctx, p);
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
  // Start in the right mode: an export builds a fresh graph and never sees applyParams.
  const auto = autoActive();
  const gainX = new GainNode(ctx, { gain: auto ? 0 : 1 });
  const gainZ = new GainNode(ctx, { gain: auto ? 0 : -1 });
  const gainY = new GainNode(ctx, { gain: auto ? 0 : p.height });
  // z (front -1 .. back +1) from either source is summed here: it positions the
  // panner and also drives the behind-the-head cues below.
  const zBus = new GainNode(ctx);
  const xBus = new GainNode(ctx);
  oscX.connect(gainX).connect(xBus);
  xBus.connect(panner.positionX);
  oscZ.connect(gainZ).connect(zBus);
  oscY.connect(gainY).connect(panner.positionY);
  zBus.connect(panner.positionZ);

  // "Follow the music": a 3-channel motion track (x, y, z; see auto.js)
  // drives the position instead, while the oscillators are muted.
  const motionIn = new ChannelSplitterNode(ctx, { numberOfOutputs: 3 });
  const motionY = new GainNode(ctx, { gain: auto ? p.height : 0 });
  motionIn.connect(xBus, 0);
  motionIn.connect(motionY, 1).connect(panner.positionY);
  motionIn.connect(zBus, 2);

  const spatial = new GainNode(ctx, { gain: p.strength * EIGHTD_MAKEUP });
  const original = new GainNode(ctx, { gain: 1 - p.strength });
  const bus = new GainNode(ctx);
  // Through headphones front and back sound alike, so a circle is heard as a
  // left-right swing. Real 8D mixes fix that with distance cues: behind the
  // head the sound gets muffled and a little quieter. The filter opens to
  // 18.5 kHz in front and closes to 3.5 kHz behind; the level dips 3 dB.
  const behindFilter = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 11000, Q: 0.5 });
  zBus.connect(new GainNode(ctx, { gain: -7500 })).connect(behindFilter.frequency);
  const behindLevel = new GainNode(ctx, { gain: 0.85 });
  zBus.connect(new GainNode(ctx, { gain: -0.15 })).connect(behindLevel.gain);
  // Bass below ~150 Hz hardly moves through HRTF (the head barely shadows
  // it), so it is split off and panned plainly left-right by the same
  // position: the bass travels with the music. 4th-order crossover.
  const lows = [0, 1].reduce((n) => n.connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: BASS_SPLIT, Q: Math.SQRT1_2 })), mono);
  const highs = [0, 1].reduce((n) => n.connect(new BiquadFilterNode(ctx, { type: 'highpass', frequency: BASS_SPLIT, Q: Math.SQRT1_2 })), mono);
  const bassPan = new StereoPannerNode(ctx, { pan: 0 });
  xBus.connect(new GainNode(ctx, { gain: BASS_PAN })).connect(bassPan.pan);
  input.connect(mono);
  highs.connect(panner).connect(behindFilter).connect(behindLevel);
  const crossed = crossfeed(ctx, behindLevel, p.hrtf ? 0 : CROSSFEED);
  crossed.connect(spatial);
  lows.connect(bassPan).connect(spatial);
  spatial.connect(bus);
  input.connect(original).connect(bus);

  // Vocals mode: the centre track plays in sync with the song. It is
  // subtracted from what orbits and sent straight to the middle instead.
  const vocalIn = new GainNode(ctx);
  const vocal = new GainNode(ctx, { gain: p.strength });
  vocalIn.connect(new GainNode(ctx, { gain: -1 })).connect(mono);
  vocalIn.connect(vocal);

  const dry = new GainNode(ctx, { gain: 1 - p.reverb * 0.4 });
  const wet = new GainNode(ctx, { gain: p.reverb });
  const convolver = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 2.8, 2.5) });
  const master = new GainNode(ctx);
  bus.connect(dry).connect(master);
  bus.connect(convolver).connect(wet).connect(master);
  // Bass boost, then a limiter so boosted peaks don't clip during playback.
  const bass = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 120, gain: p.bass });
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
  master.connect(bass).connect(limiter);
  const out = outputStage(ctx, input, limiter);

  // The voice gets a mono reverb: the stereo one is louder in one ear at some
  // pitches (random-noise impulse), which would pull sung notes off-centre.
  const vocalDry = new GainNode(ctx, { gain: 1 - p.reverb * 0.4 });
  const vocalWet = new GainNode(ctx, { gain: p.reverb });
  vocal.connect(vocalDry).connect(master);
  vocal.connect(new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 2.8, 2.5, 1) })).connect(vocalWet).connect(master);

  return {
    input, vocalIn, motionIn, panner, oscillators: [oscX, oscZ, oscY], gainX, gainZ, gainY, motionY, spatial, vocal, original, dry, wet, vocalDry, vocalWet, bass, bleed: crossed.bleed,
    ...out,
    start(when) { this.oscillators.forEach((o) => o.start(when)); },
    stop() { this.oscillators.forEach((o) => o.stop()); },
  };
}

/**
 * The end of both graphs. "Compare with original" crossfades from the
 * processed sound to the song exactly as it is (the effects keep running,
 * so switching back is instant). `output` is what gets disconnected when
 * the graph is replaced.
 */
function outputStage(ctx, input, processed) {
  const output = new GainNode(ctx);
  const effect = new GainNode(ctx, { gain: 1 });
  const bypass = new GainNode(ctx, { gain: 0 });
  processed.connect(effect).connect(output);
  input.connect(bypass).connect(output);
  output.connect(ctx.destination);
  return {
    output,
    compare(on, when) {
      effect.gain.setTargetAtTime(on ? 0 : 1, when, 0.015);
      bypass.gain.setTargetAtTime(on ? 1 : 0, when, 0.015);
    },
  };
}

// ---------- spatial mode ----------

// Virtual speakers around the listener: [azimuth°, elevation°], 0° = front, + = right.
// A 7.1.2-style layout. Each is rendered through HRTF, so on headphones the
// music seems to come from speakers in a room rather than from inside the head.
const SPEAKERS = {
  C: [0, 0], FL: [-30, 0], FR: [30, 0], SL: [-100, 0], SR: [100, 0],
  RL: [-145, 0], RR: [145, 0], TL: [-60, 50], TR: [60, 50],
};
const SPATIAL_AMBIENCE = 0.5; // how loud the side speakers' wall reflections are
const SPATIAL_HEIGHT = 1.5;   // height speakers' level at "Height" 100%
const SPATIAL_TRIM = 0.5;     // the speakers add up louder than the song; this matches the loudness

/**
 * Spatial mode, an upmix of the stereo song in the spirit of surround
 * upmixers, then binaural rendering:
 * - the voice (vocals mode's centre track) goes to the centre speaker;
 * - the rest of the left and right channels go to the front speakers at ±30°;
 * - the side speakers repeat each side a little later, like reflections off
 *   the walls of a room;
 * - the room echo comes from the rear speakers, and the treble from the
 *   height speakers ("Height").
 * Nothing moves. The bass below 150 Hz bypasses the speakers as plain stereo:
 * HRTF thins it out and it carries no direction anyway.
 * Same interface as the 8D graph (input, vocalIn, motionIn, output).
 */
function buildSpatialGraph(ctx, p) {
  const model = p.hrtf ? 'HRTF' : 'equalpower';
  const input = new GainNode(ctx);
  const spatial = new GainNode(ctx, { gain: p.strength });
  const original = new GainNode(ctx, { gain: 1 - p.strength });
  const master = new GainNode(ctx);
  const panners = [];
  const trim = new GainNode(ctx, { gain: SPATIAL_TRIM });
  const speaker = (name) => {
    const [az, el] = SPEAKERS[name].map((d) => (d * Math.PI) / 180);
    const panner = new PannerNode(ctx, {
      panningModel: model, distanceModel: 'linear', rolloffFactor: 0,
      // The listener faces -Z.
      positionX: Math.sin(az) * Math.cos(el), positionY: Math.sin(el), positionZ: -Math.cos(az) * Math.cos(el),
    });
    panner.connect(spatial);
    panners.push(panner);
    return panner;
  };
  const filter = (type, frequency) => new BiquadFilterNode(ctx, { type, frequency, Q: Math.SQRT1_2 });
  const steep = (node, type, frequency) => node.connect(filter(type, frequency)).connect(filter(type, frequency));

  // The music: the song minus the voice when vocals mode is on (the centre
  // track is the same in both channels, so it is subtracted from both).
  const vocalIn = new GainNode(ctx);
  const music = new GainNode(ctx, { channelCount: 2, channelCountMode: 'explicit' });
  input.connect(music);
  vocalIn.connect(new GainNode(ctx, { gain: -1 })).connect(music);
  const lows = new GainNode(ctx, { gain: p.strength }); // not trimmed: it doesn't pass the speakers
  steep(music, 'lowpass', BASS_SPLIT).connect(lows).connect(master);
  const highs = steep(music, 'highpass', BASS_SPLIT);
  const [left, right] = [0, 1].map(() => new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' }));
  const split = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  highs.connect(split);
  split.connect(left, 0);
  split.connect(right, 1);
  left.connect(speaker('FL'));
  right.connect(speaker('FR'));

  // Side speakers: each side's channel again, 15 ms later and softened above
  // 7 kHz, like a reflection off that side's wall. (Feeding them the
  // left-minus-right difference, as some upmixers do, sent an inverted copy
  // of right-hand sounds out of the left side: a sustained piano note mixed
  // right then sounded centred. The tests caught it.)
  for (const [channel, name] of [[left, 'SL'], [right, 'SR']]) {
    channel.connect(filter('lowpass', 7000)).connect(new DelayNode(ctx, { delayTime: 0.015 }))
      .connect(new GainNode(ctx, { gain: SPATIAL_AMBIENCE })).connect(speaker(name));
  }

  // Height speakers: the treble above 4 kHz, a little later, from above.
  const height = new GainNode(ctx, { gain: p.height * SPATIAL_HEIGHT });
  const air = steep(highs, 'highpass', 4000).connect(new DelayNode(ctx, { delayTime: 0.006 })).connect(height);
  const airSplit = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  air.connect(airSplit);
  airSplit.connect(speaker('TL'), 0);
  airSplit.connect(speaker('TR'), 1);

  // The voice: centre speaker.
  const vocal = new GainNode(ctx, { gain: p.strength });
  vocalIn.connect(vocal).connect(speaker('C'));

  // The room: a short, early-starting echo of everything, from behind.
  // The voice's echo is mono and goes to both rear speakers equally, so it
  // can't pull the voice to one side (see the 8D graph's vocal reverb).
  const room = new GainNode(ctx, { gain: p.reverb * 0.8 });
  const predelay = new DelayNode(ctx, { delayTime: 0.02 });
  highs.connect(predelay);
  const musicRoom = predelay.connect(new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 1.8, 3) }));
  const roomSplit = new ChannelSplitterNode(ctx, { numberOfOutputs: 2 });
  musicRoom.connect(room).connect(roomSplit);
  const [rl, rr] = [speaker('RL'), speaker('RR')];
  roomSplit.connect(rl, 0);
  roomSplit.connect(rr, 1);
  const vocalRoom = new GainNode(ctx, { gain: p.reverb * 0.8 });
  vocalIn.connect(new DelayNode(ctx, { delayTime: 0.02 }))
    .connect(new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 1.8, 3, 1) })).connect(vocalRoom);
  vocalRoom.connect(rl);
  vocalRoom.connect(rr);

  spatial.connect(trim).connect(master);
  input.connect(original).connect(master);
  const bass = new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 120, gain: p.bass });
  const limiter = new DynamicsCompressorNode(ctx, { threshold: -1, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });
  master.connect(bass).connect(limiter);

  return {
    input, vocalIn, motionIn: new GainNode(ctx), ...outputStage(ctx, input, limiter),
    start() {}, stop() {},
    apply(q, smooth) {
      smooth(spatial.gain, q.strength);
      smooth(lows.gain, q.strength);
      smooth(vocal.gain, q.strength);
      smooth(original.gain, 1 - q.strength);
      smooth(height.gain, q.height * SPATIAL_HEIGHT);
      smooth(room.gain, q.reverb * 0.8);
      smooth(vocalRoom.gain, q.reverb * 0.8);
      smooth(bass.gain, q.bass);
      for (const panner of panners) panner.panningModel = q.hrtf ? 'HRTF' : 'equalpower';
    },
  };
}

/** Switching between 8D and Spatial builds the other graph, and keeps playing. */
function rebuildGraph() {
  const ctx = state.ctx;
  if (!ctx) return;
  const old = state.graph;
  state.graph = buildGraph(ctx, params);
  state.graph.start(ctx.currentTime);
  state.orbit = { basePhase: 0, baseTime: ctx.currentTime, freq: 1 / params.period };
  if (state.comparing) state.graph.compare(true, ctx.currentTime);
  if (state.playing) startSource(position());
  old.output.disconnect();
  old.stop();
}

/** "Compare with original": hear the song as it is, at the same position, then switch back. */
function setComparing(on) {
  state.comparing = on;
  if (state.graph) state.graph.compare(on, state.ctx.currentTime);
  render();
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
  if (g.apply) { g.apply(params, smooth); return; }

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
  const auto = autoActive();
  smooth(g.gainX.gain, auto ? 0 : 1);
  smooth(g.gainZ.gain, auto ? 0 : -1);
  smooth(g.gainY.gain, auto ? 0 : params.height);
  smooth(g.motionY.gain, auto ? params.height : 0);
  smooth(g.spatial.gain, params.strength * EIGHTD_MAKEUP);
  smooth(g.vocal.gain, params.strength);
  smooth(g.original.gain, 1 - params.strength);
  smooth(g.dry.gain, 1 - params.reverb * 0.4);
  smooth(g.wet.gain, params.reverb);
  smooth(g.vocalDry.gain, 1 - params.reverb * 0.4);
  smooth(g.vocalWet.gain, params.reverb);
  smooth(g.bass.gain, params.bass);
  g.panner.panningModel = params.hrtf ? 'HRTF' : 'equalpower';
  for (const level of g.bleed) smooth(level.gain, params.hrtf ? 0 : CROSSFEED);
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
  if (params.vocals && state.vocalBuffer) {
    state.vocalSource = new AudioBufferSourceNode(ctx, { buffer: state.vocalBuffer });
    state.vocalSource.connect(state.graph.vocalIn);
    state.vocalSource.start(ctx.currentTime, offset); // same instant as the song: sample-aligned
  }
  if (autoActive()) {
    state.motionSource = new AudioBufferSourceNode(ctx, { buffer: state.motionBuffer });
    state.motionSource.connect(state.graph.motionIn);
    state.motionSource.start(ctx.currentTime, offset);
  }
}

function stopSource() {
  if (!state.source) return;
  state.sourceToken++;
  for (const src of [state.source, state.vocalSource, state.motionSource]) {
    if (!src) continue;
    try { src.stop(); } catch (_) { /* already stopped */ }
    src.disconnect();
  }
  state.source = null;
  state.vocalSource = null;
  state.motionSource = null;
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
    state.vocalBuffer = null;
    state.analysis = null;
    state.motionAngles = null;
    state.motionBuffer = null;
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'song';
    state.offset = 0;
    $('dropTitle').textContent = file.name;
    $('dropHint').textContent = 'Tap to choose a different song';
    $('player').hidden = false;
    $('dur').textContent = fmt(buffer.duration);
    setStatus('');
    render();
    await prepareAuto();
    if (params.vocals) await prepareVocals();
  } catch (err) {
    console.error(err);
    setStatus("Couldn't read that file. Your browser may not support this audio format — try MP3 or WAV.");
  }
}

// ---------- follow the music (auto.js) ----------

function autoActive() {
  return params.mode !== 'spatial' && params.auto && !!state.motionBuffer;
}

/** Analyse the current song's beat and loudness (once), then plan the orbit. */
async function prepareAuto() {
  if (!params.auto || params.mode === 'spatial' || !state.buffer) { renderAutoNote(); return; }
  const buffer = state.buffer;
  if (!state.analysis) {
    state.analysing = true;
    render();
    try {
      const analysis = await Auto.analyse(buffer, (f) => setStatus(`Listening to the beat… ${Math.round(f * 100)}%`));
      if (buffer !== state.buffer) return; // another song was loaded meanwhile
      state.analysis = analysis;
      setStatus('');
    } finally {
      state.analysing = false;
    }
  }
  planOrbit();
}

/** (Re)build the orbit from the analysis and the current orbit time. */
function planOrbit() {
  const plan = Auto.plan(state.analysis, params.period, params.motion);
  state.motionAngles = Auto.angles(plan, state.buffer.duration);
  state.motionBuffer = Auto.motionBuffer(state.motionAngles, state.buffer.duration);
  state.autoText = Auto.describe(plan, params.motion);
  applyParams();
  if (state.playing) startSource(position()); // pick up the new orbit right away
  renderAutoNote();
  render();
}

function renderAutoNote() {
  $('autoNote').textContent = !params.auto ? ''
    : state.motionBuffer ? state.autoText
    : 'Load a song: the orbit will sync to its beat and speed up in loud parts.';
}

// ---------- vocals mode ----------

const VOCALS_HINT = 'Works on stereo songs. Other sounds mixed dead-center, often snare or lead guitar, stay in the middle with the voice.';

async function prepareVocals() {
  const buffer = state.buffer;
  const job = ++state.vocalJob;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  state.separating = true;
  render();
  try {
    const centre = await Vocals.extractCenter(left, right, buffer.sampleRate, (f) => {
      if (job === state.vocalJob) setStatus(`Finding the vocals… ${Math.round(f * 100)}%`);
    }, { focus: params.vocalFocus });
    if (job !== state.vocalJob) return; // a newer song or request took over
    const vb = new AudioBuffer({ numberOfChannels: 1, length: buffer.length, sampleRate: buffer.sampleRate });
    vb.copyToChannel(centre, 0);
    state.vocalBuffer = vb;
    $('vocalsNote').textContent = isMono(left, right)
      ? "This song is mono (both ears identical), so the voice can't be separated: only bass and cymbals will move."
      : VOCALS_HINT;
    setStatus('');
    if (state.playing && params.vocals) startSource(position());
  } finally {
    if (job === state.vocalJob) state.separating = false;
    render();
  }
}

function isMono(left, right) {
  let side = 0, mid = 0;
  for (let i = 0; i < left.length; i += 16) {
    side += (left[i] - right[i]) ** 2;
    mid += (left[i] + right[i]) ** 2;
  }
  return side < mid * 1e-4;
}

// ---------- live 8D (Android app only) ----------

// Friendly names for common music apps; anything else shows its package name.
const APP_NAMES = {
  'com.spotify.music': 'Spotify', 'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.youtube': 'YouTube', 'deezer.android.app': 'Deezer',
  'com.amazon.mp3': 'Amazon Music', 'com.soundcloud.android': 'SoundCloud',
  'com.maxmpz.audioplayer': 'Poweramp', 'com.apple.android.music': 'Apple Music', 'all audio': 'all audio',
};

function liveAvailable() {
  try { return !!(window.Android8D && Android8D.liveSupported && Android8D.liveSupported()); } catch (_) { return false; }
}

function renderLive() {
  let status;
  try { status = JSON.parse(Android8D.liveStatus()); } catch (_) { return; }
  $('liveToggle').textContent = status.running ? 'Stop live 8D' : 'Start live 8D';
  $('liveToggle').setAttribute('aria-pressed', String(status.running));
  const beat = status.follow && status.follow.onBeat ? ` · on the beat (${status.follow.bpm} BPM)` : '';
  $('liveStatus').textContent = !status.running ? 'Off'
    : status.apps.length ? `On: ${status.apps.map((p) => APP_NAMES[p] || p).join(', ')}${beat}`
    : 'On: now press play in your music app';
  const log = $('liveLog');
  const lines = status.log || [];
  if (log.dataset.shown !== lines.join('\n')) {
    log.dataset.shown = lines.join('\n');
    log.replaceChildren(...(lines.length ? lines : ['Nothing yet.']).map((l) => Object.assign(document.createElement('li'), { textContent: l })));
  }
}

// "Follow the song" needs Android's record-audio permission, asked for when it is switched on.
function canListen() {
  try { return !!(Android8D.canListen && Android8D.canListen()); } catch (_) { return false; }
}

function bindLiveFollow() {
  const box = $('liveFollow'), note = $('liveFollowNote');
  const intro = note.textContent;
  box.checked = params.liveFollow && canListen();
  let refusedForGood = false; // Android stops asking after two refusals; then only Settings can allow it
  const set = (on) => { params.liveFollow = on; box.checked = on; saveSettings(); };
  window.__android8dListen = (granted, askable) => {
    if (granted) { note.textContent = intro; set(true); return; }
    set(false);
    refusedForGood = !askable;
    note.textContent = askable
      ? 'Not allowed, so Live 8D circles on its own. Tick the box to be asked again.'
      : 'Not allowed, and Android won\'t ask again. Tick the box to open Settings, allow Microphone under Permissions, then come back and tick it.';
  };
  box.addEventListener('change', () => {
    if (!box.checked) { set(false); return; }
    if (canListen()) { note.textContent = intro; set(true); return; }
    box.checked = false; // until Android says yes
    if (refusedForGood && Android8D.openAppSettings) Android8D.openAppSettings();
    else Android8D.requestListen();
  });
}

function bindLive() {
  if (!liveAvailable()) return;
  $('live').hidden = false;
  $('liveAll').checked = params.liveAll;
  $('liveAll').addEventListener('change', (e) => { params.liveAll = e.target.checked; saveSettings(); });
  bindLiveFollow();
  $('liveToggle').addEventListener('click', () => {
    let running = false;
    try { running = JSON.parse(Android8D.liveStatus()).running; } catch (_) { /* treat as off */ }
    if (running) Android8D.liveStop(); else Android8D.liveStart();
    setTimeout(renderLive, 300);
  });
  renderLive();
  setInterval(renderLive, 1000);
}

// ---------- export ----------

// Sample rates an MP3 (MPEG-1/2) stream can carry.
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

async function exportFile() {
  const b = state.buffer;
  if (!b) return;
  const [format, kbps] = params.format.split('-');
  const btn = $('export');
  exporting = true;
  btn.disabled = true;
  setStatus(`Rendering ${modeName()} version… (this can take a little while for long songs)`);
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
    if (params.vocals && state.vocalBuffer) {
      const vocalSrc = new AudioBufferSourceNode(off, { buffer: state.vocalBuffer });
      vocalSrc.connect(g.vocalIn);
      vocalSrc.start(0);
    }
    if (autoActive()) {
      const motionSrc = new AudioBufferSourceNode(off, { buffer: state.motionBuffer });
      motionSrc.connect(g.motionIn);
      motionSrc.start(0);
    }
    const rendered = await off.startRendering();
    normalise(rendered, 0.98);
    const blob = format === 'mp3'
      ? await encodeMp3(rendered, Number(kbps), (f) => setStatus(`Encoding MP3… ${Math.round(f * 100)}%`))
      : encodeWav(rendered);
    const saved = await download(blob, `${state.fileName} (${modeName()}).${format}`);
    setStatus(saved ? `Done — ${(blob.size / 1048576).toFixed(1)} MB ${format.toUpperCase()} saved.` : 'Save cancelled.');
  } catch (err) {
    console.error(err);
    setStatus('Export failed: ' + (err && err.message ? err.message : err) + '. Long songs can run out of memory on phones.');
  } finally {
    exporting = false;
    render();
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

async function download(blob, name) {
  if (window.Android8D) return saveWithAndroid(blob, name);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

// The Android app's WebView can't download blob: URLs, so it exposes a bridge
// (android/app/src/main/java/.../MainActivity.java). The file goes over in
// base64 chunks, then Android shows its "Save as" screen. Resolves to false
// if the user cancels.
async function saveWithAndroid(blob, name) {
  const bridge = window.Android8D;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bridge.begin(name, blob.type)) throw new Error('could not create the file');
  const chunk = 3 * 256 * 1024; // multiple of 3 so each base64 piece decodes on its own
  for (let i = 0; i < bytes.length; i += chunk) {
    if (!bridge.append(toBase64(bytes.subarray(i, i + chunk)))) throw new Error('could not write the file');
  }
  return new Promise((resolve) => {
    window.__android8dSaved = (ok) => { window.__android8dSaved = null; resolve(ok); };
    bridge.finish();
  });
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- UI ----------

const modeName = () => (params.mode === 'spatial' ? 'Spatial' : '8D');
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const setStatus = (msg) => { $('status').textContent = msg; };

function orbitAngle() {
  if (autoActive()) return Auto.angleAt(state.motionAngles, position());
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
  g.globalAlpha = 1;
  const c = size / 2, r = 76;

  g.strokeStyle = line; g.lineWidth = 2;
  g.beginPath(); g.arc(c, c, r, 0, Math.PI * 2); g.stroke();

  // head seen from above, nose pointing forward (up)
  g.fillStyle = text;
  g.beginPath(); g.arc(c, c, 14, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(c - 5, c - 12); g.lineTo(c, c - 21); g.lineTo(c + 5, c - 12); g.fill();
  g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
  g.fillText('front', c, 12);

  g.globalAlpha = state.comparing ? 0.25 : 1; // the effect is bypassed while comparing
  if (params.vocals && state.vocalBuffer) {
    // The voice stays put in the middle; only the music travels round.
    g.strokeStyle = css.getPropertyValue('--accent'); g.lineWidth = 3;
    g.beginPath(); g.arc(c, c, 24, 0, Math.PI * 2); g.stroke();
    g.fillStyle = css.getPropertyValue('--accent');
    g.fillText('voice', c, c + 40);
  }

  if (params.mode === 'spatial') {
    // Still: the virtual speakers around the head; height speakers drawn hollow.
    for (const [name, [az, el]] of Object.entries(SPEAKERS)) {
      if (name === 'C' && !(params.vocals && state.vocalBuffer)) continue;
      if (el && !params.height) continue;
      const a = (az * Math.PI) / 180, d = r * (el ? 0.55 : 1) * (0.4 + 0.6 * params.strength);
      g.fillStyle = dot; g.strokeStyle = dot; g.lineWidth = 2;
      g.beginPath(); g.arc(c + Math.sin(a) * d, c - Math.cos(a) * d, 7, 0, Math.PI * 2);
      if (el) g.stroke(); else g.fill();
    }
    return;
  }
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
  $('export').disabled = !state.buffer || state.separating || state.analysing || exporting;
  const spatialMode = params.mode === 'spatial';
  $('orbitControls').hidden = spatialMode;
  $('heightName').textContent = spatialMode ? 'Height (sound from above)' : 'Height wobble';
  $('modeNote').textContent = spatialMode
    ? 'Like sitting among speakers: voice in front, music around and above you. A still, room-like sound made from the stereo song. Use headphones.'
    : '';
  $('export').textContent = `Download ${modeName()} version`;
  $('compare').setAttribute('aria-pressed', String(state.comparing));
  $('compare').textContent = state.comparing ? `Hearing the original · tap for ${modeName()}` : 'Compare with original';
  $('orbit').setAttribute('aria-label', spatialMode ? 'Where the virtual speakers are, seen from above' : 'Sound position, seen from above');
  $('periodOut').textContent = autoActive() ? `target ${params.period}s` : `${params.period}s per circle`;
  $('motion').disabled = !params.auto;
  $('strengthOut').textContent = `${Math.round(params.strength * 100)}%`;
  $('reverbOut').textContent = `${Math.round(params.reverb * 100)}%`;
  $('heightOut').textContent = `${Math.round(params.height * 100)}%`;
  $('bassOut').textContent = params.bass ? `+${params.bass} dB` : 'off';
  $('vocalFocusOut').textContent = params.vocalFocus < 0.34 ? 'loose' : params.vocalFocus > 0.66 ? 'strict' : 'balanced';
  $('vocalFocusRow').hidden = !params.vocals;
  const active = Object.keys(PRESETS).find((k) => matchesPreset(PRESETS[k]));
  for (const b of document.querySelectorAll('[data-preset]')) b.setAttribute('aria-pressed', String(b.dataset.preset === active));
  if (!$('player').hidden) drawOrbit();
}

let seeking = false;
let exporting = false;

function matchesPreset(preset) {
  return ['period', 'strength', 'reverb', 'height', 'bass'].every((k) => Math.abs(params[k] - preset[k]) < 1e-6);
}

/** Put the current params into the form controls (after loading settings or a preset). */
function syncControls() {
  $('period').value = params.period;
  $('strength').value = Math.round(params.strength * 100);
  $('reverb').value = Math.round(params.reverb * 100);
  $('height').value = Math.round(params.height * 100);
  $('bass').value = params.bass;
  $('vocalFocus').value = Math.round(params.vocalFocus * 100);
  $('hrtf').checked = params.hrtf;
  $('vocals').checked = params.vocals;
  $('auto').checked = params.auto;
  $('motion').value = params.motion;
  $('mode').value = params.mode;
  $('format').value = params.format;
}

function bind() {
  $('file').addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = ''; // so picking the same file again still fires 'change'
  });

  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  });

  $('play').addEventListener('click', () => (state.playing ? pause() : play()));
  $('compare').addEventListener('click', () => setComparing(!state.comparing));

  const seek = $('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    $('cur').textContent = fmt((seek.value / 1000) * state.buffer.duration);
  });
  seek.addEventListener('change', () => {
    seeking = false;
    seekTo((seek.value / 1000) * state.buffer.duration);
  });

  const slider = (id, key, scale) => {
    $(id).addEventListener('input', (e) => {
      params[key] = Number(e.target.value) * scale;
      applyParams();
      render();
    });
    $(id).addEventListener('change', saveSettings); // once per drag, on release
  };
  slider('period', 'period', 1);
  $('period').addEventListener('change', () => { if (autoActive()) planOrbit(); });
  $('mode').addEventListener('change', async (e) => {
    params.mode = e.target.value;
    saveSettings();
    rebuildGraph();
    render();
    if (params.mode !== 'spatial') await prepareAuto(); // plan the orbit if that was skipped
    else renderAutoNote();
  });
  $('motion').addEventListener('change', (e) => {
    params.motion = e.target.value;
    saveSettings();
    if (autoActive()) planOrbit();
  });
  $('auto').addEventListener('change', async (e) => {
    params.auto = e.target.checked;
    saveSettings();
    if (params.auto) await prepareAuto();
    applyParams();
    if (state.playing) startSource(position());
    renderAutoNote();
    render();
  });
  slider('strength', 'strength', 0.01);
  slider('reverb', 'reverb', 0.01);
  slider('height', 'height', 0.01);
  slider('bass', 'bass', 1);
  $('hrtf').addEventListener('change', (e) => { params.hrtf = e.target.checked; applyParams(); saveSettings(); });
  $('format').addEventListener('change', (e) => { params.format = e.target.value; saveSettings(); });
  $('vocals').addEventListener('change', async (e) => {
    params.vocals = e.target.checked;
    saveSettings();
    render();
    if (!state.buffer) return;
    if (params.vocals && !state.vocalBuffer) await prepareVocals();
    else if (state.playing) startSource(position());
    render();
  });
  // Strictness changes the separation itself, so redo it once the slider is released.
  $('vocalFocus').addEventListener('input', (e) => { params.vocalFocus = Number(e.target.value) / 100; render(); });
  $('vocalFocus').addEventListener('change', async () => {
    saveSettings();
    if (!state.buffer || !params.vocals) return;
    state.vocalBuffer = null;
    if (state.playing) startSource(position()); // keep playing (without vocals mode) meanwhile
    await prepareVocals();
  });

  const presets = $('presets');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.preset = key;
    b.textContent = preset.label;
    b.addEventListener('click', () => {
      for (const k of ['period', 'strength', 'reverb', 'height', 'bass']) params[k] = preset[k];
      syncControls();
      applyParams();
      saveSettings();
      if (autoActive()) planOrbit(); // new orbit time: re-fit it to the beat
      render();
    });
    presets.appendChild(b);
  }

  $('export').addEventListener('click', exportFile);

  loadSettings();
  syncControls();
  bindLive();

  const tick = () => { if (state.playing) render(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  render();
}

bind();
