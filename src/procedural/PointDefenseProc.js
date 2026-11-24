// Steel Mans – procedural point defense system (roadmap 18, defence buildings). Drop-in alternative to
// models/3DStructures{race}/PointDefenseSystem{race}_Anim.glb, built from the style modules (ProcModules.js):
//   • plinth + tower (static, buildLods) → turret head on a slew ring (one mesh, turns) → 3 flak barrels (one mesh, recoil)
//   • launch sockets: Object3D nodes named like the GLB nodes (PDS_SOCKETS = stats.json launchSockets), children of the
//     barrel node, so shots leave from the muzzles and follow the turret
//   • styles by style.silhouette (PDS_SHAPES): rounded = clean cabinet + radar dish, angular = armoured block + bar antenna,
//     round = disc + dome + plasma emitters + floating ring, faceted = chamfered pylon + thin laser lances + crystal scanner
//   • exports the shared defence kit (DefenseProcModel, defensePlinth, defenseTower, turretHead, barrelCluster) that
//     AaTurretProc.js and RailGunProc.js reuse
// Visual only. The model never reads the simulation: DefenseStructure turns the whole model (holder.rotation.y); the
// optional hooks setAim(yaw) / fire(k) are described in docs/notes/proc-defense.md. No allocations in update().
import * as THREE from 'three';
import { PartBuilder, Spinner, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, ventUnit, fanBladesGeometry, ringGeometry,
  spike, emblemDecalGeometry, Levitator, pulseWave, PROC_MODULES,
} from './ProcModules.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Animation tuning shared by the defence models (visual only) */
export const DEFENSE_ANIM = {
  fanSpeed: 4.0,            // rad/s (× style.anim.spin)
  sensorSpeed: 1.6,         // rad/s radar dish / antenna (× style.anim.spin)
  blinkDuty: 0.5,
  phaseStep: 0.41,          // s – pulse phase offset per instance
  kickDecay: 3.5,           // 1/s – recoil settles
  kickDist: 0.5,            // model units – barrel recoil
  flashDecay: 10,           // 1/s – muzzle flash fades
  heatIdle: 0.3,            // radiator / plasma glow share while nothing fires
  chargeRate: 0.5,          // 1/s – capacitor glow (rail gun) refills after a shot
};

/** Small details shared by the defence kit (model units; "Share" = share of the related size) */
export const DEFENSE_DETAIL = {
  neonMin: 0.3,             // style.neon from which plinth / head get neon strips
  band: { h: 0.22, t: 0.06, inset: 0.97 },
  neonBand: { h: 0.08, t: 0.05, yShare: 0.8 },
  bandYShare: 0.45,
  mark: { lenShare: 1.2, h: 0.5, out: 0.02, yShare: 0.22 },
  armor: { bodyShare: 0.88, topShare: 0.7, spikeInset: 0.5, spikeH: 0.7, spikeR: 0.16 },
  disc: { seg: 32, lowerTop: 0.95, lowerShare: 0.55, upperTop: 0.72, upperBottom: 0.88, bandR: 1.01, bandY: 0.5, neonR: 0.8 },
  facet: { bodyShare: 0.9, capH: 0.14 },
  beacon: { at: 0.78, armoredAt: 0.6, discAt: 0.7 },   // discAt = share of the upper disc radius
  ringH: 0.45, ringFlare: 1.08,
  plate: { size: 1.8, d: 0.4, out: 0.06 },
  emblemSize: 1.4,
  mantlet: { w: 3.0, d: 0.6 },
  brake: { share: 1.5, h: 0.5 },
  jacket: { rShare: 1.7, rBottomShare: 1.9, lenShare: 0.45 },
  emitter: { topShare: 0.7, bottomShare: 1.2, tipShare: 0.8, haloShare: 2.0, ringShares: [0.35, 0.7], ringTube: 0.06, ringOver: 1.05 },
  lance: { tipR: 0.16, laserT: 0.05, seg: 4 },
  flashR: 1.3,
  seg: { ring: 24, tower: 24, towerRing: 24, jacket: 8, barrel: 10, emitter: 14, emitterRing: 14, tipU: 10, tipV: 6, haloU: 8, haloV: 5, lensU: 8, lensV: 6, dishU: 14, dishV: 6, arm: 8, mast: 8, dome: 24, domeV: 10 },
  hsRatio: { neonLen: 0.6, neonZ: -0.1, turretBeacon: 0.55, mastFlare: 1.2, lensR: 1.4, weightH: 2, weightD: 1.4 },
  towerRing: { tube: 0.05, ys: [0.35, 0.7], over: 0.04 },
  sensor: { mastR: 0.25, dishR: 1.5, dishDepth: 0.35, dishTilt: 0.7, armR: 0.14, barLen: 3.6, barH: 0.25, barD: 0.35, weight: 0.5, crystalR: 0.8, crystalStretch: 1.7 },
};

