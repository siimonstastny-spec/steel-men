// Steel Mans – smooth fade of the terrain into black along the map border (visual only, no simulation state).
// Cheapest correct solution: the terrain is one mesh with vertex colours, so the fade is baked into those colours
// once when the map is built (no extra objects, no per-frame cost, works with fog of war and the minimap).
import { MAP_EDGE_FADE } from '../config.js';

/**
 * Darkens the terrain vertex colours towards MAP_EDGE_FADE.color within MAP_EDGE_FADE.width units of the map edge.
 * Call once per terrain geometry, after any other vertex colour painting (Map.paintGround). Repeated calls on the
 * same geometry do nothing.
 * @param {THREE.BufferGeometry} geometry  terrain from SceneSetup.buildTerrainGeometry
 * @param {number} half  half of the map size (units)
 */
export function applyMapEdgeFade(geometry, half) {
  const col = geometry?.attributes.color;
  const pos = geometry?.attributes.position;
  if (!col || !pos || geometry.userData.edgeFaded) return;
  const cfg = MAP_EDGE_FADE;
  const width = Math.min(cfg.width, half);
  const [fr, fg, fb] = cfg.color;
  for (let i = 0; i < pos.count; i++) {
    const edge = half - Math.max(Math.abs(pos.getX(i)), Math.abs(pos.getZ(i))); // distance to the border
    if (edge >= width) continue;
    const t = Math.min(1, Math.max(0, edge / width)); // 0 at the border .. 1 at the inner edge of the band
    const k = Math.pow(t, cfg.exponent);              // share of the original colour that is kept
    col.setXYZ(i,
      fr + (col.getX(i) - fr) * k,
      fg + (col.getY(i) - fg) * k,
      fb + (col.getZ(i) - fb) * k);
  }
  col.needsUpdate = true;
  geometry.userData.edgeFaded = true;
}
