// Steel Men – WebAudio synthesis of one sound patch (data/sounds.json → patches). Retro voices: square / saw / triangle /
// sine / pulse oscillators and white / pink / crunch (8-bit sample & hold) noise, ADSR envelopes, pitch and filter sweeps,
// note sequences (jingles). Audio only – never used by the simulation, so Math.random is fine here.
import { AUDIO } from '../config.js';

const OSC_TYPES = { square: true, sawtooth: true, triangle: true, sine: true };
const PULSE_DUTY = { pulse25: 0.25, pulse12: 0.125 };
const FILTER_TYPES = { lowpass: true, highpass: true, bandpass: true };
// Paul Kellet's pink noise filter (b0..b6 pole / gain pairs) and its output scale
const PINK_POLES = [0.99886, 0.99332, 0.969, 0.8665, 0.55, -0.7616];
const PINK_GAINS = [0.0555179, 0.0750759, 0.153852, 0.3104856, 0.5329522, -0.016898];
const PINK_WHITE_GAIN = 0.5362;
const PINK_LAST_GAIN = 0.115926;
const PINK_SCALE = 0.11;
const SEMITONES_PER_OCTAVE = 12;
const DEFAULT_FREQ = 440;            // Hz, layer without freq
const DEFAULT_OSC_TYPE = 'square';   // unknown oscillator type

let preparedFor = null;                          // AudioContext the buffers / waves belong to
const noiseBuffers = { white: null, pink: null, crunch: null };
const pulseWaves = { pulse25: null, pulse12: null };
const pinkState = new Float64Array(PINK_POLES.length + 1);

/** Builds the noise buffers and pulse waves once per AudioContext (app-wide, reused by every voice) */
export function prepareSynth(ctx) {
  if (preparedFor === ctx) return;
  preparedFor = ctx;
  const length = Math.max(1, Math.round(ctx.sampleRate * AUDIO.noiseSeconds));
  noiseBuffers.white = ctx.createBuffer(1, length, ctx.sampleRate);
  noiseBuffers.pink = ctx.createBuffer(1, length, ctx.sampleRate);
  noiseBuffers.crunch = ctx.createBuffer(1, length, ctx.sampleRate);
  const white = noiseBuffers.white.getChannelData(0);
  const pink = noiseBuffers.pink.getChannelData(0);
  const crunch = noiseBuffers.crunch.getChannelData(0);
  pinkState.fill(0);
  const last = PINK_POLES.length;
  let held = 0;
  for (let i = 0; i < length; i++) {
    const w = Math.random() * 2 - 1;
    white[i] = w;
    let sum = 0;
    for (let k = 0; k < last; k++) { pinkState[k] = PINK_POLES[k] * pinkState[k] + w * PINK_GAINS[k]; sum += pinkState[k]; }
    pink[i] = (sum + pinkState[last] + w * PINK_WHITE_GAIN) * PINK_SCALE;
    pinkState[last] = w * PINK_LAST_GAIN;
    if (i % AUDIO.crunchHoldSamples === 0) held = Math.random() < 0.5 ? -1 : 1; // 1-bit noise like old sound chips
    crunch[i] = held;
  }
  for (const id of Object.keys(PULSE_DUTY)) pulseWaves[id] = pulseWave(ctx, PULSE_DUTY[id]);
}

