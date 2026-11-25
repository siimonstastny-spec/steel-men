// Steel Men – far LOD plan of a procedural robot (build time only, called by RobotKit.buildRobot before UnitBuilder.build).
// UnitKit decides the far LODs by part size alone, which drops the glow, the team paint of shoulders / torso and the helmet
// of a robot at normal zoom. Here every paint part gets an explicit `detail` (coarsest LOD it still appears in) by what it
// is: team paint, emissive parts and light markings stay, the biggest part of every bone stays (silhouette: helmet,
// shoulders, torso), the rest goes by size; then the least important parts leave each LOD until the triangle share fits
// ROBOT_LOD.share. Glow geometry is not drawn in far LODs, so the chest glow gets a small emissive stand-in (paint).
import * as THREE from 'three';
import { surface } from '../ProcKit.js';
import { BUILDING_LOD } from '../../config.js';

export const ROBOT_LOD = {
  // coarsest LOD kept for parts without a special role: largest side ≥ share × robot extent (index = LOD)
  minShare: [0, 0.04, 0.1],
  // emissive parts and light markings: kept in LOD1 / LOD2 from this share of the extent
  glowShare: [0, 0, 0.05],
  // team-painted parts: kept in LOD1 / LOD2 from this share of the extent
  teamShare: [0, 0.02, 0.035],
  // the largest part of a bone stays in the LOD (silhouette) when at least this share of the extent
  boneShare: [0, 0.015, 0.03],
  // triangle cap of a far LOD as a share of the LOD0 paint triangles
  share: [1, 0.75, 0.45],
  // chest glow stand-in (paint box inside the additive glow primitive): bone, side share of the glow bounds, min / max side
  stand: { fit: 0.58, minSide: 0.5, detail: 2, boneNames: ['chest'] },
  teamMask: 0.5,        // aSurface.x at or above this = team paint
  // joint / hub parts (bounding box holds the bone origin): kept in LOD1 / LOD2 from this share of the extent
  jointShare: [0, 0.02, 0.035],
  // emblem stand-in (planes under the decal: rim, plate, sign), width share of the decal size, depth under the decal, sign colour fallback
  emblem: { rim: 0.9, plate: 0.8, sign: 0.42, depth: [0.03, 0.022, 0.014], rimColor: "#3d424b", plateColor: "#15171b", fallback: "#ffffff", glow: 0.8 },
};

const _bb = new THREE.Box3();
const _v = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Vector3();

// highest value of attribute component i over the geometry
function maxComponent(geo, name, i) {
  const a = geo.attributes[name];
  let m = 0;
  for (let k = 0; k < a.count; k++) m = Math.max(m, a.getComponent(k, i));
  return m;
}

function triangles(p, l) {
  if (l > 0 && p.round) {
    const seg = BUILDING_LOD.roundedSegments[l];
    return seg > 0 ? 12 * (2 * seg + 1) ** 2 : 12;
  }
  return (p.geo.index ? p.geo.index.count : p.geo.attributes.position.count) / 3;
}

