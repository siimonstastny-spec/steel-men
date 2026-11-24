// Steel Men – procedural combat robot kit (experiment, preview only). A robot = legs + torso + left arm + right arm
// generated in code and assembled into ONE ProcUnit skeleton (UnitKit): 3 draw calls (paint, glow, emblem) + shadow for
// the whole robot, geometry shared per (style, part combination). The rig copies the GLB RobotPartsBasic layout:
//   • same sockets (config SOCKETS): socket_TorsoMount on the pelvis, socket_ArmLeft (−x) / socket_ArmRight (+x) on the
//     chest, weapon muzzles socket_Launch_n (MUZZLE.socketPatterns); the robot faces +Z
//   • same joint chain and rest positions as the GLB part nodes (pelvis → thigh → shin → foot, chest → head,
//     shoulder → elbow → fist), flagged userData.gltfNode / userData.rest, so AnimLibrary.bindPart could retarget the
//     existing clips onto them (option B in docs/notes/proc-robot-kit.md)
//   • wrapper bones per slot ('legs', 'torso', 'armL', 'armR') = where ModularMech hangs the part objects
// Animation is procedural (option A): gait cycle from the movement speed, torso bob / sway, punch, turret aim and bursts,
// sensors – ProcRobot.update, no clips, no allocations, no Math.random / performance.now (visual only).
// Part shapes come from registered part builders (RobotLegs.js, RobotTorsos.js, RobotArms.js); primitives follow
// style.silhouette (rounded | angular | round | faceted) and colours the style kit, never faction names.
// Sculpted forms (lofts, panels, hubs – RobotSculpt.js on ProcShapes.js) carry the look; part builders get the ROBOT kit
// (robotKit: style kit with robot paint – lighter dark palettes, toned-down gloss, neutral emblem plate).
// createProcRobotPart builds one arm alone (arm wreck) from the same part builders.
import * as THREE from 'three';
import { smootherstep, place } from '../ProcKit.js';
import { UnitBuilder, ProcUnit, createUnitCache, UNIT_KIT } from '../units/UnitKit.js';
import { chamferBox } from '../ProcShapes.js';
import { SOCKETS } from '../../config.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Kit tuning (raw GLB model units like RobotPartsBasic: a basic robot ≈ 31 high; seconds, radians) */
export const ROBOT_KIT = {
  defaultTeamColor: '#3a5ccc',
  defaults: { legs: 'basic', torso: 'basic', leftArm: 'fist', rightArm: 'fist' },
  sockets: { ...SOCKETS, launch: 'socket_Launch_', sfx: 'socket_SFX_1', aim: 'aim', smoke: 'smoke' },
  // wrapper bone of every slot (the part's root, where ModularMech hangs the GLB part object)
  slotBones: { legs: 'legs', torso: 'torso', leftArm: 'armL', rightArm: 'armR' },
  sides: { leftArm: { sign: -1, suffix: 'L' }, rightArm: { sign: 1, suffix: 'R' } },   // socket_ArmLeft at −x
  // style.edges are building-sized: robot blocks use radius × edgeScale, at most maxEdgeSegments (triangle budget)
  edges: { scale: 1.6, maxShare: 0.3, minRadius: 0.06, minSide: 0.8, maxSegments: 1 },
  seg: 8,                  // radial segments of round primitives
  sphereSeg: [6, 4],        // ellipsoid blocks (round silhouette; 36 triangles)
  plateSphereSeg: [6, 4],   // ellipsoid plates
  jointSphereSeg: [6, 4],   // ball joints
  jointSides: 6,           // faceted / rounded hinge prism
  facet: { chamfer: 0.22, top: 0.88 },   // faceted blocks: vertical edge chamfer (× smaller side), top face scale
  neon: { t: 0.14, out: 0.04 },        // light line thickness, lift off the surface
  emblemOut: 0.03,
  // Robot paint (every style, robotKit): dark palettes get a lightness floor per surface role (HSL in sRGB) so robots
  // read against the ground and in shadow with a steady light → dark ladder (frame > hull > hullDark > dark); glossy
  // metal (no environment map → near black) is toned down. plate = neutral emblem backing slab (never team).
  paint: {
    roles: {
      hull: { light: 0.46, metal: 0.42, rough: 0.42 },
      hullDark: { light: 0.3, metal: 0.38, rough: 0.5 },
      frame: { light: 0.6, metal: 0.5, rough: 0.38 },
      pipe: { light: 0.64, metal: 0.5, rough: 0.35 },
      dark: { light: 0.12, metal: 0.25, rough: 0.7 },
    },
    plate: { color: '#c9ccd1', metal: 0.15, rough: 0.55 },
    // full robot palette per silhouette (data key, not a faction): replaces the role colour / gloss outright.
    // faceted: light cream metal body, mid grey secondary, dark only on joints and mechanics (big team surfaces carry it)
    bySilhouette: {
      faceted: {
        hull: { color: '#d3cfc4', metal: 0.3, rough: 0.45 },
        hullDark: { color: '#8f9197', metal: 0.35, rough: 0.5 },
        frame: { color: '#4a4e57', metal: 0.45, rough: 0.42 },
        pipe: { color: '#9ca0a8', metal: 0.5, rough: 0.38 },
        dark: { color: '#18191d', metal: 0.25, rough: 0.7 },
      },
    },
  },
  budget: { triangles: 2500, drawCalls: 4, teamShare: 0.25 },   // per robot at LOD0 – buildRobot warns when broken
  anim: {
    blend: 5,              // 1/s – walk weight follows the speed
    minWalk: 0.05,         // walk weight under which the legs stop cycling
    minCadence: 0.45,      // cycles/s while turning on the spot / very slow
    breathHz: 0.25, breath: 0.12,      // idle chest bob (units)
    lookHz: 0.13, look: 0.35,          // idle head look-around (rad)
    lean: 0.06,                        // chest forward lean at full walk
    counterTwist: 1.3,                 // chest yaw against the pelvis twist
    rollFollow: 0.5,                   // chest roll share of the pelvis sway
    armSwing: 0.32,                    // rad, arms against the legs
    elbowSwing: 0.18,
    // crewless pose (the pelvis drop follows from hip / knee through the ground contact; `drop` is no longer used)
    power: { blend: 1.5, hip: 0.42, knee: 0.85, drop: 1.6, slump: 0.32, headDroop: 0.35, elbow: 0.25 },
    hit: { time: 0.45, pitch: 0.14, roll: 0.12, freq: 2 },            // hit reaction (chest jolt)
    punch: {               // timeline shares of the attack + target angles (shoulder / elbow rx, − = forward)
      windup: 0.3, strike: 0.48, hold: 0.62,
      backShoulder: 0.45, backElbow: -1.2, strikeShoulder: -1.45, strikeElbow: -0.1, twist: 0.22, fistRoll: 0.3,
      defaultTime: 1.5,
    },
    turret: { yawRate: 2.4, pitchRate: 1.6, scanHz: 0.12, scanArc: 0.9, scanPitch: 0.55 },
    burst: { defaultShots: 4, share: 0.7 },   // a torso attack fires its burst in the first share of the attack time
    // gun arms (attack 'gun'): forearm held forward (elbow), raised to aim during an attack; burst of `shots` spread over
    // `share` of the attack time after the `raise` share; kick = elbow recoil jitter while firing (rad, Hz)
    gun: { holdElbow: -1.45, holdShoulder: -0.08, aimShoulder: -0.3, aimElbow: -1.5, raise: 0.15, share: 0.75, kick: 0.035, kickHz: 11, defaultShots: 16, swing: 0.35 },
    visor: { idle: 0.75, depth: 0.25, hz: 0.6 },
  },
};

