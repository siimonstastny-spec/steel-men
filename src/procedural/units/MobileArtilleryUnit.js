// Steel Men – procedural mobile artillery (roadmap U2): long-range tracked gun that must anchor before firing.
//   • setDeployed(0..1): four outriggers swing down to the ground and the whole gun cradle lifts (bone `cradle`, deploy
//     channel rx); setBarrelPitch(rad) pitches the barrel on top of the lift (limits ARTILLERY_SHAPES.gun.pitch)
//   • long heavy cannon (muzzle socket, recoil, flash), sensor mast for the long sight range, status lamp
//   • sockets: muzzle, turret, aim, cargo, smoke; bones: turret, cradle, barrel, recoil, leg_1..4
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 8.8 long (+ barrel), 5.2 wide, 3.2 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, tracks, turret, weapon, statusLamp, outriggers, roofMark, UNIT_MODULES } from './UnitModules.js';

/** Shapes by style.silhouette (sizes in model units; shares of L / W where noted) */
export const ARTILLERY_SHAPES = {
  angular: {
    L: 8.8, W: 4.2, H: 1.4, trackH: 0.14, gauge: 0.88, trackW: 0.26, hullLift: 0.95, hullL: 0.92,
    turret: { w: 3.0, d: 3.6, h: 0.9, z: -0.12 },
    cradleZ: 0.8,           // cradle z = turret front × this
    gun: { length: 6.4, caliber: 0.2, pitch: [0, 0.55] },
    liftAngle: 0.6,         // rad – cradle lift at full deploy (added to the barrel pitch)
    legs: { x: 0.585, z: 0.3, y: 0.2 },   // pivot x share of W (beyond the tracks), z share of L, y in hull space
    mast: { x: -0.3, z: -0.3, h: 1.6, r: 0.05, ball: 0.22, seg: 4, ballSeg: [6, 4] },   // seg: mast sides, ballSeg: lens ball
    status: [0.3, -0.3],
  },
};

// team mark in front of the turret (roofMark; round / faceted hulls have no flat deck: module caps / strakes are their team paint).
// z, d = shares of the hull length, w = share of W; ledge = angular hull: on the flat lower-hull ledge ahead of the deck (else on the deck top)
// cover = darker team deck cover under / around the turret (shares of W, hull length, hull length); the deck mark stands on it
const DECK_MARK = {
  rounded: { z: 0.216, d: 0.2, w: 0.6, ledge: false, cover: { w: 0.7, d: 0.7, z: -0.05 } },
  angular: { z: 0.37, d: 0.12, w: 0.7, ledge: true, cover: { w: 0.64, d: 0.58, z: -0.06 } },
};
const SOCKET_AIM = 0.5;   // aim socket at hull top + turret height × this
const LEG_SPADE = 0.06;   // reserve below the leg length for the spade thickness
const SMOKE_Z = 0.45;     // smoke socket z share of the hull length (behind the centre)

const shapeOf = (kit) => ARTILLERY_SHAPES[kit.style.silhouette] ?? Object.values(ARTILLERY_SHAPES)[0];

function buildArtillery(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  const th = L * s.trackH;
  // team colour: module team layouts (skirts / plates / caps, roof marks, emblems on plates) + a deck mark
  tracks(ub, { L, gauge: W * s.gauge, tw: W * s.trackW, th, team: true });
  const hullY = th * s.hullLift;
  ub.bone('hull', 'root', [0, hullY, 0]);
  ub.meta.hull = { bone: 'hull', bank: false };
  const hullLen = L * s.hullL;
  const hl = hull(ub, { bone: 'hull', y: 0, L: hullLen, W, H, team: true });
  const dm = DECK_MARK[kit.style.silhouette];
  const coverH = dm ? UNIT_KIT.teamPaint.roofMark.h : 0;
  if (dm) {
    const c = dm.cover;
    ub.paint('hull').box(W * c.w, coverH, hullLen * c.d, S.teamShade, { y: hl.top + coverH / 2, z: hullLen * c.z, detail: UNIT_KIT.teamPaint.lod.roofMark });
    roofMark(ub, 'hull', { y: dm.ledge ? H * UNIT_MODULES.hull.angular.lowerShare : hl.top + coverH, z: hullLen * dm.z, w: W * dm.w, d: hullLen * dm.d });
  }
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
  // cradle: lifts with setDeployed, the weapon's own barrel bone pitches on top of it
  ub.bone('cradle', 'turret', [0, tr.mid, tr.front * s.cradleZ]);
  ub.deploy('cradle', 'rx', -s.liftAngle);
  weapon(ub, 'cannon', { parent: 'cradle', position: [0, 0, 0], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch });
  // outriggers: pivot beside the tracks, length so the spades reach the ground at full deploy
  const P = s.legs;
  const reach = (hullY + P.y) / Math.cos(UNIT_MODULES.outrigger.out) + LEG_SPADE;
  const legs = [];
  for (const side of [1, -1]) for (const end of [1, -1]) legs.push({ x: side * W * P.x, y: P.y, z: end * L * P.z, side });
  outriggers(ub, { parent: 'hull', legs, length: reach });
  // sensor mast (long sight)
  const M = s.mast;
  const hb = ub.paint('hull');
  hb.cylinder(M.r, M.r, M.h, M.seg, S.frame, { x: W * M.x, y: hl.top + M.h / 2, z: L * M.z, detail: 0 });
  hb.sphere(M.ball, M.ballSeg[0], M.ballSeg[1], S.lens, { x: W * M.x, y: hl.top + M.h, z: L * M.z, detail: 0 });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], hl.top, L * s.status[1]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[1]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * s.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildArtillery);

export class MobileArtilleryUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'mobileArtillery', name: 'MobileArtilleryUnit' });
  }
}

registerProcUnit('mobileArtillery', (race, teamColor, opts) => new MobileArtilleryUnit({ race, teamColor, ...opts }));