/** Point defence shapes by style.silhouette (code knows shapes, the style data picks one; unknown → rounded).
 *  Footprint: plinth R stays inside the smallest GLB footprint of the building (Venus GLB ±5.27, others ±7.5). */
export const PDS_SHAPES = {
  rounded: {
    plinth: { kind: 'box', R: 7.0, h: 1.6, ventX: 4.2, ventZ: -4.2, ventR: 0.9 },
    tower: { seg: 20, rTop: 2.4, rBottom: 3.0, h: 4.2 },
    head: { kind: 'box', w: 4.6, h: 2.4, d: 4.6, ring: 2.6, faceX: 2.3, edge: 1 },
    barrels: { kind: 'tube', r: 0.34, len: 5.0, offsets: [[-1.3, 0.1], [0, 0.6], [1.3, 0.1]] },
    sensor: { kind: 'dish', mastH: 1.4, z: -1.2 },
  },
  angular: {
    plinth: { kind: 'armored', R: 7.2, h: 2.2, baseH: 0.8, ventX: 3.6, ventZ: -3.6, ventR: 0.9 },
    tower: { seg: 4, rTop: 2.6, rBottom: 3.4, h: 3.6 },
    head: { kind: 'wedge', w: 5.4, topW: 4.2, topD: 4.4, h: 2.8, d: 5.2, ring: 3.0, faceX: 2.6 },
    barrels: { kind: 'shroud', r: 0.4, len: 5.0, offsets: [[-1.4, 0.2], [0, 0.7], [1.4, 0.2]] },
    sensor: { kind: 'bar', mastH: 1.2, z: -1.4 },
  },
  round: {
    plinth: { kind: 'disc', R: 5.0, h: 1.5, ventX: 1.9, ventZ: -1.9, ventR: 0.9 },
    tower: { seg: 24, rTop: 1.8, rBottom: 2.4, h: 4.4 },
    head: { kind: 'dome', r: 2.7, flat: 0.75, ring: 2.5, faceX: 2.7, w: 5.4, d: 5.4 },
    barrels: { kind: 'emitter', r: 0.42, len: 2.6, offsets: [[-1.2, 0.2], [0, 0.7], [1.2, 0.2]] },
    sensor: { kind: 'ring', r: 3.6, y: 1.4, z: 0 },
  },
  faceted: {
    plinth: { kind: 'faceted', R: 6.2, h: 2.0, ventX: 3.4, ventZ: -3.4, ventR: 0.7 },
    tower: { seg: 4, rTop: 0.9, rBottom: 1.3, h: 5.2 },
    head: { kind: 'box', w: 3.0, h: 2.0, d: 5.4, ring: 1.6, faceX: 1.5, edge: 1 },
    barrels: { kind: 'lance', r: 0.2, len: 4.8, offsets: [[-0.9, 0.1], [0, 0.55], [0.9, 0.1]] },
    sensor: { kind: 'crystal', y: 2.6, z: -0.6 },
  },
};

/** Socket node names = stats.json structures.pointDefenseSystem.launchSockets (the GLB node names, one per barrel) */
export const PDS_SOCKETS = ['socket_96c26dc9', 'socket_0fcb3c73', 'socket_78cc0ce5'];

const shapeOf = (style) => PDS_SHAPES[style.silhouette] ?? PDS_SHAPES.rounded;

// ---------------------------------------------------------------- shared defence kit (static writers, construction time)

