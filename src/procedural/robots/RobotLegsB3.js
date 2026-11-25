// Steel Men – procedural robot legs, block B3 (T3 content): sprintLegs, plasmaLegs, laserShieldLegs.
// Same approach as RobotLegsB6.js: shared leg rig + body from RobotLegs.buildLegBase (bones legs → pelvis → thigh / shin / foot per
// side, socket_TorsoMount, soles, stride) with own proportions (taken from the B6 shapes and overridden) plus extras on the pelvis /
// thigh / shin bones. Visual only (the simulation reads the hidden GLB body). Construction time only, no randomness.
//   sprintLegs      – very slim long digitigrade runners: carbon blade behind each shin, team thigh panels with a speed stripe
//   plasmaLegs      – medium legs with twin plasma cannons on the pelvis front (socket_Launch_G1, G2), coil rings, side tanks
//   laserShieldLegs – medium legs with a shield emitter pylon on each hip (glow shield plane between two emitter lenses),
//                     central emitter with socket_Attach_Shield (as the PowerShield GLB)
// Shapes follow kit.style.silhouette (rounded | angular | round | faceted) through the kit primitives and TUBE_SIDES.
import { registerRobotPart, block } from './RobotKit.js';
import * as Legs from './RobotLegs.js';
import { LEG_B6_SHAPES } from './RobotLegsB6.js';
import { armor } from './RobotSculpt.js';
import { tube } from '../ProcShapes.js';
import { unitStyle } from '../units/UnitKit.js';

const { LEG_SCULPT } = Legs;
const HALF_PI = Math.PI / 2;
const PLATE_SINK = 0.15;     // side plates sink into the surface by this
const LINE_OUT = 0.05;       // muzzle sockets stand this far out of the barrel
const GLOW_DIM = 0.6;        // intensity of small glow accents
const FRONT_SHARE = 0.46;    // pelvis front plane = z + this × depth (a little inside the hull)
const FLASH_CORE = 0.55;     // muzzle flash core radius
const PHASE_STEP = 1.3;      // pulse phase offset between sibling glow nodes (rad)
const SEG_POD = 8;           // sides of barrels / tanks
const SEG_RING = 10;         // sides of glow rings
// sides of thin tubes (blades, struts) per silhouette; unknown silhouettes use rounded
const TUBE_SIDES = { rounded: 6, round: 8, angular: 4, faceted: 5 };

// ---------------------------------------------------------------- shapes

const GAIT = (g) => ({ bob: 0, ...g });
const HS = LEG_B6_SHAPES.highSpeed;
const PG = LEG_B6_SHAPES.powerGun;
const PS = LEG_B6_SHAPES.powerShield;

export const LEG_B3_SHAPES = {
  // runner legs: even slimmer and taller than highSpeed, quick stride; extras = blade behind the shin + thigh panel with a stripe
  sprintLegs: {
    ...HS,
    hip: [1.7, -1.0, 2.0], knee: [0.25, -8.6, 1.2], ankle: [0, -11.6, -3.6], sole: 2.3,
    pelvis: { w: 3.0, h: 2.0, d: 3.6, y: -1.0, z: 2.0 },
    hipJoint: { r: 0.65, len: 1.2 },
    thigh: { w: 1.1, d: 1.5 },
    kneeJoint: { r: 0.7, len: 1.4 },
    boot: { w: 1.6, d: 2.0, lineAt: 0.4, lineLen: 6.0 },
    kneeShield: { w: 1.5, h: 2.2, th: 0.3, up: 0.3, tilt: 0.2 },
    gait: GAIT({ walkFull: 21, turnRadius: 3, swing: 0.48, knee: 1.05, sway: 0.018, twist: 0.09, toe: 0.34 }),
    fin: null,
    sprint: {
      blade: { r: 0.32, from: 0.3, to: 0.97, bow: 1.5, gap: 0.35, tipR: 0.45 },     // spring blade: shares along the shin, bow = max offset back
      panel: { at: 0.5, w: 1.5, h: 4.8, th: 0.32 },                                  // team panel on the front of the thigh
      stripe: { w: 0.2, h: 4.0, th: 0.08 },                                          // glow speed stripe on the panel
    },
  },
  // twin plasma cannons on the pelvis front, glowing coil rings, a tank on each side of the housing
  plasmaLegs: {
    ...PG,
    weapon: {
      kind: 'gun', shots: 2, y: -1.0, w: 5.8, h: 2.8, d: 3.0, sink: 0.5,
      barrelX: 1.55, r: 0.95, len: 3.8, sleeveR: 1.3, sleeveLen: 1.2,
      coils: [0.4, 0.75], coilR: 1.4, coilT: 0.26, coilGlow: 0.9, pulseDepth: 0.3, pulseHz: 1.6,
      tankR: 1.1, tankLen: 3.2, recoil: 0.7, orbR: 0.55,
    },
  },
  // hip emitter pylons with a glowing shield plane between two emitter lenses, central emitter (socket_Attach_Shield)
  laserShieldLegs: {
    ...PS,
    shield: null,
    lshield: {
      x: 1.5, z: 0.2, pylonW: 0.9, pylonH: 6.6, pylonD: 1.3, strutR: 0.25,
      panelW: 3.6, panelH: 5.4, panelTh: 0.1, panelGlow: 0.5,
      barH: 0.55, barTh: 0.8, barExtra: 0.8,
      lensR: 0.6, centerY: -0.9, emitterR: 1.0, emitterH: 0.8, nodeR: 0.5, socket: 'socket_Attach_Shield',
    },
  },
};

