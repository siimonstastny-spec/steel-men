// Steel Men – procedural crew member (block B5, docs/notes/b5-crew-venus.md): the small figure of a crew squad built in code
// in the style of a faction (data/buildingStyles.json, palette / glow / silhouette-independent shape), the replacement of the
// RobotCrew GLB. One member = one ProcUnit of the unit kit (UnitKit.js): ONE rigid skeleton, paint + glow skinned meshes at
// LOD0, far LODs instanced by the UnitBatcher (enableBatching), shared cached geometry per style (ref-counted), team colour on
// the shoulder pads / chest plate / pack cap (paint vertices with the team mask → setTeamColor repaints, no extra draw call).
// Model convention = the GLB crew: ≈ 7 units high, feet on y = 0, forward +Z (Crew scales it by stats.crew.modelScale).
// Animation is procedural and visual only: idle (breath, glance, arm sway, pack pulse) and run (stride, knees, arm swing, lean,
// bob); per member phase from its index (CREW_ANIM.phaseStep) – no Math.random, no Date.now / performance.now, tick() allocates
// nothing. The GLB crew has no death / lying pose (Crew just removes the squad), so there is none here either.
//   const m = createProcCrewMember('Z', '#3a5ccc', i);   // null when the race has no procedural crew / models are off
//   m.setMotion(speed);   // units/s; ≥ PROC_CREW.motion.moveEpsilon → run (stride rate from speed), else idle
//   m.play('idle' | 'run');  // alternative: forces the state (run at the reference speed) until the next setMotion
//   m.enableBatching();   // after the member is in the scene
//   m.tick(dt); m.setTeamColor(c); m.dispose();
import * as THREE from 'three';
import { ProcUnit, UnitBuilder, createUnitCache } from '../units/UnitKit.js';
import { PROC_CREW, CREW_ANIM } from '../../config.js';
import { proceduralEnabled } from '../registry.js';

const TAU = Math.PI * 2;
const SH = PROC_CREW.shape;
const SEG = PROC_CREW.segments;

// ---------------------------------------------------------------- model

// Shape variant of a style: by the silhouette family of the style (data), never by the race name
const variantOf = (kit) => PROC_CREW.variants[kit.style.silhouette] ?? PROC_CREW.variants[PROC_CREW.defaultVariant];

/** [b4-crew-slim] Sphere segments [wSeg, hSeg] of a body part: variant `seg[key]`, else the base sphere + the old offset */
const sphereSeg = (V, key, dw = 0, dh = 0) => V.seg?.[key] ?? [SEG.sphere[0] + dw, SEG.sphere[1] + dh];

/**
 * [b4-crew-slim] Cheap rounded box (48 triangles): a 2×2-per-face subdivided box pushed onto an inner box + radius, smooth
 * normals (same scheme as ProcKit.roundedBoxGeometry with an even subdivision) – a soft pillow for small pads / the pack.
 */
function pillowBoxGeometry(w, h, d, radius) {
  const g = new THREE.BoxGeometry(1, 1, 1, PROC_CREW.pillowSubdiv, PROC_CREW.pillowSubdiv, PROC_CREW.pillowSubdiv);
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const half = 0.5 / PROC_CREW.pillowSubdiv;
  const r = Math.min(radius, w / 2, h / 2, d / 2);
  const bx = w / 2 - r;
  const by = h / 2 - r;
  const bz = d / 2 - r;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let nx = x - Math.sign(x) * half;
    let ny = y - Math.sign(y) * half;
    let nz = z - Math.sign(z) * half;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    pos.setXYZ(i, Math.sign(x) * bx + nx * r, Math.sign(y) * by + ny * r, Math.sign(z) * bz + nz * r);
    nor.setXYZ(i, nx, ny, nz);
  }
  return g;
}

/** Rounded box: ProcKit roundedBox for segs ≥ 1, the cheap pillow for segs 0 */
function softBox(pb, w, h, d, radius, segs, s, t) {
  return segs > 0 ? pb.roundedBox(w, h, d, radius, segs, s, t) : pb.add(pillowBoxGeometry(w, h, d, radius), s, t);
}

