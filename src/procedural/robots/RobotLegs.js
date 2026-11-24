// Steel Men – procedural robot legs (experiment): basic, heavyLift (T2, carries more, massive), recon (T2, sensors that
// reveal stealth). Shared rig = the GLB RobotPartsBasic legs: wrapper bone 'legs' at the pelvis height, 'pelvis' →
// thigh{L,R} (hip) → shin{L,R} (knee) → foot{L,R} (ankle), socket_TorsoMount on the pelvis. L = −x (socket_ArmLeft side).
// Geometry of every segment is authored in its bone's space (hanging down, robot faces +Z). Construction time only.
// Legs contract: build(ub, kit, ctx) → { mount: [x, y, z] (pelvis space), rig: { pelvis, chains, stride, walkFull,
// turnRadius, swing, knee, bob, sway, twist, toe } } (see RobotKit.ProcRobot).
import { registerRobotPart, gltfNode, block, limbBetween, joint, plate, prismZ, lightLine, markingStrip, blockFront, shapeOf } from './RobotKit.js';
import { unitStyle } from '../units/UnitKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;       // light lines / markings stand this far off the surface
const GLOW_T = 0.12;         // thickness of glow accent bars
const GLOW_DIM = 0.6;        // intensity of small glow accents
const SEG_SMALL = 6;         // radial segments of small cylinders (pistons, masts)
const DISH_SEG = 10;         // radial segments of the sensor dish
const PELVIS_PLATE = { d: 0.6, h: 0.7, th: 0.08, x: 0.47 };   // side team plates (shares of the pelvis size)
const PELVIS_LINE = { w: 0.6, y: 0.15 };                       // front light line (shares of the pelvis size)
const FOOT_EDGE = { w: 0.6, y: 0.1 };                          // sole glow edge (shares of the foot size)

/**
 * Leg dimensions (raw GLB units). hip = pelvis → hip joint (x for the +x side), knee / ankle = offsets from the previous
 * joint (x mirrored per side), sole = ankle height above the ground; pelvis height = −(hip.y + knee.y + ankle.y) + sole.
 * Basic copies RobotPartsBasic/BasicLegsX_Skel.glb (pelvis 21.2 above the feet, socket_TorsoMount 0.2 / 0.3).
 */
