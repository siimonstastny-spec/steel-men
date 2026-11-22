// Steel Mans – graphics quality (full / reduced). Reduced = lower render resolution (pixel ratio downscale)
// and cheaper, smaller shadows. Presets are in config.js (GRAPHICS).
import * as THREE from 'three';
import { GRAPHICS } from '../config.js';
import { getSettings, onSettingsChange } from './Profile.js';

/** Applies a quality preset to the renderer and the scene's shadow-casting lights */
export function applyGraphics(renderer, scene, quality = getSettings().graphics.quality) {
  const p = GRAPHICS.presets[quality] ?? GRAPHICS.presets.full;
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
  let last = getSettings().graphics.quality;
  applyGraphics(renderer, scene, last);
  onSettingsChange((s) => {
    if (s.graphics.quality === last) return;
    last = s.graphics.quality;
    applyGraphics(renderer, scene, last);
  });
}