function addLeg(ub, kit, side, V) {
  const S = kit.S;
  const limbSeg = V.limbSeg ?? SEG.limb;
  const jointSeg = V.jointSeg ?? SEG.joint;
  const n = side > 0 ? 'L' : 'R';
  const hip = ub.bone(`hip${n}`, 'hip', [side * SH.hipX, 0, 0]);
  const knee = ub.bone(`knee${n}`, hip, [0, -SH.thigh.len, 0]);
  const th = SH.thigh;
  const sn = SH.shin;
  const f = { ...SH.foot, ...V.foot };
  if (V.lean) {
    // lean: no hip ball (closed thigh top), shin open at both ends (hidden by the knee ball and the foot)
    ub.paint(hip).cylinder(th.rTop, th.rBottom, th.len, limbSeg, S.hullDark, { y: -th.len / 2, detail: 2 });
    ub.paint(knee).sphere(SH.knee.r * (V.jointScale ?? 1), jointSeg[0], jointSeg[1], S.frame, { detail: 1 })
      .cylinder(sn.rTop, sn.rBottom, sn.len, limbSeg, S.hull, { y: -sn.len / 2, detail: 2 }, true)
      .box(f.w, f.h, f.d, S.dark, { y: -sn.len - f.drop, z: f.z, detail: 1 });
    return;
  }
  ub.paint(hip).cylinder(th.rTop, th.rBottom, th.len, limbSeg, S.hullDark, { y: -th.len / 2, detail: 2 })
    .sphere(th.rTop * 1.02, jointSeg[0], jointSeg[1], S.hull, { detail: 1 });
  ub.paint(knee).sphere(SH.knee.r, jointSeg[0], jointSeg[1], S.frame, { detail: 1 })
    .cylinder(sn.rTop, sn.rBottom, sn.len, limbSeg, S.hull, { y: -sn.len / 2, detail: 2 })
    .box(f.w, f.h, f.d, S.dark, { y: -sn.len - f.drop, z: f.z, detail: 1 });
}

/** Team shoulder pad on the shoulder joint (kind by variant) */
function addPad(pb, S, sh, side, V) {
  switch (sh.kind) {
    case 'rounded':
      return softBox(pb, sh.w, sh.h, sh.d, sh.radius, sh.segs, S.teamPaint, { y: sh.padY, detail: 2 });
    case 'slab':   // outer edge tilted down
      return pb.box(sh.w, sh.h, sh.d, S.teamPaint, { y: sh.padY, rz: -side * sh.tilt, detail: 2 });
    case 'facet':
      return pb.sphere(sh.padR, sh.wSeg, sh.hSeg, S.teamPaint, { y: sh.padY, sy: sh.padSy, detail: 2 });
    default: {
      const s = sphereSeg(V, 'pad');
      return pb.sphere(sh.padR, s[0], s[1], S.teamPaint, { y: sh.padY, sy: sh.padSy, detail: 2 });
    }
  }
}

function addArm(ub, kit, side, V) {
  const S = kit.S;
  const limbSeg = V.limbSeg ?? SEG.limb;
  const jointSeg = V.jointSeg ?? SEG.joint;
  const n = side > 0 ? 'L' : 'R';
  const sh = { ...SH.shoulder, ...V.shoulder };
  const shoulder = ub.bone(`shoulder${n}`, 'torso', [side * sh.x, sh.y, 0], { rotation: [0, 0, side * SH.armRest] });
  const ua = SH.upperArm;
  const elbow = ub.bone(`elbow${n}`, shoulder, [0, -ua.len, 0]);
  // team pad on the shoulder joint, upper arm below it
  // lean: the upper arm / forearm are open at both ends (top under the pad, joints under the elbow ball and the hand)
  addPad(ub.paint(shoulder), S, sh, side, V)
    .cylinder(ua.rTop, ua.rBottom, ua.len, limbSeg, S.hull, { y: -ua.len / 2, detail: 2 }, !!V.lean);
  const fa = SH.forearm;
  const handSeg = V.handSeg ?? jointSeg;
  ub.paint(elbow).sphere(SH.elbow.r * (V.jointScale ?? 1), jointSeg[0], jointSeg[1], S.frame, { detail: 1 })
    .cylinder(fa.rTop, fa.rBottom, fa.len, limbSeg, S.hullDark, { y: -fa.len / 2, detail: 2 }, !!V.lean)
    .sphere(SH.hand.r, handSeg[0], handSeg[1], S.dark, { y: -fa.len - SH.hand.r * 0.4, detail: 1 });
}

