// Steel Men – procedural shape library ("modeller" geometry): pure factories of THREE.BufferGeometry built from 2D
// profiles – lathe, bevelled / rounded extrusion, sweep along a CatmullRom curve, loft through N cross-sections,
// rounded / chamfered panels, chamfered boxes – plus 2D profile helpers (rounded rectangle, arc, chamfer / fillet of
// corners, Bézier, ellipse, offset, resample).
// Contract of every geometry factory (fits UnitBuilder paint `PartBuilder.add(geo, s, t)` of UnitKit and ProcKit,
// GlowPainter.add, and plain meshes):
//   • NON-indexed BufferGeometry with exactly two attributes: `position` and `normal` (no uv, no groups) – PartBuilder
//     writes colour / aSurface, adds the index and projects the uvs after merging; GlowPainter keeps the position only
//   • normals by crease angle (creaseNormals): faces meeting under the crease share a smooth normal, sharper edges stay
//     hard. crease 0 = flat facets, 180 = fully smooth. Outward facing, counter-clockwise front faces
//   • degenerate triangles (poles, collapsed rings) are dropped
// Detail (= triangle count, LOD levels) is always a parameter (segments, profile points). Construction time only: the
// factories allocate freely and must never run per frame – build once into a cache (UnitKit createUnitCache, ProcModules
// shared cache). No randomness: same input → same geometry. See docs/notes/proc-shapes.md.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** Library tuning */
export const PROC_SHAPES = {
  weld: 1e-4,            // positions closer than this share normals (crease grouping grid)
  minArea2: 1e-12,       // triangles with |cross|² below this are dropped (degenerate)
  miterLimit: 3,         // offsetOutline: a corner moves at most this × the offset distance
  crease: 35,            // default crease angle (degrees)
  clampShare: 0.999,     // chamfers / radii are clamped to this share of the half size
  panel: { corner: 0.2, bevel: 0.35 },   // panel defaults: corner size × min(w, h), front bevel × thickness
  boxChamferMax: 0.3,    // chamferBox: chamfer at most this × the smallest side (the inset front face stays valid)
  bevelMaxEdge: 0.45,    // bevelCorners: cut at most this share of the shorter edge
};

// ---------------------------------------------------------------- 2D profiles (THREE.Vector2[], CCW, no repeated end point)

const v2 = (x, y) => new THREE.Vector2(x, y);
const toV2 = (p) => (p.isVector2 ? p.clone() : v2(p[0], p[1]));

/** Signed area of a closed outline (> 0 = counter-clockwise) */
export function signedArea(outline) {
  let a = 0;
  for (let i = 0, n = outline.length; i < n; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Copy of the outline in counter-clockwise order */
export function ccw(outline) {
  const out = outline.map(toV2);
  return signedArea(out) < 0 ? out.reverse() : out;
}

/**
 * Regular n-gon / sampled ellipse (radii rx, ry), CCW, first vertex at angle `phase` (rad, 0 = +x).
 * polygon(6, r, r, Math.PI / 6) = hexagon with flat top / bottom.
 */
export function polygon(n, rx, ry = rx, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (TAU * i) / n;
    out.push(v2(Math.cos(a) * rx, Math.sin(a) * ry));
  }
  return out;
}

/** Ellipse w × h sampled with `segments` points, CCW (first point at −half a step, so x = ±w/2 lies on a flat side) */
export function ellipse(w, h, segments) {
  return polygon(segments, w / 2, h / 2, -Math.PI / segments);
}

/**
 * Rectangle w × h (centred) with 45° chamfered corners: 8 points, CCW, starting on the right side at the bottom.
 * c = chamfer leg; { top, bottom } override the chamfer of the +y / −y corners (a pointed "keel" = big top chamfer).
 * A chamfer 0 repeats the corner point (the point count stays 8 – lofts need matching counts).
 */
export function chamferRect(w, h, c, { top = c, bottom = c } = {}) {
  const a = w / 2;
  const b = h / 2;
  const lim = Math.min(a, b) * PROC_SHAPES.clampShare;
  const ct = Math.min(Math.max(0, top), lim);
  const cb = Math.min(Math.max(0, bottom), lim);
  return [
    v2(a, -b + cb), v2(a, b - ct), v2(a - ct, b), v2(-a + ct, b),
    v2(-a, b - ct), v2(-a, -b + cb), v2(-a + cb, -b), v2(a - cb, -b),
  ];
}

/**
 * Elongated hexagon w × h with points at ±y (diamond-cut limb section): sides x = ±w/2 run from −k·h/2 to +k·h/2.
 * 6 points, CCW. k = 0 → rhombus, k → 1 → rectangle with pointed ends.
 */
export function diamondHex(w, h, k = 0.5) {
  const a = w / 2;
  const b = h / 2;
  return [v2(a, -b * k), v2(a, b * k), v2(0, b), v2(-a, b * k), v2(-a, -b * k), v2(0, -b)];
}

/** Rectangle w × h with rounded corners (radius r, `segments` per quarter): 4·(segments + 1) points, CCW */
export function roundedRect(w, h, r, segments = 3) {
  const a = w / 2;
  const b = h / 2;
  const rr = Math.min(Math.max(0, r), Math.min(a, b) * PROC_SHAPES.clampShare);
  const out = [];
  const corners = [[a - rr, -b + rr, -Math.PI / 2], [a - rr, b - rr, 0], [-a + rr, b - rr, Math.PI / 2], [-a + rr, -b + rr, Math.PI]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segments; i++) {
      const t = a0 + (Math.PI / 2) * (i / segments);
      out.push(v2(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr));
    }
  }
  return out;
}

