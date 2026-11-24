// Steel Men – procedural medium laser combat hovercraft (roadmap U4). Wider, armoured hover with a main laser in the
// turret plus a small roof point-defence laser (own barrel bone, rests pitched up, for air). Hover pads glow under the
// skirt. Shape table keyed by style.silhouette with only `faceted` (others fall back to it).
//   • sockets: muzzle (main laser), muzzle_2 (roof laser, fire('muzzle_2')), turret, aim, cargo, smoke
//   • the roof laser bone `barrel_2` is not driven by setBarrelPitch (that moves the main laser)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 6.8 long, 3.4 wide, 2.5 high. Visual only.
//   • team colour: hull / turret with team: true + deck mark ahead of the turret + skirt rim + team armour pods
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp } from './UnitModules.js';
import { skirtRim, deckMark } from './LightLaserHoverUnit.js';

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const MEDIUM_LASER_HOVER_SHAPES = {
  faceted: {
    L: 6.8, W: 3.2, H: 1.05,
    turret: { w: 2.0, d: 2.5, h: 0.8, z: -0.06 },
    gun: { length: 3.4, caliber: 0.1, pitch: [-0.1, 0.45] },
    aa: { length: 1.2, caliber: 0.045, x: 0.28, z: -0.2 },   // shares of turret w / d (centre offsets)
    status: [0.2, 0.8, -0.34],   // beside the dorsal fin (x share of W)
    // deck mark ahead of the turret by style.silhouette (see LightLaserHoverUnit.js deckMark; round / faceted: module team paint only)
    team: {
      deckMark: {
        rounded: { w: 0.5, d: 0.15, z: 0.25, ledge: false },
        angular: { w: 0.6, d: 0.1, z: 0.37, ledge: true },
      },
    },
  },
};

const CHASSIS = {
  gap: 0.07, skirtL: 1.0, skirtW: 1.08, skirtH: 0.07, hullL: 0.9,
  pads: [[0.32, 0.32], [-0.32, 0.32], [0.32, -0.32], [-0.32, -0.32]],
};
const SPONSON = { w: 0.14, h: 0.5, d: 0.5, x: 0.5, y: 0.4, z: -0.02, glowR: 0.08 };   // side armour pods: shares of W / H / L
const SIDE_LASER = { x: 0.51, y: 0.45, len: 1.0, r: 0.05, seg: 6 };   // pod gun stubs (paint only): x share of W, y share of H, model units
const AA_LIFT = 0.22;            // roof laser axis above the turret roof
const AA_REST_PITCH = 0.5;       // rad, roof laser elevation at rest (bone rotation.x = −pitch)
const AA_RINGS = 1;              // barrel rings of the small roof laser (the main laser keeps the module default)
const AA_PEDESTAL = { r: 0.16, h: 0.14, flare: 1.2, seg: 6 };
const WEAPON_MOUNT = 0.85;       // trunnion z = turret front × this
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.4;

const shapeOf = (kit) => MEDIUM_LASER_HOVER_SHAPES[kit.style.silhouette] ?? MEDIUM_LASER_HOVER_SHAPES.faceted;

function buildMediumLaserHover(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, L * P.gap, 0]);
  const base = hover(ub, { bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]) });
  skirtRim(ub, base, W * P.skirtW, L * P.skirtL);
  const hullLen = L * P.hullL;
  const hl = hull(ub, { bone: 'hull', y: base, L: hullLen, W, H, team: true });
  deckMark(ub, s.team.deckMark[kit.style.silhouette], { base, top: hl.top, W, H, hullLen });
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  for (const side of [1, -1]) {
    const px = side * W * SPONSON.x;
    const py = base + H * SPONSON.y;
    hb.box(W * SPONSON.w, H * SPONSON.h, L * SPONSON.d, S.teamPaint, { x: px, y: py, z: L * SPONSON.z, detail: UNIT_KIT.teamPaint.lod.panel });
    hb.cylinder(SIDE_LASER.r, SIDE_LASER.r, SIDE_LASER.len, SIDE_LASER.seg, S.frame, { rx: Math.PI / 2, x: side * W * SIDE_LASER.x, y: base + H * SIDE_LASER.y, z: L * (SPONSON.z + SPONSON.d / 2) + SIDE_LASER.len / 2, detail: 0 });
    hg.point([px, py, L * (SPONSON.z + SPONSON.d / 2) + SIDE_LASER.len], SPONSON.glowR, ub.style.weaponGlow, {});
  }
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
  weapon(ub, 'laser', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  const ax = t.w * s.aa.x;
  const az = t.d * s.aa.z;
  ub.paint('turret').cylinder(AA_PEDESTAL.r, AA_PEDESTAL.r * AA_PEDESTAL.flare, AA_PEDESTAL.h, AA_PEDESTAL.seg, S.hullDark, { x: ax, y: t.h + AA_PEDESTAL.h / 2, z: az });
  weapon(ub, 'laser', { parent: 'turret', position: [ax, t.h + AA_LIFT, az], length: s.aa.length, caliber: s.aa.caliber, sfx: '_2', pitch: [0, 0], rings: AA_RINGS });
  ub.boneDefs[ub.boneIndex('barrel_2')].rotation = [-AA_REST_PITCH, 0, 0];
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * P.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildMediumLaserHover);

export class MediumLaserHoverUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'mediumLaserHover', name: 'MediumLaserHoverUnit' });
  }
}

registerProcUnit('mediumLaserHover', (race, teamColor, opts) => new MediumLaserHoverUnit({ race, teamColor, ...opts }));