/** Torso body in the torso bone space (kind by variant) */
function addTorsoBody(tb, S, V) {
  const t = SH.torso;
  const k = V.torso ?? {};
  switch (k.kind) {
    case 'rounded':
      return softBox(tb, k.w, k.h, k.d, k.radius, k.segs, S.hull, { y: t.cy, detail: 2 });
    case 'tapered':   // broad shoulders, narrow waist; origin of the box at its bottom face
      return tb.taperedBox(k.w, k.topW, k.h, k.d, S.hull, { y: t.cy - k.h / 2, detail: 2 });
    case 'prism':     // n-sided frustum, a flat face to the front
      return tb.cylinder(k.rTop, k.rBottom, k.h, k.sides, S.hull, { y: t.cy, ry: Math.PI / k.sides, detail: 2 });
    default: {
      const s = sphereSeg(V, 'torso', 2, 1);
      return tb.sphere(1, s[0], s[1], S.hull, { y: t.cy, sx: t.rx, sy: t.ry, sz: t.rz, detail: 2 });
    }
  }
}

/** Backpack with its team cap (kind by variant) */
function addPack(tb, S, k, V) {
  switch (k.kind) {
    case 'box': {
      if (k.radius) softBox(tb, k.w, k.h, k.d, k.radius, k.segs, S.hullDark, { y: k.y, z: k.z, detail: 2 });
      else tb.box(k.w, k.h, k.d, S.hullDark, { y: k.y, z: k.z, detail: 2 });
      return tb.box(k.w * k.capScale, k.capH, k.d * k.capScale, S.teamPaint, { y: k.y + k.h / 2, z: k.z, detail: 2 });
    }
    case 'prism': {
      tb.cylinder(k.rTop, k.rBottom, k.h, k.sides, S.hullDark, { y: k.y, z: k.z, detail: 2 });
      return tb.cylinder(k.rTop * k.capScale, k.rTop * k.capScale * 1.1, k.capH, k.sides, S.teamPaint, { y: k.y + k.h / 2, z: k.z, detail: 2 });
    }
    default: {
      const s = sphereSeg(V, 'pack');
      tb.sphere(k.r, s[0], s[1], S.hullDark, { y: k.y, z: k.z, sy: k.sy, detail: 2 });
      return tb.cylinder(k.capR, k.capR * 1.1, k.capH, V.seg?.packCap ?? SEG.limb, S.teamPaint, { y: k.y + k.r * k.sy * 0.85, z: k.z, detail: 2 });
    }
  }
}

/** Helmet shell + visor lens in the head bone space (kinds by variant) */
function addHead(hb, S, V) {
  const h = SH.head;
  const k = V.head ?? {};
  const v = { ...SH.visor, ...V.visor };
  switch (k.kind) {
    case 'rounded':
      softBox(hb, k.w, k.h, k.d, k.radius, k.segs, S.hull, { detail: 2 });
      break;
    case 'tapered': {
      hb.taperedBox(k.w, k.topW, k.h, k.d, S.hull, { y: -k.h / 2, detail: 2 });
      const c = k.crest;
      if (c) hb.box(c.w, c.h, c.d, S.frame, { y: k.h / 2 + c.h / 2 - c.sink, z: c.z, detail: 2 });
      break;
    }
    case 'facet':
      hb.sphere(h.r, k.wSeg, k.hSeg, S.hull, { sy: h.sy, sz: h.sz, detail: 2 });
      break;
    default: {
      const s = sphereSeg(V, 'head', 2, 1);
      hb.sphere(h.r, s[0], s[1], S.hull, { sy: h.sy, sz: h.sz, detail: 2 });
    }
  }
  if (v.kind === 'slab') hb.box(v.w, v.h, v.d, S.window, { y: v.y, z: v.z, detail: 1 });
  else {
    const s = sphereSeg(V, 'visor');
    hb.sphere(1, s[0], s[1], S.window, { y: v.y, z: v.z, sx: v.rx, sy: v.ry, sz: v.rz, detail: 1 });
  }
  return v;
}