/**
 * Shield / knee-cap outline w × h: flat top with chamfered corners, sides narrowing to a point at the bottom.
 * tip = share of the height taken by the pointed bottom part, chamfer = top corner chamfer (share of w). 6 points, CCW.
 */
export function shield(w, h, { tip = 0.4, chamfer = 0.18, tipW = 0 } = {}) {
  const a = w / 2;
  const b = h / 2;
  const c = w * chamfer;
  const yk = -b + h * tip;
  return [v2(a, yk), v2(a, b - c), v2(a - c, b), v2(-a + c, b), v2(-a, yk), v2(-tipW / 2, -b)].concat(tipW > 0 ? [v2(tipW / 2, -b)] : []);
}

/** Open arc polyline: centre (cx, cy), radius r, angles a0 → a1 (rad), `segments` steps → segments + 1 points */
export function arc(cx, cy, r, a0, a1, segments) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const a = a0 + (a1 - a0) * (i / segments);
    out.push(v2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return out;
}

/** Cubic Bézier polyline p0 → p3 (control p1, p2; [x, y] or Vector2): segments + 1 points */
export function bezier(p0, p1, p2, p3, segments) {
  return new THREE.CubicBezierCurve(toV2(p0), toV2(p1), toV2(p2), toV2(p3)).getPoints(segments);
}

/** Quadratic Bézier polyline p0 → p2 (control p1): segments + 1 points */
export function quadBezier(p0, p1, p2, segments) {
  return new THREE.QuadraticBezierCurve(toV2(p0), toV2(p1), toV2(p2)).getPoints(segments);
}

/**
 * Facets (fazety) / fillets of the corners of a closed outline: every corner is cut `size` along both edges
 * (clamped to 45 % of the shorter edge). segments 1 = straight chamfer, ≥ 2 = rounded fillet (quadratic arc through the
 * corner). `only` = optional array of corner indices to treat. Returns a new CCW outline.
 */
export function bevelCorners(outline, size, segments = 1, only = null) {
  const src = ccw(outline);
  const n = src.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = src[i];
    if (only && !only.includes(i)) { out.push(p.clone()); continue; }
    const prev = src[(i + n - 1) % n];
    const next = src[(i + 1) % n];
    const lp = p.distanceTo(prev);
    const ln = p.distanceTo(next);
    const s = Math.min(size, lp * PROC_SHAPES.bevelMaxEdge, ln * PROC_SHAPES.bevelMaxEdge);
    if (s <= 0) { out.push(p.clone()); continue; }
    const a = p.clone().lerp(prev, s / lp);
    const b = p.clone().lerp(next, s / ln);
    if (segments <= 1) { out.push(a, b); continue; }
    const pts = quadBezier(a, p, b, segments);
    for (const q of pts) out.push(q);
  }
  return out;
}

