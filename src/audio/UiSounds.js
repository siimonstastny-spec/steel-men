// Steel Men – [A6] interface sounds by delegated document listeners: a click on any enabled button / menu button
// (HUD grid cells are buttons too) -> uiClick, the pointer entering an enabled one -> uiHover (throttled).
// Installed once for the page (main.js); nothing per element, so menus built later need no wiring.
import { SOUND_HOOKS } from '../config.js';
import { play } from './Sound.js';

let installed = false;
let lastHoverMs = -Infinity;
let hovered = null; // element the pointer is over (a hover sound plays only when it changes)

/** The enabled sound-bearing element of an event target, or null */
function soundTarget(target) {
  const el = target?.closest?.(SOUND_HOOKS.clickSelector) ?? null;
  return el && !el.matches(SOUND_HOOKS.ignoreSelector) ? el : null;
}

function onClick(e) {
  if (e.button !== 0) return;
  if (soundTarget(e.target)) play('uiClick');
}

function onOver(e) {
  const el = soundTarget(e.target);
  if (el === hovered) return;
  hovered = el;
  if (!el) return;
  const now = performance.now();
  if (now - lastHoverMs < SOUND_HOOKS.hoverThrottleMs) return;
  lastHoverMs = now;
  play('uiHover');
}

/** Adds the listeners (idempotent) */
export function install() {
  if (installed) return;
  installed = true;
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerover', onOver, true);
}

/** Removes the listeners */
export function dispose() {
  if (!installed) return;
  installed = false;
  document.removeEventListener('click', onClick, true);
  document.removeEventListener('pointerover', onOver, true);
  hovered = null;
  lastHoverMs = -Infinity;
}