/**
 * Plinth of a defence building, centred on the axis, standing on y = 0. spec: { kind: box | armored | disc | faceted,
 * R (half size / radius), h, baseH (armored), ventX, ventZ, ventR }. Adds team band, neon band, markings, two front
 * beacons and the style's vent unit. Returns { top, face, vent }.
 */
export function defensePlinth(b, glows, kit, spec) {
  const D = DEFENSE_DETAIL;
  const S = kit.S;
  const { R, h } = spec;
  const neon = kit.style.neon >= D.neonMin;
  const lamp = glows.get(kit.style.lights === 'lamp' ? 'beacon' : 'pulse');
  let face = R;
  let bandY = h * D.bandYShare;
  let top = h;
  switch (spec.kind) {
    case 'armored': {
      const body = R * 2 * D.armor.bodyShare;
      const topW = R * 2 * D.armor.topShare;
      b.box(R * 2, spec.baseH, R * 2, S.hullDark, { base: true });
      b.taperedBox(body, topW, h - spec.baseH, body, S.hull, { y: spec.baseH }, topW);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) spike(b, kit, { x: sx * (R - D.armor.spikeInset), y: spec.baseH, z: sz * (R - D.armor.spikeInset), h: D.armor.spikeH, r: D.armor.spikeR });
      bandY = spec.baseH / 2;
      break;
    }
    case 'disc': {
      const lower = h * D.disc.lowerShare;
      const upper = h - lower;
      b.cylinder(R * D.disc.lowerTop, R, lower, D.disc.seg, S.hull, { y: lower / 2 });
      b.cylinder(R * D.disc.upperTop, R * D.disc.upperBottom, upper, D.disc.seg, S.hullDark, { y: lower + upper / 2 });
      b.torus(R * D.disc.bandR, D.band.h / 2, 4, D.disc.seg, TAU, S.team, { rx: HALF_PI, y: h * D.disc.bandY });
      if (neon) b.torus(R * D.disc.neonR, D.neonBand.h / 2, 4, D.disc.seg, TAU, S.neon, { rx: HALF_PI, y: h * D.neonBand.yShare });
      break;
    }
    case 'faceted': {
      face = R * D.facet.bodyShare;
      styledBox(b, kit, face * 2, h, face * 2, S.hull, { base: true }, 1);
      b.box(R * Math.SQRT2, D.facet.capH, R * Math.SQRT2, S.hullDark, { y: h + D.facet.capH / 2, ry: Math.PI / 4 });
      top = h + D.facet.capH;
      break;
    }
    default:
      styledBox(b, kit, R * 2, h, R * 2, S.hull, { base: true }, 1);
  }
  if (spec.kind !== 'disc') {   // team band round the four faces, neon line + markings on the front
    const out = D.band.t / 2;
    const w = face * 2 * D.band.inset;
    for (const e of [-1, 1]) {
      b.box(w, D.band.h, D.band.t, S.team, { y: bandY, z: e * (face + out) });
      b.box(D.band.t, D.band.h, w, S.team, { x: e * (face + out), y: bandY });
    }
    if (neon && spec.kind !== 'armored') neonStrip(b, kit, w, D.neonBand.h, D.neonBand.t, { y: h * D.neonBand.yShare, z: face + out });
    marking(b, kit, face * D.mark.lenShare, D.mark.h, { y: h * D.mark.yShare, z: face + D.mark.out });
  }
  // beacons and the vent stand on the body top (the faceted cap is a diamond that does not reach the corners)
  const seat = spec.kind === 'faceted' ? h : top;
  const at = spec.kind === 'disc' ? R * D.disc.upperTop * D.beacon.discAt : R * (spec.kind === 'armored' ? D.beacon.armoredAt : D.beacon.at);
  for (const sx of [-1, 1]) beacon(b, lamp, kit, [sx * at, seat, at]);
  const vent = ventUnit(b, glows, kit, { x: spec.ventX, y: seat, z: spec.ventZ, r: spec.ventR });
  return { top, face, vent };
}

