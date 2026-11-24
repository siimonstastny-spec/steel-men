// Steel Men – sculpted robot forms (construction time only): lofted hulls and limbs, shaped armour panels, hinge hubs,
// hydraulics, built from ProcShapes. One code path for every style; the look comes from style.silhouette through
// ROBOT_SCULPT.families (cross-section family, point count, crease angle):
//   faceted (W) – keeled octagon hulls / diamond hexagon limbs, crisp facets, smooth along the length (rounded transitions)
//   rounded (X) – chamfered sections smoothed into soft rounded volumes
//   round   (Z) – elliptic sections, fully smooth
//   angular (Y) – near-rectangular sections, hard edges, tapered by the profiles
// Profiles (how a limb swells and narrows) are data of the part shapes (RobotLegs / RobotTorsos / RobotArms). Code reads
// style properties only, never faction names. Triangle cost of every helper is in its comment (budget: ≤ 2.5k / robot).
import { loft, panel, hub, tube, sweep, polygon, alignTo, chamferRect, diamondHex, ellipse } from '../ProcShapes.js';

const HALF_PI = Math.PI / 2;

/** Style families and helper defaults (shares of the given sizes; degrees for crease angles) */
export const ROBOT_SCULPT = {
  families: {
    // limb / hull = section points (6-point limbs: diamond hexagon / smooth hexagon / 6-point ellipse), crease in degrees
    faceted: { kind: 'keel', limb: 6, hull: 8, chamfer: 0.26, keel: 0.42, hexSide: 0.5, crease: 14, hubSides: 6, hubCrease: 0, panel: 'hex', panelCrease: 0 },
    rounded: { kind: 'chamfer', limb: 6, hull: 8, chamfer: 0.3, keel: 0.3, hexSide: 0.6, crease: 50, hubSides: 6, hubCrease: 65, panel: 'hex', panelCrease: 50 },
    round: { kind: 'ellipse', limb: 6, hull: 8, crease: 80, hubSides: 6, hubCrease: 80, panel: 'hex', panelCrease: 75 },
    angular: { kind: 'chamfer', limb: 6, hull: 8, chamfer: 0.06, keel: 0.06, hexSide: 0.85, crease: 20, hubSides: 4, hubCrease: 0, panel: 'chamfer', panelCrease: 0 },
  },
  fallback: 'rounded',
  hubRim: 0.2,               // hinge rim chamfer (share of the radius)
  panelRound: 2,             // rounded panel corner steps
  pistonSides: 6,            // hydraulic cylinder / rod sides
  hoseSides: 5,
  hoseSegments: 3,
  hoseCrease: { facet: 30, smooth: 80 },   // hoses bend smoothly along the curve even on faceted styles
};

/** Section family of a style */
export const familyOf = (kit) => ROBOT_SCULPT.families[kit.style.silhouette] ?? ROBOT_SCULPT.families[ROBOT_SCULPT.fallback];

/**
 * Cross-section outline (u = width w, v = depth d, +v = front) of the style family with `points` points.
 * o = { points (default family limb count), keel (front chamfer share, faceted / chamfer families), back (back chamfer share) }.
 */
export function section(kit, w, d, { points, keel, back } = {}) {
  const F = familyOf(kit);
  const n = points ?? F.limb;
  if (F.kind === 'ellipse') return ellipse(w, d, n);
  if (n === 6) return diamondHex(w, d, F.hexSide);
  const m = Math.min(w, d);
  return chamferRect(w, d, m * (back ?? F.chamfer), { top: m * (keel ?? F.keel), bottom: m * (back ?? F.chamfer) });
}

/**
 * Flat front face of a hull section (hullLoft station): { w: width of the flat face, z: its distance from the section
 * centre }. Light lines, visors and emblem plates sit on it.
 */
export function frontFlat(kit, w, d, { keel, points } = {}) {
  const F = familyOf(kit);
  const n = points ?? F.hull;
  if (F.kind === 'ellipse') return { w: w * Math.sin(Math.PI / n), z: (d / 2) * Math.cos(Math.PI / n) };
  return { w: Math.max(0, w - 2 * Math.min(w, d) * (keel ?? F.keel)), z: d / 2 };
}