// ---------------------------------------------------------------- helpers (construction time only)

const tubeSides = (kit) => TUBE_SIDES[kit.style?.silhouette] ?? TUBE_SIDES.rounded;
const mirror = ([x, y, z], sign) => [x * sign, y, z];
const bootProfile = (D) => D.sculpt?.boot ?? LEG_SCULPT.boot;
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

/** Marks the weapon in the legs rig (a future legs attack clip reads it): { kind, muzzles, shots } */
function setWeapon(out, W, muzzles) {
  out.rig.weapon = { kind: W.kind, muzzles, shots: W.shots };
}

/** Muzzle on `bone` at `at`: flash bone (hidden until fired) + socket_Launch_G<index> + onFire channels (flash, optional recoil) */
function addMuzzle(ub, ctx, bone, at, index, color, extra = {}) {
  const fl = ub.bone(`legFlash${index}`, bone, at);
  ub.glow(fl).point([0, 0, FLASH_CORE], FLASH_CORE, color);
  const fi = ub.meta.flashes.push({ bone: fl }) - 1;
  const socket = `${ctx.sockets.launch}G${index}`;
  ub.socket(socket, bone, at);
  ub.onFire(socket, { flashes: [fi], ...extra });
  return socket;
}

// ---------------------------------------------------------------- sprintLegs

registerRobotPart('legs', 'sprintLegs', {
  label: 'Sprint legs',
  build(ub, kit, ctx) {
    const D = LEG_B3_SHAPES.sprintLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const B = D.sprint.blade;
    const Pn = D.sprint.panel;
    const St = D.sprint.stripe;
    const sides = tubeSides(kit);
    const glowColor = kit.glowColors.laser;
    for (const c of out.chains) {
      const ankle = mirror(D.ankle, c.side);
      const knee = mirror(D.knee, c.side);
      // spring blade behind the shin: bows backwards between the knee region and the ankle, ends in a small heel tip
      const zb = -(D.boot.d / 2 + B.gap);
      const pts = [
        [ankle[0] * B.from, ankle[1] * B.from, ankle[2] * B.from + zb],
        [ankle[0] * 0.62, ankle[1] * 0.62, ankle[2] * 0.62 + zb - B.bow],
        [ankle[0] * B.to, ankle[1] * B.to, ankle[2] * B.to + zb * 0.6],
      ];
      const sb = ub.paint(c.shin);
      sb.add(tube(pts, B.r, sides), S.frame, { detail: 0 });
      sb.sphere(B.tipR, sides, 3, S.hullDark, { x: pts[2][0], y: pts[2][1], z: pts[2][2], detail: 0 });
      // team panel on the front of the thigh + glowing speed stripe on it
      const dist = (D.thigh.d * profileAt(LEG_SCULPT.thigh, Pn.at, 2)) / 2 + Pn.th / 2 - PLATE_SINK;
      const tp = limbPoint(knee, Pn.at, dist);
      armor(ub.paint(c.thigh), kit, Pn.w, Pn.h, Pn.th, S.teamShade, { x: tp.x, y: tp.y, z: tp.z, rx: tp.rx });
      const sp = limbPoint(knee, Pn.at, dist + Pn.th / 2 + St.th / 2);
      ub.glow(c.thigh).box(St.w, St.h, St.th, glowColor, { x: sp.x, y: sp.y, z: sp.z, rx: sp.rx, intensity: GLOW_DIM });
    }
    return out;
  },
});

// ---------------------------------------------------------------- plasmaLegs

