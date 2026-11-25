// Steel Men – procedural robot legs, block A16: armorSpeedLegs, stealthLegs, chargeLegs, heavyShieldLegs, photonJetLegs.
// Same approach as RobotLegsB3.js: shared leg rig + body from RobotLegs.buildLegBase (bones legs → pelvis → thigh / shin / foot per
// side, socket_TorsoMount, soles, stride) with own proportions plus extras on the pelvis / thigh / shin / foot bones. Visual only
// (the simulation reads the hidden GLB body). Construction time only, no randomness. Shapes follow kit.style.silhouette through
// the kit primitives and the sculpt families; the code never knows a faction.
//   armorSpeedLegs  – fast legs in light armour: team thigh / shin plates, glowing heel vents
//   stealthLegs     – slim digitigrade runners with dark cloak panels and pulsing cloak emitter nodes
//   chargeLegs      – heavy bruiser legs: team ram wedge with a spike on the pelvis, knee spikes, heel boosters (glow)
//   heavyShieldLegs – heavy plated legs: tall team shield wings with glowing energy sheets, central emitter (socket_Attach_Shield)
//   photonJetLegs   – no feet: each leg ends in a photon nozzle with a hover glow (the robot "floats"); almost no stepping
import { registerRobotPart, prismZ } from './RobotKit.js';
import * as Legs from './RobotLegs.js';
import { LEG_B6_SHAPES } from './RobotLegsB6.js';
import { armor } from './RobotSculpt.js';
import { unitStyle } from '../units/UnitKit.js';

const { LEG_SHAPES, LEG_SCULPT } = Legs;
const HALF_PI = Math.PI / 2;
const PLATE_SINK = 0.15;     // plates sink into the surface by this
const GLOW_DIM = 0.6;        // intensity of small glow accents
const FRONT_SHARE = 0.46;    // pelvis front plane = z + this × depth (a little inside the hull)
const PHASE_STEP = 1.3;      // pulse phase offset between sibling glow nodes (rad)
const SEG_POD = 8;           // sides of nozzles / boosters
const SEG_RING = 10;         // sides of glow discs
const ORB_SEG = [5, 3];      // glow node (width, height segments)
const RING_SEG = { rounded: [3, 8], round: [3, 10], angular: [3, 6], faceted: [3, 6] };   // torus (radial, tubular) per silhouette
const RING_SEG_DEFAULT = [3, 8];
const GAIT = (g) => ({ bob: 0, ...g });
const HS = LEG_B6_SHAPES.highSpeed;
const AR = LEG_B6_SHAPES.armor;
const B = LEG_SHAPES.basic;

// ---------------------------------------------------------------- shapes