const E = ROBOT_KIT.edges;
const A = ROBOT_KIT.anim;
const HIDDEN = UNIT_KIT.hiddenScale;

// ---------------------------------------------------------------- part registry

const PARTS = { legs: new Map(), torso: new Map(), arm: new Map() };

/**
 * Registers a part builder. kind 'legs' | 'torso' | 'arm'.
 * def = { label, build(ub, kit, ctx) → info } – see RobotLegs / RobotTorsos / RobotArms for the per-kind contract.
 */
export function registerRobotPart(kind, id, def) {
  if (!PARTS[kind]) throw new Error(`[RobotKit] unknown part kind "${kind}"`);
  PARTS[kind].set(id, def);
}

/** Registered part ids { legs: [...], torso: [...], arm: [...] } */
export function robotPartIds() {
  return { legs: [...PARTS.legs.keys()], torso: [...PARTS.torso.keys()], arm: [...PARTS.arm.keys()] };
}

const KIND_OF = { legs: 'legs', torso: 'torso', leftArm: 'arm', rightArm: 'arm' };
const SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];

/** Normalises a part combination; unknown ids fall back to the defaults (warning). arm = '' / null → no arm. */
export function resolveRobotCombo(combo = {}) {
  const out = {};
  for (const slot of SLOTS) {
    let id = combo[slot] ?? ROBOT_KIT.defaults[slot];
    const optional = slot === 'leftArm' || slot === 'rightArm';
    if (optional && (id === '' || id === null || id === false)) { out[slot] = ''; continue; }
    if (!PARTS[KIND_OF[slot]].has(id)) {
      console.warn(`[RobotKit] no ${slot} part "${id}", using "${ROBOT_KIT.defaults[slot]}"`);
      id = ROBOT_KIT.defaults[slot];
    }
    out[slot] = id;
  }
  return out;
}

const comboKey = (c) => `${c.legs}|${c.torso}|${c.leftArm}|${c.rightArm}`;
function parseCombo(key) {
  const [legs, torso, leftArm, rightArm] = key.split('|');
  return { legs, torso, leftArm, rightArm };
}

// ---------------------------------------------------------------- robot kit (style kit + robot paint)

const robotKits = new Map();   // style key -> robot kit
const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Style kit with robot paint (ROBOT_KIT.paint): surface roles lifted to a lightness floor, metal / roughness clamped,
 * plus S.plate (neutral emblem backing). Same key / style / glow colours as the style kit. Cached per style.
 */
export function robotKit(kit) {
  if (kit.isRobotKit) return kit;
  let rk = robotKits.get(kit.key);
  if (rk) return rk;
  const R = ROBOT_KIT.paint;
  const S = { ...kit.S };
  for (const [role, r] of Object.entries(R.roles)) {
    const s = kit.S[role];
    if (!s) continue;
    const own = R.bySilhouette[kit.style.silhouette]?.[role];
    if (own) {
      S[role] = { ...s, color: new THREE.Color(own.color), metal: own.metal, rough: own.rough };
      continue;
    }
    const color = s.color.clone();
    color.getHSL(_hsl, THREE.SRGBColorSpace);
    if (_hsl.l < r.light) color.setHSL(_hsl.h, _hsl.s, r.light, THREE.SRGBColorSpace);
    S[role] = { ...s, color, metal: Math.min(s.metal, r.metal), rough: Math.max(s.rough, r.rough) };
  }
  S.plate = { color: new THREE.Color(R.plate.color), team: 0, metal: R.plate.metal, rough: R.plate.rough, glow: 0 };
  rk = Object.freeze({ ...kit, S: Object.freeze(S), isRobotKit: true });
  robotKits.set(kit.key, rk);
  return rk;
}

// Area share of team-masked triangles in a paint geometry (indexed, aSurface.x = team mask) – build time only
function teamShareOf(geo) {
  const pos = geo.attributes.position;
  const surf = geo.attributes.aSurface;
  const idx = geo.index;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let total = 0;
  let team = 0;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    const area = b.sub(a).cross(c.sub(a)).length() / 2;
    total += area;
    if (surf.getX(i0) > 0.5) team += area;
  }
  return total > 0 ? team / total : 0;
}

// ---------------------------------------------------------------- style primitives (construction time only)

const SHAPE_BY_SILHOUETTE = {
  rounded: { block: 'rounded', limb: 'cylinder', joint: 'cylinder', plate: 'rounded' },
  angular: { block: 'tapered', limb: 'tapered', joint: 'box', plate: 'tapered' },
  round: { block: 'ellipsoid', limb: 'cylinder', joint: 'sphere', plate: 'ellipsoid' },
  faceted: { block: 'prism', limb: 'diamond', joint: 'prism', plate: 'prism' },
};
/** Primitive kinds of a style (by silhouette) */
export const shapeOf = (kit) => SHAPE_BY_SILHOUETTE[kit.style.silhouette] ?? SHAPE_BY_SILHOUETTE.rounded;

/** Angular blocks / limbs narrow towards one end by this share */
const ANGULAR_TAPER = 0.82;

/** Flat-shaded copy of a geometry (faceted look); the input is disposed */
export function flat(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;   // toNonIndexed warns (and returns itself) when already non-indexed
  if (g !== geo) geo.dispose();
  g.computeVertexNormals();
  return g;
}

function edgeRadius(kit, w, h, d, scale = 1) {
  const e = kit.style.edges;
  const minSide = Math.min(w, h, d);
  const r = Math.min(e.radius * E.scale * scale, minSide * E.maxShare);
  const seg = Math.min(e.segments, E.maxSegments);
  return seg < 1 || r < E.minRadius || minSide < E.minSide ? 0 : r;
}