/**
 * Centre (v, + = front) and length of the flat side face (u = ±w/2) of a section – light lines along a side must stay
 * on it, else their ends stick out past the chamfers. { v, len }
 */
export function sideFace(kit, w, d, { keel, points } = {}) {
  const F = familyOf(kit);
  const n = points ?? F.hull;
  if (F.kind === 'ellipse') return { v: 0, len: d * Math.sin(Math.PI / n) };
  const m = Math.min(w, d);
  const ct = m * (keel ?? F.keel);
  const cb = m * F.chamfer;
  return { v: (cb - ct) / 2, len: Math.max(0, d - ct - cb) };
}

/**
 * Half length (along u) of the front (v = +d/2) or back (v = −d/2) edge of a section – how far a bottom edge reaches
 * sideways (ground contact under a rolled pelvis). o = { keel, back, points }.
 */
export function edgeHalf(kit, w, d, front, { keel, back, points } = {}) {
  const F = familyOf(kit);
  const n = points ?? F.hull;
  if (F.kind === 'ellipse') return (w / 2) * Math.sin(Math.PI / n);
  const m = Math.min(w, d);
  return Math.max(0, w / 2 - m * (front ? (keel ?? F.keel) : (back ?? F.chamfer)));
}

/** Centre v of the flat side face (sideFace(...).v) */
export const sideFaceMid = (kit, w, d, keel) => sideFace(kit, w, d, { keel }).v;

/**
 * Front surface of a hull section at width position x: { z, yaw } (yaw = rotation about Y that turns a +Z panel onto
 * the surface there – panels on the keel chamfers of the chest).
 */
export function frontAt(kit, w, d, x, { keel, points } = {}) {
  const F = familyOf(kit);
  const a = w / 2;
  const b = d / 2;
  const ax = Math.min(Math.abs(x), a * 0.98);
  const sg = x < 0 ? -1 : 1;
  if (F.kind === 'ellipse') {
    const n = points ?? F.hull;
    const k = Math.cos(Math.PI / n);   // the sampled polygon lies inside the ellipse by about this factor
    const z = b * Math.sqrt(Math.max(0, 1 - (ax / a) ** 2)) * k;
    return { z, yaw: sg * Math.atan2(ax / (a * a), Math.max(1e-6, z / (b * b))) };
  }
  const ct = Math.min(w, d) * (keel ?? F.keel);
  if (ax <= a - ct) return { z: b, yaw: 0 };
  return { z: b - (ax - (a - ct)), yaw: sg * Math.PI / 4 };
}

/**
 * Limb loft from a to c ([x, y, z], bone space) through profile stations [t, wShare, dShare, zOffset?] (t = 0 at a,
 * 1 at c; < 0 / > 1 extend past the joints). Base width w (x) and depth d (z). o = { points, keel, detail, caps }.
 * Triangles: points × 2 × (stations − 1) + 2 × (points − 2)  (6 points, 4 stations: 44). Returns the a → c length.
 */
export function limbLoft(b, kit, a, c, w, d, profile, s, { points, keel, detail, caps = true } = {}) {
  const len = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const sections = profile.map(([t, ws, ds, oz = 0]) => ({
    at: -t * len, outline: section(kit, w * ws, d * ds, { points, keel }), offset: [0, oz],
  }));
  const geo = loft(sections, { axis: 'y', caps, crease: familyOf(kit).crease });
  alignTo(geo, a, c, [0, -1, 0]);
  b.add(geo, s, detail === undefined ? {} : { detail });
  return len;
}

/**
 * Vertical hull loft (torso, pelvis, head): stations [{ y, w, d, x = 0, z = 0, keel, back }] bottom → top, placement t.
 * Triangles: points × 2 × (stations − 1) + 2 × (points − 2)  (8 points, 5 stations: 76).
 */