/** Sets p.detail of every paint part of the robot and adds the chest glow stand-ins. Construction time only. */
export function applyRobotLod(ub, kit) {
  const C = ROBOT_LOD;
  const defs = ub.boneDefs;
  // approximate model-space offset of every bone (positions only: enough for the robot extent)
  const off = defs.map(() => new THREE.Vector3());
  defs.forEach((d, i) => { off[i].fromArray(d.position); if (d.parent >= 0) off[i].add(off[d.parent]); });

  // chest glow stand-ins first (they are ordinary paint parts: LOD0 sees a tiny emissive core inside the halo)
  const neon = kit.S.neon;
  for (const name of C.stand.boneNames) {
    const bi = ub.index.get(name);
    const gp = bi === undefined ? null : ub.glows.get(bi);
    if (!gp) continue;
    for (const g of gp.parts) {
      g.computeBoundingBox();
      const sz = g.boundingBox.getSize(_v);
      if (Math.max(sz.x, sz.y, sz.z) < C.stand.minSide) continue;
      const ctr = g.boundingBox.getCenter(new THREE.Vector3());
      const col = g.attributes.color;
      _c.setRGB(col.getX(0), col.getY(0), col.getZ(0));
      const peak = Math.max(_c.r, _c.g, _c.b, 1e-3);
      _c.multiplyScalar(1 / peak);
      const s = surface(`#${_c.getHexString()}`, { metal: 0, rough: 1, glow: neon.glow });
      const f = C.stand.fit;
      ub.paint(name).box(Math.max(sz.x * f, 0.05), Math.max(sz.y * f, 0.05), Math.max(sz.z * f, 0.05), s, { x: ctr.x, y: ctr.y, z: ctr.z, detail: C.stand.detail });
      const pb = ub.paint(name).parts;
      pb[pb.length - 1].pinned = true;   // stand-in: always kept in the far LODs
    }
  }

  // emblem stand-ins: the decal (plate + sign) is not drawn in far LODs, so planes under it keep the plate and the sign
  const E = C.emblem;
  const emblemColor = kit.style?.emblem?.color ?? E.fallback;
  const rimS = surface(E.rimColor, { metal: 0.2, rough: 0.6 });
  const plateS = surface(E.plateColor, { metal: 0.2, rough: 0.6 });
  const signS = surface(emblemColor, { metal: 0, rough: 0.5, glow: E.glow });
  for (const d of ub.decals) {
    const pb = ub.paint(d.bone);
    for (const pl of d.placements) {
      const n = _v.fromArray(pl.normal).normalize();
      const tilt = Math.atan2(n.y, n.z);
      [[rimS, E.rim, E.depth[0]], [plateS, E.plate, E.depth[1]], [signS, E.sign, E.depth[2]]].forEach(([s, w, back]) => {
        pb.add(new THREE.PlaneGeometry(pl.size * w, pl.size * w), s, {
          x: pl.position[0] - n.x * back, y: pl.position[1] - n.y * back, z: pl.position[2] - n.z * back, rx: -tilt, detail: C.stand.detail,
        });
        pb.parts[pb.parts.length - 1].pinned = true;
      });
    }
  }

  // classify
  const all = [];
  let extent = 0;
  for (const [bi, b] of ub.paints) {
    for (const p of b.parts) {
      _bb.copy(p.geo.boundingBox).translate(off[bi]);
      all.push({ p, bi, box: _bb.clone() });
    }
  }
  const whole = new THREE.Box3();
  for (const e of all) whole.union(e.box);
  whole.getSize(_v);
  extent = Math.max(_v.x, _v.y, _v.z);

  const largest = new Map();   // bone -> its biggest part
  for (const e of all) {
    const cur = largest.get(e.bi);
    if (!cur || e.p.size > cur.p.size) largest.set(e.bi, e);
  }
  for (const e of all) {
    const p = e.p;
    const s = p.size / extent;
    const team = maxComponent(p.geo, 'aSurface', 0) >= C.teamMask;
    const glow = p.marking || maxComponent(p.geo, 'aSurface', 3) > 0;
    // joint / hub: the bone origin lies inside the part bounds (ball joints, hubs, boots around the ankle) – keeps limbs connected
    _bb.copy(p.geo.boundingBox).expandByScalar(extent * C.jointShare[1] * 0.5);
    const joint = _bb.containsPoint(ZERO);
    const base = largest.get(e.bi) === e;
    // demotion order: plain parts first, then structural (joints, largest part of a bone) and light, team paint last
    e.cls = team ? 2 : glow || joint || base ? 1 : 0;
    let d = 0;
    for (let l = 1; l <= 2; l++) {
      const keep = s >= C.minShare[l]
        || (joint && s >= C.jointShare[l])
        || (glow && s >= C.glowShare[l])
        || (team && s >= C.teamShare[l])
        || (largest.get(e.bi) === e && s >= C.boneShare[l]);
      if (keep) d = l;
    }
    if (p.pinned) d = C.stand.detail;
    p.detail = d;
    e.s = s;
  }

  // triangle caps (LOD2 first: parts leaving LOD2 stay in LOD1 until LOD1 is trimmed)
  let total0 = 0;
  for (const e of all) total0 += triangles(e.p, 0);
  for (const l of [2, 1]) {
    const cap = total0 * C.share[l];
    let kept = 0;
    for (const e of all) if (e.p.detail >= l) kept += triangles(e.p, l);
    const order = all.filter((e) => e.p.detail >= l && !e.p.pinned).sort((a, b) => a.cls - b.cls || a.s - b.s);
    for (let i = 0; i < order.length && kept > cap; i++) {
      const e = order[i];
      kept -= triangles(e.p, l);
      e.p.detail = l - 1;
    }
  }
}