/** Tower (cylinder with `seg` sides; 4 = square pillar) from y0 up to y0 + h, neon rings for neon-rich styles */
export function defenseTower(b, kit, t, y0) {
  const D = DEFENSE_DETAIL;
  b.cylinder(t.rTop, t.rBottom, t.h, t.seg, kit.S.hullDark, { y: y0 + t.h / 2, ry: t.seg === 4 ? Math.PI / 4 : 0 });
  if (kit.rich) {
    for (const k of D.towerRing.ys) {
      const rr = t.rBottom + (t.rTop - t.rBottom) * k + D.towerRing.over;
      b.torus(rr, D.towerRing.tube, 4, D.seg.towerRing, TAU, kit.S.neon, { rx: HALF_PI, y: y0 + t.h * k });
    }
  }
}

/** Distance of the head side face (emblem plate) from the axis; a dome stands on a drum that flares to r × ringFlare */
export const headFaceX = (hd) => (hd.kind === 'dome' ? hd.r * DEFENSE_DETAIL.ringFlare : hd.faceX);

/** Height of a turret head above its own base (the slew ring sits under it, see turretHead) */
function headHeight(hd) {
  return hd.kind === 'dome' ? hd.r * hd.flat * 2 : hd.h;
}

/**
 * Turret head on a slew ring, local space: pivot at the origin (y = 0 = tower top). Kinds: box (styled edges), wedge
 * (sloped), dome. Adds the two emblem plates on the sides. Returns { y0, top, mid, placements } (emblem placements).
 */
export function turretHead(b, kit, hd) {
  const D = DEFENSE_DETAIL;
  const S = kit.S;
  const y0 = D.ringH;
  const hh = headHeight(hd);
  const faceX = headFaceX(hd);
  b.cylinder(hd.ring, hd.ring * D.ringFlare, D.ringH, D.seg.ring, S.hullDark, { y: D.ringH / 2 });
  switch (hd.kind) {
    case 'wedge':
      b.taperedBox(hd.w, hd.topW, hd.h, hd.d, S.hull, { y: y0 }, hd.topD);
      break;
    case 'dome': {
      const drum = hd.r * hd.flat;
      b.cylinder(hd.r, hd.r * D.ringFlare, drum, D.seg.dome, S.hull, { y: y0 + drum / 2 });
      b.sphere(hd.r, D.seg.dome, D.seg.domeV, S.hull, { y: y0 + drum, sy: hd.flat });
      break;
    }
    default:
      styledBox(b, kit, hd.w, hd.h, hd.d, S.hull, { base: true, y: y0 }, hd.edge ?? 1);
  }
  const mid = y0 + (hd.kind === 'dome' ? (hd.r * hd.flat) / 2 : hh / 2);
  const placements = [];
  for (const e of [-1, 1]) {
    b.box(D.plate.d, D.plate.size, D.plate.size, S.hullDark, { x: e * (faceX + D.plate.out - D.plate.d / 2), y: mid });
    placements.push({ position: [e * (faceX + D.plate.out), mid, 0], normal: [e, 0, 0], size: D.emblemSize });
  }
  if (kit.style.neon >= D.neonMin) {
    for (const e of [-1, 1]) neonStrip(b, kit, D.band.t, D.neonBand.h, hd.d * D.hsRatio.neonLen, { x: e * (faceX + D.plate.out), y: y0 + hh * D.neonBand.yShare, z: hd.d * D.hsRatio.neonZ });
  }
  return { y0, top: y0 + hh, mid, placements };
}

/**
 * Barrel set pointing along +Z in the barrel node's space (origin = hinge / head centre). spec: { kind: tube | shroud |
 * emitter | lance, r, len, start (z where the visible barrel begins), offsets [[x, y], …] }. Paint → b, glowing parts →
 * `glow` (pulse), muzzle flash points → `flash`. Returns the muzzle tips [[x, y, z], …] (socket positions).
 */