/**
 * Main volume centred at t (w × h × d): rounded → chamfered box, angular → tapered box (top narrower), round →
 * ellipsoid, faceted → chamfered octagonal prism with a narrowed top (facetGeometry).
 */
export function block(b, kit, w, h, d, s, t = {}) {
  const kind = shapeOf(kit).block;
  if (kind === 'prism') return b.add(facetGeometry(w, h, d), s, t);
  if (kind === 'ellipsoid') {
    const [ws, hs] = ROBOT_KIT.sphereSeg;
    return b.add(new THREE.SphereGeometry(1, ws, hs), s, { ...t, sx: w / 2, sy: h / 2, sz: d / 2 });
  }
  if (kind === 'tapered') return b.taperedBox(w, w * ANGULAR_TAPER, h, d, s, { ...t, y: (t.y ?? 0) - h / 2 }, d * ANGULAR_TAPER);
  const r = edgeRadius(kit, w, h, d);
  return r > 0 ? b.add(chamferBox(w, h, d, r), s, t) : b.box(w, h, d, s, t);   // 60 triangles (rounded box: 108)
}

/** z of the front surface of a block of depth d at mid height (decals, plates) */
export function blockFront(kit, d) {
  const kind = shapeOf(kit).block;
  if (kind === 'tapered') return (d / 2) * (1 + ANGULAR_TAPER) / 2;
  if (kind === 'prism') return (d / 2) * (1 + ROBOT_KIT.facet.top) / 2;
  return d / 2;
}

/**
 * Front face of a block (h × d, centred) at height yRel above its centre: { z, tilt } – z of the surface, tilt = how
 * far the face leans back (rad; rx = −tilt lays a plate flat on it, decal normal [0, sin tilt, cos tilt]).
 */
export function blockFace(kit, h, d, yRel = 0) {
  const kind = shapeOf(kit).block;
  const taper = kind === 'prism' ? ROBOT_KIT.facet.top : kind === 'tapered' ? ANGULAR_TAPER : 1;
  const k = Math.min(1, Math.max(0, yRel / h + 0.5));   // 0 bottom … 1 top
  if (kind === 'ellipsoid') {
    const e = Math.min(1, Math.abs(2 * yRel / h));
    return { z: (d / 2) * Math.sqrt(1 - e * e), tilt: 0 };
  }
  return { z: (d / 2) * (1 - (1 - taper) * k), tilt: Math.atan(((1 - taper) * d) / 2 / h) };
}

/**
 * Faceted block (centred): octagonal prism = box with chamfered vertical edges (chamfer = facet.chamfer × smaller of
 * w / d), top face narrowed by facet.top – sharp, precise bevels with flat front / side faces for plates and decals.
 * 28 triangles.
 */
function facetGeometry(w, h, d) {
  const F = ROBOT_KIT.facet;
  const c = Math.min(w, d) * F.chamfer;
  const x = w / 2;
  const z = d / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x - c, -z);
  shape.lineTo(x, -z + c);
  shape.lineTo(x, z - c);
  shape.lineTo(x - c, z);
  shape.lineTo(-x + c, z);
  shape.lineTo(-x, z - c);
  shape.lineTo(-x, -z + c);
  shape.lineTo(-x + c, -z);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments: 1 });
  g.deleteAttribute('uv');
  g.rotateX(-HALF_PI);           // shape y → −z, extrusion z → +y
  g.translate(0, -h / 2, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    if (pos.getY(i) <= 0) continue;
    pos.setX(i, pos.getX(i) * F.top);
    pos.setZ(i, pos.getZ(i) * F.top);
  }
  return flat(g);
}

/**
 * Limb segment hanging DOWN from t.y (top at t.y, length len), width w (x), depth d (z), bottom scaled by `taper`.
 * rounded / round → cylinder (elliptic), angular → tapered box, faceted → diamond prism (edge to the front).
 */
export function limb(b, kit, w, len, d, s, t = {}, taper = 1) {
  const kind = shapeOf(kit).limb;
  const y = (t.y ?? 0) - len / 2;
  if (kind === 'tapered') {
    const g = new THREE.BoxGeometry(w, len, d);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      if (pos.getY(i) > 0) continue;
      pos.setX(i, pos.getX(i) * taper * ANGULAR_TAPER);
      pos.setZ(i, pos.getZ(i) * taper * ANGULAR_TAPER);
    }
    g.computeVertexNormals();
    return b.add(g, s, { ...t, y });
  }
  if (kind === 'diamond') {
    return b.add(flat(new THREE.CylinderGeometry(1, taper, 1, 4, 1, false)), s, { ...t, y, sx: w / 2, sy: len, sz: d / 2 });
  }
  return b.add(new THREE.CylinderGeometry(1, taper, 1, ROBOT_KIT.seg, 1, false), s, { ...t, y, sx: w / 2, sy: len, sz: d / 2 });
}

const _la = new THREE.Vector3();
const _lc = new THREE.Vector3();
const _ld = new THREE.Vector3();
const _lq = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);

/**
 * Limb segment from point a to point c ([x, y, z], bone-local), extended by o.top past a and o.bottom past c; width w
 * (x), depth d, bottom scaled by o.taper. Same shapes as limb(). Returns the segment length.
 */
export function limbBetween(b, kit, a, c, w, d, s, { top = 0, bottom = 0, taper = 1, detail } = {}) {
  _la.fromArray(a);
  _lc.fromArray(c);
  _ld.subVectors(_lc, _la);
  const span = _ld.length();
  _ld.normalize();
  const len = span + top + bottom;
  const tmp = new PartBuilderShim();
  limb(tmp, kit, w, len, d, s, { y: len / 2 }, taper);   // centred at the origin, hanging along −y
  const geo = tmp.geo;
  _lq.setFromUnitVectors(_down, _ld);
  geo.applyQuaternion(_lq);
  const mid = (span + bottom - top) / 2;   // centre along the direction, measured from a
  geo.translate(_la.x + _ld.x * mid, _la.y + _ld.y * mid, _la.z + _ld.z * mid);
  b.add(geo, s, detail === undefined ? {} : { detail });
  return span;
}

// Captures the raw geometry a primitive writer would add (limbBetween re-places it before adding it for real)
class PartBuilderShim {
  add(geo, s, t) { place(geo, t); this.geo = geo; return this; }
  taperedBox() { throw new Error('[RobotKit] shim: unsupported'); }
}

/** Hinge along X centred at t (radius r, length len): cylinder / box / sphere / hex prism by style */
export function joint(b, kit, r, len, s, t = {}) {
  const kind = shapeOf(kit).joint;
  if (kind === 'sphere') return b.sphere(r, ROBOT_KIT.jointSphereSeg[0], ROBOT_KIT.jointSphereSeg[1], s, { ...t, sx: Math.max(1, len / (2 * r)) });
  if (kind === 'box') return b.box(len, r * 2, r * 2, s, t);
  const sides = kind === 'prism' ? ROBOT_KIT.jointSides : ROBOT_KIT.seg;
  const g = new THREE.CylinderGeometry(r, r, len, sides);
  return b.add(kind === 'prism' ? flat(g) : g, s, { ...t, rz: HALF_PI });
}