function buildCrew(kit) {
  const S = kit.S;
  const V = variantOf(kit);
  const ub = new UnitBuilder(kit);
  ub.bone('hip', 'root', [0, SH.hipY, 0]);
  const p = SH.pelvis;
  ub.paint('hip').box(p.w, p.h, p.d, S.hullDark, { y: p.y, detail: 2 });
  const t = SH.torso;
  ub.bone('torso', 'hip', [0, t.y, 0]);
  const tb = ub.paint('torso');
  addTorsoBody(tb, S, V);
  if (V.belt !== false) {
    const b = { ...SH.belt, ...V.belt };
    tb.cylinder(b.r, b.r, b.h, V.seg?.belt ?? SEG.limb + 4, S.frame, { y: b.y, detail: 1 });
  }
  const c = { ...SH.chest, ...V.chest };
  tb.box(c.w, c.h, c.d, S.teamPaint, { y: c.y, z: c.z, detail: 2 });
  const k = { ...SH.pack, ...V.pack };
  addPack(tb, S, k, V);
  const n = SH.neck;
  // lean: the neck is open at both ends (top inside the helmet, bottom inside the torso)
  tb.cylinder(n.r, n.r * 1.15, n.h, V.lean ? (V.limbSeg ?? SEG.limb) : SEG.limb, S.frame, { y: n.y, detail: 1 }, !!V.lean);
  // head: helmet with a visor lens (shape by variant)
  ub.bone('head', 'torso', [0, SH.head.y, 0]);
  const v = addHead(ub.paint('head'), S, V);
  ub.glow('head').point([0, v.y, v.glowZ], v.glowR, ub.style.weaponGlow, {});
  // pack glow (pulses in idle and run)
  ub.bone('packGlow', 'torso', [0, k.y, k.glowZ]);
  ub.glow('packGlow').point([0, 0, 0], k.glowR, ub.style.plasma, {});
  for (const side of [1, -1]) { addLeg(ub, kit, side, V); addArm(ub, kit, side, V); }
  ub.socket('aim', 'torso', [0, SH.torso.cy, 0]);
  ub.socket('head', 'head', [0, 0, 0]);
  return ub.build();
}

const CACHE = createUnitCache(buildCrew);

// ---------------------------------------------------------------- unit

