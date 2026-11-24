// Steel Men – sound hook. Game code calls play('shotCannon', { position }) – nothing else is needed.
// eventName -> file is the map AUDIO.events in config.js. A missing file (or an unknown event) is skipped silently,
// so sounds can be added later by just dropping files into sounds/ – no game code changes.
// Volume = master × category (effects / music) × distance falloff when a position is given.
import { AUDIO } from '../config.js';
import { getSettings } from '../core/Profile.js';

const missing = new Set();   // files that failed to load once – not retried
const cache = new Map();     // file -> HTMLAudioElement template
let listener = null;         // { x, y, z } – where the player "hears" from (camera target)
let music = null;

/** Sets the point positional sounds are measured from (call each frame or on camera moves; optional) */
export function setListenerPosition(p) { listener = p; }

function categoryVolume(category) {
  const a = getSettings().audio;
  return a.master * (category === 'music' ? a.music : a.effects);
}

function distanceGain(position) {
  if (!position || !listener) return 1;
  const d = Math.hypot(position.x - listener.x, (position.y ?? 0) - (listener.y ?? 0), position.z - listener.z);
  if (d >= AUDIO.maxDistance) return 0;
  return (1 - d / AUDIO.maxDistance) ** AUDIO.falloffExponent;
}

function template(file) {
  if (missing.has(file)) return null;
  let audio = cache.get(file);
  if (!audio) {
    audio = new Audio(AUDIO.basePath + file);
    audio.preload = 'auto';
    audio.addEventListener('error', () => { missing.add(file); cache.delete(file); }, { once: true });
    cache.set(file, audio);
  }
  return audio;
}

/** Plays a game event sound. @param {string} eventName key of AUDIO.events @param {{position?: {x:number,y?:number,z:number}}} [opts] */
export function play(eventName, { position } = {}) {
  const file = AUDIO.events[eventName];
  if (!file) return;
  const volume = categoryVolume(AUDIO.categories[eventName] ?? 'effects') * distanceGain(position);
  if (volume <= 0) return;
  const base = template(file);
  if (!base) return;
  const node = base.cloneNode();
  node.volume = Math.min(1, volume);
  node.play().catch(() => { missing.add(file); }); // blocked autoplay or missing file: stay silent
}

/** Starts (or switches) background music by track name from AUDIO.musicTracks; stopMusic() ends it */
export function playMusic(track) {
  const file = AUDIO.musicTracks[track];
  stopMusic();
  if (!file || missing.has(file)) return;
  music = new Audio(AUDIO.basePath + file);
  music.loop = true;
  music.volume = Math.min(1, categoryVolume('music'));
  music.addEventListener('error', () => { missing.add(file); music = null; }, { once: true });
  music.play().catch(() => {});
}

export function stopMusic() { music?.pause(); music = null; }

/** Re-applies volumes to the running music (call after the audio settings changed) */
export function refreshVolumes() { if (music) music.volume = Math.min(1, categoryVolume('music')); }