/**
 * Armour plate facing +Z centred at t (w × h, thickness th): rounded → chamfered slab, angular → tapered slab,
 * round → flattened ellipsoid, faceted → diamond-cut hexagon (pointed top and bottom).
 */
export function plate(b, kit, w, h, th, s, t = {}) {
  const kind = shapeOf(kit).plate;
  if (kind === 'prism') {
    const g = new THREE.CylinderGeometry(1, 1, 1, 6, 1, false);
    g.rotateX(HALF_PI);   // hexagon in the XY plane (pointed top / bottom), thickness along Z – t rotations stay free
    return b.add(flat(g), s, { ...t, sx: w / 2, sy: h / 2, sz: th });
  }
  if (kind === 'ellipsoid') {
    const [ws, hs] = ROBOT_KIT.plateSphereSeg;
    return b.add(new THREE.SphereGeometry(1, ws, hs), s, { ...t, sx: w / 2, sy: h / 2, sz: th / 2 });
  }
  if (kind === 'tapered') return b.taperedBox(w, w * ANGULAR_TAPER, h, th, s, { ...t, y: (t.y ?? 0) - h / 2 });
  const r = edgeRadius(kit, w, h, th);
  return r > 0 ? b.add(chamferBox(w, h, th, r), s, t) : b.box(w, h, th, s, t);
}

/**
 * Prism along Z (cross-section `sides`-gon w × h, length len) centred at t, flat-shaded. Flat top/bottom faces.
 * pointed = true makes it a cone (apex at +Z) – toes, claws, spikes.
 */
export function prismZ(b, sides, w, h, len, s, t = {}, pointed = false) {
  const geo = new THREE.CylinderGeometry(pointed ? 0 : 1, 1, 1, sides, 1, false, Math.PI / sides);
  return b.add(flat(geo), s, { rx: HALF_PI, ...t, sx: w / 2, sy: len, sz: h / 2 });
}

/** Thin light line (paint neon) of length len along `axis` ('x' | 'y' | 'z') centred at t */
export function lightLine(b, kit, len, axis, t = {}) {
  const n = ROBOT_KIT.neon.t;
  const w = axis === 'x' ? len : n;
  const h = axis === 'y' ? len : n;
  const d = axis === 'z' ? len : n;
  return b.box(w, h, d, kit.S.neon, { detail: 0, ...t });
}

/** Hazard / light marking strip facing +Z, only where the style has markings (style.markings) */
export function markingStrip(b, kit, len, h, t = {}) {
  const m = kit.style.markings;
  if (m === 'hazard') return b.hazardStrip(len, h, h, kit.S.accent, kit.S.dark, { detail: 0, ...t });
  if (m === 'light') return lightLine(b, kit, len, 'x', t);
  return b;
}

// ---------------------------------------------------------------- shared data (one per style + combination)

/**
 * Builds the shared data of one part combination. Order: legs (bones 'legs' → 'pelvis' …, socket_TorsoMount),
 * torso on the 'torso' wrapper at the mount (bones 'chest' …, arm sockets), arms on 'armL' / 'armR' at the sockets.
 * Rig data for ProcRobot goes to meta.robot (plain data, bone names only).
 */
function buildRobot(styleKitIn, variant) {
  const combo = parseCombo(variant);
  const kit = robotKit(styleKitIn);
  const ub = new UnitBuilder(styleKitIn);
  const S = ROBOT_KIT.sockets;
  const robot = { gltfNodes: [], legs: null, torso: null, arms: {}, extras: { spin: [], sway: [], pulse: [] }, teamShare: 0 };
  ub.meta.robot = robot;
  const ctxBase = { robot, sockets: S };

  const legs = PARTS.legs.get(combo.legs).build(ub, kit, { ...ctxBase, bone: ROBOT_KIT.slotBones.legs });
  robot.legs = legs.rig;
  ub.socket(S.torso, 'pelvis', legs.mount);
  ub.bone(ROBOT_KIT.slotBones.torso, 'pelvis', legs.mount, { far: true });   // every slot = own far group + pick proxy
  const torso = PARTS.torso.get(combo.torso).build(ub, kit, { ...ctxBase, bone: ROBOT_KIT.slotBones.torso });
  robot.torso = torso.rig;
  for (const slot of ['leftArm', 'rightArm']) {
    const side = ROBOT_KIT.sides[slot];
    const at = torso.arms[slot];
    ub.socket(S[slot], 'chest', at);
    const wrapper = ROBOT_KIT.slotBones[slot];
    ub.bone(wrapper, 'chest', at, { far: true });   // own far LOD group: a lost / swinging arm stays right far away
    if (!combo[slot]) continue;
    const arm = PARTS.arm.get(combo[slot]).build(ub, kit, { ...ctxBase, bone: wrapper, side: side.sign, sfx: side.suffix, slot });
    robot.arms[slot] = arm.rig;
  }
  ub.socket(S.aim, 'chest', torso.aim);
  ub.socket(S.smoke, 'chest', torso.smoke ?? torso.aim);
  const data = ub.build();
  robot.teamShare = teamShareOf(data.paint);
  checkBudget(kit, variant, data, robot.teamShare);
  return data;
}

// Console warning when a combination breaks the unit budget (ROBOT_KIT.budget) – build time, once per style + combo
function checkBudget(kit, variant, data, teamShare) {
  const B = ROBOT_KIT.budget;
  const calls = 1 + (data.glow ? 1 : 0) + (data.emblem ? 1 : 0);
  if (data.triangles > B.triangles || calls > B.drawCalls || teamShare < B.teamShare) {
    console.warn(`[RobotKit] ${kit.key} ${variant}: ${data.triangles} triangles, ${calls} draw calls, team ${teamShare.toFixed(3)} (budget ${B.triangles} / ${B.drawCalls} / ≥ ${B.teamShare})`);
  }
}

const ROBOT_CACHE = createUnitCache(buildRobot);

/** Marks a bone as a GLB-like node (AnimLibrary retargeting – option B). Call from part builders, construction time. */
export function gltfNode(ctx, name) { ctx.robot.gltfNodes.push(name); return name; }

// ---------------------------------------------------------------- ProcRobot