export const LEG_SHAPES = {
  basic: {
    hip: [2.35, -1.2, 2.3], knee: [0.45, -7.1, -0.4], ankle: [-0.05, -10.1, -2.1], sole: 2.8, mount: [0, 0.2, 0.3],
    pelvis: { w: 4.6, h: 3.0, d: 5.0, y: -1.5, z: 2.2 },
    hipJoint: { r: 1.0, len: 1.8 },
    thigh: { w: 2.4, d: 3.0, top: 0.6, bottom: 0.4, taper: 0.85 },
    thighPlate: { w: 2.1, h: 3.8, th: 0.4, at: 0.45, out: 0.15, maxShare: 0.7 },   // team plate on the front, at = share down the thigh
    kneeJoint: { r: 1.2, len: 2.4, cap: { w: 2.6, h: 3.0, th: 0.6, y: -0.6, z: 2.0 } },
    shin: { w: 3.0, d: 3.4, top: 0.6, bottom: 0.4, taper: 0.72, lineAt: 0.45, lineLen: 4.5 },
    ankleJoint: { r: 0.85, len: 2.0 },
    foot: { w: 4.0, h: 1.7, len: 7.8, y: -1.95, z: 2.0, toes: 2, toeW: 1.2, toeH: 1.0, toeLen: 1.6, heelW: 1.6, heelLen: 1.6 },
    marking: { len: 2.2, h: 0.35, y: -3.5 },                        // shin front marking (style markings)
    gait: { stride: 15, walkFull: 14, turnRadius: 4, swing: 0.42, knee: 0.75, bob: 0.45, sway: 0.03, twist: 0.06, toe: 0.2 },
  },
  heavyLift: {
    hip: [3.1, -1.4, 2.2], knee: [0.6, -6.6, 0.9], ankle: [0, -9.6, -2.0], sole: 2.6, mount: [0, 0.3, 0.3],
    pelvis: { w: 6.2, h: 3.6, d: 5.8, y: -1.6, z: 2.0 },
    hipJoint: { r: 1.35, len: 2.2 },
    thigh: { w: 3.4, d: 4.0, top: 0.8, bottom: 0.5, taper: 0.9 },
    thighPlate: { w: 3.0, h: 4.2, th: 0.5, at: 0.4, out: 0.2, maxShare: 0.7 },
    kneeJoint: { r: 1.55, len: 3.0, cap: { w: 3.4, h: 3.6, th: 0.8, y: -0.4, z: 2.5 } },
    shin: { w: 4.2, d: 4.4, top: 0.8, bottom: 0.4, taper: 0.8, lineAt: 0.4, lineLen: 5 },
    ankleJoint: { r: 1.1, len: 2.6 },
    foot: { w: 5.4, h: 2.0, len: 8.8, y: -1.6, z: 1.8, toes: 3, toeW: 1.4, toeH: 1.2, toeLen: 1.8, heelW: 2.2, heelLen: 2.0 },
    marking: { len: 3, h: 0.4, y: -3.2 },
    // hydraulics: housing on the thigh (behind), rod on the shin sliding into it; side skirt plates (team) on the pelvis
    piston: { xShare: 0.5, r: 0.55, rodR: 0.28, housingTop: -1.2, housingLen: 4.2, z: -2.0, rodTop: 2.4, rodLen: 4.4, rodZ: -2.9 },
    skirt: { w: 3.0, h: 2.6, th: 0.4, x: 5.4, y: -2.2, z: 2.2 },
    load: { w: 5.0, h: 0.8, d: 1.6, y: -0.4, z: -1.6 },             // rear load clamp bar
    gait: { stride: 12, walkFull: 11, turnRadius: 5, swing: 0.34, knee: 0.6, bob: 0.7, sway: 0.05, twist: 0.05, toe: 0.12 },
  },
  recon: {
    hip: [2.2, -1.1, 2.2], knee: [0.3, -7.6, -0.2], ankle: [0, -10.2, -2.3], sole: 2.4, mount: [0, 0.2, 0.3],
    pelvis: { w: 3.8, h: 2.6, d: 4.4, y: -1.3, z: 2.1 },
    hipJoint: { r: 0.85, len: 1.6 },
    thigh: { w: 1.8, d: 2.4, top: 0.5, bottom: 0.3, taper: 0.8 },
    thighPlate: { w: 1.6, h: 3.4, th: 0.3, at: 0.45, out: 0.12, maxShare: 0.7 },
    kneeJoint: { r: 0.95, len: 2.0, cap: { w: 1.9, h: 2.4, th: 0.45, y: -0.5, z: 1.55 } },
    shin: { w: 2.2, d: 2.6, top: 0.5, bottom: 0.3, taper: 0.65, lineAt: 0.4, lineLen: 5 },
    ankleJoint: { r: 0.7, len: 1.7 },
    foot: { w: 3.2, h: 1.4, len: 7.0, y: -1.7, z: 2.0, toes: 2, toeW: 0.9, toeH: 0.8, toeLen: 1.8, heelW: 1.2, heelLen: 1.8 },
    marking: { len: 1.6, h: 0.3, y: -3.4 },
    // sensors: rotating dish on the back of each shin, swaying antenna on each thigh, hip scanner mast with a laser fan,
    // knee sensor lenses (pulse)
    dish: { at: [0.9, -3.4, -2.4], r: 1.1, depth: 0.45, bottomShare: 0.35, tilt: Math.PI / 4, backShare: 0.3, mastH: 0.7, mastR: 0.18, lensR: 0.25, spin: 3.2 },
    antenna: { at: [1.25, -1.0, -0.4], h: 3.2, t: 0.12, tipR: 0.22, lean: 0.25, amp: 0.12, hz: 0.7 },
    scanner: {
      at: [0, -2.9, 3.4], baseR: 0.6, baseH: 0.6, headW: 1.2, headH: 0.7, headD: 0.9, lensShare: 0.4,
      fanLen: 2.6, fanW: 1.8, fanT: 0.03, arc: 0.35, scanHz: 0.4, pulseHz: 1.3, pulseDepth: 0.5,
    },
    kneeLens: { r: 0.32, z: 1.9, y: -0.4 },
    gait: { stride: 17, walkFull: 15, turnRadius: 3.5, swing: 0.46, knee: 0.85, bob: 0.4, sway: 0.025, twist: 0.07, toe: 0.25 },
  },
};

