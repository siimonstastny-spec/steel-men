// Steel Men – procedural stealth jet (roadmap U3). Slim fuselage, swept wings, V-tail, two exhausts (style flame kind),
// nose plasma gun (anti-air), glowing dorsal spine and intakes. Camouflage = owner calls setCloaked(0..1) (it may move
// while cloaked); setStatus('cloaked') = blue lamp. Shape by style.silhouette (fuselage / wings modules), no faction names.
// Sockets: muzzle, aim, smoke, exhaust_1/2. Model units ≈ 5.6–6.6 long, 5.2–6.0 span; hull flies at JET.altitude (rest pose,
// like the kit's previewJet – the owner decides the real height). Aircraft owner: setThrottle(speed / maxSpeed); bank is automatic.
// Registered as 'stealthJet'. No per-frame code of its own.
// Team colour (docs/notes/proc-unit-teamcolor-kit.md): fuselage / wings have no `team` option, so the model adds its own
// team surfaces (teamAircraft, shared with StealthBomberUnit): solid team plates (extruded planform, like the wings
// themselves) over the whole upper side of the wings outside the fuselage, a neutral-backed emblem on each plate (the
// module's own wing decals sit under the plate), + a dorsal cap (rounded / round), cover + chevron (angular) or a team band
// (faceted) on the fuselage.
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp, roofMark, emblemPlate, prism, UNIT_MODULES } from './UnitModules.js';

const HALF_PI = Math.PI / 2;
const CAP = { theta0: 0.3, theta1: 1.2, phi: 2.2, seg: [6, 4], lift: 1.02 };   // dorsal ellipsoid patch behind the canopy (polar angles, sector rad, segments [phi, theta])
/**
 * Team surfaces of an aircraft by style.silhouette. plateH = thickness of the wing plate (its top lies this far over the
 * wing top, clear of the module's decal at 0.01 – the decal is hidden under it), rootGap = inner edge of the plate (× W/2,
 * the fuselage half width), cap = ellipsoid patch (rounded / round), cover / chevron = angular roof (shares of the top
 * width, L, L; the cover is the darker team lacquer), band = faceted ridge band {w, h (× fuselage), d, z (shares of L)}.
 */
export const AIRCRAFT_TEAM = {
  plateH: 0.03, rootGap: 1, crescentSteps: 4,
  rounded: { cap: CAP },
  angular: { cover: { w: 0.8, d: 0.3, z: -0.2 }, chevron: { w: 0.7, d: 0.2, z: -0.2 } },
  round: { cap: CAP },
  faceted: { band: { w: 1.03, h: 1.03, d: 0.3, z: -0.2 } },
};

/** Half planform [x, z] (x ≥ 0, z forward, wing frame) of one wing, same outline as the wings() module */
function wingHalfOutline(sil, half, rc, tc, sweep) {
  const Wg = UNIT_MODULES.wing;
  const tipF = rc / 2 - sweep;
  switch (sil) {
    case 'angular': return [[0, rc / 2], [half, tipF], [half, tipF - tc], [0, -rc / 2]];
    case 'round': {   // crescent: two quadratic curves, sampled
      const C = Wg.crescent;
      const pts = [];
      const n = AIRCRAFT_TEAM.crescentSteps;
      const q = (p0, c, p1, t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p1;
      for (let i = 0; i <= n; i++) { const t = i / n; pts.push([q(0, half * C.lead, half, t), q(rc / 2, rc / 2, -sweep, t)]); }
      for (let i = 1; i <= n; i++) { const t = i / n; pts.push([q(half, half * C.trail, 0, t), q(-sweep, rc * C.trailZ, -rc / 2, t)]); }
      return pts;
    }
    case 'faceted': {
      const F = Wg.faceted;
      const tipZ = tipF + sweep * F.tipSweep;
      return [[0, rc / 2], [half * F.kink, rc / 2 + sweep * F.kinkSweep], [half, tipZ], [half * F.tipBack, tipZ - tc], [half * F.rootBack, rc * F.rootTrail], [0, -rc / 2]];
    }
    default: return [[0, rc / 2], [half * Wg.rootSpan, tipF], [half, tipF - tc * Wg.tipCurve], [half, tipF - tc], [0, -rc / 2]];
  }
}

/** Polygon clipped to x ≥ x0 (Sutherland–Hodgman on one half-plane) */
function clipFromX(poly, x0) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ina = a[0] >= x0;
    if (ina) out.push(a);
    if (ina !== (b[0] >= x0)) out.push([x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]);
  }
  return out;
}

