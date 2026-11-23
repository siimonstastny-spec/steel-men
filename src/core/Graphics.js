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
const notifyQuality = () => { for (const fn of qualityListeners) fn(getBuildingQuality()); };

function readBuildingOptions(opts) {
  const detail = BUILDING_LOD.order.includes(opts.buildingDetail) || opts.buildingDetail === 'auto' ? opts.buildingDetail : 'high';
  const shadows = opts.buildingShadows !== false;
  const animations = Object.hasOwn(BUILDING_LOD.animations, opts.buildingAnimations) ? opts.buildingAnimations : 'full';
  const before = JSON.stringify([levelNow(), quality.shadows, quality.animations]);
  if (detail !== quality.detail) { quality.autoLevel = 'high'; quality.ema = 0; quality.slowTime = 0; quality.fastTime = 0; quality.lastMs = 0; }
  quality.detail = detail;
  quality.shadows = shadows;
  quality.animations = animations;
  quality.ready = true;
  if (JSON.stringify([levelNow(), quality.shadows, quality.animations]) !== before) notifyQuality();
}

function ensureQuality() {
  if (quality.ready) return;
  readBuildingOptions(getGraphicsOptions());
  onSettingsChange((s) => readBuildingOptions(getGraphicsOptions(s.graphics)));   // live change, no reload
}

/** Effective building quality now: { level: 'high'|'medium'|'low', ...BUILDING_LOD.quality[level], shadows, auto } */
export function getBuildingQuality() {
  ensureQuality();
  const level = levelNow();
  const q = BUILDING_LOD.quality[level];
  return { level, ...q, full: q.full * BUILDING_LOD.animations[quality.animations], shadows: quality.shadows, auto: quality.detail === 'auto' };
}

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
  if (quality.detail !== 'auto') { quality.lastMs = 0; return; }
  const A = BUILDING_LOD.auto;
  const now = performance.now();
  const last = quality.lastMs;
  quality.lastMs = now;
  if (!last) return;
  const ms = Math.min(now - last, A.maxFrameMs);
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
