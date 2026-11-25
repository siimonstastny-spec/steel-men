// Steel Men – sound engine. Game code calls play('shotCannon', { position }) – nothing else is needed.
// Events come from data/sounds.json → events: each is synthesized (Synth.js patch) or played from a file; switching an event
// to a file is a data change only. Unknown events are silent. Audio only: never touches the simulation (no world.rng, no state).
// Mix: master (→ limiter → speakers) ← effects / ui / music buses, volumes from Profile settings.audio.
// Limits: AUDIO.maxVoices simultaneous voices (quietest × lowest priority is stolen), per-event cap and re-trigger window.
import { AUDIO, SETTINGS_DEFAULTS } from '../config.js';
import { getSettings } from '../core/Profile.js';
import { prepareSynth, renderPatch } from './Synth.js';

const CATEGORIES = ['effects', 'ui'];
const MS_PER_SEC = 1000;     // no shared constant in config.js (Graphics.js keeps its own private one)
let playErrorReported = false; // play() failures are logged once

let ctx = null;              // the one AudioContext (created on the first user gesture)
let master = null;           // GainNode → compressor → destination
let compressor = null;
const buses = { effects: null, ui: null, music: null };

let data = null;             // data/sounds.json
let dataPromise = null;
const events = new Map();    // eventName -> EventState (aliases share the target's state)

const fileBuffers = new Map();   // file -> AudioBuffer
const fileLoading = new Map();   // file -> Promise<AudioBuffer|null>
const fileMissing = new Set();   // files that failed once – not retried

let listener = null;         // { x, y?, z } – where the player "hears" from (camera target)
let listenerRight = null;    // optional { x, z } camera right vector for stereo pan (world x when missing)
let muted = false;           // [J1] restoring a saved game / MP catch-up: event sounds are skipped

let musicTrack = null;       // requested track (also before unlock)
let musicSource = null;

const voices = [];           // Voice pool (AUDIO.maxVoices), built with the context
let weakScore = 0;          // score of the voice weakestVoice() returned last
let gestureInstalled = false;

/** Per event: data + re-trigger window + active voice count */
class EventState {
  constructor(name, entry, patches) {
    this.name = name;
    this.patch = entry.synth ? patches?.[entry.synth] ?? null : null;
    this.file = entry.file || null;
    this.category = CATEGORIES.includes(entry.category) ? entry.category : AUDIO.defaultCategory;
    this.gain = entry.gain ?? 1;
    this.priority = entry.priority ?? 1;
    this.minInterval = (entry.minIntervalMs ?? AUDIO.defaultMinIntervalMs) / MS_PER_SEC;
    this.maxPerEvent = entry.maxPerEvent ?? AUDIO.defaultMaxPerEvent;
    this.pitchVar = this.patch?.pitchVar ?? AUDIO.defaultPitchVar;
    this.gainVar = this.patch?.gainVar ?? AUDIO.defaultGainVar;
    this.reset();
  }
  reset() { this.lastTime = -Infinity; this.lastVoice = null; this.active = 0; }
}

/** One playing sound: its output node and sources. Pooled – handlers are bound once. */
class Voice {
  constructor() {
    this.active = false;
    this.state = null;
    this.output = null;
    this.panner = null;
    this.sources = new Array(AUDIO.maxLayers).fill(null);
    this.count = 0;
    this.endSource = null;
    this.start = 0;
    this.end = 0;
    this.score = 0;
    this.baseGain = 0;
    this.boost = 1;
    this.onEnded = (e) => { if (this.active && e.target === this.endSource) releaseVoice(this, true); };
  }
  /** Called by Synth.renderPatch for every source it starts */
  addSource(src, endTime) {
    if (this.count < this.sources.length) this.sources[this.count++] = src;
    src.onended = this.onEnded;
    if (endTime >= this.end) { this.end = endTime; this.endSource = src; }
  }
}

// ---------- context / unlock ----------

function noop() {}

function onGesture() { unlockAudio(); }

function removeGestureListeners() {
  if (!gestureInstalled) return;
  gestureInstalled = false;
  window.removeEventListener('pointerdown', onGesture, true);
  window.removeEventListener('keydown', onGesture, true);
}

function onResumed() { if (ctx && ctx.state === 'running') removeGestureListeners(); }

/**
 * Creates (first call) and resumes the AudioContext. Call from a user gesture; a one-time pointerdown/keydown listener
 * does it automatically. Before this, play() is a silent no-op. @returns {AudioContext|null}
 */
