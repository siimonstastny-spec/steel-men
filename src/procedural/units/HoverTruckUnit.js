// Steel Men – procedural hover truck (support vehicle): builds, repairs, carries 4 crew and one salvage wreck. Unarmed.
// Four builds chosen by style.silhouette (never by faction name), each with its own work tool:
//   rounded → utility cab, flat bed with rails, articulated hydraulic crane with a welding nozzle, beacon      (rig 'crane')
//   angular → heavy armoured hauler, walled bed, massive telescopic boom with chain + hook, fans, warm lamps  (rig 'hook')
//   round   → smooth pearl body, levitating cradle, floating emitter ring with a plasma beam, crew dome        (rig 'ring')
//   faceted → slim faceted body, diamond-seamed tray, rail-mounted tractor-beam emitter, glowing radiators    (rig 'rail')
// Model units (before VEHICLE.modelScale × procScale): ≈ 7 long, 3 wide, 2.4–3.1 high (see docs/notes/proc-hovertruck.md).
// Sockets: cargo (bed centre), work (tool tip: where the build / repair effect starts), aim, smoke, hatch (+ standard hover bones).
// Own animation API on top of ProcUnit (all visual, tick allocates nothing, no Math.random):
//   setWork(kind, amount)  kind 'none' | 'build' | 'repair', amount 0..1 (smooth) – tool unfolds and works; repair = other colour
//   setHatch(0..1)         crew space opens (roof hatch / dome / sliding canopy)
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hover, statusLamp, unitBox, prism, noseCone, roofMark, teamPanel, teamTrim, emblemPlate } from './UnitModules.js';
import { smootherstep } from '../ProcKit.js';

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

// Hover chassis shared by all builds (shares of L / W, same convention as the other hovers)
const CHASSIS = {
  gap: 0.07, skirtL: 0.98, skirtW: 1.06, skirtH: 0.07,
  pads: [[0.3, 0.32], [-0.3, 0.32], [0.3, -0.32], [-0.3, -0.32]],
};

// Colours that are semantic, not faction: work effects, lamps
const COLORS = { repair: '#5dff9e', repairCore: '#d8ffe8', sparkCore: '#fff2c0', headlight: '#e8f4ff', warmLamp: '#ffc070', beacon: '#ffb020', beamCore: '#ffffff' };

// ---------------------------------------------------------------- shapes (model units, keyed by style.silhouette)

