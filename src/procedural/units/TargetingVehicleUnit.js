// Steel Mans – procedural targeting vehicle (roadmap U4, tier 3). Long-range spotter on a hover chassis: tall mast with a
// sensor dish on top (turns while designating), rear antenna array and a small designator laser (it also fights weakly).
// Shape table keyed by style.silhouette with only `faceted` (others fall back to it).
//   • sockets: muzzle (designator), turret, sensor (dish focus – effects / designator beam origin), aim, cargo, smoke
//   • the dish spins up whenever fire('muzzle') is called (designating); otherwise it rests
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 6.4 long, 3.0 wide, 4.1 high with the mast. Visual only.
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp } from './UnitModules.js';

const HALF_PI = Math.PI / 2;
const TAU = Math.PI * 2;

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const TARGETING_VEHICLE_SHAPES = {
  faceted: {
    L: 6.4, W: 2.9, H: 0.95,
    turret: { w: 1.4, d: 1.8, h: 0.5, z: -0.1 },
    gun: { length: 1.4, caliber: 0.05, pitch: [-0.1, 0.4] },
    mast: { h: 1.9, r: 0.07, dish: 0.85, dishDepth: 0.35, tilt: 0.35 },   // dish radius / depth, tilt up (rad)
    status: [0.2, 0.8, -0.34],   // beside the dorsal fin (x share of W)
  },
};

const CHASSIS = {
  gap: 0.07, skirtL: 1.0, skirtW: 1.08, skirtH: 0.07, hullL: 0.9,
  pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],
};
// rear array: spacing = distance of neighbouring masts as a share of W, z share of L, foot = base radius multiplier
const ANTENNA = { count: 3, h: 1.3, r: 0.03, spacing: 0.27, z: -0.4, tip: 0.07, lean: 0.08, foot: 1.5, seg: 4 };
const MAST = { foot: 1.6, seg: 6, z: -0.1 };   // z = share of turret d
// dish: capShare = cap angle as a share of π/2, rimSeg/rimTube torus, focus = feed distance share of dishDepth,
// feedLen / feedR rod, lampScale = glow of the feed tip relative to ANTENNA.tip
const DISH = { segW: 10, segH: 3, capShare: 0.6, spin: 2.2, rimR: 0.035, rimRadial: 3, rimSeg: 12, focus: 1.9, feedR: 0.5, feedSeg: 4, lampScale: 1.4 };
const LASER_X = 0.35;        // designator laser x share of turret w
const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.4;

const shapeOf = (kit) => TARGETING_VEHICLE_SHAPES[kit.style.silhouette] ?? TARGETING_VEHICLE_SHAPES.faceted;

function buildTargetingVehicle(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, L * P.gap, 0]);
  const base = hover(ub, { bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]) });
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H });
  // rear antenna array
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  for (let i = 0; i < ANTENNA.count; i++) {
    const ax = (i - (ANTENNA.count - 1) / 2) * W * ANTENNA.spacing;
    const az = L * ANTENNA.z;
    hb.cylinder(ANTENNA.r, ANTENNA.r * ANTENNA.foot, ANTENNA.h, ANTENNA.seg, S.frame, { x: ax, y: hl.top + ANTENNA.h / 2, z: az, rx: -ANTENNA.lean, detail: 0 });
    hg.point([ax, hl.top + ANTENNA.h, az - ANTENNA.h * ANTENNA.lean], ANTENNA.tip, ub.style.weaponGlow, {});
  }
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  // mast + dish (dish bone rotates about the mast axis)
  const m = s.mast;
  const tb = ub.paint('turret');
  tb.cylinder(m.r, m.r * MAST.foot, m.h, MAST.seg, S.frame, { y: t.h + m.h / 2, z: t.d * MAST.z });
  const dish = ub.bone('dish', 'turret', [0, t.h + m.h, t.d * MAST.z]);
  const db = ub.paint(dish);
  // bowl: the cap's pole points back and down, its open side faces forward and up along `axis`
  const cap = HALF_PI * DISH.capShare;
  const sinT = Math.sin(m.tilt);
  const cosT = Math.cos(m.tilt);
  db.add(new THREE.SphereGeometry(1, DISH.segW, DISH.segH, 0, TAU, 0, cap), S.hull, {
    rx: -(HALF_PI + m.tilt), sx: m.dish, sy: m.dishDepth, sz: m.dish,
  });
  const rimBack = m.dishDepth * Math.cos(cap);   // rim lies this far behind the sphere centre along the axis
  db.torus(m.dish * Math.sin(cap), DISH.rimR, DISH.rimRadial, DISH.rimSeg, TAU, S.trim, { rx: -m.tilt, y: -rimBack * sinT, z: -rimBack * cosT, detail: 0 });
  const feed = m.dishDepth * DISH.focus;
  const focus = [0, feed * sinT, feed * cosT];
  db.cylinder(m.r * DISH.feedR, m.r * DISH.feedR, feed, DISH.feedSeg, S.frame, { rx: HALF_PI - m.tilt, y: focus[1] / 2, z: focus[2] / 2, detail: 0 });
  ub.glow(dish).point(focus, ANTENNA.tip * DISH.lampScale, ub.style.weaponGlow, { intensity: 1 });
  ub.socket('sensor', dish, focus);
  const spinIndex = ub.meta.spinners.length;
  ub.meta.spinners.push({ bone: dish, axis: 'y', speed: DISH.spin });
  weapon(ub, 'laser', {
    parent: 'turret', position: [t.w * LASER_X, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  ub.onFire('muzzle', { spinners: [spinIndex] });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * P.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildTargetingVehicle);

export class TargetingVehicleUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'targetingVehicle', name: 'TargetingVehicleUnit' });
  }
}

registerProcUnit('targetingVehicle', (race, teamColor, opts) => new TargetingVehicleUnit({ race, teamColor, ...opts }));