export function unlockAudio() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { removeGestureListeners(); return null; }
    ctx = new Ctor();
    buildGraph();
    prepareSynth(ctx);
    for (let i = 0; i < AUDIO.maxVoices; i++) voices.push(new Voice());
    refreshVolumes();
    if (musicTrack) startMusic(musicTrack);
  }
  if (ctx.state === 'running') removeGestureListeners();
  else ctx.resume().then(onResumed, noop);
  return ctx;
}

function buildGraph() {
  const c = AUDIO.compressor;
  compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = c.threshold;
  compressor.knee.value = c.knee;
  compressor.ratio.value = c.ratio;
  compressor.attack.value = c.attack;
  compressor.release.value = c.release;
  compressor.connect(ctx.destination);
  master = ctx.createGain();
  master.connect(compressor);
  for (const k of Object.keys(buses)) { buses[k] = ctx.createGain(); buses[k].connect(master); }
}

function installGestureUnlock() {
  if (typeof window === 'undefined' || gestureInstalled || ctx) return;
  gestureInstalled = true;
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
}

// ---------- data ----------

/** Loads data/sounds.json once (started automatically on import). @returns {Promise<object|null>} */
export function loadSounds(url = AUDIO.dataUrl) {
  dataPromise ??= fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Sounds ${url}: HTTP ${res.status}`);
      return res.json();
    })
    .then((d) => { data = d; buildEvents(d); return d; })
    .catch((err) => { console.warn('[sound]', err); dataPromise = null; return null; });
  return dataPromise;
}

function buildEvents(d) {
  events.clear();
  const table = d.events ?? {};
  for (const [name, entry] of Object.entries(table)) if (!entry.alias) events.set(name, new EventState(name, entry, d.patches));
  for (const [name, entry] of Object.entries(table)) if (entry.alias && events.has(entry.alias)) events.set(name, events.get(entry.alias));
}

// ---------- mix ----------

/** Re-applies the volumes from settings.audio to the buses (call after the audio settings changed) */
export function refreshVolumes() {
  if (!ctx) return;
  const a = getSettings().audio;
  master.gain.value = a.master;
  buses.effects.gain.value = a.effects;
  buses.ui.gain.value = a.ui ?? SETTINGS_DEFAULTS.audio.ui;
  buses.music.gain.value = a.music;
}

/** [J1] Mutes / unmutes event sounds (play); music is not touched */
export function setSoundMuted(on) { muted = Boolean(on); }

/**
 * Sets the point positional sounds are measured from (camera target; call on camera moves). The object is kept by
 * reference. @param {{x:number,y?:number,z:number}|null} p @param {{x:number,z:number}} [right] camera right vector for panning
 */
export function setListenerPosition(p, right) { listener = p ?? null; listenerRight = right ?? null; }

function distanceGain(position) {
  if (!position || !listener) return 1;
  const dx = position.x - listener.x, dy = (position.y ?? 0) - (listener.y ?? 0), dz = position.z - listener.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  const max = AUDIO.maxDistance;
  if (d2 >= max * max) return 0;
  return (1 - Math.sqrt(d2) / max) ** AUDIO.falloffExponent;
}

function panOf(position) {
  if (!position || !listener || !AUDIO.panWidth) return 0;
  const dx = position.x - listener.x, dz = position.z - listener.z;
  const lateral = listenerRight ? dx * listenerRight.x + dz * listenerRight.z : dx;
  const p = (lateral / AUDIO.maxDistance) * AUDIO.panWidth;
  if (!Number.isFinite(p)) return 0;
  return p > 1 ? 1 : p < -1 ? -1 : p;
}

// ---------- voices ----------

function freeVoice() {
  for (let i = 0; i < voices.length; i++) if (!voices[i].active) return voices[i];
  return null;
}

/** Weakest active voice (of one event when `state` is given): score × remaining fraction, ties → oldest */
function weakestVoice(state, now) {
  let best = null, bestScore = Infinity;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (!v.active || (state && v.state !== state)) continue;
    const span = v.end - v.start;
    const left = span > 0 ? Math.max(0, (v.end - now) / span) : 0;
    const s = v.score * v.boost * left;
    if (s < bestScore || (s === bestScore && best && v.start < best.start)) { best = v; bestScore = s; }
  }
  weakScore = bestScore;
  return best;
}

function onStolenEnded(e) {
  const out = e.target.steelMenOut;
  if (out) { out.disconnect(); e.target.steelMenOut = null; }
}

/** Frees the voice slot. fade = quick fade-out (stealing); hard = stop now */
function releaseVoice(v, ended, fadeSec = 0) {
  if (!v.active) return;
  const out = v.output;
  if (!ended) {
    const now = ctx.currentTime;
    if (fadeSec > 0) {
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(out.gain.value, now);
      out.gain.linearRampToValueAtTime(0, now + fadeSec);
    }
    for (let i = 0; i < v.count; i++) {
      const src = v.sources[i];
      src.onended = onStolenEnded; // the slot is reused: the old chain disconnects itself when it stops
      src.steelMenOut = v.panner ?? out;
      try { src.stop(now + fadeSec); } catch { /* already stopped */ }
    }
    if (fadeSec <= 0) { out.disconnect(); v.panner?.disconnect(); }
  } else {
    out?.disconnect();
    v.panner?.disconnect();
  }
  for (let i = 0; i < v.count; i++) v.sources[i] = null;
  if (v.state) {
    v.state.active = Math.max(0, v.state.active - 1);
    if (v.state.lastVoice === v) v.state.lastVoice = null;
  }
  v.active = false;
  v.state = null;
  v.output = null;
  v.panner = null;
  v.count = 0;
  v.endSource = null;
}

// ---------- files ----------

function loadFile(file) {
  if (fileBuffers.has(file)) return Promise.resolve(fileBuffers.get(file));
  if (fileMissing.has(file) || !ctx) return Promise.resolve(null);
  let p = fileLoading.get(file);
  if (!p) {
    p = fetch(AUDIO.basePath + file)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.arrayBuffer(); })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((audio) => { fileBuffers.set(file, audio); fileLoading.delete(file); return audio; })
      .catch(() => { fileMissing.add(file); fileLoading.delete(file); return null; });
    fileLoading.set(file, p);
  }
  return p;
}

// ---------- play ----------

/**
 * Plays a sound event (data/sounds.json → events). Silent before the first user gesture, while muted, for unknown events
 * and beyond AUDIO.maxDistance. @param {string} eventName @param {{position?: {x:number,y?:number,z:number}}} [opts]
 */
export function play(eventName, opts) {
  if (muted || !ctx || ctx.state !== 'running') return;
  const ev = events.get(eventName);
  if (!ev) return;
  const position = opts ? opts.position : null;
  const gain = ev.gain * distanceGain(position);
  if (!(gain >= AUDIO.minAudibleGain)) return; // also catches NaN from a non-finite position
  const bus = buses[ev.category];
  if (master.gain.value * bus.gain.value < AUDIO.minAudibleGain) return;
  const now = ctx.currentTime;

  // Re-trigger window: merge into the running voice (slightly louder) instead of a new one
  if (now - ev.lastTime < ev.minInterval) {
    const v = ev.lastVoice;
    if (v && v.active && v.boost < AUDIO.mergeMaxBoost) {
      v.boost = Math.min(AUDIO.mergeMaxBoost, v.boost * AUDIO.mergeGainBoost);
      v.output.gain.value = v.baseGain * v.boost;
    }
    return;
  }

  // Source: decoded file, else the synth patch (also while the file loads or when it is missing)
  let buffer = null;
  if (ev.file) {
    buffer = fileBuffers.get(ev.file) ?? null;
    if (!buffer && !fileMissing.has(ev.file) && !fileLoading.has(ev.file)) loadFile(ev.file);
  }
  if (!buffer && !ev.patch) return;

  // Voice: per-event cap, then the global cap (steal the weakest when the new sound matters more)
  const score = gain * ev.priority;
  let v;
  if (ev.active >= ev.maxPerEvent) {
    v = weakestVoice(ev, now);
    if (!v || weakScore > score) return;
    releaseVoice(v, false, AUDIO.stealFadeSec);
  } else {
    v = freeVoice();
    if (!v) {
      v = weakestVoice(null, now);
      if (!v || weakScore > score) return;
      releaseVoice(v, false, AUDIO.stealFadeSec);
    }
  }

  // Claim the slot first (ev.active counted together with it), so a failure below can release it consistently
  v.active = true;
  v.state = ev;
  v.output = null;
  v.panner = null;
  v.count = 0;
  v.endSource = null;
  v.start = now;
  v.end = now;
  v.score = score;
  v.boost = 1;
  ev.active++;
  try {
    const pitch = 1 + (Math.random() * 2 - 1) * ev.pitchVar;
    const g = gain * (1 + (Math.random() * 2 - 1) * ev.gainVar);
    v.baseGain = g;
    const out = ctx.createGain();
    out.gain.value = g;
    v.output = out;
    const pan = panOf(position);
    if (Math.abs(pan) >= AUDIO.panMin) {
      v.panner = ctx.createStereoPanner();
      v.panner.pan.value = pan;
      out.connect(v.panner);
      v.panner.connect(bus);
    } else {
      out.connect(bus);
    }
    if (buffer) {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = pitch;
      src.connect(out);
      src.start(now);
      v.addSource(src, now + buffer.duration / pitch);
    } else {
      renderPatch(ctx, ev.patch, out, now, pitch, v);
    }
    ev.lastTime = now;
    ev.lastVoice = v;
  } catch (err) {
    // play() runs inside simulation callbacks: it must never throw
    releaseVoice(v, true);
    if (!playErrorReported) { playErrorReported = true; console.warn('[sound] play failed', eventName, err); }
  }
}

/** Stops every event sound at once (music keeps playing) */
export function stopAllSounds() {
  for (let i = 0; i < voices.length; i++) if (voices[i].active) releaseVoice(voices[i], false, 0);
}

// ---------- weapons ----------

const weaponEvents = new WeakMap(); // weapon stats object -> event name

function isFlame(s) {
  if (s.id && String(s.id).toLowerCase().includes(AUDIO.flameIdPart)) return true;
  if ((s.damage?.fire ?? 0) > 0) return true;
  const fx = s.effects;
  if (fx) for (let i = 0; i < fx.length; i++) if (AUDIO.flameEffects.includes(fx[i]?.type)) return true;
  return false;
}

function weaponFallbackEvent(s) {
  const F = AUDIO.weaponFallback;
  if (s.class === 'melee') return F.melee;
  if (s.class === 'area') return F.area;
  if (isFlame(s)) return F.flame;
  const speed = s.projectileSpeed ?? 0;
  if (speed > 0 && AUDIO.rocketShapes.includes(s.projectileShape)) return F.rocket;
  if (s.class === 'artillery') return F.artillery;
  if ((s.damage?.energy ?? 0) > (s.damage?.physical ?? 0)) return speed > 0 ? F.energyProjectile : F.energy;
  if (speed > 0) return F.projectile;
  if ((s.burst ?? 1) >= AUDIO.gatlingMinBurst || (s.spread ?? 0) > 0) return F.gatling;
  return F.hitscan;
}

/**
 * Sound event of a weapon's shot: data/sounds.json → weapons[id], else derived from the weapon data.
 * Cached per stats object (no allocation after the first call). @param {object} weaponStats stats.json weapon
 */
export function weaponSoundEvent(weaponStats) {
  if (!weaponStats) return AUDIO.weaponFallback.hitscan;
  let ev = weaponEvents.get(weaponStats);
  if (ev) return ev;
  ev = data?.weapons?.[weaponStats.id] ?? weaponFallbackEvent(weaponStats);
  if (data) weaponEvents.set(weaponStats, ev); // before the data loads the result is not cached (the map may differ)
  return ev;
}

// ---------- music (files only, through the music bus) ----------

function startMusic(track) {
  const file = AUDIO.musicTracks[track];
  if (!file || !ctx) return;
  loadFile(file).then((buffer) => {
    if (!buffer || musicTrack !== track || musicSource) return;
    musicSource = ctx.createBufferSource();
    musicSource.buffer = buffer;
    musicSource.loop = true;
    musicSource.connect(buses.music);
    musicSource.start();
  });
}

/** Starts (or switches) background music by track name from AUDIO.musicTracks; stopMusic() ends it */
export function playMusic(track) {
  stopMusic();
  if (!AUDIO.musicTracks[track]) return;
  musicTrack = track;
  startMusic(track); // without a context yet: started by unlockAudio()
}

export function stopMusic() {
  musicTrack = null;
  if (!musicSource) return;
  try { musicSource.stop(); } catch { /* not started */ }
  musicSource.disconnect();
  musicSource = null;
}

// ---------- lifetime ----------

/**
 * Ends the match's audio: stops all voices and music, clears the listener and the per-event windows. Keeps the
 * AudioContext, noise buffers and decoded files (app-wide). Safe to call more than once.
 */
export function disposeAudio() {
  if (ctx) stopAllSounds();
  stopMusic();
  listener = null;
  listenerRight = null;
  for (const ev of events.values()) ev.reset();
}

installGestureUnlock();
if (typeof fetch === 'function') loadSounds();