const SHAPES = {
  rounded: {
    L: 7.0, W: 3.0,
    frame: { h: 0.42, d: 6.6, z: -0.1 },
    bed: { w: 3.0, d: 3.9, z: -1.3, floorT: 0.1 },
    rail: { h: 0.55, t: 0.08, x: 1.46, posts: [-1.8, -0.6, 0.6, 1.8] },   // post z relative to the bed centre
    cab: { w: 2.8, h: 1.65, d: 2.3, z: 2.1 },
    glass: { frontW: 0.82, frontH: 0.42, frontY: 0.62, sideH: 0.36, sideD: 0.5, t: 0.06, out: 0.02 },
    lamp: { w: 0.4, h: 0.2, x: 0.95, y: 0.4, glowR: 0.13 },
    hazard: { h: 0.28, stripe: 0.3, out: 0.01 },
    beacon: { z: -0.7, baseR: 0.14, glowR: 0.14, y: 0.12 },
    hatch: { z: -0.35, lidW: 0.9, lidD: 0.8, lidT: 0.06, y: 0.06, open: -1.1 },
    mark: { z: 0.2, w: 2.0, d: 1.0 },
    emblem: { y: 0.2, z: -0.2, size: 0.5 },
    lampStatus: { x: 0.3, z: -0.9 },
    crane: { x: -1.3, z: 0.6, baseR: 0.25, baseH: 0.25, lowerLen: 1.7, upperLen: 1.5, armW: 0.3, upW: 0.24, jointR: 0.2, jointW: 0.46, nozzle: 0.3 },
    smokeZ: -0.42, aimShare: 0.6,
  },
  angular: {
    L: 7.2, W: 3.4,
    frame: { h: 0.55, topW: 3.1, d: 7.0, z: -0.1 },
    plate: { t: 0.12, h: 0.7, y: 0.3, lean: 0.2, share: 0.8 },
    bumper: { h: 0.4, d: 0.3, y: 0.3 },
    lamp: { r: 0.2, rBase: 0.24, len: 0.22, x: 1.05, y: 0.62, out: 0.08, glowR: 0.26 },
    cab: { w: 2.9, topW: 2.2, h: 1.9, d: 2.6, topD: 1.9, z: 2.1 },
    glass: { w: 2.0, h: 0.4, y: 1.3, lean: -0.18, out: 0.03 },
    bed: { w: 3.2, d: 4.0, z: -1.5, floorT: 0.12, wallT: 0.14, wallH: 0.75, rivets: 6, rivetR: 0.04 },
    mark: { z: 0.55, w: 1.6, d: 0.9 },
    emblem: { y: 0.35, z: -0.3, size: 0.55, tilt: 0.18 },
    fan: { x: 0.62, z: -0.5, housingR: 0.32, housingRb: 0.36, housingH: 0.14, bladeL: 0.62, bladeT: 0.025, bladeW: 0.12, y: 0.16 },
    hatch: { z: -0.8, lidW: 0.5, lidD: 0.6, lidT: 0.08, y: 0.04, open: -1.2 },
    lampStatus: { x: 0, z: -0.05 },
    boom: { x: 1.42, z: 0.05, pedW: 0.7, pedTop: 0.5, pedH: 0.5, pedD: 0.8, len: 2.6, w: 0.4, topW: 0.3, hubR: 0.3, hubW: 0.7, ext: 1.9, extW: 0.3, extIn: 1.3, pulleyR: 0.16 },
    hook: { block: 0.22, ringR: 0.15, ringT: 0.045, chainT: 0.07, tip: 0.28 },
    smokeZ: -0.42, aimShare: 0.6,
  },
  round: {
    L: 7.4, W: 3.0,
    shell: { y: 0.4, sx: 1.5, sy: 0.45, sz: 3.6, seg: [18, 10], cap: 1.0, capLift: 1.015, capSeg: [18, 3] },
    dome: { y: 0.7, z: 2.0, rx: 1.05, ry: 0.9, rz: 1.2, seg: [14, 6], seatT: 0.06, open: 0.5, tilt: -0.2 },
    cradle: { y: 1.0, z: -1.0, rx: 1.35, rz: 1.5, t: 0.1, seg: 24, rimT: 0.05, rimRadial: 3, glowR: 0.9, bob: 0.04, bobFreq: 0.5 },
    ring: { y: 1.1, z: -3.1, R: 0.55, tube: 0.08, glowR: 0.44, glowT: 0.035, coreR: 0.15, bumps: 3, bumpS: 0.12, under: 0.62 },
    beam: { len: 3.0, near: 0.05, far: 0.22, coreNear: 0.02, coreFar: 0.07, seg: 8 },
    emblem: { y: 0.02, z: 0.4, size: 0.55, out: 0.96 },
    lampStatus: { x: 0.85, y: 0.74, z: 0 },
    smokeZ: -0.42, aimShare: 0.6,
  },
  faceted: {
    L: 7.0, W: 2.8,
    frame: { h: 0.3, d: 6.6, z: -0.1 },
    bed: { w: 2.4, d: 3.6, z: -1.6, floorT: 0.08, lipT: 0.1, lipH: 0.2, seamW: 0.05, seamH: 0.02, seamLen: 1.7, seamStep: 1.1 },
    body: { w: 2.5, h: 1.2, len: 2.4, z: 1.4, y: 0.5, noseLen: 1.1 },
    glass: { w: 1.4, h: 0.9, len: 1.6, z: 1.5 },
    edge: { t: 0.06 },
    panel: { w: 0.9, h: 0.5, z: 2.0 },
    emblem: { z: 1.3, size: 0.45 },
    slat: { n: 5, step: 0.17, z: 0.3, w: 0.14, h: 0.5, t: 0.05, slit: 0.05, slitH: 0.46, slitD: 0.09 },
    rail: { x: 1.25, h: 0.7, t: 0.08, len: 3.2, z: -1.7, posts: [-0.3, -3.1], postT: 0.07, start: -3.0 },
    boom: { len: 1.0, t: 0.1, hubR: 0.12 },
    tool: { lensW: 0.14, lensH: 0.18 },
    beam: { len: 2.6, core: [0.03, 0.06], outer: [0.07, 0.12], seg: 6 },
    hatch: { z: 1.5, slide: -0.8, lift: 0.12, y: -0.2 },
    lampStatus: { x: 0.9, z: -3.1 },
    smokeZ: -0.42, aimShare: 0.6,
  },
};
const shapeOf = (kit) => SHAPES[kit.style.silhouette] ?? SHAPES.rounded;
// glow intensities (× colour) and the cradle glow-disc size share
const GLOW = { heat: 1.2, beam: 0.7, cradleDisc: 0.5, cradleFill: 0.8, ringUnder: 0.5 };
const FX = { sparks: 3, sparkR: 0.06, coreR: 0.1, ring: 0.2, ringT: 0.03, orbR: 0.13, spark: 0.12 };   // crane / hook effect parts

// ---------------------------------------------------------------- animation tables (angles rad, positions model units)

const WORK = {
  ease: 3.2, hatchEase: 3.2, fxStart: 0.6, flickerRate: 18, flicker: 0.35, pulseRate: 9, pulse: 0.15, epsilon: 0.002,
  beaconWorkShare: 0.3,   // beacon period while working = style.anim.blink × this
  heatIdle: 0.1, heatPulse: 0.12, heatRate: 5,
};
const POSES = {
  // crane work pose: lower arm raised 1.2 rad, upper arm hangs down (relative 1.74) → nozzle ≈ 0.7 above the ground, ≈ 1.7 beside the hull edge
  crane: { slew: -1.3, lower: [-1.5, 1.2], upper: [3.0, 1.74], sweep: 0.22, sweepRate: 1.1, wobble: 0.08, wobbleRate: 2.3 },
  hook: { slew: 1.15, boom: [-1.5, 1.05], ext: 1.1, chain: [0.25, 2.6], sweep: 0.12, sweepRate: 0.9, swing: 0.18, swingRate: 1.6, fan: [3, 14] },
  ring: { rise: 0.9, tilt: 0.95, sweep: -0.6, wander: 0.18, wanderRate: 0.8, spin: [0.4, 3], bob: 0.03, bobFreq: 0.6 },
  rail: { slide: [-3.0, -1.0], swing: [HALF_PI, Math.PI], sway: 0.06, swayRate: 1.4, drop: -0.6, lean: 0.35 },
};

// ---------------------------------------------------------------- common parts

function chassis(ub, W, L) {
  ub.bone('hull', 'root', [0, L * CHASSIS.gap, 0]);
  return hover(ub, {
    bone: 'hull', L: L * CHASSIS.skirtL, W: W * CHASSIS.skirtW, skirtH: L * CHASSIS.skirtH, pads: CHASSIS.pads.map(([x, z]) => [x * W, z * L]),
  });
}

/** Work effect bones: fxBuild (style weapon glow) and fxRepair (green) under `parent`; `fill(painter, color, core, repair)` draws one */
function fxBones(ub, parent, position, fill) {
  const build = ub.bone('fxBuild', parent, position);
  const repair = ub.bone('fxRepair', parent, position);
  fill(ub.glow(build), ub.style.weaponGlow, COLORS.sparkCore, false);
  fill(ub.glow(repair), COLORS.repair, COLORS.repairCore, true);
  return { fxBuild: build, fxRepair: repair };
}