export const LEG_A16_SHAPES = {
  // between the light runners and the plated legs: a little stockier than highSpeed, thigh and shin plates in the team colour
  armorSpeedLegs: {
    ...B,
    hip: [3.0, -1.2, 2.1], knee: [0.4, -7.6, 0.5], ankle: [0, -10.5, -2.6], sole: 2.6, mount: [0, 0.2, 0.3],
    pelvis: { w: 5.0, h: 3.0, d: 5.0, y: -1.5, z: 2.1 },
    hipJoint: { r: 1.2, len: 2.0 },
    thigh: { w: 2.3, d: 2.7 },
    kneeJoint: { r: 1.2, len: 2.4 },
    boot: { w: 3.4, d: 3.6, lineAt: 0.4, lineLen: 4.4 },
    kneeShield: { w: 3.4, h: 3.8, th: 0.7, up: 0.4, tilt: 0.14 },
    foot: { w: 4.2, h: 2.2, len: 8.4, y: -1.5, z: 2.5, toes: 2, toeW: 0.8, toeH: 0.7, toeLen: 2.2, heelW: 1.2, heelH: 0.8, heelLen: 1.5 },
    keel: HS.keel, marking: HS.marking,
    sculpt: { boot: [[-0.04, 1.15, 1.1, 0.15], [0.25, 1.0, 1.0, 0.1], [0.65, 0.75, 0.8, 0.05], [0.92, 0.9, 0.95, 0.15], [1.05, 1.0, 1.15, 0.4]] },
    gait: GAIT({ walkFull: 16, turnRadius: 3.5, swing: 0.38, knee: 0.85, sway: 0.025, twist: 0.07, toe: 0.26 }),
    armorSpeed: {
      thigh: { at: 0.45, w: 3.2, h: 4.6, th: 0.55 },                     // team plate on the front of the thigh
      shin: { at: 0.55, w: 3.0, h: 3.6, th: 0.5 },                       // team plate on the front of the shin (above the boot cuff)
      vent: { at: 0.5, w: 0.5, h: 3.6, th: 0.14, intensity: 0.7 },       // glowing vent strip on the back of the boot
    },
  },
  // slim digitigrade legs, cloak panels and emitter nodes
  stealthLegs: {
    ...HS,
    fin: null,
    hip: [1.8, -1.0, 2.0], knee: [0.3, -8.4, 1.0], ankle: [0, -11.2, -3.5], sole: 2.4,
    gait: GAIT({ walkFull: 17, turnRadius: 3, swing: 0.4, knee: 0.95, sway: 0.02, twist: 0.08, toe: 0.28 }),
    stealth: {
      cape: { w: 4.6, h: 4.6, th: 0.3, y: -1.2, back: 0.45, tilt: 0.28 },   // dark cloak sheet hanging behind the pelvis
      thighCloak: { at: 0.4, w: 2.2, h: 5.2, th: 0.22, behind: 0.5 },      // dark cloak panel behind each thigh
      node: { r: 0.55, ring: 0.85, tube: 0.12, hz: 0.7, depth: 0.45, at: 0.62 },   // pulsing emitter on the outer thigh
      heel: { r: 0.45, hz: 0.9, depth: 0.4 },                              // emitter node on the heel
    },
  },
  // heavy bruiser legs: wide stance, ram wedge on the pelvis front, boosters
  chargeLegs: {
    ...AR,
    gait: GAIT({ walkFull: 12, turnRadius: 5, swing: 0.3, knee: 0.65, sway: 0.045, twist: 0.05, toe: 0.12 }),
    charge: {
      ram: { w: 6.8, h: 5.0, th: 1.3, y: -0.8, tilt: 0.12 },                // team ram wedge on the pelvis front
      horn: { w: 2.6, h: 2.6, len: 5.0 },                                   // spike on the ram
      kneeSpike: { w: 1.5, len: 2.8, y: -0.2 },                              // spike on each knee
      booster: { r: 1.0, rBack: 1.45, len: 3.0, at: 0.62, gap: 0.5, ring: 1.5, intensity: 0.8 },   // nozzle behind each shin
    },
  },
  // heavy plated legs with energy shield wings
  heavyShieldLegs: {
    ...AR,
    gait: GAIT({ walkFull: 10, turnRadius: 5, swing: 0.26, knee: 0.55, sway: 0.05, twist: 0.04, toe: 0.1 }),
    hshield: {
      thigh: { at: 0.42, w: 3.8, h: 4.6, th: 0.7 },                         // team thigh plate
      wing: { w: 3.0, h: 7.2, th: 0.7, dx: 1.5, y: 1.2 },                   // tall team wing standing over each hip
      sheet: { w: 0.12, h: 6.0, d: 3.2, intensity: 0.5 },                   // glowing energy sheet in the wing's shadow
      emitter: { r: 1.2, h: 0.9, y: -0.8, node: 0.7, socket: 'socket_Attach_Shield' },
    },
  },
  // hover legs: tiny feet hidden in a photon nozzle, no real step
  photonJetLegs: {
    ...HS,
    fin: null,
    hip: [2.4, -1.1, 2.1], knee: [0.3, -7.4, 0.4], ankle: [0, -10.0, -1.4], sole: 2.8,
    pelvis: { w: 4.6, h: 2.8, d: 4.6, y: -1.4, z: 2.1 },
    hipJoint: { r: 1.0, len: 1.8 },
    thigh: { w: 1.9, d: 2.3 },
    kneeJoint: { r: 1.0, len: 2.2 },
    boot: { w: 2.8, d: 3.0, lineAt: 0.4, lineLen: 4.4 },
    kneeShield: { w: 2.6, h: 3.0, th: 0.5, up: 0.4, tilt: 0.14 },
    foot: { w: 3.0, h: 2.4, len: 3.4, y: -1.6, z: 0.2, toes: 0, toeW: 0.5, toeH: 0.5, toeLen: 0.5, heelW: 0.5, heelH: 0.5, heelLen: 0.5 },
    sculpt: { foot: [[-0.5, 0.8, 0.9], [0, 1, 1], [0.5, 0.8, 0.9]], boot: [[-0.05, 0.95, 1, 0.2], [0.16, 0.8, 0.84], [0.62, 0.95, 0.95, 0.1], [0.9, 1.05, 1.05, 0.15], [1.1, 1.1, 1.1, 0.3]] },
    // stride is explicit: the walk cycle is very slow and shallow (the legs hang and sway, the robot floats)
    gait: GAIT({ walkFull: 20, turnRadius: 3, swing: 0.06, knee: 0.1, sway: 0.01, twist: 0.015, toe: 0, stride: 60 }),
    jet: {
      nozzle: { rTop: 1.2, rBottom: 2.1, len: 2.7, y: -1.5 },               // photon nozzle round the foot (bottom at the sole)
      ring: { r: 2.2, len: 0.25, y: -2.78 },                                // glow disc under the nozzle
      flame: { near: 1.6, far: 0.3, len: 3.4, intensity: 0.55, hz: 3.2, depth: 0.25 },   // always-on hover plume
    },
  },
};