export function barrelCluster(b, glow, flash, kit, spec) {
  const S = kit.S;
  const D = DEFENSE_DETAIL;
  const { r, len, start } = spec;
  const tips = [];
  for (const [ox, oy] of spec.offsets) {
    const z = (f) => start + len * f;
    const along = { rx: HALF_PI, x: ox, y: oy };
    switch (spec.kind) {
      case 'shroud':
        b.cylinder(r * D.jacket.rShare, r * D.jacket.rBottomShare, len * D.jacket.lenShare, D.seg.jacket, S.hullDark, { ...along, z: z(D.jacket.lenShare / 2) });
        b.cylinder(r, r, len, D.seg.barrel, S.frame, { ...along, z: z(0.5) });
        b.cylinder(r * D.brake.share, r * D.brake.share, D.brake.h, D.seg.jacket, S.dark, { ...along, z: z(1) - D.brake.h / 2 });
        break;
      case 'emitter':
        b.cylinder(r * D.emitter.topShare, r * D.emitter.bottomShare, len, D.seg.emitter, S.hull, { ...along, z: z(0.5) });
        for (const f of D.emitter.ringShares) b.torus(r * D.emitter.ringOver * (D.emitter.bottomShare + (D.emitter.topShare - D.emitter.bottomShare) * f), D.emitter.ringTube, 4, D.seg.emitterRing, TAU, S.neon, { x: ox, y: oy, z: z(f) });
        b.sphere(r * D.emitter.tipShare, D.seg.tipU, D.seg.tipV, S.plasma, { x: ox, y: oy, z: z(1) });
        glow.sphere(r * D.emitter.haloShare, D.seg.haloU, D.seg.haloV, { x: ox, y: oy, z: z(1) });
        break;
      case 'lance':
        b.cylinder(r, r, len, D.lance.seg, S.frame, { ...along, z: z(0.5), ry: 0 });
        b.sphere(D.lance.tipR, D.seg.lensU, D.seg.lensV, S.lens, { x: ox, y: oy, z: z(1) });
        glow.segment([ox, oy, z(0)], [ox, oy, z(1)], D.lance.laserT);
        break;
      default:
        b.cylinder(r, r, len, D.seg.barrel, S.frame, { ...along, z: z(0.5) });
        b.cylinder(r * D.brake.share, r * D.brake.share, D.brake.h, D.seg.jacket, S.dark, { ...along, z: z(1) - D.brake.h / 2 });
    }
    flash.point([ox, oy, z(1)], D.flashR);
    tips.push([ox, oy, z(1)]);
  }
  return tips;
}

/** Sensor geometry (own mesh, origin = its pivot): dish / bar spin, ring / crystal levitate. Returns { geometry, mode } */
export function sensorGeometry(kit, sensor) {
  const S = kit.S;
  const D = DEFENSE_DETAIL.sensor;
  const b = new PartBuilder();
  switch (sensor.kind) {
    case 'dish': {
      b.cylinder(D.armR, D.armR, D.dishDepth * 2, DEFENSE_DETAIL.seg.arm, S.frame, { y: D.dishDepth });
      const cap = new THREE.SphereGeometry(D.dishR, DEFENSE_DETAIL.seg.dishU, DEFENSE_DETAIL.seg.dishV, 0, TAU, 0, HALF_PI);
      b.add(cap, S.hull, { y: D.dishDepth * 2, rx: Math.PI - D.dishTilt, sy: D.dishDepth / D.dishR + 0.3 });
      b.sphere(D.armR * DEFENSE_DETAIL.hsRatio.lensR, DEFENSE_DETAIL.seg.lensU, DEFENSE_DETAIL.seg.lensV, S.lens, { y: D.dishDepth * 2 + D.dishDepth });
      return { geometry: b.build(), mode: 'spin' };
    }
    case 'bar':
      b.box(D.barLen, D.barH, D.barD, S.frame, { y: D.barH });
      for (const e of [-1, 1]) b.box(D.weight, D.barH * DEFENSE_DETAIL.hsRatio.weightH, D.barD * DEFENSE_DETAIL.hsRatio.weightD, S.hullDark, { x: e * D.barLen / 2, y: D.barH });
      return { geometry: b.build(), mode: 'spin' };
    case 'ring':
      return { geometry: ringGeometry(kit, sensor.r), mode: 'levitate' };
    default: {   // crystal
      b.add(new THREE.OctahedronGeometry(D.crystalR, 0), S.plasma, { sy: D.crystalStretch });
      return { geometry: b.build(), mode: 'levitate' };
    }
  }
}