/** Sparks / orb of the crane and the hook (point effects at the tool tip) */
function pointFx(g, color, core, repair) {
  if (repair) {
    g.point([0, 0, 0], FX.orbR, color, {}).point([0, 0, 0], FX.orbR * 0.5, core, {})
      .torus(FX.ring, FX.ringT, 3, 10, color, { rx: HALF_PI });
    return;
  }
  g.point([0, 0, 0], FX.coreR, core, {});
  g.point([FX.spark, FX.spark * 0.7, 0], FX.sparkR, color, {});
  g.point([-FX.spark * 0.8, FX.spark * 0.5, FX.spark * 0.7], FX.sparkR, color, {});
  g.point([FX.spark * 0.2, FX.spark, -FX.spark], FX.sparkR, color, {});
}

/** Beam along local −Y (cone, outer + core) */
function beamFx(g, color, core, len, outer, inner, seg) {
  g.cylinder(outer[0], outer[1], len, seg, color, { y: -len / 2, intensity: GLOW.beam }, true);
  g.cylinder(inner[0], inner[1], len, seg, core, { y: -len / 2 }, true);
  g.point([0, 0, 0], outer[0] * 2, core, {});
}

/** Roof hatch / dome / canopy channels are applied by the class: { bone, channels: [{ prop, to }] } (absolute targets) */
const rigMeta = (rig, bones, hatch, extra = {}) => ({ rig, bones, hatch, ...extra });

// ---------------------------------------------------------------- rounded build (utility truck with crane)

function buildRounded(ub, kit) {
  const s = SHAPES.rounded;
  const S = kit.S;
  const base = chassis(ub, s.W, s.L);
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  const f = s.frame;
  const yF = base + f.h;
  unitBox(hb, kit, s.W, f.h, f.d, S.hullDark, { y: base + f.h / 2, z: f.z });
  const bed = s.bed;
  const bedTop = yF + bed.floorT;
  hb.box(bed.w, bed.floorT, bed.d, S.dark, { y: yF + bed.floorT / 2, z: bed.z });
  // hazard stripes along the frame edge
  const hz = s.hazard;
  for (const side of [1, -1]) {
    hb.hazardStrip(bed.d, hz.h, hz.stripe, S.accent, S.dark, { x: side * (s.W / 2 + hz.out), y: base + f.h / 2, z: bed.z, ry: side * HALF_PI });
  }
  hb.hazardStrip(s.W, hz.h, hz.stripe, S.accent, S.dark, { y: base + f.h / 2, z: f.z - f.d / 2 - hz.out, ry: Math.PI });
  // rails
  const r = s.rail;
  for (const side of [1, -1]) {
    hb.box(r.t, r.t, bed.d, S.frame, { x: side * r.x, y: bedTop + r.h, z: bed.z });
    for (const pz of r.posts) hb.box(r.t, r.h, r.t, S.frame, { x: side * r.x, y: bedTop + r.h / 2, z: bed.z + pz });
  }
  hb.box(s.W - r.t, r.t, r.t, S.frame, { y: bedTop + r.h, z: bed.z - bed.d / 2 + r.t });
  // cab (team body)
  const c = s.cab;
  const cabTop = yF + c.h;
  const front = c.z + c.d / 2;
  unitBox(hb, kit, c.w, c.h, c.d, S.teamPaint, { y: yF + c.h / 2, z: c.z, detail: 2 });
  roofMark(ub, 'hull', { y: cabTop, z: c.z + s.mark.z, w: s.mark.w, d: s.mark.d });
  const g = s.glass;
  hb.box(c.w * g.frontW, c.h * g.frontH, g.t, S.window, { y: yF + c.h * g.frontY, z: front + g.out });
  for (const side of [1, -1]) {
    hb.box(g.t, c.h * g.sideH, c.d * g.sideD, S.window, { x: side * (c.w / 2 + g.out), y: yF + c.h * g.frontY, z: c.z + 0.1 });
    emblemPlate(ub, 'hull', { position: [side * (c.w / 2), yF + c.h * s.emblem.y, c.z + s.emblem.z], normal: [side, 0, 0], size: s.emblem.size });
    const l = s.lamp;
    hb.box(l.w, l.h, g.t, S.lamp, { x: side * l.x, y: yF + l.y, z: front + g.out });
    hg.point([side * l.x, yF + l.y, front + g.out + g.t], l.glowR, COLORS.headlight, {});
  }
  // beacon
  const bc = s.beacon;
  hb.cylinder(bc.baseR, bc.baseR * 1.3, bc.y, 8, S.dark, { y: cabTop + bc.y / 2, z: c.z + bc.z, detail: 0 });
  const beacon = ub.bone('beacon', 'hull', [0, cabTop + bc.y + bc.glowR * 0.5, c.z + bc.z]);
  ub.glow(beacon).point([0, 0, 0], bc.glowR, COLORS.beacon, {});
  // crew roof hatch
  const h = s.hatch;
  const hatch = ub.bone('hatch', 'hull', [0, cabTop + h.y * 0.3, c.z + h.z]);
  ub.paint(hatch).box(h.lidW, h.lidT, h.lidD, S.frame, { y: h.y * 0.7, z: h.lidD / 2, detail: 0 });
  // crane: slew → lower arm → upper arm → nozzle tool
  const k = s.crane;
  hb.cylinder(k.baseR, k.baseR * 1.2, k.baseH, 8, S.frame, { x: k.x, y: bedTop + k.baseH / 2, z: k.z });
  const slew = ub.bone('slew', 'hull', [k.x, bedTop + k.baseH, k.z]);
  // rest pose = stowed (also what the far LOD freezes), update() folds it out
  const lower = ub.bone('lower', slew, [0, 0.1, 0], { rotation: [POSES.crane.lower[0], 0, 0] });
  const upper = ub.bone('upper', lower, [0, k.lowerLen, 0], { rotation: [POSES.crane.upper[0], 0, 0] });
  const tool = ub.bone('tool', upper, [0, k.upperLen + k.nozzle, 0]);
  const lb = ub.paint(lower);
  lb.box(k.armW, k.lowerLen, k.armW, S.hull, { y: k.lowerLen / 2 });
  lb.cylinder(k.jointR, k.jointR, k.jointW, 8, S.frame, { rz: HALF_PI });
  lb.cylinder(0.06, 0.06, k.lowerLen * 0.6, 6, S.frame, { x: -(k.armW / 2 + 0.06), y: k.lowerLen * 0.4, detail: 0 });   // on the rail side, keeps the bed centre free
  const ubn = ub.paint(upper);
  ubn.box(k.upW, k.upperLen, k.upW, S.hull, { y: k.upperLen / 2 });
  ubn.cylinder(k.jointR * 0.8, k.jointR * 0.8, k.jointW * 0.8, 8, S.frame, { rz: HALF_PI });
  ubn.cylinder(0.04, 0.13, k.nozzle, 8, S.frame, { y: k.upperLen + k.nozzle / 2 });
  const fx = fxBones(ub, tool, [0, 0.04, 0], pointFx);
  const aimY = yF + c.h * s.aimShare;
  ub.socket('cargo', 'hull', [0, bedTop, bed.z]);
  ub.socket('work', tool, [0, 0.04, 0]);
  ub.socket('aim', 'hull', [0, aimY, c.z]);
  ub.socket('smoke', 'hull', [0, bedTop, s.L * s.smokeZ]);
  ub.socket('hatch', hatch, [0, 0.3, h.lidD / 2]);
  statusLamp(ub, { parent: 'hull', position: [c.w * s.lampStatus.x, cabTop, c.z + s.lampStatus.z] });
  ub.meta.truck = rigMeta('crane', { slew, lower, upper, tool, beacon, ...fx }, { bone: hatch, channels: [{ prop: 'rx', to: h.open }] });
  return ub.build();
}