/** Fourier series of a pulse wave with the given duty cycle (cosine terms only: the phase does not matter to the ear) */
function pulseWave(ctx, duty) {
  const n = AUDIO.pulseHarmonics + 1;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Length of a layer in seconds (from its start, delay excluded) */
function layerLength(L) {
  if (L.notes) {
    let end = 0;
    for (let i = 0; i < L.notes.length; i++) { const n = L.notes[i]; if (n[1] + n[2] > end) end = n[1] + n[2]; }
    return end;
  }
  return (L.a || 0) + (L.d || 0) + (L.st || 0) + (L.r || 0);
}

function sweep(param, from, to, t0, t1, linear) {
  param.setValueAtTime(from, t0);
  if (!(to > 0) || t1 <= t0) return;
  if (linear) param.linearRampToValueAtTime(to, t1);
  else param.exponentialRampToValueAtTime(to, t1);
}

/** Single envelope: attack → decay to sustain → hold → release */
function envelope(g, L, peak, t0) {
  const floor = AUDIO.envFloor;
  const a = L.a || 0, d = L.d || 0, st = L.st || 0, r = L.r || 0;
  const sustain = Math.max(floor, peak * (L.s || 0));
  g.setValueAtTime(floor, t0);
  g.linearRampToValueAtTime(peak, t0 + a);
  g.exponentialRampToValueAtTime(sustain, t0 + a + d);
  if (r > 0) {
    g.setValueAtTime(sustain, t0 + a + d + st);
    g.exponentialRampToValueAtTime(floor, t0 + a + d + st + r);
  }
}

/** Note sequence on one oscillator: each note rises over `a`, holds, falls over `r` before its end */
function notes(osc, g, L, base, peak, t0) {
  const floor = AUDIO.envFloor;
  const a = L.a || 0, r = L.r || 0;
  g.setValueAtTime(floor, t0);
  for (let i = 0; i < L.notes.length; i++) {
    const n = L.notes[i];
    const ns = t0 + n[1];
    const ne = ns + n[2];
    const p = peak * (n.length > 3 ? n[3] : 1);
    osc.frequency.setValueAtTime(base * Math.pow(2, n[0] / SEMITONES_PER_OCTAVE), ns);
    g.setValueAtTime(floor, ns);
    g.linearRampToValueAtTime(p, ns + a);
    const holdEnd = Math.max(ns + a, ne - r);
    g.setValueAtTime(p, holdEnd);
    g.exponentialRampToValueAtTime(floor, ne);
  }
}

/**
 * Schedules all layers of a patch into `dest` starting at audio time t0.
 * voice.addSource(source, endTime) is called for every source (Sound.js tracks the voice end through it).
 * @returns {number} audio time the last layer ends
 */
export function renderPatch(ctx, patch, dest, t0, pitch, voice) {
  const layers = patch.layers;
  const count = Math.min(layers.length, AUDIO.maxLayers);
  let end = t0;
  for (let i = 0; i < count; i++) {
    const e = renderLayer(ctx, layers[i], dest, t0, pitch, voice);
    if (e > end) end = e;
  }
  return end;
}

function renderLayer(ctx, L, dest, t0, pitch, voice) {
  const start = t0 + (L.delay || 0);
  const length = layerLength(L);
  const end = start + length;
  const linear = L.sweep === 'lin';
  const sweepEnd = start + (L.sweepTime || length);
  const peak = L.gain ?? 1;
  let src;
  const noise = noiseBuffers[L.type];
  if (noise) {
    src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const rate = (L.rate || 1) * pitch;
    sweep(src.playbackRate, rate, (L.rateEnd || 0) * pitch, start, sweepEnd, linear);
  } else {
    src = ctx.createOscillator();
    const wave = pulseWaves[L.type];
    if (wave) src.setPeriodicWave(wave);
    else src.type = OSC_TYPES[L.type] ? L.type : DEFAULT_OSC_TYPE;
    if (!L.notes) sweep(src.frequency, (L.freq || DEFAULT_FREQ) * pitch, (L.freqEnd || 0) * pitch, start, sweepEnd, linear);
  }
  const g = ctx.createGain();
  if (L.notes && !noise) notes(src, g.gain, L, (L.freq || DEFAULT_FREQ) * pitch, peak, start);
  else envelope(g.gain, L, peak, start);

  const f = L.filter;
  if (f) {
    const filter = ctx.createBiquadFilter();
    filter.type = FILTER_TYPES[f.type] ? f.type : 'lowpass';
    if (f.q) filter.Q.value = f.q;
    sweep(filter.frequency, f.freq, f.freqEnd || 0, start, start + (f.time || length), false);
    src.connect(filter);
    filter.connect(g);
  } else {
    src.connect(g);
  }
  g.connect(dest);
  if (noise) src.start(start, Math.random() * noise.duration); // random offset: repeated shots never sound identical
  else src.start(start);
  src.stop(end + AUDIO.stopTailSec);
  voice.addSource(src, end + AUDIO.stopTailSec);
  return end;
}