/**
 * Team surfaces of an aircraft (call after fuselage() + wings() with the same numbers): wing plates + fuselage cap / chevron.
 * `wingFrom` share of the half span (see AIRCRAFT_TEAM); y / z = the wings() arguments.
 */
export function teamAircraft(ub, { bone = 'hull', L, W, H, y = 0, wingY, wingZ, span, rc, tc, sweep, over }) {
  const kit = ub.kit;
  const S = kit.S;
  const sil = kit.style.silhouette;
  const T = { ...(AIRCRAFT_TEAM[sil] ?? AIRCRAFT_TEAM.rounded), ...over };   // over = per-aircraft replacement of cap / cover / chevron / band
  const half = span / 2;
  const Wg = UNIT_MODULES.wing;
  const poly = clipFromX(wingHalfOutline(sil, half, rc, tc, sweep), (W / 2) * AIRCRAFT_TEAM.rootGap);
  const b = ub.paint(bone);
  if (poly.length >= 3) {
    const topY = wingY + Wg.thick / 2 + AIRCRAFT_TEAM.plateH;   // plate top
    for (const side of [1, -1]) {
      // same construction as the wing itself (extrude, rotateX π/2: top face up, shape y = z), so the top faces up
      const shape = new THREE.Shape(poly.map(([px, pz]) => new THREE.Vector2(side * px, pz)));
      b.add(new THREE.ExtrudeGeometry(shape, { depth: AIRCRAFT_TEAM.plateH, bevelEnabled: false }), S.teamPaint, {
        rx: HALF_PI, y: topY, z: wingZ, detail: UNIT_KIT.teamPaint.lod.panel,
      });
      // emblem on the plate where the module's decal is (hidden under the plate), on a neutral slab
      emblemPlate(ub, bone, {
        position: [side * half * Wg.emblemX, topY, wingZ + rc * Wg.emblemZ], normal: [0, 1, 0], up: [0, 0, 1], size: rc * Wg.emblemShare,
      });
    }
  }
  if (T.cap) {
    const c = T.cap;
    const geo = new THREE.SphereGeometry(1, c.seg[0], c.seg[1], Math.PI * 1.5 - c.phi / 2, c.phi, c.theta0, c.theta1 - c.theta0);   // sector behind the canopy (rear = +phi 3π/2)
    b.add(geo, S.teamPaint, { sx: (W / 2) * c.lift, sy: (H / 2) * c.lift, sz: (L / 2) * c.lift, y, detail: UNIT_KIT.teamPaint.lod.roofMark });
  }
  if (T.cover) {   // angular: darker cover on the flat roof behind the canopy + chevron on it
    const A = UNIT_MODULES.fuselage.angular;
    const k = UNIT_KIT.teamPaint.roofMark.h;
    b.box(W * A.topW * T.cover.w, k, L * T.cover.d, S.teamShade, { y: y + H / 2 + k / 2, z: L * T.cover.z, detail: UNIT_KIT.teamPaint.lod.roofMark });
    roofMark(ub, bone, { y: y + H / 2 + k, z: L * T.chevron.z, w: W * A.topW * T.chevron.w, d: L * T.chevron.d });
  }
  if (T.band) {    // faceted: team band round the ridge fuselage (same section, a hair bigger)
    prism(b, 4, W * T.band.w, H * T.band.h, L * T.band.d, S.teamPaint, { y, z: L * T.band.z, detail: UNIT_KIT.teamPaint.lod.roofMark });
  }
}