// ---------------------------------------------------------------- angular build (heavy hauler with boom + hook)

function buildAngular(ub, kit) {
  const s = SHAPES.angular;
  const S = kit.S;
  const base = chassis(ub, s.W, s.L);
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  const f = s.frame;
  const yF = base + f.h;
  hb.taperedBox(s.W, f.topW, f.h, f.d, S.hullDark, { y: base, z: f.z });
  const frontZ = f.z + f.d / 2;
  const p = s.plate;
  for (const side of [1, -1]) {
    hb.box(p.t, p.h, f.d * p.share, S.hull, { x: side * (s.W / 2), y: base + p.y, z: f.z, rz: side * p.lean });
  }
  const bp = s.bumper;
  hb.box(s.W + 0.1, bp.h, bp.d, S.frame, { y: base + bp.y, z: frontZ + bp.d / 2 });
  const lp = s.lamp;
  for (const side of [1, -1]) {
    hb.cylinder(lp.r, lp.rBase, lp.len, 8, S.lamp, { x: side * lp.x, y: base + lp.y, z: frontZ + bp.d + lp.out, rx: HALF_PI });
    hg.point([side * lp.x, base + lp.y, frontZ + bp.d + lp.out + lp.len / 2], lp.glowR, COLORS.warmLamp, {});
  }
  // cab: sloped team armour
  const c = s.cab;
  const cabTop = yF + c.h;
  hb.taperedBox(c.w, c.topW, c.h, c.d, S.teamPaint, { y: yF, z: c.z, detail: 2 }, c.topD);
  roofMark(ub, 'hull', { y: cabTop, z: c.z + s.mark.z, w: s.mark.w, d: s.mark.d });
  const g = s.glass;
  const faceZ = c.z + c.d / 2 - ((c.d - c.topD) / 2) * (g.y / c.h);
  hb.box(g.w, g.h, 0.06, S.window, { y: yF + g.y, z: faceZ + g.out, rx: g.lean });
  for (const side of [1, -1]) {
    const e = s.emblem;
    const halfW = c.w / 2 - ((c.w - c.topW) / 2) * e.y;
    emblemPlate(ub, 'hull', { position: [side * halfW, yF + c.h * e.y, c.z + e.z], normal: [side, e.tilt, 0], size: e.size });
  }
  // bed with walls and rivets
  const b = s.bed;
  const bedTop = yF + b.floorT;
  hb.box(b.w, b.floorT, b.d, S.dark, { y: yF + b.floorT / 2, z: b.z });
  for (const side of [1, -1]) {
    hb.box(b.wallT, b.wallH, b.d, S.teamShade, { x: side * (b.w / 2), y: bedTop + b.wallH / 2, z: b.z, detail: 2 });
    for (let i = 0; i < b.rivets; i++) {
      const rz = b.z - b.d / 2 + ((i + 0.5) / b.rivets) * b.d;
      hb.cylinder(b.rivetR, b.rivetR, b.wallT * 0.6, 4, S.frame, { x: side * (b.w / 2 + b.wallT / 2), y: bedTop + b.wallH * 0.6, z: rz, rz: HALF_PI, detail: 0 });
    }
  }
  hb.box(b.w + b.wallT, b.wallH, b.wallT, S.teamShade, { y: bedTop + b.wallH / 2, z: b.z - b.d / 2, detail: 2 });
  // fans (no grille: bare blades) + crew hatch on the cab roof
  const fn = s.fan;
  const fans = {};
  for (const [i, side] of [1, -1].entries()) {
    hb.cylinder(fn.housingR, fn.housingRb, fn.housingH, 10, S.dark, { x: side * fn.x, y: cabTop + fn.housingH / 2, z: c.z + fn.z });
    const fan = ub.bone(`fan${i + 1}`, 'hull', [side * fn.x, cabTop + fn.y, c.z + fn.z]);
    ub.paint(fan).box(fn.bladeL, fn.bladeT, fn.bladeW, S.frame, {}).box(fn.bladeL, fn.bladeT, fn.bladeW, S.frame, { ry: HALF_PI });
    fans[`fan${i + 1}`] = fan;
  }
  const h = s.hatch;
  const hatch = ub.bone('hatch', 'hull', [0, cabTop + h.y * 0.3, c.z + h.z]);
  ub.paint(hatch).box(h.lidW, h.lidT, h.lidD, S.frame, { y: h.y * 0.7, z: h.lidD / 2, detail: 0 });
  // boom: pedestal → slew → boom → telescope → chain (hangs vertical) → hook
  const m = s.boom;
  hb.taperedBox(m.pedW, m.pedTop, m.pedH, m.pedD, S.hullDark, { x: m.x, y: bedTop, z: m.z });
  const slew = ub.bone('slew', 'hull', [m.x, bedTop + m.pedH, m.z]);
  const boomRest = POSES.hook.boom[0];   // rest pose = stowed (far LOD freezes it)
  const chain0 = POSES.hook.chain[0];    // stowed chain length = geometry length, update() scales it
  const boom = ub.bone('boom', slew, [0, 0.05, 0], { rotation: [boomRest, 0, 0] });
  const ext = ub.bone('ext', boom, [0, m.len - m.extIn, 0]);
  const chainRot = ub.bone('chainRot', ext, [0, m.ext, 0], { rotation: [-boomRest, 0, 0] });
  const chain = ub.bone('chain', chainRot, [0, 0, 0]);
  const hk = s.hook;
  const hook = ub.bone('hook', chainRot, [0, -chain0, 0]);
  const bm = ub.paint(boom);
  bm.taperedBox(m.w, m.topW, m.len, m.w, S.hull, {});
  bm.cylinder(m.hubR, m.hubR, m.hubW, 8, S.frame, { rz: HALF_PI });
  bm.cylinder(0.08, 0.08, m.len * 0.5, 6, S.frame, { x: -(m.w / 2 + 0.1), y: m.len * 0.35, detail: 0 });
  const em = ub.paint(ext);
  em.taperedBox(m.extW, m.extW * 0.85, m.ext, m.extW, S.frame, {});
  em.cylinder(m.pulleyR, m.pulleyR, m.extW + 0.04, 8, S.dark, { y: m.ext, rz: HALF_PI });
  ub.paint(chain).box(hk.chainT, chain0, hk.chainT, S.frame, { y: -chain0 / 2 });
  const hp = ub.paint(hook);
  hp.box(hk.block, hk.block * 0.9, hk.block, S.dark, { y: hk.block * 0.45 });
  hp.torus(hk.ringR, hk.ringT, 3, 10, TAU, S.frame, { y: -hk.ringR * 0.8 });
  const fx = fxBones(ub, hook, [0, -hk.tip, 0], pointFx);
  ub.socket('cargo', 'hull', [0, bedTop, b.z]);
  ub.socket('work', hook, [0, -hk.tip, 0]);
  ub.socket('aim', 'hull', [0, yF + c.h * s.aimShare, c.z]);
  ub.socket('smoke', 'hull', [0, bedTop, s.L * s.smokeZ]);
  ub.socket('hatch', hatch, [0, 0.3, h.lidD / 2]);
  statusLamp(ub, { parent: 'hull', position: [s.lampStatus.x, cabTop, c.z + s.lampStatus.z] });
  ub.meta.truck = rigMeta('hook', { slew, boom, ext, chainRot, chain, hook, ...fans, ...fx }, { bone: hatch, channels: [{ prop: 'rx', to: h.open }] });
  return ub.build();
}

