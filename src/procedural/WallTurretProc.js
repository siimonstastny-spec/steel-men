// Steel Men – procedural wall turrets (roadmap 18, walls): mobileWallGunTurret and mobileWallLaserTurret. Drop-in
// alternatives to models/3DStructures{race}/MobileWall{Gun,Laser}Turret{race}_Anim.glb, built on the defence kit of
// PointDefenseProc.js (DefenseProcModel, turretHead, barrelCluster) – same pattern as the point defence:
//   • the model origin is the turret pivot on the wall post (DefenseStructure puts a turning model there): static pedestal
//     (1 mesh) → turret head on a slew ring (1 mesh, turns: setAim(yaw)) → barrel node (1 mesh + launch sockets, recoil: fire())
//   • gun: 2 barrels, sockets `socket_Launch_1`, `socket_2e603755` (GUN_SOCKETS = stats.json launchSockets), muzzles ≈ 10.2 ahead
//     of the pivot like the GLB; laser: 1 emitter, socket `socket_Launch_1` (LASER_SOCKETS), muzzle ≈ 10.6 ahead
//   • by style.silhouette (GUN_SHAPES / LASER_SHAPES): rounded = chamfered head, tube barrels / smooth emitter tube with neon
//     rings, angular = armoured wedge, shrouded barrels / finned heavy emitter, round = dome head, plasma emitters / plasma
//     lens, faceted = slim head, thin laser lances / prism with a diamond lens and a laser line
//   • faction emblem on both sides of the head (the decals turn with it)
// Draw calls: static, head, barrels, emblem + 1–2 glow layers = 5–7. Triangles ≈ 1.2–2.5 k (rounded heads are the most expensive).
// The models stay ordinary meshes (no batching: DefenseProcModel.enableBatching is empty). Visual only: nothing here is read
// by the simulation; update() allocates nothing.
import * as THREE from 'three';
import { PartBuilder } from './ProcKit.js';
import { createSharedCache, GlowSet, emblemDecalGeometry, pulseWave, teamPanel } from './ProcModules.js';
import {
  DefenseProcModel, DEFENSE_DETAIL, DEFENSE_ANIM, turretHead, barrelCluster, nextDefenseInstance,
} from './PointDefenseProc.js';
import { TAU, HALF_PI, QUARTER_PI, WALL_LAYOUT, WALL_TEAM } from './MobileWallProc.js';
import { getStats } from '../data/Stats.js';
import { STRUCTURE, PROC_MUZZLE } from '../config.js';

/**
 * Team paint of the turret (S.teamPaint / S.teamShade, see WALL_TEAM): the whole pedestal and the slew ring, a cap on the head
 * (flat slab on a box head, painted upper part of a wedge, painted crown of a dome) and a panel on the rear face of a box head.
 * The emblem plates on the sides and the front (barrels) stay neutral.
 */
const TURRET_TEAM = {
  cap: { inset: 0.86, t: 0.14 },                          // box head: top slab (share of the roof size, thickness)
  ringOver: 0.05,                                         // slew ring paint sits this much outside the ring
  wedge: { from: 0.4, over: 0.08 },                       // wedge head: painted from this share of the height up, offset off the faces
  dome: { arc: Math.PI / 3, over: 1.015, seg: 24, rows: 6 },   // dome head: painted crown (polar angle, radius factor, segments)
  panel: { w: 0.7, h: 0.5 },                              // box head: rear panel (shares of the head width / height)
};

/** Socket node names = stats.json launchSockets of the two turrets (the GLB node names, one per muzzle) */
export const GUN_SOCKETS = ['socket_Launch_1', 'socket_2e603755'];
export const LASER_SOCKETS = ['socket_Launch_1'];

const BARREL_BACK = 0.4;     // visible barrel starts this far behind the head's front face (hides inside the head)

/** Pedestal (static, under the turning head): ring + neon + team belt */
const PEDESTAL = { ringShare: 1.02, tube: 0.18, yShare: 0.35, neonTube: 0.06, neonYShare: 0.85, neonShare: 0.97, segments: 24 };

