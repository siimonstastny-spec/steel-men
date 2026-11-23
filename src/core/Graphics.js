// Steel Mans – graphics quality (full / medium / reduced). Reduced = lower render resolution (pixel ratio downscale)
// and cheaper, smaller shadows. Presets are in config.js (GRAPHICS).
// Also the building quality level (procedural buildings, BUILDING_LOD): the setting `buildingDetail` high / medium /
// low / auto → effective level; `auto` follows the measured frame time. Visual only, the simulation never reads it.
import * as THREE from 'three';
import { GRAPHICS, BUILDING_LOD } from '../config.js';
import { getSettings, onSettingsChange, getGraphicsOptions } from './Profile.js';

// ---------------------------------------------------------------- building quality level

const MS_PER_SECOND = 1000;
const quality = {
  detail: 'high',        // setting: high | medium | low | auto
  shadows: true,         // setting buildingShadows
  animations: 'full',    // setting buildingAnimations: full | near | off
  autoLevel: 'high',     // level the auto mode has reached
  ema: 0, slowTime: 0, fastTime: 0, lastMs: 0,
  ready: false,
};
const qualityListeners = new Set();

const levelNow = () => (quality.detail === 'auto' ? quality.autoLevel : quality.detail);
const notifyQuality = () => { refreshCurrent(); for (const fn of qualityListeners) fn(current); };

// The effective quality object handed out by getBuildingQuality (one object, updated in place – no allocation per call)
const current = { level: 'high', full: 0, mid: 0, textureSize: 0, shadows: true, auto: false };
function refreshCurrent() {
  const level = levelNow();
  const q = BUILDING_LOD.quality[level];
  current.level = level;
  current.full = q.full * BUILDING_LOD.animations[quality.animations];
  current.mid = q.mid;
  current.textureSize = q.textureSize;
  current.shadows = quality.shadows;
  current.auto = quality.detail === 'auto';
}

let clockSeconds = 0;   // real time of the last rendered frame, see getRenderClock

function readBuildingOptions(opts) {
  const detail = BUILDING_LOD.order.includes(opts.buildingDetail) || opts.buildingDetail === 'auto' ? opts.buildingDetail : 'high';
  const shadows = opts.buildingShadows !== false;
  const animations = Object.hasOwn(BUILDING_LOD.animations, opts.buildingAnimations) ? opts.buildingAnimations : 'full';
  const before = JSON.stringify([levelNow(), quality.shadows, quality.animations]);
  if (detail !== quality.detail) { quality.autoLevel = 'high'; quality.ema = 0; quality.slowTime = 0; quality.fastTime = 0; quality.lastMs = 0; }
  quality.detail = detail;
  quality.shadows = shadows;
  quality.animations = animations;
  refreshCurrent();
  quality.ready = true;
  if (JSON.stringify([levelNow(), quality.shadows, quality.animations]) !== before) notifyQuality();
}

function ensureQuality() {
  if (quality.ready) return;
  readBuildingOptions(getGraphicsOptions());
  onSettingsChange((s) => readBuildingOptions(getGraphicsOptions(s.graphics)));   // live change, no reload
}

/**
 * Effective building quality now: { level: 'high'|'medium'|'low', full, mid, textureSize, shadows, auto } – `full` = LOD0
 * range (already scaled by buildingAnimations), `mid` = LOD1 range. One live object, read-only for callers.
 */
export function getBuildingQuality() {
  ensureQuality();
  return current;
}

/**
 * Real time (s) of the last rendered frame, written by noteRenderFrame (render side). Visual animations that follow a
 * shared clock (sun tracking) read it; the simulation never does. 0 until the first frame was rendered.
 */
export const getRenderClock = () => clockSeconds;

/** Calls fn(buildingQuality) whenever the effective level or the building shadow flag changes; returns unsubscribe */
export function onBuildingQualityChange(fn) {
  ensureQuality();
  qualityListeners.add(fn);
  return () => qualityListeners.delete(fn);
}

/**
 * Called once per rendered frame by the building batcher (render side – the only place that reads the real clock).
 * In `auto` mode it keeps an EMA of the frame time and moves the level one step down / up after a few seconds
 * (BUILDING_LOD.auto); otherwise it does nothing.
 */
export function noteRenderFrame() {
  ensureQuality();
  const now = performance.now();
  clockSeconds = now / MS_PER_SECOND;
  if (quality.detail !== 'auto') { quality.lastMs = 0; return; }
  const A = BUILDING_LOD.auto;
  const last = quality.lastMs;
  quality.lastMs = now;
  if (!last || now - last > A.maxFrameMs) return;   // first sample / hidden tab / loading stall: not a measurement
  const ms = now - last;
  quality.ema = quality.ema ? quality.ema + (ms - quality.ema) * A.smoothing : ms;
  const dt = ms / MS_PER_SECOND;
  quality.slowTime = quality.ema > A.degradeMs ? quality.slowTime + dt : 0;
  quality.fastTime = quality.ema < A.upgradeMs ? quality.fastTime + dt : 0;
  const order = BUILDING_LOD.order;
  const i = order.indexOf(quality.autoLevel);
  if (quality.slowTime >= A.degradeSeconds && i < order.length - 1) quality.autoLevel = order[i + 1];
  else if (quality.fastTime >= A.upgradeSeconds && i > 0) quality.autoLevel = order[i - 1];
  else return;
  quality.slowTime = 0; quality.fastTime = 0; quality.ema = 0;   // measure again at the new level
  notifyQuality();
}

/** Applies the graphics options (Advanced values: Full / Reduced / Custom) to the renderer and the scene's shadow-casting lights */
export function applyGraphics(renderer, scene, opts = getGraphicsOptions()) {
  const p = opts;
  const ratio = Math.min(window.devicePixelRatio, p.pixelRatioCap) * p.pixelRatioScale;
  renderer.setPixelRatio(Math.max(GRAPHICS.minPixelRatio, ratio));
  const el = renderer.domElement.parentElement;
  if (el) renderer.setSize(el.clientWidth, el.clientHeight);
  renderer.shadowMap.enabled = p.shadows;
  renderer.shadowMap.type = THREE[p.shadowType] ?? THREE.PCFSoftShadowMap;
  scene.traverse((o) => {
    if (!o.isLight || !o.castShadow || !o.shadow) return;
    if (o.shadow.mapSize.x !== p.shadowMapSize) {
      o.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      o.shadow.map?.dispose();
      o.shadow.map = null;
    }
  });
  // Materials must recompile when the shadow type changes
  scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
  renderer.shadowMap.needsUpdate = true;
}

/** Applies the saved quality now and re-applies it whenever the graphics setting changes */
export function initGraphics(renderer, scene) {
  // the building options do not touch the renderer (the batcher follows them itself) – leave them out of the comparison,
  // so changing them does not recompile every material
  const renderKey = (o) => JSON.stringify({ ...o, buildingDetail: 0, buildingShadows: 0, buildingAnimations: 0 });
  let last = renderKey(getGraphicsOptions());
  ensureQuality();
  applyGraphics(renderer, scene);
  onSettingsChange((s) => {
    const now = renderKey(getGraphicsOptions(s.graphics));
    if (now === last) return;
    last = now;
    applyGraphics(renderer, scene, getGraphicsOptions(s.graphics));
  });
}
