// Steel Men – procedural heavy fighter jet (roadmap U2): strong air-to-air airframe with FOUR engines (four exhaust
// flames, size / colour from the style data), belly missile pod and a rotary cannon.
//   • aircraft rig: hull bone hovers at JET altitude, banks into turns (meta.hull bank), setThrottle() drives the flames
//   • sockets: muzzle + launch_1..4 (missile pod), muzzle_2 (cannon), exhaust_1..4, aim, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 9.0 long, 8.5 span, ≈ 4.7 high with fins. Visual only.
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp, roofMark, UNIT_MODULES } from './UnitModules.js';

/** Shapes by style.silhouette (sizes in model units; Y / Z of parts as shares of H / L) */
export const HEAVY_FIGHTER_SHAPES = {
  angular: {
    L: 9.0, W: 1.9, H: 1.5, span: 8.5, rc: 4.2, tc: 0.9, sweep: 2.6,
    altitude: 3.0, bobAmp: 0.12, bobFreq: 0.35,
    wingY: -0.1, wingZ: -0.1,
    fins: { count: 2, h: 1.4, chord: 1.8, y: 0.3, z: -0.38 },
    engines: { x: [-1.45, -0.55, 0.55, 1.45], r: 0.36, length: 1.8, z: -0.46, y: -0.1 },   // z share of L, y share of H
    nacelle: { w: 0.85, h: 0.8, len: 3.2 },
    missiles: { count: 4, x: 0, y: -0.45, z: 0.12, length: 1.0 },
    gun: { x: 0.35, y: -0.15, z: 0.28, length: 1.3, caliber: 0.08 },   // x share of W
    status: [0.45, -0.25],
  },
};

const SMOKE_Z = 0.4;   // smoke socket z share of L (behind the centre)

// team colour: engine nacelles in the dark team lacquer (recoloured, +0 triangles), a wing-tip strip per wing, a spine mark
// behind the canopy (flat angular top / ellipsoid round top; the other fuselages have a team band or a ridge – no mark).
// The wing carries the emblem decals on its inner part, so the strip sits outboard of them.
const WING_STRIP = { from: 0.84, to: 0.98, chord: 0.7, h: 0.03 };   // span range (× half span), share of the local chord, height above the wing
const SPINE_MARK = {
  angular: { z: -0.09, d: 0.18, w: 0.5 },            // z, d shares of L, w share of W (clear of the status lamp and the fins)
};
// round (ellipsoid) fuselage: a team cap laid over the top of the same ellipsoid (polar angle, absolute lift in model units, segments)
const ROUND_CAP = { angle: 0.45, lift: 0.03, segW: 12, segH: 2 };
const CRESCENT_SAMPLES = 8;   // curve samples per crescent edge (round wing planform)

const shapeOf = (kit) => HEAVY_FIGHTER_SHAPES[kit.style.silhouette] ?? Object.values(HEAVY_FIGHTER_SHAPES)[0];

function sampleQuad(p0, p1, p2, out) {
  for (let i = 1; i <= CRESCENT_SAMPLES; i++) {
    const t = i / CRESCENT_SAMPLES;
    const u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]]);
  }
}

