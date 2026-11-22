// Steel Mans – remapping of KEYBINDINGS (config.js): validation, applying saved bindings, saving.
// KEYBINDINGS arrays are changed IN PLACE, so code that captured a reference keeps working.
import { CAMERA_RESERVED_KEYS, FORBIDDEN_KEYS, KEYBINDINGS, KEY_ACTIONS } from '../config.js';
import { getSettings, replaceSetting } from '../core/Profile.js';

export const REMAPPABLE = [...KEY_ACTIONS.camera, ...KEY_ACTIONS.commands];
export const KEY_SLOTS = 2; // keys shown per action

// Defaults as shipped in config.js (snapshot before saved bindings are applied)
const DEFAULTS = Object.fromEntries(REMAPPABLE.map((a) => [a, [...KEYBINDINGS[a]]]));
export const defaultKeys = (action) => [...DEFAULTS[action]];
export const currentKeys = (action) => [...KEYBINDINGS[action]];

const isCameraAction = (a) => KEY_ACTIONS.camera.includes(a);
const groupKeys = () => new Set(KEYBINDINGS.controlGroups.flat());

function setKeys(action, codes) {
  KEYBINDINGS[action].splice(0, KEYBINDINGS[action].length, ...codes);
}

/** Applies the bindings saved in the profile (call once at startup, before the game reads keys) */
export function applySavedKeybindings() {
  const saved = getSettings().keybindings ?? {};
  for (const action of REMAPPABLE) {
    const codes = saved[action];
    if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string')) continue;
    if (isCameraAction(action) || !codes.some((c) => CAMERA_RESERVED_KEYS.includes(c))) setKeys(action, codes);
  }
}

function persist() {
  const diff = {};
  for (const a of REMAPPABLE) if (JSON.stringify(KEYBINDINGS[a]) !== JSON.stringify(DEFAULTS[a])) diff[a] = [...KEYBINDINGS[a]];
  replaceSetting('keybindings', diff);
}

/**
 * Checks whether `code` may be put on slot `slot` of `action`.
 * @returns {null | {reason: 'reserved'|'forbidden'|'group'|'conflict', other?: string}}
 */
export function validateKey(action, slot, code) {
  if (FORBIDDEN_KEYS.includes(code)) return { reason: 'forbidden' };
  if (!isCameraAction(action) && CAMERA_RESERVED_KEYS.includes(code)) return { reason: 'reserved' };
  if (groupKeys().has(code)) return { reason: 'group' };
  for (const other of REMAPPABLE) {
    const keys = KEYBINDINGS[other];
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === code && !(other === action && i === slot)) return { reason: 'conflict', other };
    }
  }
  return null;
}

/** Sets one slot (code = null clears it) and saves; validate first */
export function setKey(action, slot, code) {
  const keys = currentKeys(action);
  while (keys.length <= slot) keys.push(null);
  keys[slot] = code;
  setKeys(action, keys.filter(Boolean));
  persist();
}

export function resetKeybindings() {
  for (const a of REMAPPABLE) setKeys(a, DEFAULTS[a]);
  persist();
}

/** Human-readable key name from a KeyboardEvent.code */
export function keyLabel(code) {
  if (!code) return '';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Arrow')) return { Up: '↑', Down: '↓', Left: '←', Right: '→' }[code.slice(5)];
  return code.replace('Numpad', 'Num ').replace('Left', ' L').replace('Right', ' R');
}