const SIDES = [{ sign: -1, sfx: 'L' }, { sign: 1, sfx: 'R' }];

const mirror = ([x, y, z], sign) => [x * sign, y, z];

/** Pelvis height of a leg shape (feet on the ground) */
export const pelvisHeight = (D) => -(D.hip[1] + D.knee[1] + D.ankle[1]) + D.sole;

/**
 * Common leg rig + body of every leg type. Returns { mount, rig, chains (bone names per side) } and leaves the per-type
 * extras to the caller (pistons, sensors…).
 */
function buildLegBase(ub, kit, ctx, D) {
  const S = kit.S;
  const glowColor = kit.glowColors.laser;
  ub.bone(ctx.bone, 'root', [0, pelvisHeight(D), 0], { far: true });   // own far LOD group + pick proxy (RobotKit)
  ub.bone(gltfNode(ctx, 'pelvis'), ctx.bone);
  const pb = ub.paint('pelvis');
  const P = D.pelvis;
  block(pb, kit, P.w, P.h, P.d, S.hullDark, { y: P.y, z: P.z });
  // side plates in the team colour (big surfaces) + light line across the front
  for (const { sign } of SIDES) plate(pb, kit, P.d * PELVIS_PLATE.d, P.h * PELVIS_PLATE.h, P.w * PELVIS_PLATE.th, S.teamShade, { x: sign * P.w * PELVIS_PLATE.x, y: P.y, z: P.z, ry: HALF_PI });
  lightLine(pb, kit, P.w * PELVIS_LINE.w, 'x', { y: P.y + P.h * PELVIS_LINE.y, z: P.z + blockFront(kit, P.d) + LINE_OUT });

  const chains = [];
  for (const { sign, sfx } of SIDES) {
    const hip = mirror(D.hip, sign);
    const knee = mirror(D.knee, sign);
    const ankle = mirror(D.ankle, sign);
    const thigh = gltfNode(ctx, `thigh${sfx}`);
    const shin = gltfNode(ctx, `shin${sfx}`);
    const foot = gltfNode(ctx, `foot${sfx}`);
    ub.bone(thigh, 'pelvis', hip);
    ub.bone(shin, thigh, knee);
    ub.bone(foot, shin, ankle);
    chains.push({ side: sign, thigh, shin, foot });

    // hip joint on the pelvis side, thigh with its team plate
    joint(pb, kit, D.hipJoint.r, D.hipJoint.len, S.frame, { x: hip[0], y: hip[1], z: hip[2] });
    const tb = ub.paint(thigh);
    const T = D.thigh;
    const tLen = limbBetween(tb, kit, [0, 0, 0], knee, T.w, T.d, S.hull, { top: T.top, bottom: T.bottom, taper: T.taper });
    const TP = D.thighPlate;
    const at = [knee[0] * TP.at, knee[1] * TP.at, knee[2] * TP.at];
    plate(tb, kit, TP.w, Math.min(TP.h, tLen * TP.maxShare), TP.th, S.teamPaint, { x: at[0], y: at[1], z: at[2] + T.d / 2 + TP.out });

    // knee joint + cap, shin with a light line and marking
    const sb = ub.paint(shin);
    const KJ = D.kneeJoint;
    joint(sb, kit, KJ.r, KJ.len, S.frame, {});
    const C = KJ.cap;
    plate(sb, kit, C.w, C.h, C.th, S.hull, { y: C.y, z: C.z });
    const H = D.shin;
    limbBetween(sb, kit, [0, 0, 0], ankle, H.w, H.d, S.hull, { top: H.top, bottom: H.bottom, taper: H.taper });
    const lineAt = [ankle[0] * H.lineAt, ankle[1] * H.lineAt, ankle[2] * H.lineAt];
    lightLine(sb, kit, H.lineLen, 'y', { x: lineAt[0], y: lineAt[1], z: lineAt[2] + H.d / 2 + LINE_OUT });
    markingStrip(sb, kit, D.marking.len, D.marking.h, { x: lineAt[0], y: D.marking.y, z: H.d / 2 + LINE_OUT * 2 });

    // ankle joint + foot (prism with flat sole, toes, heel)
    const fb = ub.paint(foot);
    joint(fb, kit, D.ankleJoint.r, D.ankleJoint.len, S.frame, {});
    const F = D.foot;
    footShape(fb, kit, F, S);
    // glowing sole edge accent (tiny, LOD0) in the style's laser colour
    ub.glow(foot).box(F.w * FOOT_EDGE.w, GLOW_T, GLOW_T, glowColor, { y: F.y + F.h * FOOT_EDGE.y, z: F.z + F.len / 2 + GLOW_T, intensity: GLOW_DIM });
  }
  return {
    mount: D.mount,
    chains,
    rig: { pelvis: 'pelvis', chains, ...D.gait },
  };
}

