// Steel Men – procedural heavy bomber (roadmap U2): large four-engine war plane (four big exhaust flames), bomb bay
// doors under the belly (sockets bomb_1..n = where bombs leave), weak defensive guns (tail gun faces backwards).
//   • aircraft rig: hull bone hovers at the altitude, banks into turns, setThrottle() drives the flames
//   • sockets: muzzle (tail gun, points back), muzzle_2 (dorsal gun), bomb_1..n, exhaust_1..4, aim, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 15 long, 17 span, ≈ 5.7 high with the fin. Visual only.
import * as THREE from 'three';
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp, roofMark, UNIT_MODULES } from './UnitModules.js';

const PI = Math.PI;

/** Shapes by style.silhouette (sizes in model units; Y / Z of parts as shares of H / L unless noted) */
export const HEAVY_BOMBER_SHAPES = {
  angular: {
    L: 15.0, W: 3.4, H: 2.6, span: 17.0, rc: 6.5, tc: 2.6, sweep: 3.0,
    altitude: 3.0, bobAmp: 0.1, bobFreq: 0.25,
    wingY: -0.1, wingZ: -0.1,
    fin: { h: 1.9, chord: 3.0, y: 0.3, z: -0.38 },
    engines: { pos: [[-5.6, -4.3], [-3.2, -4.6], [3.2, -4.6], [5.6, -4.3]], r: 0.5, length: 2.6, y: -0.1 },   // [x, z] model units, y share of H
    nacelle: { w: 1.3, h: 1.2, len: 4.5 },
    bay: { w: 0.55, len: 0.3, z: 0.0, doorT: 0.1, gap: 0.03, bombs: 6, bombZ: 0.07 },   // shares of W / L; bombZ = spacing share of L
    tail: { z: -0.42, y: 0.2, length: 1.2, caliber: 0.07 },
    dorsal: { z: 0.05, length: 1.2, caliber: 0.07 },
    status: [0.5, -0.15],
  },
};

const SMOKE_Z = 0.4;   // smoke socket z share of L (behind the centre)

// team colour: engine nacelles in the dark team lacquer (recoloured, +0 triangles), a wing strip per wing, a spine mark
// behind the dorsal gun (flat angular top / ellipsoid round top; the other fuselages have a team band or a ridge – no mark).
// The wing carries the emblem decals on its inner part, so the strip sits outboard of them.
const WING_STRIP = { from: 0.75, to: 0.97, chord: 0.7, h: 0.03 };   // span range (× half span), share of the local chord, height above the wing
const SPINE_MARK = {
  angular: { z: -0.28, d: 0.14, w: 0.5 },            // z, d shares of L, w share of W (behind the status lamp, ahead of the fin)
};
// round (ellipsoid) fuselage: a team cap laid over the top of the same ellipsoid (polar angle, absolute lift in model units, segments)
const ROUND_CAP = { angle: 0.45, lift: 0.03, segW: 12, segH: 2 };
const CRESCENT_SAMPLES = 8;   // curve samples per crescent edge (round wing planform)

const shapeOf = (kit) => HEAVY_BOMBER_SHAPES[kit.style.silhouette] ?? Object.values(HEAVY_BOMBER_SHAPES)[0];

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

function buildHeavyBomber(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const S = kit.S;
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
    ub.paint('hull').add(new THREE.SphereGeometry(1, ROUND_CAP.segW, ROUND_CAP.segH, 0, Math.PI * 2, 0, ROUND_CAP.angle), S.teamPaint, {
      sx: W / 2 + ROUND_CAP.lift, sy: H / 2 + ROUND_CAP.lift, sz: L / 2 + ROUND_CAP.lift, detail: UNIT_KIT.teamPaint.lod.roofMark,
    });
  }
  tailFins(ub, { bone: 'hull', y: H * s.fin.y, z: L * s.fin.z, h: s.fin.h, chord: s.fin.chord, count: 1 });
  const E = s.engines;
  const hb = ub.paint('hull');
  E.pos.forEach(([x, z], i) => {
    const y = H * E.y;
    hb.box(s.nacelle.w, s.nacelle.h, s.nacelle.len, S.teamShade, { x, y, z: z + UNIT_MODULES.exhaust.nozzleLen + s.nacelle.len / 2 });
    exhaust(ub, { parent: 'hull', position: [x, y, z], r: E.r, length: E.length, index: i + 1 });
  });
  // bomb bay doors (two flaps with a seam) + bomb drop sockets along the bay
  const B = s.bay;
  const bayW = W * B.w;
  const bayL = L * B.len;
  const bayY = -H / 2 - B.doorT / 2;
  for (const side of [1, -1]) hb.box(bayW / 2 - B.gap, B.doorT, bayL, S.dark, { x: side * bayW / 4, y: bayY, z: L * B.z });
  for (let i = 0; i < B.bombs; i++) ub.socket(`bomb_${i + 1}`, 'hull', [0, bayY - B.doorT, L * B.z + (i - (B.bombs - 1) / 2) * L * B.bombZ]);
  // defensive guns: tail gun on a bone turned backwards, dorsal gun on the spine
  const T = s.tail;
  ub.bone('tail', 'hull', [0, H * T.y, L * T.z], { rotation: [0, PI, 0] });
  weapon(ub, 'gun', { parent: 'tail', position: [0, 0, 0], length: T.length, caliber: T.caliber, pitch: [0, 0] });
  const D = s.dorsal;
  weapon(ub, 'gun', { parent: 'hull', position: [0, H / 2, L * D.z], length: D.length, caliber: D.caliber, pitch: [0, 0], sfx: '_2' });
  statusLamp(ub, { parent: 'hull', position: [0, H * s.status[0], L * s.status[1]] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyBomber);

export class HeavyBomberUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyBomber', name: 'HeavyBomberUnit' });
  }
}

registerProcUnit('heavyBomber', (race, teamColor, opts) => new HeavyBomberUnit({ race, teamColor, ...opts }));