/** Gun turret shapes by style.silhouette (GLB units; head specs are those of turretHead, barrels those of barrelCluster) */
export const GUN_SHAPES = {
  rounded: {
    pedestal: { seg: 20, r: 2.7, h: 1.6, topShare: 0.9 },
    head: { kind: 'box', w: 4.6, h: 3.6, d: 4.6, ring: 2.4, faceX: 2.3, edge: 1 },
    barrels: { kind: 'tube', r: 0.4, offsets: [[-0.9, 0.1], [0.9, 0.1]] },
  },
  angular: {
    pedestal: { seg: 6, r: 2.8, h: 1.6, topShare: 0.85 },
    head: { kind: 'wedge', w: 5.0, topW: 3.6, topD: 3.8, h: 3.2, d: 5.0, ring: 2.6, faceX: 2.5 },
    barrels: { kind: 'shroud', r: 0.45, offsets: [[-1.0, 0.2], [1.0, 0.2]] },
  },
  round: {
    pedestal: { seg: 24, r: 2.5, h: 1.6, topShare: 0.85 },
    head: { kind: 'dome', r: 2.6, flat: 0.8, ring: 2.4, faceX: 2.6, w: 5.2, d: 5.2 },
    barrels: { kind: 'emitter', r: 0.42, offsets: [[-0.9, 0.3], [0.9, 0.3]] },
  },
  faceted: {
    pedestal: { seg: 4, r: 2.9, h: 1.6, topShare: 0.8 },
    head: { kind: 'box', w: 3.0, h: 2.8, d: 5.0, ring: 1.6, faceX: 1.5, edge: 1 },
    barrels: { kind: 'lance', r: 0.2, offsets: [[-0.7, 0.2], [0.7, 0.2]] },
  },
};

/** Laser turret shapes (lower and smaller than the gun; `barrel` kinds: tube | finned | emitter | lance, see laserBarrel) */
export const LASER_SHAPES = {
  rounded: {
    pedestal: { seg: 20, r: 2.3, h: 1.2, topShare: 0.9 },
    head: { kind: 'box', w: 3.8, h: 2.8, d: 4.0, ring: 2.0, faceX: 1.9, edge: 1 },
    barrels: { kind: 'tube', r: 0.8 },
  },
  angular: {
    pedestal: { seg: 6, r: 2.4, h: 1.2, topShare: 0.85 },
    head: { kind: 'wedge', w: 4.2, topW: 3.0, topD: 3.2, h: 2.6, d: 4.2, ring: 2.2, faceX: 2.1 },
    barrels: { kind: 'finned', r: 0.9 },
  },
  round: {
    pedestal: { seg: 24, r: 2.2, h: 1.2, topShare: 0.85 },
    head: { kind: 'dome', r: 2.2, flat: 0.8, ring: 2.0, faceX: 2.2, w: 4.4, d: 4.4 },
    barrels: { kind: 'emitter', r: 0.8 },
  },
  faceted: {
    pedestal: { seg: 4, r: 2.5, h: 1.2, topShare: 0.8 },
    head: { kind: 'box', w: 2.6, h: 2.2, d: 4.4, ring: 1.5, faceX: 1.3, edge: 1 },
    barrels: { kind: 'lance', r: 0.35 },
  },
};

/** Laser emitter details (shares of the barrel radius r unless noted) */
const LASER_DETAIL = {
  lens: 0.8, halo: 2.2, tubeSeg: 12,
  ringFractions: [0.3, 0.55, 0.8], ringTube: 0.07, ringSeg: 12,
  finned: { seg: 6, rear: 1.1, fins: 4, finH: 0.9, finT: 0.12, finLen: 0.5, finAt: 0.4, cage: 1.15, cageTube: 0.08, cageBack: 0.4 },
  emitter: { top: 0.6, bottom: 1.1, seg: 14, rings: [0.35, 0.7], ringTube: 0.06, ringOver: 1.05, tip: 0.75, haloShare: 1.9 },
  lance: { top: 0.6, bottom: 1.0, lens: 1.2, stretch: 2.2, laserT: 0.05 },
};

/** Muzzle distance ahead of the pivot (GLB sockets: gun 10.2, laser 10.6) */
const MUZZLE = { gun: 10.2, laser: 10.6 };

// ---------------------------------------------------------------- static writers

function pedestal(b, kit, P) {
  const S = kit.S;
  const apothem = P.r * Math.cos(Math.PI / P.seg);
  const detail = WALL_TEAM.detail;
  b.cylinder(P.r * P.topShare, P.r, P.h, P.seg, S.teamPaint, { y: P.h / 2, ry: P.seg === 4 ? QUARTER_PI : 0, detail });   // painted pedestal
  b.torus(apothem * PEDESTAL.ringShare, PEDESTAL.tube, 4, PEDESTAL.segments, TAU, S.teamShade, { rx: HALF_PI, y: P.h * PEDESTAL.yShare, detail });
  if (kit.rich) b.torus(apothem * P.topShare * PEDESTAL.neonShare, PEDESTAL.neonTube, 3, PEDESTAL.segments, TAU, S.neon, { rx: HALF_PI, y: P.h * PEDESTAL.neonYShare });
}