const SLOT_OF_BONE = Object.fromEntries(Object.entries(ROBOT_KIT.slotBones).map(([slot, b]) => [b, slot]));
// Pick proxies are never drawn: one shared invisible material for all of them (never disposed, holds no GPU resource)
const PROXY_MATERIAL = new THREE.MeshBasicMaterial({ visible: false });

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const wrap =(a) => (a > TAU || a < -TAU ? a % TAU : a);
const lerp = (a, b, k) => a + (b - a) * k;
const approach = (v, target, maxStep) => (v < target ? Math.min(target, v + maxStep) : Math.max(target, v - maxStep));
// 0 → 1 (eased over `edge`) → hold → 1 → 0 (eased over the last `edge`) across u ∈ [0, 1]
const plateauEase = (u, edge) => (u < edge ? smootherstep(u / edge) : u > 1 - edge ? smootherstep((1 - u) / edge) : 1);

/**
 * Procedural robot model (THREE.Group, forward +Z, origin on the ground between the feet). Owner API, all visual:
 *   setGait(speed, turn)        units/s (signed) and yaw rate rad/s – drives the walk cycle (= ProcUnit.setMotion)
 *   playAttack(slot, duration, shots)  'leftArm' | 'rightArm' → arm attack (fist: punch, gun arm: raise + burst with
 *                               spinning barrels), 'torso' → turret burst
 *   setAim(yaw, pitch) / clearAim()   torso turret aim relative to the chest (rad)
 *   setPowered(on)              crew on board: stand ready / crewless: power-down crouch, visor off
 *   hit(direction)              'front' | 'back' | 'left' | 'right' – chest jolt
 *   setPartVisible(slot, on)    lost arm (wrapper bone hidden, also in the far LOD)
 *   setClipDriven(on)           GLB clips drive the body (option B), getPartProxy(slot) pick / bounds mesh of a part
 *   getSocket(name), getSlotBone(slot), tick(dt), stats(), dispose() (ProcUnit)
 */