// ---------------------------------------------------------------- the shared defence model base

/**
 * Base class of the defence models: a `turret` node (child of the model; its yaw = setAim), a `barrelNode` that carries
 * the barrels (recoil, optional pitch) and the launch sockets. DefenseStructure turns the whole model through
 * `holder.rotation.y`, so this model needs no per-frame aim; setAim(yaw) only turns the turret part relative to the base
 * (for a future DefenseStructure that keeps the base still) and fire(k) plays recoil + muzzle flash.
 * Static batching is switched off (enableBatching does nothing): batched instances keep the matrix they had when
 * registered and would not follow the turning holder.
 */
export class DefenseProcModel extends ProcModel {
  constructor(opts) {
    super(opts);
    this.turret = new THREE.Group();
    this.turret.name = 'turret';
    this.add(this.turret);
    this.barrelNode = new THREE.Group();
    this.barrelNode.name = 'barrels';
    this.turret.add(this.barrelNode);
    this.sockets = [];
    this.aimYaw = 0;
    this.kick = 0;
    this.flash = 0;
    this.flashGlow = null;
    this.restY = 0;
    this.restZ = 0;
    this.pitchSin = 0;
    this.pitchCos = 1;
  }

  /** Puts the barrel node at `at` (turret space) tilted up by `pitch` rad; recoil then runs along the tilted barrel axis */
  mountBarrels([x, y, z], pitch = 0) {
    this.restY = y;
    this.restZ = z;
    this.pitchSin = Math.sin(pitch);
    this.pitchCos = Math.cos(pitch);
    this.barrelNode.position.set(x, y, z);
    this.barrelNode.rotation.x = -pitch;
  }

  /** Named launch socket (Object3D) under the barrel node at a muzzle position (barrel-node space) */
  addSocket(name, [x, y, z]) {
    const node = new THREE.Object3D();
    node.name = name;
    node.position.set(x, y, z);
    this.barrelNode.add(node);
    this.sockets.push(node);
    return node;
  }

  /** Turns the turret part relative to the base (rad, around +Y) */
  setAim(yaw) {
    this.aimYaw = yaw;
    this.turret.rotation.y = yaw;
  }

  /** Shot fired: barrels kick back and the muzzles flash (the `k` argument = barrel index, unused – all barrels move together) */
  fire() {
    this.kick = 1;
    this.flash = 1;
    this.charge = 0;
  }

  /** The turning holder would leave a batched body behind – the defence models stay ordinary meshes */
  enableBatching() {}

  /** Drops the socket references (DefenseStructure.sockets would keep nodes of a detached turret) and releases the model */
  dispose() {
    this.sockets.length = 0;
    super.dispose();
  }