// ---------------------------------------------------------------- round build (pearl body, levitating cradle, emitter ring)

function buildRound(ub, kit) {
  const s = SHAPES.round;
  const S = kit.S;
  const base = chassis(ub, s.W, s.L);
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  const sh = s.shell;
  const shellY = base + sh.y;
  hb.sphere(1, sh.seg[0], sh.seg[1], S.hull, { y: shellY, sx: sh.sx, sy: sh.sy, sz: sh.sz, detail: 2 });
  // team cap over the top of the shell
  hb.add(new THREE.SphereGeometry(1, sh.capSeg[0], sh.capSeg[1], 0, TAU, 0, sh.cap), S.teamPaint, {
    y: shellY, sx: sh.sx * sh.capLift, sy: sh.sy * sh.capLift, sz: sh.sz * sh.capLift, detail: 2,
  });
  // crew dome (its own bone: lifts for boarding)
  const d = s.dome;
  const domeBase = base + d.y;
  hb.cylinder(1, 1, d.seatT, d.seg[0], S.interior, { y: domeBase, z: d.z, sx: d.rx, sz: d.rz });
  teamTrim(ub, 'hull', { x: 0, y: domeBase - 0.02, z: d.z, w: d.rx * 2.1, d: d.rz * 2.1, round: true });
  const hatch = ub.bone('hatch', 'hull', [0, domeBase, d.z]);
  ub.paint(hatch).add(new THREE.SphereGeometry(1, d.seg[0], d.seg[1], 0, TAU, 0, HALF_PI), S.window, { sx: d.rx, sy: d.ry, sz: d.rz });
  // levitating cradle (bed): glow ring under it, rim on top
  const cr = s.cradle;
  const cradle = ub.bone('cradle', 'hull', [0, base + cr.y, cr.z]);
  const cp = ub.paint(cradle);
  cp.cylinder(1, 0.88, cr.t, cr.seg, S.teamShade, { y: cr.t / 2, sx: cr.rx, sz: cr.rz, detail: 2 });   // team-coloured cradle floor (readable from above)
  cp.torus(1, cr.rimT, cr.rimRadial, cr.seg, TAU, S.trim, { rx: HALF_PI, y: cr.t, sx: cr.rx, sy: cr.rz, sz: 1, detail: 0 });
  ub.glow(cradle).torus(0.9, 0.04, 3, cr.seg, ub.style.hoverGlow, { rx: HALF_PI, sx: cr.rx, sy: cr.rz, y: -0.02 })
    .disc(cr.glowR, 12, ub.style.hoverGlow, { y: -0.05, sx: cr.rx / cr.glowR * GLOW.cradleFill, sy: cr.rz / cr.glowR * GLOW.cradleFill, intensity: GLOW.cradleDisc });   // disc is built in XY, then laid flat: sy = depth
  // emitter ring: ring (rise + sweep) → tilt → spin
  const rg = s.ring;
  const ring = ub.bone('ring', 'hull', [0, base + rg.y, rg.z]);
  const tilt = ub.bone('tilt', ring, [0, 0, 0]);
  const spin = ub.bone('spin', tilt, [0, 0, 0]);
  const sp = ub.paint(spin);
  sp.torus(rg.R, rg.tube, 4, 16, TAU, S.trim, { rx: HALF_PI });
  for (let i = 0; i < rg.bumps; i++) {
    const a = (i / rg.bumps) * TAU;
    sp.box(rg.bumpS, rg.bumpS, rg.bumpS, S.hull, { x: Math.cos(a) * rg.R, z: Math.sin(a) * rg.R, ry: -a, detail: 0 });
  }
  ub.glow(spin).torus(rg.glowR, rg.glowT, 3, 16, ub.style.plasma, { rx: HALF_PI });
  ub.glow(tilt).point([0, 0, 0], rg.coreR, ub.style.plasma, {});
  ub.glow(ring).disc(rg.under, 10, ub.style.hoverGlow, { y: -0.15, intensity: GLOW.ringUnder });
  const bm = s.beam;
  const fx = fxBones(ub, tilt, [0, -0.1, 0], (g, color, core) => beamFx(g, color, core, bm.len, [bm.near, bm.far], [bm.coreNear, bm.coreFar], bm.seg));
  // emblem on the shell flank, status lamp
  const e = s.emblem;
  for (const side of [1, -1]) {
    emblemPlate(ub, 'hull', { position: [side * sh.sx * e.out, shellY + e.y, e.z], normal: [side, 0.1, 0], size: e.size, backing: false });
  }
  statusLamp(ub, { parent: 'hull', position: [s.lampStatus.x, base + s.lampStatus.y, s.lampStatus.z] });
  ub.socket('cargo', cradle, [0, cr.t, 0]);
  ub.socket('work', tilt, [0, -0.1, 0]);
  ub.socket('aim', 'hull', [0, shellY + sh.sy * s.aimShare, d.z * 0.3]);
  ub.socket('smoke', 'hull', [0, shellY + sh.sy, s.L * s.smokeZ]);
  ub.socket('hatch', hatch, [0, d.ry * 0.5, 0]);
  ub.meta.truck = rigMeta('ring', { ring, tilt, spin, cradle, ...fx }, { bone: hatch, channels: [{ prop: 'y', to: domeBase + d.open }, { prop: 'rx', to: d.tilt }] });
  return ub.build();
}