export class ProcCrewMember extends ProcUnit {
  /**
   * @param {object} [o]
   * @param {string} [o.race]  style key (race of the crew)
   * @param {import('three').ColorRepresentation} [o.teamColor]
   * @param {number} [o.index]  member index in the squad: deterministic animation phase
   */
  constructor({ race, teamColor = PROC_CREW.defaultTeamColor, index = 0 } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'crewMember', name: 'ProcCrew' });
    this.index = index;
    this.phase = (((index + 1) * CREW_ANIM.phaseStep) % 1) * TAU;   // overrides the kit's instance counter: same on every run
    this.gait = this.phase;       // stride phase, rad
    this.runW = 0;                // 0 idle … 1 run (smoothed)
    this.forced = null;           // play(): 'idle' | 'run' | null
    const b = (name) => this.getBone(name);
    this.hipBone = b('hip');
    this.torsoBone = b('torso');
    this.headBone = b('head');
    this.packGlow = b('packGlow');
    this.armsL = { shoulder: b('shoulderL'), elbow: b('elbowL') };
    this.armsR = { shoulder: b('shoulderR'), elbow: b('elbowR') };
    this.legsL = { hip: b('hipL'), knee: b('kneeL') };
    this.legsR = { hip: b('hipR'), knee: b('kneeR') };
    this.hipY = this.hipBone.position.y;
  }

  /** Forces the state: 'idle' | 'run' (run at the reference speed) until the next setMotion() */
  play(state) {
    this.forced = state === 'run' ? 'run' : 'idle';
    this.speed = this.forced === 'run' ? PROC_CREW.motion.runRefSpeed : 0;
  }

  /** Real speed of the squad (units/s): ≥ moveEpsilon runs, stride rate follows the speed */
  setMotion(speed, turn = 0) {
    this.forced = null;
    super.setMotion(speed, turn);
  }

  // Called by ProcUnit.tick after the generic drivers, LOD0 and visible only (no allocation)
  update(dt) {
    const M = PROC_CREW.motion;
    const R = PROC_CREW.run;
    const I = PROC_CREW.idle;
    const t = this.time;
    const ph = this.phase;
    const moving = Math.abs(this.speed) >= M.moveEpsilon;
    this.runW += ((moving ? 1 : 0) - this.runW) * Math.min(1, dt * M.blendRate);
    const w = this.runW;
    const iw = 1 - w;
    if (moving) {
      const rate = Math.max(M.minRate, Math.abs(this.speed) / M.runRefSpeed);
      this.gait = (this.gait + dt * TAU * M.cyclesPerSecond * rate) % TAU;
    }
    const g = this.gait;
    const sg = Math.sin(g);
    const sg2 = Math.sin(g + Math.PI);   // right leg / left arm

    // legs: forward swing = negative rotation.x, knee bends while the thigh recovers forward
    this.legsL.hip.rotation.x = -R.thigh * sg * w;
    this.legsR.hip.rotation.x = -R.thigh * sg2 * w;
    this.legsL.knee.rotation.x = R.knee * w * Math.max(0, Math.cos(g));
    this.legsR.knee.rotation.x = R.knee * w * Math.max(0, Math.cos(g + Math.PI));
    // arms swing against the same-side leg, elbows bent while running
    const sway = I.armSway * Math.sin(TAU * I.swayRate * t + ph) * iw;
    this.armsL.shoulder.rotation.x = R.arm * sg * w + sway;
    this.armsR.shoulder.rotation.x = R.arm * sg2 * w - sway;
    this.armsL.elbow.rotation.x = -R.elbow * w;
    this.armsR.elbow.rotation.x = -R.elbow * w;
    // hip drops when the legs spread (twice per stride); torso leans, twists and breathes
    this.hipBone.position.y = this.hipY - R.bob * w * (0.5 - 0.5 * Math.cos(2 * g));
    this.torsoBone.rotation.x = R.lean * w + I.breath * Math.sin(TAU * I.breathRate * t + ph) * iw;
    this.torsoBone.rotation.y = R.twist * w * sg;
    this.headBone.rotation.y = I.look * Math.sin(TAU * I.lookRate * t + ph * 1.7) * iw - R.twist * w * sg;
    this.packGlow.scale.setScalar(1 + I.packPulse * Math.sin(TAU * I.packRate * t + ph));
  }
}

/** True when a race has a procedural crew and procedural models are on (PROC_CREW.enabled, steelMen.procedural) */
export const hasProcCrew = (race) => PROC_CREW.enabled && proceduralEnabled() && PROC_CREW.races.includes(race);

/**
 * New procedural crew member or null (race without procedural crew / models off). Needs loadBuildingStyles() done.
 * @param {string} race
 * @param {import('three').ColorRepresentation} teamColor
 * @param {number} index  member index (animation phase)
 */
export function createProcCrewMember(race, teamColor, index = 0) {
  return hasProcCrew(race) ? new ProcCrewMember({ race, teamColor, index }) : null;
}