export class ProcRobot extends ProcUnit {
  /**
   * @param {object} o  { race, teamColor, legs, torso, leftArm, rightArm } (part ids, '' = no arm)
   */
  constructor({ race, teamColor = ROBOT_KIT.defaultTeamColor, ...parts } = {}) {
    const combo = resolveRobotCombo(parts);
    super({ race, teamColor, cache: ROBOT_CACHE, variant: comboKey(combo), type: 'procRobot', name: 'ProcRobot' });
    this.isProcRobot = true;
    this.combo = combo;
    this.walkW = 0; this.gaitPhase = 0;
    this.powered = true; this.powerW = 0;
    this.hitTimer = 0; this.hitPitch = 0; this.hitRoll = 0;
    this.aimYaw = 0; this.aimPitch = 0; this.aimSet = false;
    this.burstLeft = 0; this.burstTimer = 0; this.burstInterval = 0; this.burstIndex = 0;
    this.clipDriven = false;
    try {
      this.#initRig(this.shared.meta.robot);
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  #initRig(r) {
    const bone = (name) => {
      const b = this.getBone(name);
      if (!b) throw new Error(`[ProcRobot] rig names unknown bone "${name}"`);
      return b;
    };
    // GLB-like nodes for AnimLibrary.bindPart (option B); the rest pose is the bone's build pose
    for (const name of r.gltfNodes) {
      const b = bone(name);
      b.userData.gltfNode = true;
      b.userData.rest = { p: b.position.toArray(), q: b.quaternion.toArray() };
    }
    const L = r.legs;
    this.pelvis = bone(L.pelvis);
    this.pelvisY = this.pelvis.position.y;
    this.legRig = {
      stride: L.stride, walkFull: L.walkFull, turnRadius: L.turnRadius, swing: L.swing, knee: L.knee,
      bob: L.bob, sway: L.sway, twist: L.twist, toe: L.toe ?? 0,
    };
    this.chains = L.chains.map((c) => {
      const thigh = bone(c.thigh);
      const shin = bone(c.shin);
      const foot = bone(c.foot);
      // hip / knee / ankle offsets for the ground contact of the pelvis (#body); fx = foot x in pelvis space (sway)
      return {
        phase: c.side > 0 ? 0 : Math.PI, thigh, shin, foot,
        hy: thigh.position.y, ky: shin.position.y, kz: shin.position.z, ay: foot.position.y, az: foot.position.z,
        fx: thigh.position.x + shin.position.x + foot.position.x,
      };
    });
    // lowest sole points of the foot (foot space [z, y, half width]: heel, toe, claw / spur tips) as a flat
    // [y, z, hw, …] list; hw = how far the edge reaches sideways (a rolled pelvis lowers the outer edge). Legs without
    // the data fall back to the ankle itself
    const soles = L.soles?.length ? L.soles : [[0, 0, 0]];
    this.soles = soles.flatMap(([z, y, hw = 0]) => [y, z, hw]);
    let soleMin = 0;
    for (let i = 0; i < this.soles.length; i += 3) soleMin = Math.min(soleMin, this.soles[i]);
    // lowest points carried by the shin (boot cuff, shin space [z, y, hw]) – they may dip below the sole when it tilts
    this.shinPts = (L.shinPoints ?? []).flatMap(([z, y, hw = 0]) => [y, z, hw]);
    let shinMin = 0;
    for (let i = 0; i < this.shinPts.length; i += 3) shinMin = Math.min(shinMin, this.shinPts[i]);
    const c0 = this.chains[0];
    // lowest point below the pelvis at rest (= the ground): the sole, unless a shin point already reaches lower
    this.restLowest = Math.min(c0.hy + c0.ky + c0.ay + soleMin, c0.hy + c0.ky + shinMin);
    const T = r.torso;
    this.chest = bone(T.chest);
    this.chestY = this.chest.position.y;
    this.head = T.head ? bone(T.head) : null;
    this.visor = T.visor ? bone(T.visor) : null;
    this.turret = T.turret ? {
      yaw: bone(T.turret.yaw), pitch: bone(T.turret.pitch), limitLo: T.turret.limits[0], limitHi: T.turret.limits[1], muzzles: T.turret.muzzles,
      shots: T.turret.shots ?? A.burst.defaultShots,
    } : null;
    this.arms = [];
    for (const slot of ['leftArm', 'rightArm']) {
      const a = r.arms[slot];
      if (!a) continue;
      this.arms.push({
        slot, side: ROBOT_KIT.sides[slot].sign, shoulder: bone(a.shoulder), elbow: bone(a.elbow), fist: bone(a.fist),
        attack: a.attack, fire: a.fire, timer: 0, duration: 1, struck: false,
        legPhase: ROBOT_KIT.sides[slot].sign > 0 ? Math.PI : 0,   // swings with the opposite leg
        // gun arms ('gun'): muzzle sockets, default burst, burst state (fired from update, also while clip driven)
        gun: a.attack === 'gun', muzzles: a.muzzles ?? [], shots: a.shots ?? A.gun.defaultShots,
        burstLeft: 0, burstTimer: 0, burstInterval: 0, burstIndex: 0,
      });
    }
    // pick proxy per slot: the coarsest far LOD of the slot's far group, invisible, child of the slot wrapper bone –
    // Raycaster hits it (ignores `visible`) and findMechPart climbs from it to the slot (MechPart.object = wrapper)
    this.partProxies = {};
    for (const f of this.shared.far) {
      const slot = SLOT_OF_BONE[f.name];
      const geo = f.lods[f.lods.length - 1] ?? f.lods.find(Boolean);
      if (!slot || !geo) continue;
      const m = new THREE.Mesh(geo, PROXY_MATERIAL);
      m.visible = false;
      m.name = `pickProxy_${slot}`;
      this.bones[f.bone].add(m);
      this.partProxies[slot] = m;
    }
    const X = r.extras;
    this.spins = X.spin.map((s) => ({ bone: bone(s.bone), axis: s.axis, speed: s.speed }));
    this.sways = X.sway.map((s, i) => {
      const b = bone(s.bone);
      return { bone: b, axis: s.axis, amp: s.amp, hz: s.hz, rest: b.rotation[s.axis], phase: s.phase ?? i * UNIT_KIT.phaseStep };
    });
    this.pulses = X.pulse.map((p) => ({ bone: bone(p.bone), depth: p.depth, hz: p.hz, phase: p.phase ?? 0 }));
  }

  // ---------- owner API ----------

  /** Walk drive: speed units/s (negative = backwards), turn = yaw rate rad/s (turning on the spot steps too) */
  setGait(speed, turn = 0) { this.setMotion(speed, turn); }

  /**
   * Attack animation of a slot: arms play their attack (punch); 'torso' fires the turret burst (shots spread over
   * ROBOT_KIT.anim.burst.share of the duration, each from the next socket_Launch_n). Returns false when the slot has none.
   * duration and shots should come from the weapon data (stats.json attackTime / burst); the defaults are visual only.
   */
  playAttack(slot = 'rightArm', duration = A.punch.defaultTime, shots = 0) {
    if (!this.shared) return false;
    if (slot === 'torso') {
      if (!this.turret) return false;
      const n = shots > 0 ? shots : this.turret.shots;
      this.burstLeft = n;
      this.burstInterval = (duration * A.burst.share) / n;
      this.burstTimer = 0;
      return true;
    }
    for (let i = 0; i < this.arms.length; i++) {
      const a = this.arms[i];
      if (a.slot !== slot) continue;
      a.timer = duration; a.duration = duration; a.struck = false;
      if (a.gun && a.muzzles.length) {
        const G = A.gun;
        const n = shots > 0 ? shots : a.shots;
        a.burstLeft = n;
        a.burstInterval = (duration * G.share) / n;
        a.burstTimer = duration * G.raise;   // first shot once the gun is up
      }
      return true;
    }
    return false;
  }

  /** Turret aim relative to the chest (yaw rad, + = towards +X… same as rotation.y; pitch rad, + = up), clamped */
  setAim(yaw, pitch = 0) { this.aimYaw = yaw; this.aimPitch = pitch; this.aimSet = true; }
  clearAim() { this.aimSet = false; }

  /** Crew on board (stands ready) or not (power-down crouch, visor off) */
  setPowered(on) { this.powered = !!on; }

  /**
   * true = the GLB-like nodes (pelvis, thighs…, chest, head, arms) are driven by MechAnimator clips (option B: AnimLibrary
   * retargeting): the procedural walk / torso / arm drive is skipped, turret, sensors and flashes keep running
   */
  setClipDriven(on) { this.clipDriven = !!on; }

  /** Hit reaction: 'front' | 'back' | 'left' | 'right' */
  hit(direction = 'front') {
    const H = A.hit;
    this.hitTimer = H.time;
    this.hitPitch = direction === 'front' ? -H.pitch : direction === 'back' ? H.pitch : 0;
    this.hitRoll = direction === 'left' ? H.roll : direction === 'right' ? -H.roll : 0;
  }

  /** Shows / hides a slot (lost arm): its wrapper bone collapses, which also hides it in the far LOD */
  setPartVisible(slot, visible) {
    const b = this.getSlotBone(slot);
    if (b) b.scale.setScalar(visible ? 1 : HIDDEN);
  }

  /** Wrapper bone of a slot ('legs' | 'torso' | 'leftArm' | 'rightArm') – the part root ModularMech would use */
  getSlotBone(slot) { return this.getBone(ROBOT_KIT.slotBones[slot]); }

  /** Invisible pick / bounds mesh of a slot (coarse LOD of that part, follows its bones) or null */
  getPartProxy(slot) { return this.partProxies?.[slot] ?? null; }

  /** Releases everything (ProcUnit.dispose) and drops the rig references (proxies use shared far geometry) */
  dispose() {
    super.dispose();
    this.partProxies = null;
    this.chains = this.arms = this.turret = null;
    this.spins = this.sways = this.pulses = null;
  }

  /** Rig summary for the console */
  describe() {
    return {
      race: this.race, combo: { ...this.combo }, ...this.stats(), teamShare: this.shared?.meta.robot.teamShare ?? 0,
      dims: this.dims, sockets: this.socketNames,
    };
  }

  // ---------- per frame (ProcUnit.tick → generic drivers → update) ----------

  update(dt) {
    if (!this.chains) return;   // rig not ready (constructor failed)
    const t = this.time;
    const G = this.legRig;
    const P = A.power;
    const drive = Math.abs(this.speedSmooth) + Math.abs(this.turnSmooth) * G.turnRadius;
    this.powerW = approach(this.powerW, this.powered ? 0 : 1, dt * P.blend);
    const walkTarget = this.powered ? clamp01(drive / G.walkFull) : 0;
    this.walkW += (walkTarget - this.walkW) * Math.min(1, dt * A.blend);
    const w = this.walkW;
    const pw = smootherstep(this.powerW);
    const cadence = w > A.minWalk ? Math.max(drive / G.stride, A.minCadence) : 0;
    const dir = this.speedSmooth < 0 ? -1 : 1;
    this.gaitPhase = wrap(this.gaitPhase + dir * TAU * cadence * dt);
    const phase = this.gaitPhase;

    if (!this.clipDriven) this.#body(dt, t, phase, w, pw);

    // turret: aim (or idle scan), burst
    if (this.turret) this.#turret(dt, t, pw);
    // gun arm bursts (muzzle flash + barrel spin via the ProcUnit fire map), also while GLB clips drive the body
    for (let i = 0; i < this.arms.length; i++) if (this.arms[i].burstLeft > 0) this.#gunBurst(this.arms[i], dt);

    // sensors / antennas
    const spin = this.kit.style.anim.spin ?? 1;
    for (let i = 0; i < this.spins.length; i++) {
      const sp = this.spins[i];
      sp.bone.rotation[sp.axis] = wrap(sp.bone.rotation[sp.axis] + sp.speed * spin * (1 - pw) * dt);
    }
    for (let i = 0; i < this.sways.length; i++) {
      const sw = this.sways[i];
      sw.bone.rotation[sw.axis] = sw.rest + sw.amp * (1 + w) * Math.sin(TAU * sw.hz * t + sw.phase);
    }
    for (let i = 0; i < this.pulses.length; i++) {
      const p = this.pulses[i];
      const v = (1 - pw) * (1 - p.depth * (0.5 + 0.5 * Math.sin(TAU * p.hz * t + p.phase)));
      p.bone.scale.setScalar(Math.max(HIDDEN, v));
    }
  }

  // Walk cycle, torso, head, visor and arms (skipped while GLB clips drive the GLB-like nodes – setClipDriven)
  #body(dt, t, phase, w, pw) {
    const G = this.legRig;
    const P = A.power;
    const dir = this.speedSmooth < 0 ? -1 : 1;
    // legs: hip swing (− = forward), knee lift while the foot travels forward, foot kept level (toe up while lifted)
    const s = Math.sin(phase);
    const rz = G.sway * w * s;
    const sinZ = Math.sin(rz);
    const cosZ = Math.cos(rz);
    const absZ = Math.abs(sinZ);
    const sole = this.soles;
    const shinPts = this.shinPts;
    let lowest = 0;   // lowest sole point below the pelvis (most negative y); rotations about X: y' = y cos − z sin
    for (let i = 0; i < this.chains.length; i++) {
      const c = this.chains[i];
      const ph = phase + c.phase;
      const swing = Math.sin(ph);
      const lift = Math.max(0, Math.cos(ph) * dir);
      const hip = -G.swing * swing * w - P.hip * pw;
      const knee = G.knee * lift * w + P.knee * pw;
      c.thigh.rotation.x = hip;
      c.shin.rotation.x = knee;
      const footRot = -(hip + knee) - G.toe * lift * w;
      c.foot.rotation.x = footRot;
      const kneeY = c.hy + c.ky * Math.cos(hip) - c.kz * Math.sin(hip);
      const cosS = Math.cos(hip + knee);   // shin pitch in pelvis space
      const sinS = Math.sin(hip + knee);
      const ankleY = kneeY + c.ay * cosS - c.az * sinS;
      // pelvis roll (rotation about Z): y' = x sin + y cos, the outer bottom edge (x = fx ± hw) is the lower one
      for (let k = 0; k < shinPts.length; k += 3) {
        const y = c.fx * sinZ - shinPts[k + 2] * absZ + (kneeY + shinPts[k] * cosS - shinPts[k + 1] * sinS) * cosZ;
        if (y < lowest) lowest = y;
      }
      const T = hip + knee + footRot;   // foot pitch in pelvis space
      const cosT = Math.cos(T);
      const sinT = Math.sin(T);
      for (let k = 0; k < sole.length; k += 3) {
        const y = c.fx * sinZ - sole[k + 2] * absZ + (ankleY + sole[k] * cosT - sole[k + 1] * sinT) * cosZ;
        if (y < lowest) lowest = y;
      }
    }
    // ground contact = the LAST height correction of the pelvis: it sinks / rises just enough to keep the lowest point
    // (sole edges, claws, boot cuff) on the ground. The walk bob and the crewless crouch come out of the leg angles
    // (rig.bob is no longer applied – an extra dip would push the feet into the ground)
    this.pelvis.position.y = this.pelvisY + (this.restLowest - lowest);
    this.pelvis.rotation.z = rz;
    this.pelvis.rotation.y = G.twist * w * s;

    // torso: counter twist, lean, breathing, slump when crewless, hit jolt
    let hitK = 0;
    if (this.hitTimer > 0) {
      this.hitTimer = Math.max(0, this.hitTimer - dt);
      const k = this.hitTimer / A.hit.time;
      hitK = k * Math.sin((1 - k) * Math.PI * A.hit.freq);
    }
    const idle = (1 - w) * (1 - pw);
    this.chest.rotation.y = -G.twist * A.counterTwist * w * s;
    this.chest.rotation.x = A.lean * w + P.slump * pw + this.hitPitch * hitK;
    this.chest.rotation.z = -G.sway * A.rollFollow * w * s + this.hitRoll * hitK;
    this.chest.position.y = this.chestY + A.breath * idle * Math.sin(TAU * A.breathHz * t + this.phase);
    if (this.head) {
      this.head.rotation.y = A.look * idle * Math.sin(TAU * A.lookHz * t + this.phase);
      this.head.rotation.x = P.headDroop * pw;
    }
    if (this.visor) {
      const V = A.visor;
      const on = 1 - pw;
      this.visor.scale.setScalar(on > 0 ? Math.max(HIDDEN, on * (V.idle + V.depth * Math.sin(TAU * V.hz * t + this.phase))) : HIDDEN);
    }

    // arms: swing against the legs, attack overlay
    for (let i = 0; i < this.arms.length; i++) this.#arm(this.arms[i], dt, phase, w, pw);
  }