function footShape(fb, kit, F, S) {
  const faceted = shapeOf(kit).block === 'prism';
  prismZ(fb, faceted ? 6 : 4, F.w, F.h, F.len, S.hullDark, { y: F.y, z: F.z });
  const toeY = F.y - F.h / 2 + F.toeH / 2;
  const span = F.w - F.toeW;
  for (let i = 0; i < F.toes; i++) {
    const x = F.toes > 1 ? -span / 2 + (span * i) / (F.toes - 1) : 0;
    prismZ(fb, 4, F.toeW, F.toeH, F.toeLen, S.frame, { x, y: toeY, z: F.z + F.len / 2 + F.toeLen / 2 }, true);
  }
  prismZ(fb, 4, F.heelW, F.toeH, F.heelLen, S.frame, { y: toeY, z: F.z - F.len / 2 - F.heelLen / 2, rx: -HALF_PI }, true);
}

// ---------------------------------------------------------------- basic

registerRobotPart('legs', 'basic', {
  label: 'Basic legs',
  build(ub, kit, ctx) {
    return buildLegBase(ub, kit, ctx, LEG_SHAPES.basic);
  },
});

// ---------------------------------------------------------------- heavy lifting (T2)

registerRobotPart('legs', 'heavyLift', {
  label: 'Heavy lifting legs',
  build(ub, kit, ctx) {
    const D = LEG_SHAPES.heavyLift;
    const out = buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const pb = ub.paint('pelvis');
    const Pi = D.piston;
    for (const c of out.chains) {
      // hydraulic housing on the back of the thigh, rod on the back of the shin (slides as the knee bends)
      const knee = mirror(D.knee, c.side);
      ub.paint(c.thigh).cylinder(Pi.r, Pi.r, Pi.housingLen, SEG_SMALL, S.frame,
        { x: knee[0] * Pi.xShare, y: Pi.housingTop - Pi.housingLen / 2, z: Pi.z });
      ub.paint(c.shin).cylinder(Pi.rodR, Pi.rodR, Pi.rodLen, SEG_SMALL, S.pipe, { y: Pi.rodTop - Pi.rodLen / 2, z: Pi.rodZ, detail: 0 });
      // side skirt plate (team) on the pelvis, outside each hip
      const K = D.skirt;
      plate(pb, kit, K.w, K.h, K.th, S.teamPaint, { x: c.side * K.x, y: K.y, z: K.z, ry: HALF_PI });
    }
    const Ld = D.load;
    block(pb, kit, Ld.w, Ld.h, Ld.d, S.frame, { y: Ld.y, z: Ld.z });
    return out;
  },
});

