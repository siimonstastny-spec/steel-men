// Steel Men – keeps the camera look-at point (OrbitControls target) inside the map.
// The map is a square centred on the origin with side world.map.size (the same convention as Minimap.toMini).
import { CAMERA_BOUNDS } from '../config.js';

let sizeProvider = () => globalThis.steelMen?.world?.map?.size; // lazy: the map can be rebuilt per game

/** Optional explicit wiring (e.g. from main.js): fn() returns the current map side length */
export function setMapSizeProvider(fn) { sizeProvider = fn; }

/**
 * Clamps controls.target on the ground plane to the map (+ CAMERA_BOUNDS.overshoot) and shifts the camera by the
 * same amount so the view angle and distance stay. No allocations. Returns true when something was corrected.
 */
export function clampToMap(camera, controls) {
  const size = sizeProvider();
  if (!(size > 0)) return false;
  const half = size / 2 + CAMERA_BOUNDS.overshoot;
  const t = controls.target;
  const cx = Math.max(-half, Math.min(half, t.x));
  const cz = Math.max(-half, Math.min(half, t.z));
  const dx = cx - t.x;
  const dz = cz - t.z;
  if (!dx && !dz) return false;
  t.x = cx;
  t.z = cz;
  camera.position.x += dx;
  camera.position.z += dz;
  return true;
}