  #gunBurst(a, dt) {
    a.burstTimer -= dt;
    if (a.burstTimer > 0) return;
    this.fire(a.muzzles[a.burstIndex % a.muzzles.length]);
    a.burstIndex = (a.burstIndex + 1) % a.muzzles.length;
    a.burstLeft--;
    a.burstTimer += a.burstInterval;
  }

  // Gun arm: forearm held forward (swinging a little with the walk), raised to aim during an attack, recoil jitter
  #gunArm(a, dt, phase, w, pw) {
    const G = A.gun;
    const swing = Math.sin(phase + a.legPhase);
    let shoulder = G.holdShoulder - A.armSwing * G.swing * swing * w;
    let elbow = lerp(G.holdElbow, -A.power.elbow, pw);
    if (a.timer > 0) {
      a.timer = Math.max(0, a.timer - dt);
      const u = 1 - a.timer / a.duration;
      const k = plateauEase(u, G.raise);
      shoulder = lerp(shoulder, G.aimShoulder, k);
      elbow = lerp(elbow, G.aimElbow, k);
      if (a.burstLeft > 0) elbow += G.kick * Math.sin(TAU * G.kickHz * this.time);
    }
    a.shoulder.rotation.x = shoulder;
    a.elbow.rotation.x = elbow;
    a.fist.rotation.z = 0;
  }

  #arm(a, dt, phase, w, pw) {
    if (a.gun) { this.#gunArm(a, dt, phase, w, pw); return; }
    const K = A.punch;
    const swing = Math.sin(phase + a.legPhase);
    let shoulder = -A.armSwing * swing * w;
    let elbow = -A.elbowSwing * (0.5 + 0.5 * swing) * w - A.power.elbow * pw;
    let twist = 0;
    let roll = 0;
    if (a.timer > 0) {
      a.timer = Math.max(0, a.timer - dt);
      const u = 1 - a.timer / a.duration;   // 0 → 1 over the attack
      let sh; let el; let k;
      if (u < K.windup) {                    // wind up: arm back, forearm bent
        k = smootherstep(u / K.windup);
        sh = lerp(shoulder, K.backShoulder, k); el = lerp(elbow, K.backElbow, k); twist = -K.twist * k;
      } else if (u < K.strike) {             // strike: arm forward, straight
        k = smootherstep((u - K.windup) / (K.strike - K.windup));
        sh = lerp(K.backShoulder, K.strikeShoulder, k); el = lerp(K.backElbow, K.strikeElbow, k);
        twist = lerp(-K.twist, K.twist, k); roll = K.fistRoll * k;
        if (!a.struck && k > 0.5) { a.struck = true; if (a.fire) this.fire(a.fire); }
      } else if (u < K.hold) {               // hold at full reach
        sh = K.strikeShoulder; el = K.strikeElbow; twist = K.twist; roll = K.fistRoll;
      } else {                               // recover to the walk pose
        k = smootherstep((u - K.hold) / (1 - K.hold));
        sh = lerp(K.strikeShoulder, shoulder, k); el = lerp(K.strikeElbow, elbow, k);
        twist = K.twist * (1 - k); roll = K.fistRoll * (1 - k);
      }
      shoulder = sh; elbow = el;
    }
    a.shoulder.rotation.x = shoulder;
    a.elbow.rotation.x = elbow;
    a.fist.rotation.z = roll * a.side;
    // the chest turns into a punch (shared by both arms – the latest one wins, fine for a preview)
    if (twist !== 0) this.chest.rotation.y += twist * -a.side;
  }

  #turret(dt, t, pw) {
    const tu = this.turret;
    const T = A.turret;
    const yaw = this.aimSet ? this.aimYaw : T.scanArc * Math.sin(TAU * T.scanHz * t + this.phase);
    const pitchRaw = (this.aimSet ? this.aimPitch : T.scanPitch) * (1 - pw);
    const lo = tu.limitLo;
    const hi = tu.limitHi;
    const pitch = pitchRaw < lo ? lo : pitchRaw > hi ? hi : pitchRaw;
    tu.yaw.rotation.y = approach(tu.yaw.rotation.y, yaw * (1 - pw), T.yawRate * dt);
    tu.pitch.rotation.x = approach(tu.pitch.rotation.x, -pitch, T.pitchRate * dt);
    if (this.burstLeft <= 0) return;
    this.burstTimer -= dt;
    if (this.burstTimer > 0) return;
    this.fire(tu.muzzles[this.burstIndex % tu.muzzles.length]);
    this.burstIndex = (this.burstIndex + 1) % tu.muzzles.length;
    this.burstLeft--;
    this.burstTimer += this.burstInterval;
  }
}