/** Team paint on the turning head (written after turretHead; `head` = its return value) */
function teamHead(b, kit, hd, head) {
  const S = kit.S;
  const D = DEFENSE_DETAIL;
  const K = TURRET_TEAM;
  const detail = WALL_TEAM.detail;
  b.cylinder(hd.ring + K.ringOver, hd.ring * D.ringFlare + K.ringOver, D.ringH, D.seg.ring, S.teamShade, { y: D.ringH / 2, detail });
  if (hd.kind === 'dome') {
    const drum = hd.r * hd.flat;
    b.add(new THREE.SphereGeometry(hd.r * K.dome.over, K.dome.seg, K.dome.rows, 0, TAU, 0, K.dome.arc), S.teamPaint, { y: head.y0 + drum, sy: hd.flat, detail });
  } else if (hd.kind === 'wedge') {
    const f0 = K.wedge.from;
    const o = 2 * K.wedge.over;
    const w0 = hd.w + (hd.topW - hd.w) * f0 + o;
    const d0 = hd.d + (hd.topD - hd.d) * f0 + o;
    b.taperedBox(w0, hd.topW + o, hd.h * (1 - f0), d0, S.teamPaint, { y: head.y0 + hd.h * f0, detail }, hd.topD + o);
  } else {
    b.box(hd.w * K.cap.inset, K.cap.t, hd.d * K.cap.inset, S.teamPaint, { y: head.top + K.cap.t / 2, detail });
    teamPanel(b, kit, hd.w * K.panel.w, hd.h * K.panel.h, { y: head.y0 + hd.h / 2, z: -hd.d / 2, ry: Math.PI });
  }
}

/**
 * Laser emitter pointing along +Z in the barrel node's space (barrelCluster's signature): spec = { kind, r, start, len }.
 * Paint → b, glowing parts → `glow` (pulse), muzzle flash point → `flash`. Returns the muzzle tips [[x, y, z]].
 */
function laserBarrel(b, glow, flash, kit, spec) {
  const S = kit.S;
  const L = LASER_DETAIL;
  const { r, start, len } = spec;
  const tip = start + len;
  const mid = start + len / 2;
  const along = { rx: HALF_PI };
  switch (spec.kind) {
    case 'finned': {
      const F = L.finned;
      b.cylinder(r, r * F.rear, len, F.seg, S.frame, { ...along, z: mid });
      for (let k = 0; k < F.fins; k++) {   // cooling fins: radial plates along the rear half
        const a = (k * TAU) / F.fins;
        b.box(r * F.finH, F.finT, len * F.finLen, S.hullDark, { x: Math.cos(a) * r, y: Math.sin(a) * r, z: start + len * F.finAt, rz: a });
      }
      b.torus(r * F.cage, F.cageTube, 4, F.seg, TAU, S.frame, { z: tip - F.cageBack });
      b.sphere(r * L.lens, 8, 6, S.lens, { z: tip });
      glow.point([0, 0, tip], r * L.halo);
      break;
    }
    case 'emitter': {
      const E = L.emitter;
      b.cylinder(r * E.top, r * E.bottom, len, E.seg, S.hull, { ...along, z: mid });
      for (const f of E.rings) b.torus(r * E.ringOver * (E.bottom + (E.top - E.bottom) * f), E.ringTube, 4, E.seg, TAU, S.neon, { z: start + len * f });
      b.sphere(r * E.tip, 10, 6, S.plasma, { z: tip });
      glow.sphere(r * E.haloShare, 8, 5, { z: tip });
      break;
    }
    case 'lance': {
      const N = L.lance;
      b.cylinder(r * N.top, r * N.bottom, len, 4, S.frame, { ...along, ry: QUARTER_PI, z: mid });
      b.add(new THREE.OctahedronGeometry(r * N.lens, 0), S.lens, { z: tip, sz: N.stretch });
      glow.segment([0, 0, start], [0, 0, tip], N.laserT);
      break;
    }
    default: {   // tube
      b.cylinder(r, r, len, L.tubeSeg, S.hull, { ...along, z: mid });
      if (kit.style.neon >= WALL_LAYOUT.neonMin) {
        for (const f of L.ringFractions) b.torus(r + L.ringTube / 2, L.ringTube, 3, L.ringSeg, TAU, S.neon, { z: start + len * f });
      }
      b.sphere(r * L.lens, 10, 6, S.lens, { z: tip });
      glow.point([0, 0, tip], r * L.halo);
    }
  }
  flash.point([0, 0, tip], DEFENSE_DETAIL.flashR);
  return [[0, 0, tip]];
}