export function hullLoft(b, kit, stations, s, t = {}, { points } = {}) {
  const F = familyOf(kit);
  const sections = stations.map((st) => ({
    at: st.y, outline: section(kit, st.w, st.d, { points: points ?? F.hull, keel: st.keel, back: st.back }), offset: [st.x ?? 0, st.z ?? 0],
  }));
  return b.add(loft(sections, { axis: 'y', crease: F.crease }), s, t);
}

/**
 * Horizontal loft along Z (feet, gun housings): stations [{ z, w, h, x = 0, y = 0 }] back → front, outline (u = x, v = y).
 * Triangles as hullLoft.
 */
export function lengthLoft(b, kit, stations, s, t = {}, { points } = {}) {
  const F = familyOf(kit);
  const sections = stations.map((st) => ({
    at: st.z, outline: section(kit, st.w, st.h, { points: points ?? F.hull, keel: st.keel, back: st.back }), offset: [st.x ?? 0, st.y ?? 0],
  }));
  return b.add(loft(sections, { axis: 'z', crease: F.crease }), s, t);
}

/**
 * Armour panel w × h × th facing +Z with the style's corner shape (faceted: diamond hexagon, rounded / round: rounded
 * rectangle, angular: chamfered), bevelled front edge. o = { corner, r, tip, bevel, tilt (rad, lean about the panel's own
 * X before t rotates it – flared skirts) }. Triangles: ~32 (hex) … ~60 (round).
 */
export function armor(b, kit, w, h, th, s, t = {}, o = {}) {
  const F = familyOf(kit);
  const corner = o.corner ?? F.panel;
  const geo = panel(w, h, th, {
    corner, r: o.r, tip: o.tip, bevel: o.bevel, segments: ROBOT_SCULPT.panelRound, crease: F.panelCrease,
  });
  if (o.tilt) geo.rotateX(o.tilt);   // own lean (about the panel's X) before the placement turns it (t.ry)
  return b.add(geo, s, t);
}

/**
 * Hinge hub along X (radius r, length len) centred at t, style sides; rim = chamfered rims (visible knees / elbows).
 * Triangles: sides × 4 plain, sides × 8 with rims (6 sides: 24 / 48), boss adds sides × 4.
 */
export function hinge(b, kit, r, len, s, t = {}, { boss = null, rim = false } = {}) {
  const F = familyOf(kit);
  const geo = hub(r, len, { sides: F.hubSides, rim: rim ? ROBOT_SCULPT.hubRim : 0, boss, crease: F.hubCrease });
  return b.add(geo, s, { ...t, rz: HALF_PI });
}

/**
 * Hydraulic piston between two points of ONE bone: cylinder (radius r) from `from` to the share `split` of the way and
 * a thinner rod (r × rodShare) to `to`. Triangles: 2 × sides × 2 + caps ≈ 40 with 6 sides.
 */
export function piston(b, kit, from, to, r, sCyl, sRod, { split = 0.55, rodShare = 0.5, detail = 0 } = {}) {
  const n = ROBOT_SCULPT.pistonSides;
  const mid = [from[0] + (to[0] - from[0]) * split, from[1] + (to[1] - from[1]) * split, from[2] + (to[2] - from[2]) * split];
  const crease = familyOf(kit).hubCrease;
  b.add(tube([from, mid], r, n, { crease }), sCyl, { detail });
  b.add(tube([mid, to], r * rodShare, n, { crease }), sRod, { detail });
}

/** Curved hose / cable through points (CatmullRom sweep, radius r). Triangles: sides × 2 × hoseSegments + caps. */
export function hose(b, kit, points, r, s, { detail = 0, segments = ROBOT_SCULPT.hoseSegments } = {}) {
  const n = ROBOT_SCULPT.hoseSides;
  const crease = familyOf(kit).hubCrease === 0 ? ROBOT_SCULPT.hoseCrease.facet : ROBOT_SCULPT.hoseCrease.smooth;
  b.add(sweep(polygon(n, 1, 1, Math.PI / n), points, { segments, radius: r, crease }), s, { detail });
}
