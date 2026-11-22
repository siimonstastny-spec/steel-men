// Steel Mans – local player profile in localStorage (one key, PROFILE.storageKey).
// Holds nickname, language, settings (keys, mouse, audio, graphics, ui) and the last new-game choice.
// Storage may be blocked or hold garbage: everything falls back to defaults, nothing throws.
import { PROFILE, SETTINGS_DEFAULTS, ORE_MULTIPLIER } from '../config.js';
import { cleanAvatarImage } from './PlayerLabels.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge of plain objects; arrays and primitives are replaced, unknown keys of `base` are kept */
function merge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return clone(patch);
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : clone(v);
  return out;
}

/** Keeps only keys known in `defaults`, and only values of the same type (stale or hand-edited data is dropped) */
function sanitize(defaults, data) {
  if (!isObject(defaults)) return typeof data === typeof defaults || defaults === null ? data : defaults;
  const out = {};
  for (const [k, def] of Object.entries(defaults)) {
    if (k === 'keybindings') out[k] = isObject(data?.[k]) ? data[k] : {}; // free-form: validated by the Settings screen
    else out[k] = isObject(def) ? sanitize(def, data?.[k]) : (typeof data?.[k] === typeof def || (def === null && typeof data?.[k] === 'string') ? data[k] : def);
  }
  return out;
}

function defaults() {
  return { version: PROFILE.version, settings: clone(SETTINGS_DEFAULTS), newGame: null };
}

function readStorage(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key));
    return isObject(data) ? data : null;
  } catch {
    return null;
  }
}

let cache = null;
const listeners = new Set();

function load() {
  const stored = readStorage(PROFILE.storageKey);
  const profile = defaults();
  if (stored) {
    profile.settings = sanitize(SETTINGS_DEFAULTS, stored.settings);
    profile.settings.avatar = cleanAvatarImage(profile.settings.avatar); // [UISMALL] hand-edited garbage becomes the silhouette
    profile.newGame = isObject(stored.newGame) ? stored.newGame : null;
  } else {
    // First run with the profile: take over the last new-game choice from the older key
    for (const key of PROFILE.legacyKeys) {
      const legacy = readStorage(key);
      if (legacy) { profile.newGame = legacy; break; }
    }
  }
  // [B1] the old "infinite deposits" checkbox became the ore multiplier combobox
  const ng = profile.newGame;
  if (ng && 'infiniteDeposits' in ng) {
    if (ng.infiniteDeposits === true && ng.oreMultiplier === undefined) ng.oreMultiplier = ORE_MULTIPLIER.infinite;
    delete ng.infiniteDeposits;
  }
  return profile;
}

function persist() {
  try {
    localStorage.setItem(PROFILE.storageKey, JSON.stringify(cache));
  } catch { /* storage unavailable – settings just won't survive a reload */ }
}

/** The whole profile (live object – change it through the functions below) */
export function getProfile() {
  cache ??= load();
  return cache;
}

/** Player settings (live object) */
export const getSettings = () => getProfile().settings;

/** Merges a patch into the settings (e.g. { audio: { master: 0.5 } }), saves, notifies listeners */
export function updateSettings(patch) {
  const p = getProfile();
  p.settings = merge(p.settings, patch);
  persist();
  for (const fn of listeners) fn(p.settings, patch);
  return p.settings;
}

/** Replaces a whole settings key (used for keybindings, where merging would keep removed actions) */
export function replaceSetting(key, value) {
  const p = getProfile();
  p.settings = { ...p.settings, [key]: clone(value) };
  persist();
  for (const fn of listeners) fn(p.settings, { [key]: value });
}

/** [UISMALL] Data URL of the uploaded avatar picture of the local player, '' = none (the UI shows a head silhouette) */
export const getAvatarImage = () => cleanAvatarImage(getSettings().avatar);

/** [UISMALL] Saves a picture (data URL from Avatar.js fileToAvatarData) or removes it with '' / null; false = refused */
export function setAvatarImage(dataUrl) {
  const clean = cleanAvatarImage(dataUrl);
  if (dataUrl && !clean) return false;
  updateSettings({ avatar: clean });
  return true;
}

/** Last new-game choice { races, colors, friendlyFire, fogOfWar } or null */
export const getNewGame = () => getProfile().newGame;

/** Merges a change into the saved new-game choice */
export function saveNewGame(patch) {
  const p = getProfile();
  p.newGame = { ...p.newGame, ...clone(patch) };
  persist();
}

/** Calls fn(settings, patch) after every settings change; returns an unsubscribe function */
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resets one settings group (or all with no argument) to defaults */
export function resetSettings(key) {
  updateSettings(key ? { [key]: clone(SETTINGS_DEFAULTS[key]) } : clone(SETTINGS_DEFAULTS));
  if (!key || key === 'keybindings') replaceSetting('keybindings', {});
}
