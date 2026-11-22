// Steel Mans – draft of the player settings edited in the Settings screen. Nothing reaches the profile or the game
// (KEYBINDINGS, language, volumes, graphics…) until commit() – the Save button. discard() throws the draft away.
import { CAMERA_RESERVED_KEYS, FORBIDDEN_KEYS, KEYBINDINGS, KEY_ACTIONS, SETTINGS_DEFAULTS } from '../config.js';
import { getSettings, replaceSetting, updateSettings } from '../core/Profile.js';
import { cleanAvatarImage } from '../core/PlayerLabels.js';
import { getLanguage, setLanguage } from '../i18n/i18n.js';
import { REMAPPABLE, defaultKeys } from './SettingsKeybindings.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isCameraAction = (a) => KEY_ACTIONS.camera.includes(a);

/** True while the page is shown in browser fullscreen */
export const isFullscreen = () => !!document.fullscreenElement;
/** False when the browser forbids fullscreen (iframe without permission, unsupported) */
export const fullscreenAvailable = () => !!document.fullscreenEnabled;

export class SettingsDraft {
  constructor() { this.discard(); }

  /** (Re)starts the draft from the saved settings and the live key bindings */
  discard() {
    const { keybindings, ...rest } = getSettings();
    this.settings = clone(rest);
    this.keys = Object.fromEntries(REMAPPABLE.map((a) => [a, [...KEYBINDINGS[a]]]));
    // Fullscreen is browser state, not profile data (a browser only enters it from a user gesture): the draft starts
    // from the real state, the screen applies the wish on Save (SettingsScreen.save)
    this.fullscreen = isFullscreen();
    this.base = this.#snapshot();
  }

  #snapshot() { return JSON.stringify({ s: this.settings, k: this.keys, f: this.fullscreen }); }

  /** The real fullscreen state changed (Esc, F11, Save): draft and baseline both follow it, so the switch stays honest */
  syncFullscreen(on) {
    const wasDirty = this.dirty;
    this.fullscreen = on;
    const base = JSON.parse(this.base);
    base.f = on;
    this.base = JSON.stringify(base);
    return wasDirty;
  }

  get dirty() { return this.#snapshot() !== this.base; }

  /** Language shown in the selector (the saved one, or the detected one while none is saved) */
  get language() { return this.settings.language ?? getLanguage(); }

  /** Sets a value by dotted path ('mouse.invertPan') */
  set(path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((obj, k) => (obj[k] ??= {}), this.settings);
    target[last] = value;
  }

  /** Puts one settings group back to the shipped defaults (in the draft only) */
  resetGroup(key) { this.settings[key] = clone(SETTINGS_DEFAULTS[key]); }

  // ---------- key bindings (same rules as SettingsKeybindings.validateKey, but against the draft) ----------

  keysOf(action) { return [...this.keys[action]]; }

  /** @returns {null | {reason: 'reserved'|'forbidden'|'group'|'conflict', other?: string}} */
  validateKey(action, slot, code) {
    if (FORBIDDEN_KEYS.includes(code)) return { reason: 'forbidden' };
    if (!isCameraAction(action) && CAMERA_RESERVED_KEYS.includes(code)) return { reason: 'reserved' };
    if (KEYBINDINGS.controlGroups.flat().includes(code)) return { reason: 'group' };
    for (const other of REMAPPABLE) {
      const list = this.keys[other];
      for (let i = 0; i < list.length; i++) if (list[i] === code && !(other === action && i === slot)) return { reason: 'conflict', other };
    }
    return null;
  }

  setKey(action, slot, code) {
    const list = this.keysOf(action);
    while (list.length <= slot) list.push(null);
    list[slot] = code;
    this.keys[action] = list.filter(Boolean);
  }

  resetKeys() { for (const a of REMAPPABLE) this.keys[a] = defaultKeys(a); }

  // ---------- saving ----------

  /** Applies the draft: key bindings (in place), settings groups, language. Returns true when volumes changed. */
  commit() {
    const saved = getSettings();
    const audioChanged = !same(saved.audio, this.settings.audio);
    // Key bindings: KEYBINDINGS arrays are changed in place, only the remapped actions go to the profile
    const diff = {};
    for (const a of REMAPPABLE) {
      KEYBINDINGS[a].splice(0, KEYBINDINGS[a].length, ...this.keys[a]);
      if (!same(this.keys[a], defaultKeys(a))) diff[a] = [...this.keys[a]];
    }
    if (!same(saved.keybindings ?? {}, diff)) replaceSetting('keybindings', diff);
    // Everything else, only the groups that changed (listeners such as Graphics re-apply just those)
    const patch = {};
    for (const [k, v] of Object.entries(this.settings)) {
      if (k === 'language' || same(saved[k], v)) continue;
      patch[k] = k === 'avatar' ? cleanAvatarImage(v) : clone(v);
    }
    if (Object.keys(patch).length) updateSettings(patch);
    if (this.settings.language && this.settings.language !== saved.language) setLanguage(this.settings.language);
    this.discard(); // new baseline = what was just saved
    return audioChanged;
  }
}