registerRobotPart('legs', 'plasmaLegs', {
  label: 'Plasma legs',
  build(ub, kit, ctx) {
    const D = LEG_B3_SHAPES.plasmaLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const W = D.weapon;
    const glow = unitStyle(kit).weaponGlow;
    const z0 = pelvisFront(D);
    const pb = ub.paint('pelvis');
    block(pb, kit, W.w, W.h, W.d, S.teamShade, { y: W.y, z: z0 + W.d / 2 - W.sink });
    // plasma tanks on both sides of the housing
    for (const sign of [-1, 1]) {
      pb.cylinder(W.tankR, W.tankR, W.tankLen, SEG_POD, S.hullDark, { x: sign * (W.w / 2 + W.tankR - PLATE_SINK), y: W.y, z: z0 + W.tankLen / 2, rx: HALF_PI }, true);
    }
    const muzzles = [];
    let i = 0;
    for (const sign of [-1, 1]) {
      const barrel = ub.bone(`legPlasma${i + 1}`, 'pelvis', [sign * W.barrelX, W.y, z0 + W.d - W.sink]);
      const bb = ub.paint(barrel);
      bb.cylinder(W.sleeveR, W.sleeveR, W.sleeveLen, SEG_POD, S.hullDark, { z: W.sleeveLen / 2, rx: HALF_PI }, true);
      bb.cylinder(W.r, W.r, W.len, SEG_POD, S.frame, { z: W.len / 2, rx: HALF_PI }, true);
      // glowing coil rings (pulse in step with the sibling barrel's phase offset)
      const coils = ub.bone(`legPlasmaCoils${i + 1}`, barrel, [0, 0, 0]);
      for (const at of W.coils) {
        ub.glow(coils).cylinder(W.coilR, W.coilR, W.coilT, SEG_RING, glow, { z: W.len * at, rx: HALF_PI, intensity: W.coilGlow }, true);
      }
      ctx.robot.extras.pulse.push({ bone: coils, depth: W.pulseDepth, hz: W.pulseHz, phase: i * PHASE_STEP });
      ub.glow(barrel).point([0, 0, W.len], W.orbR, glow, { intensity: GLOW_DIM });
      const ri = ub.meta.recoils.push({ bone: barrel, dist: W.recoil }) - 1;
      i += 1;
      muzzles.push(addMuzzle(ub, ctx, barrel, [0, 0, W.len + LINE_OUT], i, glow, { recoils: [ri] }));
    }
    setWeapon(out, W, muzzles);
    return out;
  },
});

// ---------------------------------------------------------------- laserShieldLegs

registerRobotPart('legs', 'laserShieldLegs', {
  label: 'Laser shield legs',
  build(ub, kit, ctx) {
    const D = LEG_B3_SHAPES.laserShieldLegs;
    const out = Legs.buildLegBase(ub, kit, ctx, D);
    const S = kit.S;
    const H = D.lshield;
    const P = D.pelvis;
    const glow = unitStyle(kit).weaponGlow;
    const sides = tubeSides(kit);
    const pb = ub.paint('pelvis');
    const top = P.y + P.h / 2 + 0.3;
    const yMid = top - H.pylonH / 2;
    const z = P.z + H.z;
    let n = 0;
    for (const sign of [-1, 1]) {
      const x = sign * (D.hip[0] + D.thigh.w / 2 + H.x);
      block(pb, kit, H.pylonW, H.pylonH, H.pylonD, S.hullDark, { x, y: yMid, z });
      // strut from the pelvis side to the pylon
      pb.add(tube([[sign * (P.w / 2 - PLATE_SINK), P.y, z], [x - sign * H.pylonW / 2, P.y, z]], H.strutR, sides), S.frame, { detail: 0 });
      // shield plane (thin glow slab) hanging between a top and a bottom team bar
      const px = x + sign * (H.pylonW / 2 + H.panelTh / 2);
      ub.glow('pelvis').box(H.panelTh, H.panelH, H.panelW, glow, { x: px, y: yMid, z, intensity: H.panelGlow });
      for (const dy of [-1, 1]) {
        block(pb, kit, H.barTh, H.barH, H.panelW + H.barExtra, S.teamPaint, { x: px, y: yMid + dy * (H.panelH / 2 + H.barH / 2), z });
        // emitter lens at the pylon ends (ProcUnit lens driver pulses it)
        const lens = ub.bone(`lsLens${n}`, 'pelvis', [x, yMid + dy * (H.pylonH / 2), z]);
        ub.glow(lens).point([0, 0, 0], H.lensR, glow, { intensity: GLOW_DIM });
        ub.meta.lenses.push({ bone: lens });
        n += 1;
      }
    }
    // central emitter on the pelvis front: ring + node, socket for the shield effect (as the PowerShield GLB)
    const em = ub.bone('legShieldEmitter', 'pelvis', [0, H.centerY, pelvisFront(D)]);
    ub.paint(em).cylinder(H.emitterR, H.emitterR, H.emitterH, SEG_POD, S.hullDark, { z: H.emitterH / 2, rx: HALF_PI }, true);
    ub.glow(em).point([0, 0, H.emitterH + H.nodeR * 0.5], H.nodeR, glow);
    ub.meta.lenses.push({ bone: em });
    ub.socket(H.socket, em, [0, 0, H.emitterH]);
    return out;
  },
});

export const LEG_B3_IDS = Object.keys(LEG_B3_SHAPES);