// ---------------------------------------------------------------- shared record per turret type and style

const GUN_DEF = {
  shapes: GUN_SHAPES, barrels: barrelCluster, muzzle: MUZZLE.gun, mantlets: true, statsId: 'mobileWallGunTurret', sockets: GUN_SOCKETS.length,
};
const LASER_DEF = {
  shapes: LASER_SHAPES, barrels: laserBarrel, muzzle: MUZZLE.laser, mantlets: false, statsId: 'mobileWallLaserTurret', sockets: LASER_SOCKETS.length,
};

const clampAbs = (v, max) => Math.max(-max, Math.min(max, v));

/**
 * [B5-muzzles] Simulation shot points of a turret (stats simBody.muzzles at aim 0, byRace of the style / its modelRace) in
 * model units (÷ STRUCTURE.modelScale × stats modelScale), or null (stats not loaded, no data, fit off). Read-only.
 */
function dataMuzzles(statsId, race) {
  if (!PROC_MUZZLE.fit.enabled) return null;
  try {
    const st = getStats();
    const s = st.structures?.[statsId];
    const body = s?.simBody;
    if (!body) return null;
    const over = body.byRace?.[race] ?? body.byRace?.[st.races?.[race]?.modelRace];
    const list = over?.muzzles ?? body.muzzles;
    if (!list?.length) return null;
    const k = STRUCTURE.modelScale * (s.modelScale ?? 1);
    return list.map(([x, y, z]) => [x / k, y / k, z / k]);
  } catch {
    return null;
  }
}

/**
 * [B5-muzzles] Barrel layout fitted to the data muzzles within PROC_MUZZLE.wall: { offsets, len, lift, pedestalH }.
 * Without data: the shape as designed.
 */
function fitBarrels(def, kit, shape, head, start) {
  const P = shape.pedestal;
  const hd = shape.head;
  const bs = shape.barrels;
  let offsets = bs.offsets ?? [[0, 0]];
  const len0 = def.muzzle - start;
  const data = dataMuzzles(def.statsId, kit.key);
  if (!data) return { offsets, len: len0, lift: 0, pedestalH: P.h };
  const W = PROC_MUZZLE.wall;
  const oy = offsets.reduce((a, o) => a + o[1], 0) / offsets.length;
  offsets = data.length < offsets.length
    ? data.map(([x]) => [x, oy])                                               // one barrel per data muzzle
    : offsets.map(([ox, y], i) => [ox + clampAbs(data[i % data.length][0] - ox, W.xShift), y]);
  let ty = 0;
  let tz = 0;
  for (const m of data) { ty += m[1]; tz += m[2]; }
  ty /= data.length;
  tz /= data.length;
  const need = ty - (P.h + head.mid + oy);
  const headH = hd.kind === 'dome' ? hd.r * hd.flat : hd.h;
  const lift = clampAbs(need, Math.max(0, headH / 2 - bs.r));
  const pedestalH = P.h + clampAbs(need - lift, P.h * W.pedestalShare);
  const len = Math.min(len0 * W.stretch[1], Math.max(len0 * W.stretch[0], tz - start));
  return { offsets, len, lift, pedestalH };
}