// ---------------------------------------------------------------- faceted build (slim body, tray, rail tractor beam)

function buildFaceted(ub, kit) {
  const s = SHAPES.faceted;
  const S = kit.S;
  const base = chassis(ub, s.W, s.L);
  const hb = ub.paint('hull');
  const f = s.frame;
  const yF = base + f.h;
  unitBox(hb, kit, s.W, f.h, f.d, S.hullDark, { y: base + f.h / 2, z: f.z });
  // tray with diamond seams and gold lips
  const b = s.bed;
  const bedTop = yF + b.floorT;
  hb.box(b.w, b.floorT, b.d, S.teamShade, { y: yF + b.floorT / 2, z: b.z, detail: 2 });   // team-coloured tray floor (readable from above)
  for (const ry of [Math.PI / 4, -Math.PI / 4]) {
    for (const k of [-1, 0, 1]) hb.box(b.seamW, b.seamH, b.seamLen, S.frame, { y: bedTop + b.seamH / 2, z: b.z + k * b.seamStep, ry, detail: 0 });
  }
  for (const side of [1, -1]) hb.box(b.lipT, b.lipH, b.d, S.accent, { x: side * (b.w / 2 + b.lipT / 2), y: bedTop + b.lipH / 2, z: b.z });
  hb.box(b.w + b.lipT * 2, b.lipH, b.lipT, S.accent, { y: bedTop + b.lipH / 2, z: b.z - b.d / 2 - b.lipT / 2 });
  // faceted body + team nose
  const o = s.body;
  const yC = yF + o.y;
  prism(hb, 6, o.w, o.h, o.len, S.hull, { y: yC, z: o.z, detail: 2 }, 0);
  noseCone(hb, 6, o.w, o.h, o.noseLen, S.teamPaint, { y: yC, z: o.z + o.len / 2 + o.noseLen / 2, detail: 2 });
  const flankX = Math.sin(Math.PI / 3) * (o.w / 2);   // vertical flank face of the hexagon
  const ridge = yC + o.h / 2;
  const sl = s.slat;
  const edge = s.edge;
  const heat = ub.bone('heat', 'hull', [0, yC - sl.h / 2, 0]);
  for (const side of [1, -1]) {
    hb.box(edge.t, edge.t, o.len, S.accent, { x: side * flankX, y: yC - o.h * 0.25, z: o.z });
    teamPanel(ub, 'hull', s.panel.w, s.panel.h, { x: side * flankX, y: yC, z: s.panel.z, ry: side * HALF_PI });
    emblemPlate(ub, 'hull', { position: [side * flankX, yC, s.emblem.z], normal: [side, 0, 0], size: s.emblem.size });
    for (let i = 0; i < sl.n; i++) {
      const z = sl.z + i * sl.step;
      hb.box(sl.w, sl.h, sl.t, S.hullDark, { x: side * (flankX + sl.w / 2), y: yC, z, detail: 0 });
      if (i < sl.n - 1) ub.glow(heat).box(sl.slitD * 0.5, sl.slitH, sl.slit, ub.style.hoverGlow, { x: side * (flankX + sl.slitD * 0.5), y: sl.slitH / 2, z: z + sl.step / 2, intensity: GLOW.heat });
    }
  }
  // glass canopy = sliding hatch
  const gl = s.glass;
  const hatch = ub.bone('hatch', 'hull', [0, ridge + s.hatch.y, gl.z]);
  prism(ub.paint(hatch), 4, gl.w, gl.h, gl.len, S.window, { detail: 1 });
  // rail + tractor emitter: slide → swing (yaw) → drop (tilt) → tool
  const r = s.rail;
  hb.box(r.t, r.t, r.len, S.accent, { x: -r.x, y: bedTop + r.h, z: r.z });
  for (const pz of r.posts) hb.box(r.postT, r.h, r.postT, S.accent, { x: -r.x, y: bedTop + r.h / 2, z: pz });
  const slide = ub.bone('slide', 'hull', [-r.x, bedTop + r.h, r.start]);
  const swing = ub.bone('swing', slide, [0, 0, 0], { rotation: [0, HALF_PI, 0] });
  const drop = ub.bone('drop', swing, [0, 0, 0]);
  const bo = s.boom;
  const tool = ub.bone('tool', drop, [bo.len, 0, 0]);
  const dp = ub.paint(drop);
  dp.box(bo.len, bo.t, bo.t, S.hullDark, { x: bo.len / 2 });
  dp.cylinder(bo.hubR, bo.hubR, bo.t * 1.6, 6, S.accent, { rx: HALF_PI });
  ub.paint(tool).box(s.tool.lensW, s.tool.lensH, s.tool.lensW, S.dark, { y: -s.tool.lensH / 2 });
  ub.glow(tool).point([0, -s.tool.lensH, 0], s.tool.lensW * 0.5, ub.style.weaponGlow, {});
  const bm = s.beam;
  const fx = fxBones(ub, tool, [0, -s.tool.lensH, 0], (g, color, core) => beamFx(g, color, core, bm.len, bm.outer, bm.core, bm.seg));
  ub.socket('cargo', 'hull', [0, bedTop, b.z]);
  ub.socket('work', tool, [0, -s.tool.lensH, 0]);
  ub.socket('aim', 'hull', [0, yC, o.z]);
  ub.socket('smoke', 'hull', [0, bedTop, s.L * s.smokeZ]);
  ub.socket('hatch', hatch, [0, gl.h * 0.5, 0]);
  statusLamp(ub, { parent: 'hull', position: [s.lampStatus.x, bedTop, s.lampStatus.z] });
  const hy = ridge + s.hatch.y;
  ub.meta.truck = rigMeta('rail', { slide, swing, drop, tool, heat, ...fx }, {
    bone: hatch, channels: [{ prop: 'z', to: gl.z + s.hatch.slide }, { prop: 'y', to: hy + s.hatch.lift }],
  });
  return ub.build();
}