const BASE = { L: 6.2, W: 1.2, H: 0.75, span: 5.4, rc: 3.0, tc: 0.5, sweep: 1.8, fins: 2 };

/** Shapes by style.silhouette (unknown → rounded) */
export const STEALTH_JET_SHAPES = {
  rounded: BASE,
  // team: bigger roof cover + chevron (angular) / wider, lower dorsal cap (round) than AIRCRAFT_TEAM (the bomber keeps the defaults)
  angular: { ...BASE, L: 6.6, W: 1.4, span: 5.8, sweep: 2.3, team: { cover: { w: 0.95, d: 0.4, z: -0.22 }, chevron: { w: 0.8, d: 0.28, z: -0.22 } } },
  round: { ...BASE, L: 5.8, W: 1.8, H: 0.8, tc: 0, sweep: 1.4, fins: 0, team: { cap: { ...CAP, phi: 3.2, theta1: 1.5 } } },
  faceted: { ...BASE, L: 6.6, W: 1.0, H: 0.7, span: 5.2, tc: 0.4, sweep: -0.5 },
};
const JET = {
  altitude: 3, bobAmp: 0.1, bobFreq: 0.4,
  engines: 2, engineSpacing: 0.55, engineR: 0.22, engineLen: 1.5,
  finH: 0.9, finChord: 1.1, finY: 0.3, finZ: -0.38, finTilt: 0.6,
  wingY: -0.1, wingZ: -0.1,
  gunY: -0.3, gunZ: 0.3, gunLen: 1.3, gunCal: 0.1,
  statusY: 0.45, statusZ: -0.2,
  intake: { x: 0.5, z: 0.05, w: 0.3, h: 0.25, d: 0.9, haloR: 0.1 },        // box beside the fuselage (x share of W)
  spine: { y: 0.42, z0: -0.3, z1: 0.1, t: 0.035, intensity: 0.6 },            // glowing dorsal line (y share of H, z shares of L)
  smokeZ: 0.3,                                                                // smoke socket z share of L (behind the centre)
};

const shapeOf = (kit) => STEALTH_JET_SHAPES[kit.style.silhouette] ?? STEALTH_JET_SHAPES.rounded;

function build(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L, W, H });
  wings(ub, { bone: 'hull', y: H * JET.wingY, z: L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  teamAircraft(ub, {
    bone: 'hull', L, W, H, wingY: H * JET.wingY, wingZ: L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep, over: s.team,
  });
  if (s.fins) tailFins(ub, { bone: 'hull', y: H * JET.finY, z: L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  const I = JET.intake;
  for (const side of [1, -1]) {
    ub.paint('hull').box(I.w, I.h, I.d, kit.S.hullDark, { x: side * W * I.x, y: 0, z: L * I.z });
    ub.glow('hull').point([side * W * I.x, 0, L * I.z + I.d / 2], I.haloR, ub.style.weaponGlow, {});
  }
  const sp = JET.spine;
  ub.glow('hull').segment([0, H * sp.y, L * sp.z0], [0, H * sp.y, L * sp.z1], sp.t, ub.style.weaponGlow);
  for (let i = 0; i < JET.engines; i++) {
    const x = (i - (JET.engines - 1) / 2) * JET.engineSpacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -L / 2], r: JET.engineR, length: JET.engineLen, index: i + 1 });
  }
  weapon(ub, 'plasma', { parent: 'hull', position: [0, H * JET.gunY, L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0] });
  statusLamp(ub, { parent: 'hull', position: [0, H * JET.statusY, L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * JET.smokeZ]);
  return ub.build();
}

const CACHE = createUnitCache(build);

export class StealthJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: THREE.ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'stealthJet', name: 'StealthJetUnit' });
  }
}

registerProcUnit('stealthJet', (race, teamColor, opts) => new StealthJetUnit({ race, teamColor, ...opts }));
