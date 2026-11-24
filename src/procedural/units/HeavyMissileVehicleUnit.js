// Steel Mans – procedural heavy missile vehicle (roadmap U2): 8-wheel carrier with a yawing turret and ONE big guided
// missile on a pitching launcher cradle (muzzle flash at the nose + back-blast cone at the tail on fire()).
//   • dimensions are plain numbers per style.silhouette (HEAVY_MISSILE_SHAPES, unknown → the first entry); the look of
//     hull / turret / wheels adapts through the modules, flame colours come from style data – no faction names here
//   • sockets: muzzle, launch_1 (nose of the missile), turret, aim, cargo, smoke; bones: turret, barrel (pitch), recoil
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 8.0 long, 4.2 wide, 3.4 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, wheels, turret, statusLamp } from './UnitModules.js';

const HALF_PI = Math.PI / 2;

/** Shapes by style.silhouette (sizes in model units) */
export const HEAVY_MISSILE_SHAPES = {
  angular: {
    wheelR: 0.63, wheelW: 0.62, gauge: 3.6, axles: [3.0, 1.0, -1.0, -3.0], steer: 2, bellyL: 7.0, hullLift: 1.3,
    hullL: 8.0, hullW: 3.2, hullH: 1.3,
    turret: { w: 2.3, d: 3.0, h: 0.75, z: -0.9 },
    status: [-1.2, -3.1],   // x, z on the hull deck
    launcher: {
      pivotY: 0.55, pitch: [-0.05, 1.15], railX: 0.6, railH: 0.5, railT: 0.18, railLen: 3.4, pylonW: 0.7, pylonD: 1.0,
      missileR: 0.38, missileLen: 4.0, missileZ: 0.3, noseLen: 1.2, bandLen: 0.45, bandAt: 0.2,
      finSpan: 1.7, finChord: 0.7, finT: 0.05, recoil: 0.25, flashR: 0.55, blastR: 0.55, blastLen: 2.2, muzzleGap: 0.1, seg: 8,
      crossH: 0.6, crossD: 0.6,       // cross brace of the rails: shares of railH / pylonD
      bandOver: 1.02,                 // team band radius over the missile radius
      flashSeg: [6, 4], haloShare: 1.8, flashGlow: 0.8, blastSeg: 6, blastGlow: 0.8,   // flash core sphere, halo radius × flashR, blast cone
    },
  },
};

const SOCKET_AIM = 0.5;      // aim socket at hull top + turret height × this
const SOCKET_CARGO_Z = -0.3; // cargo socket z = −hull length × this
const SMOKE_Z = 0.45;        // smoke socket z share of the hull length (behind the centre)
const FIN_COUNT = 2;         // crossed missile fins

const shapeOf = (kit) => HEAVY_MISSILE_SHAPES[kit.style.silhouette] ?? Object.values(HEAVY_MISSILE_SHAPES)[0];

// Pitching launcher with one large missile (own module: the generic missile pod is made for many small tubes)
function launcher(ub, s, tr) {
  const S = ub.kit.S;
  const u = ub.style;
  const Ln = s.launcher;
  const barrel = ub.bone('barrel', 'turret', [0, tr.top + Ln.pivotY, 0]);
  ub.meta.barrel = barrel;
  ub.meta.pitch = Ln.pitch;
  const recoil = ub.bone('recoil', barrel);
  ub.paint('turret').box(Ln.pylonW, Ln.pivotY, Ln.pylonD, S.hullDark, { y: tr.top + Ln.pivotY / 2 });
  const bb = ub.paint(barrel);
  for (const side of [1, -1]) bb.box(Ln.railT, Ln.railH, Ln.railLen, S.hullDark, { x: side * Ln.railX, z: Ln.missileZ });
  bb.box(Ln.railX * 2 + Ln.railT, Ln.railH * Ln.crossH, Ln.pylonD * Ln.crossD, S.frame, {});
  const rb = ub.paint(recoil);
  const R = Ln.missileR;
  const rear = Ln.missileZ - Ln.missileLen / 2;
  const front = Ln.missileZ + Ln.missileLen / 2;
  rb.cylinder(R, R, Ln.missileLen, Ln.seg, S.hull, { rx: HALF_PI, z: Ln.missileZ });
  rb.cylinder(0, R, Ln.noseLen, Ln.seg, S.hullDark, { rx: HALF_PI, z: front + Ln.noseLen / 2 });
  rb.cylinder(R * Ln.bandOver, R * Ln.bandOver, Ln.bandLen, Ln.seg, S.team, { rx: HALF_PI, z: rear + Ln.missileLen * Ln.bandAt });
  for (let k = 0; k < FIN_COUNT; k++) rb.box(Ln.finT, Ln.finSpan, Ln.finChord, S.accent, { z: rear + Ln.finChord / 2, rz: k * HALF_PI });
  const tip = front + Ln.noseLen;
  // flashes: nose flash + back-blast cone behind the tail
  const flash = ub.bone('flash', recoil, [0, 0, tip]);
  ub.glow(flash).sphere(Ln.flashR, Ln.flashSeg[0], Ln.flashSeg[1], UNIT_KIT.flash.core, {}).point([0, 0, 0], Ln.flashR * Ln.haloShare, u.weaponGlow, { intensity: Ln.flashGlow });
  const blast = ub.bone('flash_2', recoil, [0, 0, rear]);
  ub.glow(blast).flame(Ln.blastR, 0, Ln.blastLen, Ln.blastSeg, u.weaponGlow, { intensity: Ln.blastGlow }, false);
  const meta = ub.meta;
  const fire = { flashes: [meta.flashes.length, meta.flashes.length + 1], recoils: [meta.recoils.length] };
  meta.flashes.push({ bone: flash }, { bone: blast });
  meta.recoils.push({ bone: recoil, dist: Ln.recoil });
  ub.socket('muzzle', recoil, [0, 0, tip + Ln.muzzleGap]);
  ub.socket('launch_1', recoil, [0, 0, tip + Ln.muzzleGap]);
  ub.onFire('muzzle', fire);
  ub.onFire('launch_1', fire);
}

function buildHeavyMissileVehicle(kit) {
  const s = shapeOf(kit);
  const ub = new UnitBuilder(kit);
  wheels(ub, { L: s.bellyL, gauge: s.gauge, r: s.wheelR, ww: s.wheelW, axles: s.axles, steer: s.steer });
  ub.bone('hull', 'root', [0, s.wheelR * s.hullLift, 0]);
  ub.meta.hull = { bone: 'hull', bank: false };
  const hl = hull(ub, { bone: 'hull', y: 0, L: s.hullL, W: s.hullW, H: s.hullH });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: t.z, w: t.w, d: t.d, h: t.h });
  launcher(ub, s, tr);
  statusLamp(ub, { parent: 'hull', position: [s.status[0], hl.top, s.status[1]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, s.hullL * SOCKET_CARGO_Z]);
  ub.socket('smoke', 'hull', [0, hl.top, -s.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyMissileVehicle);

export class HeavyMissileVehicleUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyMissileVehicle', name: 'HeavyMissileVehicleUnit' });
  }
}

registerProcUnit('heavyMissileVehicle', (race, teamColor, opts) => new HeavyMissileVehicleUnit({ race, teamColor, ...opts }));