/**
 * Parallel outline at distance d (> 0 outward, < 0 inward) with mitred corners (miter limited to
 * PROC_SHAPES.miterLimit × |d|). Same point count. Exact for convex outlines, fine for mild concavities.
 */
export function offsetOutline(outline, d) {
  const src = ccw(outline);
  const n = src.length;
  const out = [];
  const e1 = new THREE.Vector2();
  const e2 = new THREE.Vector2();
  const m = new THREE.Vector2();
  for (let i = 0; i < n; i++) {
    const p = src[i];
    // skip repeated neighbours (chamfer 0) so the miter direction is defined
    let ip = (i + n - 1) % n;
    while (ip !== i && src[ip].distanceToSquared(p) < 1e-12) ip = (ip + n - 1) % n;
    let inx = (i + 1) % n;
    while (inx !== i && src[inx].distanceToSquared(p) < 1e-12) inx = (inx + 1) % n;
    e1.subVectors(p, src[ip]).normalize();
    e2.subVectors(src[inx], p).normalize();
    // outward normals of a CCW outline: (dy, −dx)
    const n1x = e1.y; const n1y = -e1.x;
    const n2x = e2.y; const n2y = -e2.x;
    m.set(n1x + n2x, n1y + n2y);
    if (m.lengthSq() < 1e-12) m.set(n1x, n1y);
    m.normalize();
    const cos = Math.max(1 / PROC_SHAPES.miterLimit, m.x * n1x + m.y * n1y);
    out.push(v2(p.x + (m.x * d) / cos, p.y + (m.y * d) / cos));
  }
  return out;
}

/** Closed outline resampled to n points evenly by arc length (loft between outlines of different point counts) */
export function resample(outline, n) {
  const src = outline.map(toV2);
  const m = src.length;
  const cum = [0];
  for (let i = 0; i < m; i++) cum.push(cum[i] + src[i].distanceTo(src[(i + 1) % m]));
  const total = cum[m];
  const out = [];
  let k = 0;
  for (let j = 0; j < n; j++) {
    const s = (total * j) / n;
    while (k < m - 1 && cum[k + 1] < s) k++;
    const seg = cum[k + 1] - cum[k];
    const t = seg > 0 ? (s - cum[k]) / seg : 0;
    out.push(src[k].clone().lerp(src[(k + 1) % m], t));
  }
  return out;
}

/** Outline scaled (sx, sy) and moved (ox, oy) – a new array */
export function transformOutline(outline, sx = 1, sy = sx, ox = 0, oy = 0) {
  return outline.map((p) => v2(p.x * sx + ox, p.y * sy + oy));
}

// ---------------------------------------------------------------- normals

/**
 * Writes `normal` of a NON-indexed geometry by crease angle (degrees): a vertex averages (area weighted) the normals of
 * the faces around its position that are within `crease` of its own face. 0 = flat facets, ≥ 180 = smooth.
 * Indexed input is converted (the input is disposed then). Returns the geometry.
 */