  /**
   * Builds every mesh, glow layer and animated part from a shared record (buildDefenseShared layout) – the common part of
   * the defence constructors. `sockets` = names of the launch sockets, one per barrel tip (extra tips get socket_launch_N).
   */
  assemble(sh, seq, sockets) {
    const an = this.kit.style.anim;
    const A = DEFENSE_ANIM;
    const gc = this.kit.glowColors;
    const lev = PROC_MODULES.levitate;

    this.staticMesh(sh.static);
    const layer = (geo, color, visible, parent) => (geo ? this.glowLayer(geo, color, { visible, parent }) : null);
    this.beaconGlow = layer(sh.glow.beacon, gc.beacon, false, this);
    this.pulseGlow = layer(sh.glow.pulse, gc.pulse, true, this);
    this.heatGlow = layer(sh.glow.radiator, gc.radiator, false, this);

    this.turret.position.y = sh.pivotY;
    this.paintMesh(sh.turret, this.turret);
    this.emblem(sh.emblem, this.turret);
    this.turretBeacon = layer(sh.turretGlow.beacon, gc.beacon, false, this.turret);
    this.turretPulse = layer(sh.turretGlow.pulse, gc.pulse, true, this.turret);

    this.mountBarrels(sh.barrelAt, sh.pitch ?? 0);
    this.paintMesh(sh.barrels, this.barrelNode);
    this.barrelPulse = layer(sh.barrelGlow.pulse, gc.pulse, true, this.barrelNode);
    this.chargeGlow = layer(sh.barrelGlow.charge, gc.pulse, true, this.barrelNode);
    this.flashGlow = layer(sh.barrelGlow.flash, gc.pulse, false, this.barrelNode);
    for (let i = 0; i < sh.tips.length; i++) this.addSocket(sockets[i] ?? `socket_launch_${i + 1}`, sh.tips[i]);

    // vent parts (fan turns / plasma ring floats) and the sensor
    this.spinner = null;
    this.levitator = null;
    this.sensorSpin = null;
    this.sensorFloat = null;
    if (sh.fan) {
      const fan = this.paintMesh(sh.fan);
      fan.position.set(sh.fanBase[0], sh.fanBase[1], sh.fanBase[2]);
      this.spinner = new Spinner(fan, { speed: A.fanSpeed * an.spin * (1 + (((seq * 3) % 7) / 6 - 0.5) * 0.5), phase: (seq * 0.7) % TAU });
    }
    if (sh.ring) {
      const ring = this.paintMesh(sh.ring);
      ring.position.set(sh.ringSpot[0], sh.ringSpot[1], sh.ringSpot[2]);
      this.levitator = new Levitator(ring, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin, phase: seq * 0.37 });
    }
    const sensor = this.paintMesh(sh.sensor, this.turret);
    sensor.position.set(sh.sensorAt[0], sh.sensorAt[1], sh.sensorAt[2]);
    if (sh.sensorMode === 'spin') {
      this.sensorSpin = new Spinner(sensor, { speed: A.sensorSpeed * an.spin, phase: (seq * 0.9) % TAU });
    } else {
      this.sensorFloat = new Levitator(sensor, { amp: lev.amp * an.levitate, spin: lev.spin * an.spin, phase: seq * 0.53 });
    }

    this.charge = 1;
    this.time = seq * A.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty, phase: (seq * A.phaseStep) % 1 });
  }

  /** Per-frame animation of everything assemble() built (numbers only, no allocations) */
  animate(delta) {
    const A = DEFENSE_ANIM;
    const an = this.kit.style.anim;
    this.time += delta;
    const glow = pulseWave(this.time, an.pulse);
    this.pulseGlow?.setIntensity(glow);
    this.turretPulse?.setIntensity(glow);
    this.barrelPulse?.setIntensity(glow);
    this.charge += (1 - this.charge) * Math.min(1, delta * A.chargeRate);
    this.chargeGlow?.setIntensity(this.charge * glow);
    this.blink.update(delta, true);
    const on = this.blink.on ? 1 : 0;
    this.beaconGlow?.setIntensity(on);
    this.turretBeacon?.setIntensity(on);
    this.heatGlow?.setIntensity(A.heatIdle + (1 - A.heatIdle) * this.kick);
    this.spinner?.update(delta, true);
    this.levitator?.update(delta, true);
    this.sensorSpin?.update(delta, true);
    this.sensorFloat?.update(delta, true);
    this.stepFire(delta);
  }

  /** Recoil + flash decay (call from update(), no allocations) */
  stepFire(delta) {
    const A = DEFENSE_ANIM;
    this.kick = Math.max(0, this.kick - delta * A.kickDecay);
    this.flash = Math.max(0, this.flash - delta * A.flashDecay);
    const back = this.kick * A.kickDist;
    this.barrelNode.position.y = this.restY - back * this.pitchSin;
    this.barrelNode.position.z = this.restZ - back * this.pitchCos;
    this.flashGlow?.setIntensity(this.flash);
  }
}

// ---------------------------------------------------------------- generic defence build (shared by the three buildings)

