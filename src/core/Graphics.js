// Steel Mans – graphics quality (full / reduced). Reduced = lower render resolution (pixel ratio downscale)
// and cheaper, smaller shadows. Presets are in config.js (GRAPHICS).
import * as THREE from 'three';
import { GRAPHICS } from '../config.js';
import { getSettings, onSettingsChange, getGraphicsOptions } from './Profile.js';

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
  let last = JSON.stringify(getGraphicsOptions());
  applyGraphics(renderer, scene);
  onSettingsChange((s) => {
    const now = JSON.stringify(getGraphicsOptions(s.graphics));
    if (now === last) return;
    last = now;
    applyGraphics(renderer, scene, getGraphicsOptions(s.graphics));
  });
}