/** Creates a procedural robot (needs loadBuildingStyles() done and the part modules imported – RobotParts.js) */
export function createProcRobot(race, teamColor, parts = {}) {
  return new ProcRobot({ race, teamColor, ...parts });
}

// ---------------------------------------------------------------- single part (arm wreck)

/**
 * Shared data of ONE arm built alone (variant "slot|partId"): the same registered arm builder as in a robot, wrapper
 * bone (armL / armR) at the model origin = the arm socket, the arm hanging down along −Y, facing +Z. The wrapper is not
 * a far group of its own, so the root far group holds the whole arm (pick proxy + far LOD).
 */
function buildRobotPart(styleKitIn, variant) {
  const [slot, id] = variant.split('|');
  const def = PARTS.arm.get(id);
  const side = ROBOT_KIT.sides[slot];
  if (!def || !side) throw new Error(`[RobotKit] no arm part "${id}" for slot "${slot}"`);
  const kit = robotKit(styleKitIn);
  const ub = new UnitBuilder(styleKitIn);
  const robot = { gltfNodes: [], legs: null, torso: null, arms: {}, extras: { spin: [], sway: [], pulse: [] }, teamShare: 0 };
  ub.meta.robot = robot;
  const wrapper = ROBOT_KIT.slotBones[slot];
  ub.bone(wrapper, 'root');
  robot.arms[slot] = def.build(ub, kit, { robot, sockets: ROBOT_KIT.sockets, bone: wrapper, side: side.sign, sfx: side.suffix, slot }).rig;
  const data = ub.build();
  robot.teamShare = teamShareOf(data.paint);
  return data;
}

const PART_CACHE = createUnitCache(buildRobotPart);

/**
 * One robot arm as its own model (THREE.Group, ProcUnit): wreck of a lost arm (ArmWreck) – same geometry builders,
 * cached per (style, slot, part), ref-counted; dispose() releases it. Static pose (rest), sockets of the part
 * (e.g. socket_Launch_R1, socket_SFX_1_L), team colour / highlight / batching like any ProcUnit.
 */
export class ProcRobotPart extends ProcUnit {
  /** @param {object} o { race, teamColor, slot: 'leftArm' | 'rightArm', partId } */
  constructor({ race, teamColor = ROBOT_KIT.defaultTeamColor, slot = 'rightArm', partId = ROBOT_KIT.defaults.rightArm } = {}) {
    const side = ROBOT_KIT.sides[slot] ? slot : 'rightArm';
    const id = PARTS.arm.has(partId) ? partId : ROBOT_KIT.defaults[side];
    if (id !== partId) console.warn(`[RobotKit] no arm part "${partId}", using "${id}"`);
    super({ race, teamColor, cache: PART_CACHE, variant: `${side}|${id}`, type: 'procRobotPart', name: 'ProcRobotPart' });
    this.isProcRobotPart = true;
    this.slot = side;
    this.partId = id;
  }

  /** Wrapper bone of the arm (its root, at the model origin) */
  getSlotBone() { return this.getBone(ROBOT_KIT.slotBones[this.slot]); }

  describe() {
    return { race: this.race, slot: this.slot, partId: this.partId, ...this.stats(), teamShare: this.shared?.meta.robot.teamShare ?? 0, dims: this.dims };
  }
}

/** Creates one arm model (arm wreck): createProcRobotPart('W', '#3a5ccc', 'rightArm', 'gattling') */
export function createProcRobotPart(race, teamColor, slot, partId) {
  return new ProcRobotPart({ race, teamColor, slot, partId });
}