// ---------------------------------------------------------------- helpers (construction time only)

const mirror = ([x, y, z], sign) => [x * sign, y, z];
const ringOf = (kit) => RING_SEG[kit.style?.silhouette] ?? RING_SEG_DEFAULT;
const pelvisFront = (D) => D.pelvis.z + D.pelvis.d * FRONT_SHARE;

/** Linear value of profile column `col` at share t (rows sorted by column 0; missing column → 0) */
function profileAt(profile, t, col) {
  const v = (row) => row[col] ?? 0;
  if (t <= profile[0][0]) return v(profile[0]);
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1];
    const b = profile[i];
    if (t <= b[0]) return v(a) + ((v(b) - v(a)) * (t - a[0])) / (b[0] - a[0]);
  }
  return v(profile[profile.length - 1]);
}

/** Point `dist` in front of (− = behind) a limb running from the bone origin to `end`, at share t; rx tilts a +Z panel with it */
function limbPoint(end, t, dist) {
  const rx = Math.atan2(-end[2], -end[1]);
  return { x: end[0] * t, y: end[1] * t - Math.sin(rx) * dist, z: end[2] * t + Math.cos(rx) * dist, rx };
}

/** Half depth of the boot / thigh at share t (profile col 2 = depth share) */
const halfDepth = (D, profile, base, t) => (base * profileAt(profile, t, 2)) / 2;

// ---------------------------------------------------------------- armorSpeedLegs

registerRobotPart('legs', 'armorSpeedLegs', {
  label: 'Armor speed legs',
  build(ub, kit, ctx) {
    const D = LEG_A16_SHAPES.armorSpeedLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const A = D.armorSpeed;
    const glow = kit.glowColors.laser;
    const bootProfile = D.sculpt.boot;
    for (const c of out.chains) {
      const knee = mirror(D.knee, c.side);
      const ankle = mirror(D.ankle, c.side);
      const td = halfDepth(D, LEG_SCULPT.thigh, D.thigh.d, A.thigh.at) + A.thigh.th / 2 - PLATE_SINK;
      const tp = limbPoint(knee, A.thigh.at, td);
      armor(ub.paint(c.thigh), kit, A.thigh.w, A.thigh.h, A.thigh.th, S.teamPaint, { x: tp.x, y: tp.y, z: tp.z, rx: tp.rx });
      const sd = halfDepth(D, bootProfile, D.boot.d, A.shin.at) + profileAt(bootProfile, A.shin.at, 3) + A.shin.th / 2 - PLATE_SINK;
      const sp = limbPoint(ankle, A.shin.at, sd);
      armor(ub.paint(c.shin), kit, A.shin.w, A.shin.h, A.shin.th, S.teamShade, { x: sp.x, y: sp.y, z: sp.z, rx: sp.rx });
      // glowing vent strip on the back of the boot
      const vp = limbPoint(ankle, A.vent.at, -(halfDepth(D, bootProfile, D.boot.d, A.vent.at) + A.vent.th / 2));
      ub.glow(c.shin).box(A.vent.w, A.vent.h, A.vent.th, glow, { x: vp.x, y: vp.y, z: vp.z, rx: vp.rx, intensity: A.vent.intensity });
    }
    return out;
  },
});