const BUILDERS = { rounded: buildRounded, angular: buildAngular, round: buildRound, faceted: buildFaceted };

function buildHoverTruck(kit) {
  const ub = new UnitBuilder(kit);
  return (BUILDERS[kit.style.silhouette] ?? buildRounded)(ub, kit);
}

const CACHE = createUnitCache(buildHoverTruck);

// ---------------------------------------------------------------- unit

const clamp01 = (v) => (v <= 0 ? 0 : v >= 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const hash = (step, seed) => { const n = Math.sin(step * 12.9898 + seed * 78.233) * 43758.5453; return n - Math.floor(n); };

export class HoverTruckUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'hoverTruck', name: 'HoverTruckUnit' });
    const m = this.shared.meta.truck;
    this.rig = m.rig;
    this.pose = POSES[m.rig];
    this.b = {};
    for (const [key, name] of Object.entries(m.bones)) this.b[key] = this.getBone(name);
    // rest values (the bones come in their rest pose from the cache)
    this.rest = { ext: this.b.ext?.position.y ?? 0, ring: this.b.ring?.position.y ?? 0, cradle: this.b.cradle?.position.y ?? 0 };
    const hb = this.getBone(m.hatch.bone);
    this.hatch = {
      bone: hb,
      ch: m.hatch.channels.map((c) => ({
        prop: c.prop, to: c.to,
        from: c.prop === 'x' || c.prop === 'y' || c.prop === 'z' ? hb.position[c.prop] : hb.rotation[c.prop.slice(1)],
      })),
    };
    this.workKind = 'none';
    this.workGoal = 0;
    this.w = 0;
    this.fxKind = 0;       // 0 build, 1 repair (kept while the tool winds down)
    this.hatchGoal = 0;
    this.h = 0;
    this.fanSpin = 0;
    this.hidden = UNIT_KIT.hiddenScale;
    for (const k of ['fxBuild', 'fxRepair']) this.b[k]?.scale.setScalar(this.hidden);
    if (this.b.beacon) this.b.beacon.scale.setScalar(this.hidden);
  }

  /** Work state: kind 'none' | 'build' | 'repair', amount 0..1 (smoothed in update) */
  setWork(kind = 'none', amount = 1) {
    this.workKind = kind;
    if (kind === 'build') { this.fxKind = 0; this.workGoal = clamp01(amount); }
    else if (kind === 'repair') { this.fxKind = 1; this.workGoal = clamp01(amount); }
    else this.workGoal = 0;
  }

  /** Crew space open 0..1 (roof hatch / dome / canopy), smoothed in update */
  setHatch(v) { this.hatchGoal = clamp01(v); }

  /** Smoothed work amount 0..1 (tool deployment) */
  get workAmount() { return this.w; }

  update(dt) {
    const t = this.time;
    const w = this.w += (this.workGoal - this.w) * Math.min(1, dt * WORK.ease);
    if (this.workGoal === 0 && w < WORK.epsilon) this.w = 0;
    this.h += (this.hatchGoal - this.h) * Math.min(1, dt * WORK.hatchEase);
    const e = smootherstep(this.w);
    this.#pose(e, t, dt);
    this.#effects(e, t);
    this.#hatchPose();
    this.#extras(t, dt);
  }

  #pose(e, t, dt) {
    const P = this.pose;
    const b = this.b;
    const w = this.w;
    const ph = this.phase;
    switch (this.rig) {
      case 'crane':
        b.slew.rotation.y = P.slew * e + P.sweep * w * Math.sin(P.sweepRate * t + ph);
        b.lower.rotation.x = lerp(P.lower[0], P.lower[1], e);
        b.upper.rotation.x = lerp(P.upper[0], P.upper[1], e) + P.wobble * w * Math.sin(P.wobbleRate * t + ph);
        break;
      case 'hook': {
        b.slew.rotation.y = P.slew * e + P.sweep * w * Math.sin(P.sweepRate * t + ph);
        const boomRx = lerp(P.boom[0], P.boom[1], e);
        b.boom.rotation.x = boomRx;
        b.ext.position.y = this.rest.ext + P.ext * e;
        const len = lerp(P.chain[0], P.chain[1], e);
        b.chainRot.rotation.x = -boomRx + P.swing * w * Math.sin(P.swingRate * t + ph);   // the chain hangs vertical
        b.chain.scale.y = len / P.chain[0];
        b.hook.position.y = -len;
        break;
      }
      case 'ring':
        b.ring.position.y = this.rest.ring + P.rise * e + P.bob * Math.sin(TAU * P.bobFreq * t + ph);
        b.ring.rotation.y = P.sweep * e + P.wander * w * Math.sin(P.wanderRate * t + ph);
        b.tilt.rotation.z = P.tilt * e;
        b.spin.rotation.y = (b.spin.rotation.y + dt * lerp(P.spin[0], P.spin[1], w)) % TAU;
        b.cradle.position.y = this.rest.cradle + SHAPES.round.cradle.bob * Math.sin(TAU * SHAPES.round.cradle.bobFreq * t + ph);
        break;
      default: {   // 'rail'
        b.slide.position.z = lerp(P.slide[0], P.slide[1], e);
        b.swing.rotation.y = lerp(P.swing[0], P.swing[1], e) + P.sway * w * Math.sin(P.swayRate * t + ph);
        b.drop.rotation.z = P.drop * e;
        b.tool.rotation.z = -b.drop.rotation.z + P.lean * e;
        const heat = WORK.heatIdle + (1 - WORK.heatIdle) * e * (1 + WORK.heatPulse * Math.sin(WORK.heatRate * t + ph));
        b.heat.scale.y = Math.max(this.hidden, heat);
      }
    }
  }

  // Build / repair effect: point effects (crane, hook) flicker, beams (ring, rail) grow; only the active kind shows
  #effects(e, t) {
    const b = this.b;
    const hid = this.hidden;
    const k = e > WORK.fxStart ? (e - WORK.fxStart) / (1 - WORK.fxStart) : 0;
    const beam = this.rig === 'ring' || this.rig === 'rail';
    const build = this.fxKind === 0;
    const flick = 1 + WORK.flicker * (hash(Math.floor(t * WORK.flickerRate), this.phase) - 0.5) * 2;
    const pulse = 1 + WORK.pulse * Math.sin(WORK.pulseRate * t + this.phase);
    const kb = build ? k : 0;
    const kr = build ? 0 : k;
    if (kb <= 0) b.fxBuild.scale.setScalar(hid);
    else if (beam) b.fxBuild.scale.set(flick, Math.max(hid, kb), flick);
    else b.fxBuild.scale.setScalar(kb * flick);
    if (kr <= 0) b.fxRepair.scale.setScalar(hid);
    else if (beam) b.fxRepair.scale.set(pulse, Math.max(hid, kr), pulse);
    else b.fxRepair.scale.setScalar(kr * pulse);
  }

  #hatchPose() {
    const eh = smootherstep(this.h);
    const ch = this.hatch.ch;
    const bone = this.hatch.bone;
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      const value = c.from + (c.to - c.from) * eh;
      switch (c.prop) {
        case 'x': bone.position.x = value; break;
        case 'y': bone.position.y = value; break;
        case 'z': bone.position.z = value; break;
        case 'rx': bone.rotation.x = value; break;
        case 'ry': bone.rotation.y = value; break;
        default: bone.rotation.z = value;
      }
    }
  }

  // Beacon blink (crane build) and fans (hook build): idle slow, fast while working
  #extras(t, dt) {
    const b = this.b;
    if (b.beacon) {
      const period = this.kit.style.anim.blink * lerp(1, WORK.beaconWorkShare, this.w);
      b.beacon.scale.setScalar((t + this.phase) % period < period / 2 ? 1 : this.hidden);
    }
    if (b.fan1) {
      const P = this.pose;
      this.fanSpin = (this.fanSpin + dt * this.kit.style.anim.spin * lerp(P.fan[0], P.fan[1], this.w)) % TAU;
      b.fan1.rotation.y = this.fanSpin;
      b.fan2.rotation.y = -this.fanSpin;
    }
  }
}

registerProcUnit('hoverTruck', (race, teamColor, opts) => new HoverTruckUnit({ race, teamColor, ...opts }));