export function creaseNormals(geo, crease = PROC_SHAPES.crease) {
  let g = geo;
  if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
  const pos = g.attributes.position.array;
  const n = g.attributes.position.count;
  const tris = Math.floor(n / 3);
  const fn = new Float32Array(tris * 3);
  const fu = new Float32Array(tris * 3);
  for (let t = 0; t < tris; t++) {
    const o = t * 9;
    const ax = pos[o + 3] - pos[o]; const ay = pos[o + 4] - pos[o + 1]; const az = pos[o + 5] - pos[o + 2];
    const bx = pos[o + 6] - pos[o]; const by = pos[o + 7] - pos[o + 1]; const bz = pos[o + 8] - pos[o + 2];
    const cx = ay * bz - az * by; const cy = az * bx - ax * bz; const cz = ax * by - ay * bx;
    const l = Math.hypot(cx, cy, cz) || 1;
    fn[t * 3] = cx; fn[t * 3 + 1] = cy; fn[t * 3 + 2] = cz;
    fu[t * 3] = cx / l; fu[t * 3 + 1] = cy / l; fu[t * 3 + 2] = cz / l;
  }
  const inv = 1 / PROC_SHAPES.weld;
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(pos[i * 3] * inv)}|${Math.round(pos[i * 3 + 1] * inv)}|${Math.round(pos[i * 3 + 2] * inv)}`;
    let list = groups.get(key);
    if (!list) { list = []; groups.set(key, list); }
    list.push(i);
  }
  const cosC = crease >= 180 ? -2 : Math.cos(crease * DEG) - 1e-6;
  const nor = new Float32Array(n * 3);
  for (const list of groups.values()) {
    for (const i of list) {
      const ti = Math.floor(i / 3) * 3;
      let x = 0; let y = 0; let z = 0;
      for (const j of list) {
        const tj = Math.floor(j / 3) * 3;
        if (fu[ti] * fu[tj] + fu[ti + 1] * fu[tj + 1] + fu[ti + 2] * fu[tj + 2] < cosC) continue;
        x += fn[tj]; y += fn[tj + 1]; z += fn[tj + 2];
      }
      const l = Math.hypot(x, y, z);
      if (l > 0) { nor[i * 3] = x / l; nor[i * 3 + 1] = y / l; nor[i * 3 + 2] = z / l; }
      else { nor[i * 3] = fu[ti]; nor[i * 3 + 1] = fu[ti + 1]; nor[i * 3 + 2] = fu[ti + 2]; }
    }
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

// ---------------------------------------------------------------- triangle sink + ring surfaces (internal)

const _ab = new THREE.Vector3();
const _ac = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();

class TriSink {
  constructor() { this.p = []; }

  /** Adds triangle a, b, c (Vector3); flipped when its normal points against `dir` (optional) */
  tri(a, b, c, dir = null) {
    _ab.subVectors(b, a);
    _ac.subVectors(c, a);
    _n.crossVectors(_ab, _ac);
    if (_n.lengthSq() < PROC_SHAPES.minArea2) return;
    if (dir && _n.dot(dir) < 0) { const t = b; b = c; c = t; }
    this.p.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  geometry(crease) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    return creaseNormals(g, crease);
  }
}

const centroid = (ring, out) => {
  out.set(0, 0, 0);
  for (const p of ring) out.add(p);
  return out.multiplyScalar(1 / ring.length);
};

/**
 * Surface through rings of 3D points (Vector3[][], all rings the same length). closed = rings are loops.
 * orient: 'auto' (one winding for the whole surface, chosen so faces point away from the ring centres – sections,
 * sweeps, extrusions), 'right' (normal = ring direction × ring-to-ring direction – lathe convention), 'left'.
 * capStart / capEnd close the first / last ring (planar polygon, triangulated, facing away from the neighbour ring).
 */
export function ringSurface(rings, { closed = true, capStart = false, capEnd = false, orient = 'auto', crease = PROC_SHAPES.crease } = {}) {
  const sink = new TriSink();
  const K = rings.length;
  const M = rings[0].length;
  const cents = rings.map((r) => centroid(r, new THREE.Vector3()));
  const span = closed ? M : M - 1;
  let flip = orient === 'left';
  if (orient === 'auto') {
    // majority vote of the 'right' winding against the outward direction (ring centres → face)
    let vote = 0;
    const mid = new THREE.Vector3();
    const dir = new THREE.Vector3();
    for (let k = 0; k < K - 1; k++) {
      for (let i = 0; i < span; i++) {
        const a = rings[k][i]; const b = rings[k][(i + 1) % M]; const c = rings[k + 1][(i + 1) % M];
        _ab.subVectors(b, a); _ac.subVectors(c, a); _n.crossVectors(_ab, _ac);
        mid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
        dir.copy(cents[k]).add(cents[k + 1]).multiplyScalar(0.5);
        dir.subVectors(mid, dir);
        vote += Math.sign(_n.dot(dir)) * _n.length();
      }
    }
    flip = vote < 0;
  }
  for (let k = 0; k < K - 1; k++) {
    for (let i = 0; i < span; i++) {
      const a = rings[k][i]; const b = rings[k][(i + 1) % M];
      const c = rings[k + 1][(i + 1) % M]; const d = rings[k + 1][i];
      if (flip) { sink.tri(a, c, b); sink.tri(a, d, c); } else { sink.tri(a, b, c); sink.tri(a, c, d); }
    }
  }
  if (capStart && K > 1) capRing(sink, rings[0], _c.subVectors(cents[0], cents[1]));
  if (capEnd && K > 1) capRing(sink, rings[K - 1], _c.subVectors(cents[K - 1], cents[K - 2]));
  return sink.geometry(crease);
}

// Planar cap of a ring (Newell normal → 2D → earcut), every triangle facing `dir`
function capRing(sink, ring, dir) {
  const nrm = new THREE.Vector3();
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]; const q = ring[(i + 1) % n];
    nrm.x += (p.y - q.y) * (p.z + q.z);
    nrm.y += (p.z - q.z) * (p.x + q.x);
    nrm.z += (p.x - q.x) * (p.y + q.y);
  }
  if (nrm.lengthSq() < 1e-16) return;   // collapsed ring (pole)
  nrm.normalize();
  const u = new THREE.Vector3().set(1, 0, 0);
  if (Math.abs(nrm.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(nrm.clone().multiplyScalar(nrm.dot(u))).normalize();
  const w = new THREE.Vector3().crossVectors(nrm, u);
  const pts = ring.map((p) => v2(p.dot(u), p.dot(w)));
  const faces = THREE.ShapeUtils.triangulateShape(pts, []);
  const d = dir.lengthSq() > 1e-16 ? dir.clone() : nrm;
  for (const [a, b, c] of faces) sink.tri(ring[a], ring[b], ring[c], d);
}

// 2D outline (u, v) placed on an axis at `at` → Vector3 ring
function placeRing(outline, axis, at, ou = 0, ov = 0) {
  return outline.map((p) => {
    const u = p.x + ou;
    const v = p.y + ov;
    if (axis === 'x') return new THREE.Vector3(at, v, u);
    if (axis === 'z') return new THREE.Vector3(u, v, at);
    return new THREE.Vector3(u, at, v);   // 'y': u → x, v → z (+v = front +Z)
  });
}

// ---------------------------------------------------------------- geometry factories

/**
 * Lathe (rotation) of a profile around Y: profile = [[r, y], …] (or Vector2 x = r), the surface faces the RIGHT of the
 * walking direction in the (r → right, y ↑) plane – i.e. walk the outside bottom → top; start / end at r = 0 to close.
 * o = { segments = 12, phase = 0 (rad, first meridian; θ = 0 → +Z), arc = TAU (open arcs get segments + 1 meridians),
 *       crease (deg; flat-shaded facets = 0) }.
 */
export function lathe(profile, { segments = 12, phase = 0, arc: sweepArc = TAU, crease = PROC_SHAPES.crease } = {}) {
  const full = sweepArc >= TAU - 1e-6;
  const meridians = full ? segments : segments + 1;
  const rings = profile.map((p) => {
    const r = p.isVector2 ? p.x : p[0];
    const y = p.isVector2 ? p.y : p[1];
    const ring = [];
    for (let i = 0; i < meridians; i++) {
      const a = phase + (sweepArc * i) / segments;
      ring.push(new THREE.Vector3(r * Math.sin(a), y, r * Math.cos(a)));
    }
    return ring;
  });
  return ringSurface(rings, { closed: full, orient: 'right', crease });
}

/**
 * Loft through N cross-sections along an axis (default 'y'). sections: [{ at, outline (Vector2[], all the same point
 * count – see resample), offset: [ou, ov], scale: [su, sv] }]. Outline axes: axis 'y' → (u = x, v = z, +v = front),
 * 'z' → (u = x, v = y), 'x' → (u = z, v = y). o = { caps = true (both ends) | { start, end }, crease }.
 * Example: thigh from an oval to a hexagon – [{ at: 0, outline: ellipse(3, 3.4, 6) }, { at: -7, outline: diamondHex(2, 2.6) }].
 */
export function loft(sections, { axis = 'y', caps = true, crease = PROC_SHAPES.crease } = {}) {
  const rings = sections.map((s) => {
    const [su, sv] = s.scale ?? [1, 1];
    const [ou, ov] = s.offset ?? [0, 0];
    const outline = su === 1 && sv === 1 ? s.outline : transformOutline(s.outline, su, sv);
    return placeRing(outline, axis, s.at, ou, ov);
  });
  const capStart = caps === true || !!caps?.start;
  const capEnd = caps === true || !!caps?.end;
  return ringSurface(rings, { closed: true, capStart, capEnd, crease });
}

/**
 * Extrusion of a closed 2D outline (x, y) along Z, centred (z −depth/2 … +depth/2), front face +Z.
 * o = { bevel = 0 (size, both inset and depth), bevelSegments = 1 (1 = chamfer, ≥ 2 = rounded), front = true / back = true
 *       (bevel that face; an unbevelled face stays sharp), capFront = true, capBack = true, crease }.
 * Triangles ≈ points × 2 × (bands) + 2 × (points − 2).
 */
export function extrude(outline, depth, {
  bevel = 0, bevelSegments = 1, front = true, back = true, capFront = true, capBack = true, crease = PROC_SHAPES.crease,
} = {}) {
  const src = ccw(outline);
  const h = depth / 2;
  const b = Math.min(Math.max(0, bevel), h * PROC_SHAPES.clampShare);
  const rings = [];
  const ring = (inset, z) => rings.push(placeRing(inset > 0 ? offsetOutline(src, -inset) : src, 'z', z));
  const bs = Math.max(1, bevelSegments);
  if (back && b > 0) {
    for (let s = 0; s <= bs; s++) { const f = (Math.PI / 2) * (s / bs); ring(b * (1 - Math.sin(f)), -h + b * (1 - Math.cos(f))); }
  } else ring(0, -h);
  if (front && b > 0) {
    for (let s = bs; s >= 0; s--) { const f = (Math.PI / 2) * (s / bs); ring(b * (1 - Math.sin(f)), h - b * (1 - Math.cos(f))); }
  } else ring(0, h);
  return ringSurface(rings, { closed: true, capStart: capBack, capEnd: capFront, orient: 'right', crease });
}

/**
 * Sweep of a closed cross-section along a CatmullRom curve through `points` ([x, y, z] or Vector3).
 * o = { segments = 8 (steps along the curve), radius = 1 (scale of the section: number, array per control point
 *       (interpolated) or function t → r), closed = false (loop path), caps = true, crease, curveType = 'centripetal' }.
 * Section axes: u = curve normal, v = binormal (Frenet frames, three's parallel-transport variant).
 * Hydraulic hoses, cables, curved pipes, tapering horns.
 */
export function sweep(section, points, {
  segments = 8, radius = 1, closed = false, caps = true, crease = PROC_SHAPES.crease, curveType = 'centripetal',
} = {}) {
  const pts = points.map((p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2])));
  const curve = new THREE.CatmullRomCurve3(pts, closed, curveType);
  const frames = curve.computeFrenetFrames(segments, closed);
  const rAt = (t) => {
    if (typeof radius === 'function') return radius(t);
    if (Array.isArray(radius)) {
      if (radius.length < 2) return radius[0] ?? 1;
      const f = t * (radius.length - 1);
      const i = Math.min(radius.length - 2, Math.floor(f));
      return radius[i] + (radius[i + 1] - radius[i]) * (f - i);
    }
    return radius;
  };
  const sec = section.map(toV2);
  const rings = [];
  const count = closed ? segments : segments + 1;
  for (let k = 0; k < count; k++) {
    const t = k / segments;
    const c = curve.getPointAt(t);
    const N = frames.normals[k];
    const B = frames.binormals[k];
    const r = rAt(t);
    rings.push(sec.map((p) => c.clone().addScaledVector(N, p.x * r).addScaledVector(B, p.y * r)));
  }
  if (closed) rings.push(rings[0]);
  return ringSurface(rings, { closed: true, capStart: caps && !closed, capEnd: caps && !closed, crease });
}

/**
 * Tube (round section) along a straight segment or a curve – shortcut for sweep(polygon(sides, r), points, …).
 * Use sides 5–8 for robot-size pistons and hoses.
 */
export function tube(points, r, sides = 6, o = {}) {
  return sweep(polygon(sides, 1, 1, Math.PI / sides), points, { segments: points.length > 2 ? 6 : 1, ...o, radius: o.radius ?? r });
}

/**
 * Armour panel w × h (thickness th along Z, centred, front face +Z) with shaped corners and a bevelled front edge.
 * o = { corner: 'chamfer' | 'round' | 'hex' | 'shield' (outline kind), r (corner size, default 0.2 × min side),
 *       segments (rounded corner steps, default 2), outline (own Vector2[] wins), bevel (front edge, default 0.35 × th),
 *       bevelSegments = 1, back = false (bevel the back too), crease }.
 * Triangles: chamfer 8 points → 2·8·(1 + bevelSegments) + 12 (≈ 44 with a 1-step bevel).
 */
export function panel(w, h, th, {
  corner = 'chamfer', r, segments = 2, outline, bevel, bevelSegments = 1, back = false, crease = PROC_SHAPES.crease, tip,
} = {}) {
  const c = r ?? Math.min(w, h) * PROC_SHAPES.panel.corner;
  let shape = outline;
  if (!shape) {
    if (corner === 'round') shape = roundedRect(w, h, c, segments);
    else if (corner === 'hex') shape = diamondHex(w, h, Math.max(0, 1 - (2 * c) / h));
    else if (corner === 'shield') shape = shield(w, h, { tip: tip ?? 0.4, chamfer: c / w });
    else shape = chamferRect(w, h, c);
  }
  return extrude(shape, th, { bevel: bevel ?? th * PROC_SHAPES.panel.bevel, bevelSegments, front: true, back, crease });
}

/**
 * Box w × h × d (centred) with every edge chamfered (c) – 60 triangles (vs. 108 of a 1-segment rounded box).
 * segments ≥ 2 rounds the four edges around Z instead (more triangles).
 */
export function chamferBox(w, h, d, c, { segments = 1, crease = PROC_SHAPES.crease } = {}) {
  const cc = Math.min(c, Math.min(w, h, d) * PROC_SHAPES.boxChamferMax);
  const outline = segments > 1 ? roundedRect(w, h, cc, segments) : chamferRect(w, h, cc);
  return extrude(outline, d, { bevel: cc, bevelSegments: 1, crease });
}

/**
 * Hinge / hub along Y (radius r, length len, centred): a prism of `sides` with chamfered rims (rim = chamfer size,
 * share of r) and optional end bosses (boss = [radius share, height]). Flat facets with crease 0.
 * Triangles: sides × (6 + boss ? 4 : 0) roughly.
 */
export function hub(r, len, { sides = 8, rim = 0.18, boss = null, phase, crease = PROC_SHAPES.crease } = {}) {
  const h = len / 2;
  const c = Math.min(r * rim, h * 0.45);
  const prof = [];
  if (boss) {
    const [bs, bh] = boss;
    prof.push([0, -h - bh], [r * bs, -h - bh], [r * bs, -h]);
  } else prof.push([0, -h]);
  prof.push([r - c, -h], [r, -h + c], [r, h - c], [r - c, h]);
  if (boss) { const [bs, bh] = boss; prof.push([r * bs, h], [r * bs, h + bh], [0, h + bh]); } else prof.push([0, h]);
  return lathe(prof, { segments: sides, phase: phase ?? Math.PI / sides, crease });
}

// ---------------------------------------------------------------- placement helpers

const _q = new THREE.Quaternion();
const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Rotates a geometry so its local `localAxis` (default −Y) points from `from` to `to` (minimal rotation – pick the
 * local axis closest to the target direction, else the section may turn front-to-back) and moves its origin to `from`.
 * Returns the distance from → to.
 */
export function alignTo(geo, from, to, localAxis = [0, -1, 0]) {
  _from.set(localAxis[0], localAxis[1], localAxis[2]).normalize();
  _dir.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const len = _dir.length();
  if (len > 0) {
    _dir.multiplyScalar(1 / len);
    _q.setFromUnitVectors(_from, _dir);
    geo.applyQuaternion(_q);
  }
  geo.translate(from[0], from[1], from[2]);
  return len;
}

/** Triangle count of a factory result (non-indexed) */
export const shapeTriangles = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