// ---------------------------------------------------------------- stealthLegs

registerRobotPart('legs', 'stealthLegs', {
  label: 'Stealth legs',
  build(ub, kit, ctx) {
    const D = LEG_A16_SHAPES.stealthLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const X = D.stealth;
    const glow = unitStyle(kit).weaponGlow;
    const ring = ringOf(kit);
    // dark cloak sheet behind the pelvis
    const P = D.pelvis;
    const Cp = X.cape;
    armor(ub.paint('pelvis'), kit, Cp.w, Cp.h, Cp.th, S.hullDark, { y: P.y + Cp.y, z: P.z - P.d / 2 - Cp.back, ry: Math.PI, rx: Cp.tilt });
    let i = 0;
    for (const c of out.chains) {
      const knee = mirror(D.knee, c.side);
      const ankle = mirror(D.ankle, c.side);
      const Tc = X.thighCloak;
      const back = limbPoint(knee, Tc.at, -(halfDepth(D, LEG_SCULPT.thigh, D.thigh.d, Tc.at) + Tc.behind));
      armor(ub.paint(c.thigh), kit, Tc.w, Tc.h, Tc.th, S.hullDark, { x: back.x, y: back.y, z: back.z, rx: back.rx, ry: Math.PI });
      // cloak emitter on the outer side of the thigh: team-coloured ring, pulsing glow node
      const N = X.node;
      const np = limbPoint(knee, N.at, 0);
      const nx = np.x + c.side * (D.thigh.w / 2 + 0.1);
      const node = ub.bone(`stealthNode${i}`, c.thigh, [nx, np.y, np.z]);
      // solid ring on the thigh (static); only the glow node pulses
      ub.paint(c.thigh).torus(N.ring, N.tube, ring[0], ring[1], Math.PI * 2, S.teamPaint, { x: nx, y: np.y, z: np.z, ry: HALF_PI });
      ub.glow(node).sphere(N.r, ORB_SEG[0], ORB_SEG[1], glow, { intensity: GLOW_DIM });
      ctx.robot.extras.pulse.push({ bone: node, depth: N.depth, hz: N.hz, phase: i * PHASE_STEP });
      // heel node
      const H = X.heel;
      const heel = ub.bone(`stealthHeel${i}`, c.shin, [ankle[0] * 0.9, ankle[1] * 0.9, ankle[2] * 0.9 - D.boot.d * 0.55]);
      ub.glow(heel).sphere(H.r, ORB_SEG[0], ORB_SEG[1], glow, { intensity: GLOW_DIM });
      ctx.robot.extras.pulse.push({ bone: heel, depth: H.depth, hz: H.hz, phase: i * PHASE_STEP + 0.5 });
      i += 1;
    }
    return out;
  },
});

// ---------------------------------------------------------------- chargeLegs

registerRobotPart('legs', 'chargeLegs', {
  label: 'Charge legs',
  build(ub, kit, ctx) {
    const D = LEG_A16_SHAPES.chargeLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const X = D.charge;
    const glow = unitStyle(kit).weaponGlow;
    // ram wedge on the pelvis front with a spike
    const pb = ub.paint('pelvis');
    const z0 = pelvisFront(D);
    const R = X.ram;
    armor(pb, kit, R.w, R.h, R.th, S.teamPaint, { y: D.pelvis.y + R.y, z: z0 + R.th / 2, rx: R.tilt }, { corner: 'shield', tip: 0.5 });
    const Hn = X.horn;
    prismZ(pb, 4, Hn.w, Hn.h, Hn.len, S.frame, { y: D.pelvis.y + R.y + 0.2, z: z0 + R.th + Hn.len / 2 - 0.3 }, true);
    for (const c of out.chains) {
      const ankle = mirror(D.ankle, c.side);
      const sb = ub.paint(c.shin);
      // knee spike
      const K = X.kneeSpike;
      prismZ(sb, 4, K.w, K.w, K.len, S.hullDark, { y: K.y, z: D.boot.d / 2 + K.len / 2 - 0.2 }, true);
      // heel booster behind the shin: nozzle + glow disc at its mouth
      const Bo = X.booster;
      const bz = ankle[2] * Bo.at - (D.boot.d / 2 + Bo.gap + Bo.len / 2);
      const by = ankle[1] * Bo.at;
      const bx = ankle[0] * Bo.at;
      sb.cylinder(Bo.r, Bo.rBack, Bo.len, SEG_POD, S.frame, { x: bx, y: by, z: bz, rx: HALF_PI }, true);
      ub.glow(c.shin).cylinder(Bo.ring, Bo.ring, 0.18, SEG_RING, glow, { x: bx, y: by, z: bz - Bo.len / 2 - 0.1, rx: HALF_PI, intensity: Bo.intensity });
    }
    return out;
  },
});