// planform of one wing (x ≥ 0; [x, z] points) – the same outlines as the wings() module (UNIT_MODULES.wing)
function wingPlan(sil, half, rc, tc, sweep) {
  const Wg = UNIT_MODULES.wing;
  const tipF = rc / 2 - sweep;
  switch (sil) {
    case 'angular': return [[0, rc / 2], [half, tipF], [half, tipF - tc], [0, -rc / 2]];
    case 'round': {
      const pts = [[0, rc / 2]];
      sampleQuad([0, rc / 2], [half * Wg.crescent.lead, rc / 2], [half, -sweep], pts);
      sampleQuad([half, -sweep], [half * Wg.crescent.trail, rc * Wg.crescent.trailZ], [0, -rc / 2], pts);
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

// [min z, max z] of a planform at span position x
function planRange(plan, x) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const b = plan[(i + 1) % plan.length];
    if (a[0] === b[0] || x < Math.min(a[0], b[0]) || x > Math.max(a[0], b[0])) continue;
    const z = a[1] + ((x - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return [lo, hi];
}

// team strip on the top of both wings, along the mid-chord line between two span positions, inside the planform
function wingStrips(ub, { y, z, span, rc, tc, sweep }) {
  const half = span / 2;
  const plan = wingPlan(ub.kit.style.silhouette, half, rc, tc, sweep);
  const x0 = half * WING_STRIP.from;
  const x1 = half * WING_STRIP.to;
  const r0 = planRange(plan, x0);
  const r1 = planRange(plan, x1);
  const m0 = (r0[0] + r0[1]) / 2;
  const m1 = (r1[0] + r1[1]) / 2;
  const chord = Math.min(r0[1] - r0[0], r1[1] - r1[0]) * WING_STRIP.chord;
  const len = Math.hypot(x1 - x0, m1 - m0);
  if (!(chord > 0)) return;
  const h = WING_STRIP.h;
  for (const side of [1, -1]) {
    ub.paint('hull').box(len, h, chord, ub.kit.S.teamPaint, {
      x: (side * (x0 + x1)) / 2, y: y + UNIT_MODULES.wing.thick / 2 + h / 2, z: z + (m0 + m1) / 2,
      ry: -Math.atan2(m1 - m0, side * (x1 - x0)), detail: UNIT_KIT.teamPaint.lod.panel,
    });
  }
}

function buildHeavyFighter(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, s.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: s.bobAmp, bobFreq: s.bobFreq };
  fuselage(ub, { bone: 'hull', L, W, H });
  wings(ub, { bone: 'hull', y: H * s.wingY, z: L * s.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  wingStrips(ub, { y: H * s.wingY, z: L * s.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  const sil = kit.style.silhouette;
  const sm = SPINE_MARK[sil];
  if (sm) {
    roofMark(ub, 'hull', { y: H / 2, z: L * sm.z, w: W * sm.w, d: L * sm.d });
  } else if (sil === 'round') {
    ub.paint('hull').add(new THREE.SphereGeometry(1, ROUND_CAP.segW, ROUND_CAP.segH, 0, Math.PI * 2, 0, ROUND_CAP.angle), kit.S.teamPaint, {
      sx: W / 2 + ROUND_CAP.lift, sy: H / 2 + ROUND_CAP.lift, sz: L / 2 + ROUND_CAP.lift, detail: UNIT_KIT.teamPaint.lod.roofMark,
    });
  }
  tailFins(ub, { bone: 'hull', y: H * s.fins.y, z: L * s.fins.z, h: s.fins.h, chord: s.fins.chord, count: s.fins.count });
  const E = s.engines;
  const nb = ub.paint('hull');
  E.x.forEach((x, i) => {
    const pos = [x, H * E.y, L * E.z];
    nb.box(s.nacelle.w, s.nacelle.h, s.nacelle.len, kit.S.teamShade, { x, y: pos[1], z: pos[2] + UNIT_MODULES.exhaust.nozzleLen + s.nacelle.len / 2 });
    exhaust(ub, { parent: 'hull', position: pos, r: E.r, length: E.length, index: i + 1 });
  });
  const m = s.missiles;
  weapon(ub, 'missile', { parent: 'hull', position: [m.x, H * m.y, L * m.z], length: m.length, count: m.count, pitch: [0, 0] });
  const g = s.gun;
  weapon(ub, 'gun', { parent: 'hull', position: [W * g.x, H * g.y, L * g.z], length: g.length, caliber: g.caliber, pitch: [0, 0], sfx: '_2' });
  statusLamp(ub, { parent: 'hull', position: [0, H * s.status[0], L * s.status[1]] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyFighter);

export class HeavyFighterJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyFighterJet', name: 'HeavyFighterJetUnit' });
  }
}

registerProcUnit('heavyFighterJet', (race, teamColor, opts) => new HeavyFighterJetUnit({ race, teamColor, ...opts }));