// ---------------------------------------------------------------- recon (T2)

registerRobotPart('legs', 'recon', {
  label: 'Recon legs',
  build(ub, kit, ctx) {
    const D = LEG_SHAPES.recon;
    const out = buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const sensor = unitStyle(kit).weaponGlow;
    const X = ctx.robot.extras;
    const Di = D.dish;
    const An = D.antenna;
    const KL = D.kneeLens;
    for (const c of out.chains) {
      const sfx = c.side > 0 ? 'R' : 'L';
      // rotating sensor dish on the back of the shin
      const dish = ub.bone(`reconDish${sfx}`, c.shin, mirror(Di.at, c.side));
      const db = ub.paint(dish);
      db.cylinder(Di.mastR, Di.mastR, Di.mastH, SEG_SMALL, S.frame, { y: Di.mastH / 2, detail: 0 });
      // dish bowl tilted up and back, lens in its centre
      db.cylinder(Di.r, Di.r * Di.bottomShare, Di.depth, DISH_SEG, S.hull, { y: Di.mastH + Di.depth / 2, rx: -Di.tilt, z: -Di.depth * Di.backShare });
      ub.glow(dish).point([0, Di.mastH + Di.depth, -Di.depth * Di.backShare], Di.lensR, sensor);
      X.spin.push({ bone: dish, axis: 'y', speed: Di.spin * c.side });
      // swaying antenna on the outer side of the thigh, leaning outwards
      const ant = ub.bone(`reconAnt${sfx}`, c.thigh, mirror(An.at, c.side), { rotation: [0, 0, -An.lean * c.side] });
      const ab = ub.paint(ant);
      ab.box(An.t, An.h, An.t, S.frame, { y: An.h / 2, detail: 0 });
      ub.glow(ant).point([0, An.h, 0], An.tipR, kit.glowColors.beacon);
      X.sway.push({ bone: ant, axis: 'z', amp: An.amp * c.side, hz: An.hz });
      // knee sensor lens (pulse via the ProcUnit lens driver)
      const lens = ub.bone(`reconKneeLens${sfx}`, c.shin, [0, KL.y, KL.z]);
      ub.glow(lens).point([0, 0, 0], KL.r, sensor);
      ub.meta.lenses.push({ bone: lens });
    }
    // scanner hanging under the front of the pelvis, a sweeping laser fan (reveals stealth)
    const Sc = D.scanner;
    const scan = ub.bone('reconScanner', 'pelvis', Sc.at);
    const sb = ub.paint('pelvis');
    sb.cylinder(Sc.baseR, Sc.baseR, Sc.baseH, SEG_SMALL, S.frame, { x: Sc.at[0], y: Sc.at[1] + Sc.baseH / 2, z: Sc.at[2] });
    block(ub.paint(scan), kit, Sc.headW, Sc.headH, Sc.headD, S.hullDark, { y: -Sc.headH / 2 });
    const fan = ub.bone('reconFan', scan, [0, -Sc.headH / 2, Sc.headD / 2]);
    ub.glow(fan).box(Sc.fanW, Sc.fanT, Sc.fanLen, sensor, { z: Sc.fanLen / 2, intensity: GLOW_DIM });
    ub.glow(fan).point([0, 0, 0], Sc.headH * Sc.lensShare, sensor);
    X.sway.push({ bone: scan, axis: 'y', amp: Sc.arc, hz: Sc.scanHz });
    X.pulse.push({ bone: fan, depth: Sc.pulseDepth, hz: Sc.pulseHz });
    return out;
  },
});