// ---------------------------------------------------------------- heavyShieldLegs

registerRobotPart('legs', 'heavyShieldLegs', {
  label: 'Heavy shield legs',
  build(ub, kit, ctx) {
    const D = LEG_A16_SHAPES.heavyShieldLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const X = D.hshield;
    const glow = unitStyle(kit).weaponGlow;
    const pb = ub.paint('pelvis');
    const P = D.pelvis;
    for (const c of out.chains) {
      const knee = mirror(D.knee, c.side);
      const td = halfDepth(D, LEG_SCULPT.thigh, D.thigh.d, X.thigh.at) + X.thigh.th / 2 - PLATE_SINK;
      const tp = limbPoint(knee, X.thigh.at, td);
      armor(ub.paint(c.thigh), kit, X.thigh.w, X.thigh.h, X.thigh.th, S.teamShade, { x: tp.x, y: tp.y, z: tp.z, rx: tp.rx });
      // tall team wing over the hip, leaning outward, with a glowing energy sheet standing behind its face
      const W = X.wing;
      const x = c.side * (P.w / 2 + W.dx);
      armor(pb, kit, W.w, W.h, W.th, S.teamPaint, { x, y: P.y + W.y, z: P.z + 0.6, ry: c.side * HALF_PI });
      ub.glow('pelvis').box(X.sheet.w, X.sheet.h, X.sheet.d, glow, { x: x - c.side * (W.th / 2 + 0.2), y: P.y + W.y, z: P.z + 0.6, intensity: X.sheet.intensity });
    }
    // central emitter (socket for the shield effect)
    const E = X.emitter;
    const em = ub.bone('hshieldEmitter', 'pelvis', [0, P.y + E.y, pelvisFront(D)]);
    ub.paint(em).cylinder(E.r, E.r, E.h, SEG_POD, S.hullDark, { z: E.h / 2, rx: HALF_PI }, true);
    ub.glow(em).sphere(E.node, ORB_SEG[0], ORB_SEG[1], glow, { z: E.h + E.node * 0.4 });
    ub.meta.lenses.push({ bone: em });
    ub.socket(E.socket, em, [0, 0, E.h]);
    return out;
  },
});

// ---------------------------------------------------------------- photonJetLegs

registerRobotPart('legs', 'photonJetLegs', {
  label: 'Photon jet legs',
  build(ub, kit, ctx) {
    const D = LEG_A16_SHAPES.photonJetLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const J = D.jet;
    const glow = unitStyle(kit).weaponGlow;
    let i = 0;
    for (const c of out.chains) {
      const Nz = J.nozzle;
      // the nozzle covers the foot: team cone, dark inner ring, glow disc under it, always-on plume (flickers)
      ub.paint(c.foot).cylinder(Nz.rTop, Nz.rBottom, Nz.len, SEG_POD, S.teamPaint, { y: Nz.y }, true);
      ub.paint(c.foot).cylinder(J.ring.r * 0.92, J.ring.r * 0.92, J.ring.len, SEG_POD, S.hullDark, { y: J.ring.y + 0.2 }, true);
      ub.glow(c.foot).cylinder(J.ring.r * 0.8, J.ring.r * 0.8, J.ring.len * 0.5, SEG_RING, glow, { y: J.ring.y - 0.05, intensity: 0.9 });
      const plume = ub.bone(`photonPlume${i}`, c.foot, [0, J.ring.y - 0.1, 0]);
      const F = J.flame;
      ub.glow(plume).flame(F.near, F.far, F.len, 5, glow, { rx: -HALF_PI, intensity: F.intensity });
      ctx.robot.extras.pulse.push({ bone: plume, depth: F.depth, hz: F.hz, phase: i * PHASE_STEP });
      i += 1;
    }
    return out;
  },
});

export const LEG_A16_IDS = Object.keys(LEG_A16_SHAPES);