function buildTurret(kit, shape, hooks) {
  const S = kit.S;
  const D = DEFENSE_DETAIL;
  const hd = shape.head;
  const b = new PartBuilder();
  const glows = new GlowSet();
  const head = turretHead(b, kit, hd);
  const bz = hd.d / 2;
  const faceX = headFaceX(hd);
  if (!shape.pitch) {   // level barrels leave through mantlets in the front face; pitched ones hinge on the head top (shape hooks add the cradle)
    for (const [ox, oy] of shape.barrels.offsets) b.box(shape.barrels.r * D.mantlet.w, shape.barrels.r * D.mantlet.w, D.mantlet.d, S.hullDark, { x: ox, y: head.mid + oy, z: bz });
  }
  const sn = shape.sensor;
  let sensorAt;
  if (sn.kind === 'dish' || sn.kind === 'bar') {
    b.cylinder(D.sensor.mastR, D.sensor.mastR * D.hsRatio.mastFlare, sn.mastH, D.seg.mast, S.frame, { y: head.top + sn.mastH / 2, z: sn.z });
    sensorAt = [0, head.top + sn.mastH, sn.z];
  } else if (sn.kind === 'ring') {
    sensorAt = [0, head.mid + sn.y, sn.z];
  } else {
    sensorAt = [0, head.top + sn.y, sn.z];
  }
  beacon(b, glows.get(kit.style.lights === 'lamp' ? 'beacon' : 'pulse'), kit, [faceX * D.hsRatio.turretBeacon, head.top, bz * D.hsRatio.turretBeacon]);
  hooks?.turretExtra?.(b, glows, kit, shape, head);
  return { paint: b.build(), glow: glows.build(), emblems: head.placements, mid: head.mid, top: head.top, bz, sensorAt };
}

/**
 * Shared record of one defence building and style (everything the DefenseProcModel.assemble reads). shape = { plinth, tower,
 * head, barrels, sensor, pitch? } (see PDS_SHAPES); hooks.turretExtra(b, glows, kit, shape, head) adds parts to the turret,
 * hooks.barrels(b, glow, flash, kit, spec) replaces barrelCluster (returns the tips).
 */
export function buildDefenseShared(kit, shape, hooks) {
  const b = new PartBuilder();
  const glows = new GlowSet();
  const plinth = defensePlinth(b, glows, kit, shape.plinth);
  defenseTower(b, kit, shape.tower, plinth.top);
  const lods = b.buildLods();
  for (const g of lods.slice(1)) g.dispose();
  const turret = buildTurret(kit, shape, hooks);
  const barrelB = new PartBuilder();
  const barrelGlow = new GlowSet();
  const spec = { ...shape.barrels, start: shape.barrels.start ?? turret.bz - 0.4 };
  const tips = (hooks?.barrels ?? barrelCluster)(barrelB, barrelGlow.get('pulse'), barrelGlow.get('flash'), kit, spec, barrelGlow);
  const sensor = sensorGeometry(kit, shape.sensor);
  const vent = plinth.vent;
  return {
    pivotY: plinth.top + shape.tower.h,
    pitch: shape.pitch ?? 0,
    static: lods.slice(0, 1),   // enableBatching() is off, so only LOD0 is ever drawn
    glow: glows.build(),
    turret: turret.paint,
    turretGlow: turret.glow,
    emblem: emblemDecalGeometry(turret.emblems),
    barrels: barrelB.build(),
    barrelGlow: barrelGlow.build(),
    barrelAt: shape.pitch ? [0, turret.top, 0] : [0, turret.mid, 0],
    tips,
    sensor: sensor.geometry,
    sensorMode: sensor.mode,
    sensorAt: turret.sensorAt,
    fanBase: vent.fan ?? null,
    fan: vent.fan ? fanBladesGeometry(kit, vent.r, vent.blades) : null,
    ringSpot: vent.ring ? [vent.ring.x, vent.ring.y, vent.ring.z] : null,
    ring: vent.ring ? ringGeometry(kit, vent.ring.r) : null,
    heat: Boolean(vent.radiator),
  };
}

/** Next instance number (spreads animation phases) */
let instanceCounter = 0;
export const nextDefenseInstance = () => instanceCounter++;

// ---------------------------------------------------------------- point defence

const PDS_CACHE = createSharedCache((kit) => buildDefenseShared(kit, shapeOf(kit.style)));

export class PointDefenseProc extends DefenseProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: PDS_CACHE, name: 'PointDefenseProc' });
    try {
      this.assemble(this.shared, nextDefenseInstance(), PDS_SOCKETS);
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  /** @param {number} delta seconds @param {boolean} [active] unused – a defence building has no production */
  update(delta) {
    if (this.shared) this.animate(delta);
  }
}