/** Shared record: { static (LODs), turret, emblem, barrels, barrelGlow, barrelAt, pivotY, tips } */
function buildShared(kit, def) {
  const S = kit.S;
  const key = Object.hasOwn(def.shapes, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const shape = def.shapes[key];

  const tb = new PartBuilder();
  const hd = shape.head;
  const head = turretHead(tb, kit, hd);
  teamHead(tb, kit, hd, head);
  const bz = hd.d / 2;
  const bs = shape.barrels;
  const start = bz - BARREL_BACK;
  const fit = fitBarrels(def, kit, shape, head, start);   // [B5-muzzles] muzzles on the simulation shot points
  const offsets = fit.offsets;
  if (def.mantlets) {   // barrels leave through mantlets in the front face
    const M = DEFENSE_DETAIL.mantlet;
    for (const [ox, oy] of offsets) tb.box(bs.r * M.w, bs.r * M.w, M.d, S.hullDark, { x: ox, y: head.mid + fit.lift + oy, z: bz });
  }
  const base = new PartBuilder();
  pedestal(base, kit, { ...shape.pedestal, h: fit.pedestalH });

  const barrelB = new PartBuilder();
  const barrelGlow = new GlowSet();
  const tips = def.barrels(barrelB, barrelGlow.get('pulse'), barrelGlow.get('flash'), kit, { ...bs, offsets, start, len: fit.len });
  // every named launch socket gets a tip (fewer barrels than sockets: socket i uses barrel i % n)
  for (let i = tips.length, n = tips.length; i < def.sockets; i++) tips.push(tips[i % n]);
  return {
    static: base.buildLods(),
    turret: tb.build(),
    emblem: emblemDecalGeometry(head.placements),
    barrels: barrelB.build(),
    barrelGlow: barrelGlow.build(),
    barrelAt: [0, head.mid + fit.lift, 0],
    pivotY: fit.pedestalH,
    tips,
  };
}

// [B5-muzzles] models built before stats.json loaded (no muzzle fit) use their own cache, so later ones are fitted
const GUN_CACHE = createSharedCache((kit) => buildShared(kit, GUN_DEF));
const LASER_CACHE = createSharedCache((kit) => buildShared(kit, LASER_DEF));
const GUN_CACHE_PRE = createSharedCache((kit) => buildShared(kit, GUN_DEF));
const LASER_CACHE_PRE = createSharedCache((kit) => buildShared(kit, LASER_DEF));
const statsReady = () => { try { return Boolean(getStats()); } catch { return false; } };

// ---------------------------------------------------------------- the models

class WallTurretModel extends DefenseProcModel {
  constructor(opts, cache, name, sockets) {
    super({ ...opts, cache, name });
    try {
      this.#assemble(sockets);
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #assemble(sockets) {
    const sh = this.shared;
    const gc = this.kit.glowColors;
    const seq = nextDefenseInstance();
    this.staticMesh(sh.static);
    this.turret.position.y = sh.pivotY;
    this.paintMesh(sh.turret, this.turret);
    this.emblem(sh.emblem, this.turret);
    this.mountBarrels(sh.barrelAt, 0);
    this.paintMesh(sh.barrels, this.barrelNode);
    const layer = (geo, visible) => (geo ? this.glowLayer(geo, gc.pulse, { visible, parent: this.barrelNode }) : null);
    this.barrelPulse = layer(sh.barrelGlow.pulse, true);
    this.flashGlow = layer(sh.barrelGlow.flash, false);
    // Launch sockets hang on the turning but NON-recoiling turret node (rest position of the muzzles), not on barrelNode:
    // the muzzle point stays identical whether or not update() ran (fog of war), so fire() is safe for the simulation.
    for (let i = 0; i < sh.tips.length; i++) {
      const node = new THREE.Object3D();
      node.name = sockets[i] ?? `socket_launch_${i + 1}`;
      node.position.set(sh.barrelAt[0] + sh.tips[i][0], sh.barrelAt[1] + sh.tips[i][1], sh.barrelAt[2] + sh.tips[i][2]);
      this.turret.add(node);
      this.sockets.push(node);
    }
    this.charge = 1;
    this.time = seq * DEFENSE_ANIM.phaseStep;
  }

  /** Per-frame animation (numbers only, no allocations); `active` is unused – a turret has no production */
  update(delta) {
    if (!this.shared) return;
    this.time += delta;   // already scaled by animScale in tick(): unpowered, the barrel pulse freezes (recoil below keeps real time so it settles)
    this.barrelPulse?.setIntensity(pulseWave(this.time, this.kit.style.anim.pulse));
    this.stepFire(this.realDelta || delta);
  }
}

export class MobileWallGunTurretProc extends WallTurretModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor }, statsReady() ? GUN_CACHE : GUN_CACHE_PRE, 'MobileWallGunTurretProc', GUN_SOCKETS);
  }
}

export class MobileWallLaserTurretProc extends WallTurretModel {
  /** Same options as MobileWallGunTurretProc */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor }, statsReady() ? LASER_CACHE : LASER_CACHE_PRE, 'MobileWallLaserTurretProc', LASER_SOCKETS);
  }
}
