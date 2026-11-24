// Steel Men – procedural unit modules (roadmap U0). Each module writes painted parts, glow parts, bones, sockets and
// animation meta into a UnitBuilder (UnitKit.js); shapes follow style.silhouette (rounded | angular | round | faceted),
// colours / surfaces come from the style kit (kit.S, unitStyle), never from faction names.
//   chassis   tracks (moving cleats + sprockets), wheels (spin + steering), hover (skirt, glowing pads, bob)
//   body      hull, turret (yaw bone), fuselage, wings, tailFins (aircraft)
//   weapons   weapon(kind): cannon | missile | gun | laser | plasma | lightning (pitch bone, recoil, flash, sockets)
//   effects   exhaust (flame by style: ion / rocket / plasma / beam), statusLamp, outriggers (deploy channels)
//   team      teamStripe, teamPanel, teamTrim, roofMark (kit.S.teamPaint / teamShade vertices, no extra draw call),
//             emblemPlate (sign decal on a neutral backing slab); hull / turret / tracks take `team: true` for a team
//             layout by silhouette (docs/notes/proc-unit-teamcolor-kit.md)
// Units of length = model units of the unit (see docs/notes/proc-unit-kit.md: light tank ≈ 6.2 long). Forward = +Z.
// Construction time only – nothing here runs per frame.
import * as THREE from 'three';
import { makeRng } from '../ProcKit.js';
import { marking } from '../ProcModules.js';
import { PROC_EMBLEM } from '../../config.js';
import { UNIT_KIT } from './UnitKit.js';

export { teamPaintShare } from '../ProcModules.js';   // test / tuning: teamPaintShare(unit.shared.paint)

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Module tuning (model units of a unit; "Share" = share of the named size) */
export const UNIT_MODULES = {
  // style.edges are building-sized: units use radius × edgeScale, at most maxEdgeSegments (triangle budget)
  // maxEdgeSegments 1 = chamfer (108 triangles per box instead of 300 at 2) – at unit size it reads as a rounded edge
  edgeScale: 0.35, edgeMaxShare: 0.3, edgeMinRadius: 0.04, edgeMinSide: 0.45, maxEdgeSegments: 1,
  seg: 8,                    // default radial segments (triangle budget: 8 keeps the silhouette round enough at unit size)
  ring: { radial: 3, tubular: 16 },   // decorative torus rings (neon / team bands)
  neon: { h: 0.05, d: 0.03, out: 0.01 },
  hull: {
    rounded: { lowerShare: 0.6, deckL: 0.78, deckW: 0.86, deckZ: -0.05, glacisD: 0.16, neonY: 0.45, neonL: 0.7 },
    angular: {
      lowerShare: 0.65, topW: 0.82, topD: 0.9, deckW: 0.8, deckTopW: 0.66, deckL: 0.7, deckTopL: 0.6, deckZ: -0.06, plateT: 0.08,
      plateH: 0.45, plateL: 0.8, rivetStep: 1.3, rivetR: 0.035, rivetSeg: 4, rivetY: 0.75, ramR: 0.09, ramL: 0.45, ramX: 0.3, ramY: 0.4, ramSeg: 4,
    },
    round: { bodyY: 0.5, bodyH: 0.55, domeW: 0.3, domeH: 0.3, domeL: 0.28, domeY: 0.85, domeZ: -0.05, ringT: 0.035, segW: 14, segH: 8, domeSegW: 10, domeSegH: 5, topShare: 0.95 },
    faceted: { bodyL: 0.7, bodyZ: -0.05, bodyH: 0.8, bodyY: 0.45, noseL: 0.2, rearShare: 0.7, rearL: 0.8, neonL: 0.9, finH: 0.45, finL: 0.16, finT: 0.06, finSink: 0.05, finZ: 0.43, finX: 0.18 },   // twin rear fins (±finX × W): behind the turret, centre free for a lamp
    lights: { r: 0.09, d: 0.06, xShare: 0.32, yShare: 0.4, halo: 0.22, glow: 0.8, seg: 8 },
    front: { round: 0.42, faceted: 0.3, default: 0.5 },   // z of the headlights (× L): pointed noses sit back
    markLen: 0.6, markH: 0.12, markY: 0.35, markOut: 0.02,
  },
  track: {
    cleatPitch: 0.85, cleatH: 0.08, cleatD: 0.24, cleatOver: 1.08, hubD: 0.08, hubShare: 0.82, spokes: 2, spokeT: 0.1, spokeD: 1.3, spokeL: 1.9,
    skirtH: 0.3, skirtOver: 0.12, bellyShare: 0.7, bellyL: 0.9, bellyY: 0.5,
    plateT: 0.1, plateH: 0.9, plateY: 0.55, plateL: 0.8, topPlateL: 0.84, rivetStep: 1.3, rivetR: 0.035, rivetSeg: 4, rivetY: 0.85, rivetSpan: 0.4,
    podSeg: [10, 6], podY: 0.8, podH: 0.55, podInset: 0.3, podNeonL: 0.6,
    bladeT: 0.06, bladeH: 0.7, bladeY: 0.6, bladeL: 0.9, bladeNeonL: 0.85, markL: 0.25, markH: 0.6, markZ: 0.3, markOut: 0.02,
  },
  wheel: { hubShare: 0.55, hubOver: 1.05, spokes: 3, spokeT: 0.08, spokeOver: 1.05, bellyShare: 0.8, bellyGap: 0.1, tyreSegExtra: 2 },
  hover: {
    padR: 0.42, padRing: 0.06, padTubular: 6, holeShare: 0.85, holeY: -0.01, ringY: 0.01, coneLen: 0.4, coneSpread: 1.5, coneGlow: 0.45,
    discGlow: 0.9, discY: 0.03, bobAmp: 0.08, bobFreq: 0.5, taper: 0.85, skirtSeg: 16,
  },
  turret: {
    hatchShare: 0.18, hatchH: 0.1, bandShare: 0.18, bandY: 0.62, antennaR: 0.02, antennaH: 1.1, binShare: 0.22,
    domeSegW: 16, domeSegH: 6, ringT: 0.04, ringY: 0.35, domeHatch: 0.84, faceTop: 0.75, emblemShare: 0.7, emblemZ: -0.1, emblemOut: 0.01,
    emblemY: 0.3, emblemSide: 0.42,   // side emblem of the box turret: below the team band
    bandOver: 1.01,                   // team band (box turret, missile pod) slightly proud of the body
    hatchTop: 0.98, hatchX: -0.2, hatchZ: -0.15, antennaX: 0.3, antennaZ: -0.4, antennaSeg: 4, midShare: 0.5,
    angular: {
      topW: 0.78, topD: 0.8, binH: 0.6, binD: 0.5, binInset: 0.3, binY: 0.3, binZ: -0.3,
      plateW: 0.6, plateH: 0.3, plateD: 0.05, plateY: 0.5, plateOut: 0.02, emblemZ: -0.05, emblemSize: 0.9,
    },
    round: { ringInset: 0.5, teamInset: 0.3, emblemAt: 0.5, emblemTilt: 0.4 },   // emblemAt = height share of the side emblems
    faceted: {
      bandW: 0.25, bandH: 0.04, bandD: 0.55, bandZ: -0.05, finT: 0.05, finH: 0.9, finD: 0.3, finX: 0.22, finY: 0.9, finZ: -0.32,
      emblemOut: 0.05, emblemZ: 0.2, emblemSize: 0.9,
    },
  },
  // weapons: sizes as multiples of the caliber c (mantlet [w, h, d]) or shares of the barrel length
  barrel: {
    mantletW: 5, mantletH: 4, mantletD: 3, fumeShare: 1.4, fumeLen: 0.15, fumeZ: 0.55, brakeShare: 1.55, brakeLen: 0.1,
    brakeBox: [3.2, 2.2], brakePrism: 2.8, brakeSeg: [10, 6], recoil: 0.06, angularScale: 1.2, flashScale: 1.4,   // recoil = share of the length
  },
  missile: { tubeR: 0.16, tubeGap: 0.08, depth: 0.9, frontShare: 0.7, rim: 0.03, rimRadial: 3, holeD: 0.02, count: 4, bandH: 0.2, bandY: 0.25, bandD: 0.6, launchOut: 0.05 },
  gun: {
    barrels: 3, barrelR: 0.035, barrelSeg: 6, ring: 0.09, clampT: 0.8, clampZ: 0.8, clampSeg: [3, 10], receiver: [0.36, 0.3, 0.55],
    receiverBack: 0.1, ammo: [0.28, 0.26, 0.4], ammoY: -0.03, ammoZ: 0.05, spin: 25, recoil: 0.04, flashScale: 1.5,
  },
  // rings = barrel torus rings (weapon() option `rings` overrides it: secondary lasers use fewer); the lens halo ring only with rings > 0
  laser: { mantlet: [4, 3.5, 4], taper: 0.8, rings: 3, ringR: 1.25, ringT: 0.03, lensR: 0.12, lensD: 0.06, halo: 2.6, haloGlow: 0.7, haloRing: 1.5, haloRingT: 0.02, recoil: 0.06 },
  plasma: {
    mantlet: [4.5, 4, 4], tubeTop: 1.15, tubeLen: 0.8, coils: 2, coilR: 1.45, coilT: 0.04, core: 1.15, coreZ: 0.6, coreSeg: [8, 5],
    halo: 2.4, haloSeg: [6, 4], haloGlow: 0.45, pointShare: 1.2, recoil: 0.12,
  },
  lightning: {
    mantlet: [4, 3.5, 4], rodTop: 0.7, rodBottom: 0.9, rodLen: 0.7, ringR: 1.4, ringT: 0.6, ringZ: 0.68, prongs: 3, prongR: 0.06, prongSeg: 6,
    prongLen: 0.7, tipAt: 0.9, spread: 2.2, arcT: 0.03, arcSegments: 5, arcJitter: 0.07, ball: 0.08, seed: 777, recoil: 0.03,
  },
  flash: { size: 2.2, petals: 3, petalT: 0.05, petalLen: 1.6, coreShare: 0.45, coreSeg: [6, 4], beamLen: 4, beamShare: 0.35, beamTip: 0.4, beamSeg: 8, beamGlow: 0.9, ball: 0.6, muzzleOut: 0.05 },
  // exhaust: nozzle + flame by kind (key = unitStyle.exhaust.kind, unknown → ion).
  //   layers: [nearR, farR (both × r × width), length share, intensity, colour 'outer' | 'core', open (hollow) tube]
  //   balls (shock diamonds): [r (× r × width), z (share of the flame length, behind the exit), intensity]
  //   bulb / halo (spheres): [r (× r × width), z (× r, behind the exit), intensity]; ring: [r (× r × width), tube (× r), intensity]
  //   lens: exit disc radius (× r)
  exhaust: {
    nozzleLen: 0.35, bell: 1.15, front: 0.85, seg: 8, holeShare: 0.95, holeLen: 0.02, holeOut: 0.005, lensOut: 0.01,
    ballSeg: [6, 4], bulbSeg: [8, 5], ringRadial: 3,
    shapes: {
      ion: { layers: [[0.9, 0.45, 1, 0.8, 'outer', true], [0.5, 0.2, 0.5, 0.35, 'core', true]], ring: [0.8, 0.12, 1] },
      rocket: { layers: [[1, 0, 1, 0.85, 'outer', false], [0.6, 0, 0.55, 1, 'core', false]], balls: [[0.3, 0.3, 0.6], [0.22, 0.5, 0.45]] },
      plasma: { layers: [[1, 0.25, 1, 0.7, 'outer', true]], bulb: [0.85, 0.5, 0.9], halo: [1.6, 0.6, 0.25] },
      beam: { layers: [[0.35, 0.25, 1, 1, 'core', false], [0.7, 0.45, 0.85, 0.5, 'outer', true]], lens: 0.8 },
    },
  },
  status: { baseR: 0.08, baseFlare: 1.2, baseH: 0.06, baseSeg: 8, lampR: 0.07, halo: 0.17, haloGlow: 0.45, white: '#ffffff' },   // white × status colour
  // aircraft fuselage by silhouette (shares of L / W / H); canopy = [w, h, l] shares, canopyY / canopyZ shares
  fuselage: {
    rounded: { seg: [16, 10], canopy: [0.25, 0.32, 0.2], canopySeg: [12, 6], canopyY: 0.3, canopyZ: 0.18, bandH: 0.12, bandL: 0.35, bandZ: -0.1, bandOver: 1.02 },
    angular: { topW: 0.7, bodyL: 0.7, bodyZ: -0.08, topL: 0.6, noseL: 0.3, noseH: 0.8, noseW: 0.8, noseZ: 0.35, canopy: [0.3, 0.35, 0.2], canopyZ: 0.12, canopySink: 0.05 },
    round: { seg: [18, 10], canopy: [0.22, 0.3, 0.18], canopySeg: [12, 6], canopyY: 0.28, canopyZ: 0.12 },
    faceted: { bodyL: 0.6, bodyZ: -0.05, noseL: 0.25, noseZ: 0.375, canopyW: 0.5, canopyH: 0.45, canopyL: 0.25, canopyY: 0.22, canopyZ: 0.2, neonL: 0.5 },
  },
  wing: {
    thick: 0.12, navR: 0.08, emblemShare: 0.6, emblemX: 0.45, emblemZ: -0.1, emblemOut: 0.01, tipCurve: 0.3, curveSegments: 8,
    rootSpan: 0.92,                                         // rounded: straight edge to this share of the half span
    crescent: { lead: 0.7, trail: 0.6, trailZ: -0.1 },      // round: quadratic control points (× half span, × rc)
    faceted: { kink: 0.6, kinkSweep: 0.4, tipSweep: 2, tipBack: 0.85, rootBack: 0.4, rootTrail: -0.2 },
  },
  fin: { thick: 0.08, tipFront: -0.1, tipBack: -0.45 },    // tip edge z (× chord)
  outrigger: { beamT: 0.15, spadeW: 0.5, spadeH: 0.06, spadeD: 0.4, fold: 2.95, out: 0.5 },
  // aviation navigation light colours (left / right) – physical convention, not faction
  navColors: ['#ff3020', '#30ff60'],
  // team layouts of hull / turret / tracks (option team: true), shares of the module sizes; caps = polar angle (rad) of a
  // sphere segment laid over the curved top × lift (just proud of the body), capSegH = its height segments
  team: {
    hull: {
      rounded: { stripeY: 0.5, stripeH: 0.42, stripeL: 0.8, stripes: 1 },    // deck side stripes (shares of the deck height / deck length)
      round: { cap: 0.85, capLift: 1.015, capSegH: 2 },                      // ellipsoid top cap (+ side plates / fins painted elsewhere)
      faceted: { strakeShare: 0.55, strakeL: 0.75 },                         // strakes on the upper faces (share of the face width / body length)
    },
    turret: {
      rounded: { roofW: 0.72, roofD: 0.6, roofZ: 0.06, emblemY: 0.26, emblemSide: 0.38 },   // band painted, roof mark, side emblems on plates under the band
      angular: { emblemX: 0.2, emblemZ: -0.22, emblemShare: 0.7, chevronW: 0.8, chevronD: 0.34, chevronZ: 0.25 },   // shares of the roof (w × topW, d × topD), emblem × h, beside the hatch; bins + rear plate painted
      round: { cap: 0.85, capLift: 1.012, capSegH: 2, emblemAt: 0.38, emblemShare: 0.45 },  // dome cap instead of the team ring; side emblems below it
      faceted: { roof: 0.92, emblemAt: 0.5, emblemShare: 0.75 },                            // rhombus over the top diamond; emblems on the front flank faces
    },
  },
};

const M = UNIT_MODULES;

// ---------------------------------------------------------------- helpers

/** Box with the style's edges scaled to unit size (rounded / chamfered / sharp); small boxes stay sharp */
export function unitBox(b, kit, w, h, d, s, t = {}, edgeScale = 1) {
  const e = kit.style.edges;
  const minSide = Math.min(w, h, d);
  const r = Math.min(e.radius * M.edgeScale * edgeScale, minSide * M.edgeMaxShare);
  const seg = Math.min(e.segments, M.maxEdgeSegments);
  if (seg < 1 || r < M.edgeMinRadius || minSide < M.edgeMinSide) return b.box(w, h, d, s, t);
  return b.roundedBox(w, h, d, r, seg, s, t);
}

/** Flat-shaded copy of a geometry (faceted look); the input is disposed */
export function flat(geo) {
  const g = geo.toNonIndexed();
  geo.dispose();
  g.computeVertexNormals();
  return g;
}

/** Prism along Z (cross-section `sides`-gon, width w × height h, length len), flat-shaded */
export function prism(b, sides, w, h, len, s, t = {}, thetaStart = 0) {
  return b.add(flat(new THREE.CylinderGeometry(1, 1, 1, sides, 1, false, thetaStart)), s, { ...t, rx: HALF_PI, sx: w / 2, sy: len, sz: h / 2 });
}

/** Pointed cone along +Z (apex forward), `sides`-gon base w × h, length len; centred at t.z */
export function noseCone(b, sides, w, h, len, s, t = {}) {
  return b.add(flat(new THREE.CylinderGeometry(0, 1, 1, sides)), s, { rx: HALF_PI, ...t, sx: w / 2, sy: len, sz: h / 2 });   // t.rx = −π/2 points it back
}

/** Thin neon line along Z */
const neonLine = (b, kit, len, t) => b.box(M.neon.d, M.neon.h, len, kit.S.neon, t);

const shapeOf = (kit, table) => table[kit.style.silhouette] ?? table.rounded;

// ---------------------------------------------------------------- team paint + emblem plate (construction time only)
// Team colour of a unit = ordinary paint vertices with the team mask (kit.S.teamPaint, darker kit.S.teamShade) on any
// bone's PartBuilder: no extra mesh / material / draw call, setTeamColor and the batcher's aInst repaint them. Wall
// elements (stripe, panel) have their origin ON the wall, centred, and stick out toward local +Z; the placement t
// ({ x, y, z, ry, detail }) puts them on any wall: ry 0 = +Z (front), π = −Z, +π/2 = +X, −π/2 = −X. Top elements
// (roofMark, teamTrim) stand on y. Look by kit.team (style.teamPaint) and style.silhouette, never by faction names.

const TPU = UNIT_KIT.teamPaint;
const lodOf = (kind, t) => ({ detail: TPU.lod[kind], ...t });

/** Box offset inside the element's own frame (lx, ly, lz), then placed with t */
function teamBox(b, s, t, w, h, d, lx, ly, lz) {
  return b.add(new THREE.BoxGeometry(w, h, d).translate(lx, ly, lz), s, t);
}

/** Flat rhombus slab (extent w × d on the XZ plane, height h, standing on y = 0), local offset y0 */
function rhombusSlab(w, h, d, y0 = 0) {
  return new THREE.BoxGeometry(1, h, 1).rotateY(Math.PI / 4).scale(w / Math.SQRT2, 1, d / Math.SQRT2).translate(0, y0 + h / 2, 0);
}

/** Free intervals of [−length/2, length/2] around `avoid` ([from, to] pairs in local x) + UNIT_KIT.teamPaint.emblemClear */
function freeSpans(length, avoid) {
  let spans = [[-length / 2, length / 2]];
  if (avoid) {
    for (const [a, c] of avoid) {
      const lo = Math.min(a, c) - TPU.emblemClear;
      const hi = Math.max(a, c) + TPU.emblemClear;
      const next = [];
      for (const [s0, s1] of spans) {
        if (hi <= s0 || lo >= s1) { next.push([s0, s1]); continue; }
        if (lo > s0) next.push([s0, lo]);
        if (hi < s1) next.push([hi, s1]);
      }
      spans = next;
    }
  }
  return spans.filter(([s0, s1]) => s1 - s0 >= TPU.stripe.minSegment);
}

/**
 * Team stripe on a wall of `bone`: strip `length` (local x) × `height` (local y), kind by style.teamPaint.stripeKind –
 * 'band' (min(count, maxBands) team bands), 'slash' (team band over a darker team band), 'fine' (fineLines thin lines,
 * team / shade alternating). count defaults to style.teamPaint.stripes. avoid = [[x0, x1], …] local x intervals kept free
 * (+ emblemClear each side; e.g. [-half, half] from emblemPlate) – team paint never touches an emblem.
 */
export function teamStripe(ub, bone, length, height, t = {}, { avoid, count = ub.kit.team.stripes } = {}) {
  const S = ub.kit.S;
  const K = TPU.stripe;
  const kind = ub.kit.team.stripeKind;
  const b = ub.paint(bone);
  const tt = lodOf('stripe', t);
  let lines, thick, step, lift;
  if (kind === 'fine') {
    lines = K.fineLines; step = height / lines; thick = step * K.fineShare; lift = (step - thick) / 2;
  } else if (kind === 'slash') {
    lines = 2; thick = height / 2; step = thick; lift = 0;
  } else {
    lines = Math.max(1, Math.min(K.maxBands, count)); thick = height / (lines + (lines - 1) * K.gap); step = thick * (1 + K.gap); lift = 0;
  }
  for (const [s0, s1] of freeSpans(length, avoid)) {
    for (let i = 0; i < lines; i++) {
      const shade = kind === 'fine' ? i % 2 === 1 : kind === 'slash' && i === 0;
      teamBox(b, shade ? S.teamShade : S.teamPaint, tt, s1 - s0, thick, K.depth, (s0 + s1) / 2, -height / 2 + thick / 2 + i * step + lift, K.depth / 2);
    }
  }
  return ub;
}

/**
 * Team panel on a wall of `bone` (w × h, centred on the placement), kind by style.teamPaint.panelKind: 'inset' (metal
 * frame round a team core), 'plate' (team plate + darker lower strip), 'pearl' (oval), 'blade' (rhombus + darker core).
 */
export function teamPanel(ub, bone, w, h, t = {}) {
  const S = ub.kit.S;
  const K = TPU.panel;
  const b = ub.paint(bone);
  const tt = lodOf('panel', t);
  const d = K.depth;
  switch (ub.kit.team.panelKind) {
    case 'plate': {
      const lowH = h * K.lowerShare;
      teamBox(b, S.teamPaint, tt, w, h, d, 0, 0, d / 2);
      teamBox(b, S.teamShade, tt, w, lowH, d * K.lowerDepth, 0, -h / 2 + lowH / 2, (d * K.lowerDepth) / 2);
      break;
    }
    case 'pearl':
      b.add(new THREE.CylinderGeometry(1, 1, d, K.segments).rotateX(HALF_PI).scale(w / 2, h / 2, 1).translate(0, 0, d / 2), S.teamPaint, tt);
      break;
    case 'blade':
      // rhombusSlab stands on y = 0; rotateX(π/2) turns its thickness to local +Z (0..depth), its d extent to y
      b.add(rhombusSlab(w, d, h).rotateX(HALF_PI), S.teamPaint, tt);
      b.add(rhombusSlab(w * K.coreShare, d * K.coreDepth, h * K.coreShare).rotateX(HALF_PI), S.teamShade, tt);
      break;
    default: {
      const f = Math.min(K.frame, w / 4, h / 4);
      teamBox(b, S.frame, tt, w, h, d * K.frameDepth, 0, 0, (d * K.frameDepth) / 2);
      teamBox(b, S.teamPaint, tt, w - 2 * f, h - 2 * f, d, 0, 0, d / 2);
    }
  }
  return ub;
}

/**
 * Low team rim standing on y (bottom) of `bone`: round a w × d rectangle (4 bars, centre x z), or an open ring of radius
 * r / an ellipse w × d (`round: true`). Height h (default UNIT_KIT.teamPaint.trim.h) × style.teamPaint.trim (0 = none).
 */
export function teamTrim(ub, bone, { x = 0, y = 0, z = 0, w, d, r, h, round = false }, t = {}) {
  const k = ub.kit.team.trim;
  if (k <= 0) return ub;
  const K = TPU.trim;
  const th = (h ?? K.h) * k;
  const s = ub.kit.S.teamPaint;
  const b = ub.paint(bone);
  const tt = lodOf('trim', t);
  if (r !== undefined || round) {
    const sx = r !== undefined ? r : w / 2;
    const sz = r !== undefined ? r : d / 2;
    b.add(new THREE.CylinderGeometry(1, 1, th, K.segments, 1, true).scale(sx, 1, sz).translate(x, y + th / 2, z), s, tt);
    return ub;
  }
  for (const e of [1, -1]) {
    teamBox(b, s, tt, w + K.t, th, K.t, x, y + th / 2, z + e * d / 2);
    teamBox(b, s, tt, K.t, th, d - K.t, x + e * w / 2, y + th / 2, z);
  }
  return ub;
}

const ROOF_MARKS = { rounded: 'plate', angular: 'chevron', round: 'disc', faceted: 'rhombus' };   // by style.silhouette

/**
 * Team mark lying on a top surface of `bone` (y = the surface), footprint w × d (× style.teamPaint.roofMark, 0 = none),
 * turned by ry; shape by silhouette: rounded = plate with a darker stripe, angular = chevron pointing to +Z, round =
 * elliptic disc with a darker core, faceted = rhombus with a darker core. The most readable team surface from the RTS camera.
 */
export function roofMark(ub, bone, { x = 0, y = 0, z = 0, w, d, ry = 0 }, t = {}) {
  const k = ub.kit.team.roofMark;
  if (k <= 0) return ub;
  const S = ub.kit.S;
  const K = TPU.roofMark;
  const b = ub.paint(bone);
  const tt = lodOf('roofMark', { x, y, z, ry, ...t });
  const W = w * k;
  const D = d * k;
  const top = K.h;
  switch (ROOF_MARKS[ub.kit.style.silhouette] ?? ROOF_MARKS.rounded) {
    case 'chevron': {
      const armW = D * K.chevronArm;
      const len = Math.hypot(W / 2, D - armW);
      for (const s of [1, -1]) {
        const phi = Math.atan2(D - armW, s * (W / 2));   // arm from the apex (0, +D/2) back to (±W/2, −D/2)
        b.add(new THREE.BoxGeometry(len, top, armW).rotateY(phi).translate((s * W) / 4, top / 2, 0), S.teamPaint, tt);
      }
      break;
    }
    case 'disc':
      b.add(new THREE.CylinderGeometry(1, 1, top, K.segments).scale(W / 2, 1, D / 2).translate(0, top / 2, 0), S.teamPaint, tt);
      b.add(new THREE.CylinderGeometry(1, 1, top * K.coreLift, K.segments).scale((W / 2) * K.discCore, 1, (D / 2) * K.discCore).translate(0, (top * K.coreLift) / 2, 0), S.teamShade, tt);
      break;
    case 'rhombus':
      b.add(rhombusSlab(W, top, D), S.teamPaint, tt);
      b.add(rhombusSlab(W * K.rhombusCore, top * K.coreLift, D * K.rhombusCore), S.teamShade, tt);
      break;
    default:
      teamBox(b, S.teamPaint, tt, W, top, D, 0, top / 2, 0);
      teamBox(b, S.teamShade, tt, W * K.stripeShare, top * K.coreLift, D * K.stripeD, 0, (top * K.coreLift) / 2, 0);
  }
  return ub;
}

const _pn = new THREE.Vector3();
const _pu = new THREE.Vector3();
const _po = new THREE.Vector3();
const _pm = new THREE.Matrix4();

/**
 * Faction emblem on `bone`: the sign decal (faction colour on its neutral plate, PROC_EMBLEM) at `position` on a wall
 * with `normal`, side `size`; with `backing` (flat walls) a neutral slab (kit.S[UNIT_KIT.emblemPlate.surface], never
 * team-masked) slightly larger than the decal lifts it off the wall, so no team paint can show through or overlap.
 * Leave backing off on curved surfaces (domes). Returns the half side of the plate → teamStripe avoid [−half, half].
 */
export function emblemPlate(ub, bone, { position, normal, size, up, backing = true }) {
  const E = UNIT_KIT.emblemPlate;
  const quad = size * PROC_EMBLEM.plate.grow;
  if (!backing) {
    ub.emblem(bone, [{ position, normal, size, up }]);
    return quad / 2;
  }
  const side = quad * E.grow;
  _pn.fromArray(normal).normalize();
  if (up) _pu.fromArray(up); else _pu.set(0, Math.abs(_pn.y) > 0.99 ? 0 : 1, Math.abs(_pn.y) > 0.99 ? -1 : 0);   // as emblemDecalGeometry
  _pm.lookAt(_pn, _po.set(0, 0, 0), _pu).setPosition(position[0], position[1], position[2]);   // local +Z → normal
  const slab = new THREE.BoxGeometry(side, side, E.depth).translate(0, 0, E.depth / 2).applyMatrix4(_pm);
  ub.paint(bone).add(slab, ub.kit.S[E.surface], { detail: E.lod });
  ub.emblem(bone, [{
    position: [position[0] + _pn.x * E.depth, position[1] + _pn.y * E.depth, position[2] + _pn.z * E.depth], normal, size, up,
  }]);
  return side / 2;
}

// ---------------------------------------------------------------- hull

/**
 * Hull body on `bone` (bottom at y = o.y), length L, width W, height H. Shape by silhouette. Adds headlights (paint +
 * glow) and a rear marking. team: true = team layout (UNIT_MODULES.team.hull): rounded side stripes, angular side
 * armour plates, round ellipsoid cap, faceted strakes + fins + tail cone in the team colour.
 * Returns { top (y of the deck), frontZ, rearZ, halfW }.
 */
export function hull(ub, { bone = 'hull', y = 0, L, W, H, team = false }) {
  const kit = ub.kit;
  const S = kit.S;
  const b = ub.paint(bone);
  const sil = kit.style.silhouette;
  const TH = M.team.hull;
  let top = y + H;
  if (sil === 'angular') {
    const A = M.hull.angular;
    const lowH = H * A.lowerShare;
    b.taperedBox(W, W * A.topW, lowH, L, S.hull, { y }, L * A.topD);
    b.taperedBox(W * A.deckW, W * A.deckTopW, H - lowH, L * A.deckL, S.hullDark, { y: y + lowH, z: L * A.deckZ }, L * A.deckTopL);
    for (const side of [1, -1]) {
      const px = side * (W / 2 + A.plateT / 2);
      b.box(A.plateT, H * A.plateH, L * A.plateL, team ? S.teamPaint : S.lower, { x: px, y: y + (H * A.plateH) / 2, detail: team ? TPU.lod.panel : undefined });
      for (let z = -L * A.plateL / 2 + A.rivetStep / 2; z < L * A.plateL / 2; z += A.rivetStep) {
        b.cylinder(A.rivetR, A.rivetR, A.rivetR * 2, A.rivetSeg, S.trim, { rz: HALF_PI, x: px + side * A.plateT / 2, y: y + H * A.plateH * A.rivetY, z, detail: 0 });
      }
      b.cylinder(0, A.ramR, A.ramL, A.ramSeg, S.frame, { rx: HALF_PI, x: side * W * A.ramX, y: y + lowH * A.ramY, z: L / 2 + A.ramL / 2 });
    }
  } else if (sil === 'round') {
    const R = M.hull.round;
    b.sphere(1, R.segW, R.segH, S.hull, { sx: W / 2, sy: H * R.bodyH, sz: L / 2, y: y + H * R.bodyY });
    b.sphere(1, R.domeSegW, R.domeSegH, S.hullDark, { sx: W * R.domeW, sy: H * R.domeH, sz: L * R.domeL, y: y + H * R.domeY, z: L * R.domeZ });
    b.torus(1, R.ringT, M.ring.radial, M.ring.tubular, TAU, S.neon, { rx: HALF_PI, sx: W / 2 + R.ringT, sy: L / 2 + R.ringT, y: y + H * R.bodyY });
    if (team) {
      const C = TH.round;
      b.add(new THREE.SphereGeometry(1, R.segW, C.capSegH, 0, TAU, 0, C.cap), S.teamPaint, {
        sx: (W / 2) * C.capLift, sy: H * R.bodyH * C.capLift, sz: (L / 2) * C.capLift, y: y + H * R.bodyY, detail: TPU.lod.roofMark,
      });
    }
    top = y + H * (R.bodyY + R.bodyH) * R.topShare;
  } else if (sil === 'faceted') {
    const F = M.hull.faceted;
    const cy = y + H * F.bodyY;
    const bodyL = L * F.bodyL;
    prism(b, 4, W, H * F.bodyH, bodyL, S.hull, { y: cy, z: L * F.bodyZ });
    const frontZ = L * F.bodyZ + bodyL / 2;
    noseCone(b, 4, W, H * F.bodyH, L * F.noseL, S.hull, { y: cy, z: frontZ + (L * F.noseL) / 2 });
    const rearL = L * F.noseL * F.rearL;
    noseCone(b, 4, W * F.rearShare, H * F.bodyH * F.rearShare, rearL, team ? S.teamShade : S.hullDark, { y: cy, z: L * F.bodyZ - bodyL / 2 - rearL / 2, rx: -HALF_PI });
    for (const side of [1, -1]) neonLine(b, kit, bodyL * F.neonL, { x: side * (W / 2 + M.neon.out), y: cy, z: L * F.bodyZ });
    // diamond section: at |x| = finX·W the top surface is (1 − 2·finX) of the half height above the centre
    const finBase = cy + ((H * F.bodyH) / 2) * (1 - 2 * F.finX) - F.finSink;
    for (const side of [1, -1]) {
      b.box(F.finT, H * F.finH, L * F.finL, team ? S.teamPaint : S.hullDark, { x: side * W * F.finX, y: finBase + (H * F.finH) / 2, z: L * F.bodyZ - bodyL * F.finZ });
    }
    if (team) {
      // strakes on the two upper faces: face from (±W/2, cy) to (0, cy + hb/2), outward normal (±sin β, cos β)
      const C = TH.faceted;
      const hb = H * F.bodyH;
      const beta = Math.atan2(hb / 2, W / 2);
      const faceW = Math.hypot(W / 2, hb / 2);
      const d = TPU.panel.depth;
      for (const side of [1, -1]) {
        b.box(faceW * C.strakeShare, d, bodyL * C.strakeL, S.teamPaint, {
          rz: -side * beta, x: side * (W / 4 + Math.sin(beta) * d / 2), y: cy + hb / 4 + Math.cos(beta) * d / 2, z: L * F.bodyZ, detail: TPU.lod.panel,
        });
      }
    }
    top = cy + (H * F.bodyH) / 2;
  } else {
    const R = M.hull.rounded;
    const lowH = H * R.lowerShare;
    unitBox(b, kit, W, lowH, L, S.hull, { y: y + lowH / 2 });
    const deckL = L * R.deckL;
    unitBox(b, kit, W * R.deckW, H - lowH, deckL, S.hull, { y: y + lowH + (H - lowH) / 2, z: L * R.deckZ });
    b.wedge(L * R.glacisD, H - lowH, W * R.deckW, S.hull, { ry: HALF_PI, y: y + lowH, z: L * R.deckZ + deckL / 2 + (L * R.glacisD) / 2 });
    for (const side of [1, -1]) neonLine(b, kit, L * R.neonL, { x: side * (W / 2 + M.neon.out), y: y + H * R.neonY });
    if (team) {
      const C = TH.rounded;
      for (const side of [1, -1]) {
        // on the deck sides (the lower box sides are inside the track skirts)
        teamStripe(ub, bone, deckL * C.stripeL, (H - lowH) * C.stripeH, { x: (side * W * R.deckW) / 2, y: y + lowH + (H - lowH) * C.stripeY, z: L * R.deckZ, ry: side * HALF_PI }, { count: C.stripes });
      }
    }
  }
  // headlights
  const Lt = M.hull.lights;
  const g = ub.glow(bone);
  const lampColor = kit.style.lights === 'lamp' ? kit.style.palette.lamp : kit.style.palette.window;
  for (const side of [1, -1]) {
    const lx = side * W * Lt.xShare;
    const ly = y + H * Lt.yShare;
    const lz = frontAt(sil, L) + Lt.d / 2;
    b.cylinder(Lt.r, Lt.r, Lt.d, Lt.seg, kit.style.lights === 'lamp' ? S.lamp : S.lens, { rx: HALF_PI, x: lx, y: ly, z: lz, detail: 0 });
    g.point([lx, ly, lz + Lt.d], Lt.halo, lampColor, { intensity: Lt.glow });
  }
  marking(b, kit, W * M.hull.markLen, M.hull.markH, { z: -L / 2 - M.hull.markOut, y: y + H * M.hull.markY, ry: Math.PI });
  return { top, frontZ: L / 2, rearZ: -L / 2, halfW: W / 2 };
}

// front face z where lights sit (the round / faceted noses are pointed: lights a bit back)
const frontAt = (sil, L) => L * (Object.hasOwn(M.hull.front, sil) ? M.hull.front[sil] : M.hull.front.default);

// ---------------------------------------------------------------- chassis: tracks

/**
 * Two tracks (gauge = centre distance, width tw, height th, length L) on `parent` with a belly between them, moving
 * cleats (upper / lower runs) and front / rear sprockets as bones; skirts by silhouette. Sets meta.tracks and the hull
 * lean (meta.hull is set by the model: { bone: 'hull' }). team: true = the big skirt parts (rounded skirts, angular
 * top plates, round pods, faceted blades) in the team colour.
 */
export function tracks(ub, { parent = 'root', L, gauge, tw, th, team = false }) {
  const kit = ub.kit;
  const S = kit.S;
  const T = M.track;
  const b = ub.paint(parent);
  const r = th / 2;
  const skin = team ? S.teamPaint : null;   // team layout: replaces the skirt surface below
  const tDetail = team ? TPU.lod.panel : undefined;
  const sil = kit.style.silhouette;
  b.box(gauge - tw, th * T.bellyShare, L * T.bellyL, S.hullDark, { y: th * T.bellyY });
  for (const side of [1, -1]) {
    const sideName = side > 0 ? 'L' : 'R';
    const x = side * gauge / 2;
    b.box(tw, th, L - th, S.rubber, { x, y: r });
    for (const end of [1, -1]) b.cylinder(r, r, tw, M.seg, S.rubber, { rz: HALF_PI, x, y: r, z: end * (L / 2 - r) });
    // sprockets (outer face hubs with spokes – their spin is visible)
    const sprockets = [];
    for (const end of [1, -1]) {
      const name = ub.bone(`sprocket${sideName}${end > 0 ? 'F' : 'R'}`, parent, [x + side * (tw / 2 + T.hubD / 2), r, end * (L / 2 - r)]);
      const sb = ub.paint(name);
      const rs = r * T.hubShare;
      sb.cylinder(rs, rs, T.hubD, M.seg, S.frame, { rz: HALF_PI });
      for (let k = 0; k < T.spokes; k++) sb.box(T.hubD * T.spokeD, T.spokeT, rs * T.spokeL, S.trim, { rx: (k * Math.PI) / T.spokes, detail: 0 });
      sprockets.push(name);
    }
    // cleats: upper run on top of the track, lower run under it; the drivers shift them by up to one pitch
    const count = Math.max(2, Math.floor((L - th) / T.cleatPitch));
    const span = (count - 1) * T.cleatPitch;
    const top = ub.bone(`cleatTop${sideName}`, parent, [x, th, 0]);
    const bottom = ub.bone(`cleatBottom${sideName}`, parent, [x, 0, 0]);
    for (let i = 0; i < count; i++) {   // upper run shifts +[0, pitch), lower run −[0, pitch): offset so both stay centred
      const z = -span / 2 + i * T.cleatPitch;
      ub.paint(top).box(tw * T.cleatOver, T.cleatH, T.cleatD, S.dark, { z: z - T.cleatPitch / 2, detail: 1 });
      ub.paint(bottom).box(tw * T.cleatOver, T.cleatH, T.cleatD, S.dark, { z: z + T.cleatPitch / 2, detail: 1 });
    }
    ub.meta.tracks.push({ side, halfGauge: gauge / 2, pitch: T.cleatPitch, radius: r, top, bottom, sprockets });
    // skirt by silhouette
    const sx = side * (gauge / 2 + tw / 2);
    if (sil === 'angular') {
      b.box(T.plateT, th * T.plateH, L * T.plateL, S.lower, { x: sx + side * T.plateT / 2, y: th * T.plateY });
      b.box(tw + T.skirtOver * 2, T.plateT, L * T.topPlateL, skin ?? S.hullDark, { x, y: th + T.plateT / 2 + T.cleatH, detail: tDetail });
      for (let z = -L * T.rivetSpan + T.rivetStep / 2; z < L * T.rivetSpan; z += T.rivetStep) {
        b.cylinder(T.rivetR, T.rivetR, T.rivetR * 2, T.rivetSeg, S.trim, { rz: HALF_PI, x: sx + side * T.plateT, y: th * T.rivetY, z, detail: 0 });
      }
    } else if (sil === 'round') {
      b.sphere(1, T.podSeg[0], T.podSeg[1], skin ?? S.hull, { sx: tw / 2 + T.skirtOver, sy: th * T.podH, sz: L / 2 - th * T.podInset, x, y: th * T.podY, detail: tDetail });
      neonLine(b, kit, L * T.podNeonL, { x: sx + side * (T.skirtOver + M.neon.out), y: th * T.podY });
    } else if (sil === 'faceted') {
      b.box(T.bladeT, th * T.bladeH, L * T.bladeL, skin ?? S.hullDark, { x: sx + side * T.bladeT, y: th * T.bladeY, detail: tDetail });
      neonLine(b, kit, L * T.bladeNeonL, { x: sx + side * (T.bladeT * 1.5 + M.neon.out), y: th * T.bladeY });
    } else {
      const skirtY = th + T.cleatH + T.skirtH / 2;   // above the upper cleat run
      unitBox(b, kit, tw + T.skirtOver, T.skirtH, L - th * 2, skin ?? S.hull, { x, y: skirtY, detail: tDetail });
      marking(b, kit, L * T.markL, T.skirtH * T.markH, { x: sx + side * (T.skirtOver / 2 + T.markOut), y: skirtY, z: L * T.markZ, ry: side * HALF_PI });
    }
  }
}

// ---------------------------------------------------------------- chassis: wheels

/**
 * Wheels at axle positions `axles` (z values), the first `steer` axles steer. Each wheel = spin bone (and a steering
 * bone above it); belly box between them. Sets meta.wheels.
 */
export function wheels(ub, { parent = 'root', L, gauge, r, ww, axles, steer = 1 }) {
  const kit = ub.kit;
  const S = kit.S;
  const Wh = M.wheel;
  ub.paint(parent).box(gauge - ww - Wh.bellyGap, r * Wh.bellyShare, L, S.hullDark, { y: r });
  axles.forEach((z, i) => {
    for (const side of [1, -1]) {
      const sideName = side > 0 ? 'L' : 'R';
      const pos = [side * gauge / 2, r, z];
      let steerBone = null;
      let spin;
      if (i < steer) {
        steerBone = ub.bone(`steer${i}${sideName}`, parent, pos);
        spin = ub.bone(`wheel${i}${sideName}`, steerBone);
      } else {
        spin = ub.bone(`wheel${i}${sideName}`, parent, pos);
      }
      const b = ub.paint(spin);
      b.cylinder(r, r, ww, M.seg + Wh.tyreSegExtra, S.rubber, { rz: HALF_PI });
      b.cylinder(r * Wh.hubShare, r * Wh.hubShare, ww * Wh.hubOver, M.seg, S.frame, { rz: HALF_PI });
      for (let k = 0; k < Wh.spokes; k++) b.box(ww * Wh.hubOver * Wh.spokeOver, Wh.spokeT, r, S.trim, { rx: (k * Math.PI) / Wh.spokes, detail: 0 });
      ub.meta.wheels.push({ spin, steer: steerBone, radius: r, side, halfGauge: gauge / 2, steerSign: 1 });
    }
  });
}

// ---------------------------------------------------------------- chassis: hover

/**
 * Hover skirt on `bone` (the hull bone, floating) with glowing pads (glow on a child bone 'hoverGlow', pulsing):
 * a soft glow under each pad, not a flame. pads = [[x, z], …]. Sets meta.hoverGlow and the hull bob / bank.
 * Returns the skirt top y (in the bone's space).
 */
export function hover(ub, { bone = 'hull', L, W, skirtH, pads }) {
  const kit = ub.kit;
  const S = kit.S;
  const Hv = M.hover;
  const b = ub.paint(bone);
  const sil = kit.style.silhouette;
  if (sil === 'angular') b.taperedBox(W * Hv.taper, W, skirtH, L, S.hullDark, {}, L);
  else if (sil === 'round') b.cylinder(1, Hv.taper, skirtH, Hv.skirtSeg, S.hullDark, { sx: W / 2, sz: L / 2, y: skirtH / 2 });
  else if (sil === 'faceted') b.add(flat(new THREE.CylinderGeometry(1, Hv.taper, skirtH, 4)), S.hullDark, { sx: W / 2, sz: L / 2, y: skirtH / 2 });
  else unitBox(b, kit, W, skirtH, L, S.hullDark, { y: skirtH / 2 });
  const glowBone = ub.bone('hoverGlow', bone);
  const g = ub.glow(glowBone);
  const color = ub.style.hoverGlow;
  for (const [x, z] of pads) {
    b.torus(Hv.padR, Hv.padRing, M.ring.radial, Hv.padTubular, TAU, S.frame, { rx: HALF_PI, x, y: Hv.ringY, z });
    b.add(new THREE.CircleGeometry(Hv.padR * Hv.holeShare, M.seg), S.hole, { rx: HALF_PI, x, y: Hv.holeY, z });   // faces down
    g.disc(Hv.padR, M.seg, color, { x, y: -Hv.discY, z, intensity: Hv.discGlow });
    g.cylinder(Hv.padR, Hv.padR * Hv.coneSpread, Hv.coneLen, M.seg, color, { x, y: -Hv.coneLen / 2 - Hv.discY, z, intensity: Hv.coneGlow });
  }
  ub.meta.hoverGlow = glowBone;
  ub.meta.hull = { bone, bank: true, bobAmp: Hv.bobAmp, bobFreq: Hv.bobFreq };
  return skirtH;
}

// ---------------------------------------------------------------- turret

/**
 * Turret on `parent` at [0, y, z] (bone 'turret', its own far LOD group, yaw = rotation.y). Shape by silhouette, team
 * band, emblem decals. team: true = team layout (UNIT_MODULES.team.turret): roof mark / cap in the team colour, painted
 * band / bins / rear plate, emblems on neutral plates kept clear of the team paint. Returns { top, front, mid } in turret space.
 */
export function turret(ub, { parent = 'hull', y, z = 0, w, d, h, team = false }) {
  const kit = ub.kit;
  const S = kit.S;
  const T = M.turret;
  const TT = M.team.turret;
  const bone = ub.bone('turret', parent, [0, y, z], { far: true });
  ub.meta.turret = bone;
  const b = ub.paint(bone);
  const sil = kit.style.silhouette;
  let emblems;
  let hatchY = h * T.hatchTop;
  if (sil === 'angular') {
    const A = T.angular;
    b.taperedBox(w, w * A.topW, h, d, S.hull, {}, d * A.topD);
    for (const side of [1, -1]) {
      b.box(w * T.binShare, h * A.binH, d * A.binD, team ? S.teamPaint : S.hullDark, { x: side * (w / 2 - w * T.binShare * A.binInset), y: h * A.binY, z: d * A.binZ, detail: team ? TPU.lod.panel : undefined });
    }
    b.box(w * A.plateW, h * A.plateH, A.plateD, team ? S.teamPaint : S.team, { y: h * A.plateY, z: -d / 2 - A.plateOut });
    if (team) {
      // roof (top of the tapered box): emblem on a plate at the back, +x side (the hatch is at -x), chevron in front
      const C = TT.angular;
      const roofW = w * A.topW;
      const roofD = d * A.topD;
      emblemPlate(ub, bone, { position: [roofW * C.emblemX, h, roofD * C.emblemZ], normal: [0, 1, 0], up: [0, 0, 1], size: h * C.emblemShare });
      roofMark(ub, bone, { y: h, z: roofD * C.chevronZ, w: roofW * C.chevronW, d: roofD * C.chevronD });
      emblems = [];
    } else {
      emblems = [{ position: [0, h + T.emblemOut, d * A.emblemZ], normal: [0, 1, 0], up: [0, 0, 1], size: h * A.emblemSize }];
    }
  } else if (sil === 'round') {
    const R = T.round;
    b.add(new THREE.SphereGeometry(1, T.domeSegW, T.domeSegH, 0, TAU, 0, HALF_PI), S.hull, { sx: w / 2, sy: h, sz: d / 2 });
    b.torus(1, T.ringT, M.ring.radial, M.ring.tubular, TAU, S.neon, { rx: HALF_PI, sx: w / 2 + T.ringT * R.ringInset, sy: d / 2 + T.ringT * R.ringInset, y: T.ringT });
    let at = R.emblemAt;
    let share = T.emblemShare;
    if (team) {
      // team cap over the top of the dome instead of the team ring (the ring would run through the side emblems)
      const C = TT.round;
      b.add(new THREE.SphereGeometry(1, T.domeSegW, C.capSegH, 0, TAU, 0, C.cap), S.teamPaint, {
        sx: (w / 2) * C.capLift, sy: h * C.capLift, sz: (d / 2) * C.capLift, detail: TPU.lod.roofMark,
      });
      at = C.emblemAt;
      share = C.emblemShare;
    } else {
      const k = Math.sqrt(1 - T.ringY * T.ringY);
      b.torus(1, T.ringT, M.ring.radial, M.ring.tubular, TAU, S.team, { rx: HALF_PI, sx: (w / 2) * k + T.ringT * R.teamInset, sy: (d / 2) * k + T.ringT * R.teamInset, y: h * T.ringY });
    }
    const sideX = (w / 2) * Math.sqrt(1 - at * at);
    emblems = [1, -1].map((s) => ({ position: [s * sideX, h * at, d * T.emblemZ], normal: [s, R.emblemTilt, 0], size: h * share }));
    hatchY = h * T.domeHatch;
  } else if (sil === 'faceted') {
    const F = T.faceted;
    b.add(flat(new THREE.CylinderGeometry(T.faceTop, 1, 1, 4)), S.hull, { sx: w / 2, sy: h, sz: d / 2, y: h / 2 });
    for (const side of [1, -1]) b.box(F.finT, h * F.finH, d * F.finD, S.hullDark, { x: side * w * F.finX, y: h * F.finY, z: d * F.finZ });
    if (team) {
      // rhombus over the top diamond; emblems on plates on the two front flank faces (planes through the +x / +z
      // edges: x/a + z/b + (1 − k)·y/h = 1 → normal (1/a, (1 − k)/h, 1/b))
      const C = TT.faceted;
      const a = w / 2;
      const c = d / 2;
      const k = T.faceTop;
      roofMark(ub, bone, { y: h, w: 2 * a * k * C.roof, d: 2 * c * k * C.roof });
      const r = 1 - (1 - k) * C.emblemAt;
      for (const s of [1, -1]) {
        emblemPlate(ub, bone, { position: [(s * r * a) / 2, h * C.emblemAt, (r * c) / 2], normal: [s / a, (1 - k) / h, 1 / c], size: h * C.emblemShare });
      }
      emblems = [];
    } else {
      b.box(w * F.bandW, F.bandH, d * F.bandD, S.team, { y: h + F.bandH / 2, z: d * F.bandZ });
      emblems = [{ position: [0, h + F.emblemOut, d * F.emblemZ], normal: [0, 1, 0], up: [0, 0, 1], size: h * F.emblemSize }];
    }
  } else {
    unitBox(b, kit, w, h, d, S.hull, { y: h / 2 });
    b.box(w * T.bandOver, h * T.bandShare, d * T.bandOver, team ? S.teamPaint : S.team, { y: h * T.bandY, detail: team ? TPU.lod.panel : undefined });
    if (team) {
      const C = TT.rounded;
      roofMark(ub, bone, { y: h, z: d * C.roofZ, w: w * C.roofW, d: d * C.roofD });
      for (const s of [1, -1]) {
        emblemPlate(ub, bone, { position: [(s * w) / 2, h * C.emblemY, d * T.emblemZ], normal: [s, 0, 0], size: h * C.emblemSide });
      }
      emblems = [];
    } else {
      emblems = [1, -1].map((s) => ({ position: [s * (w / 2 * T.bandOver + T.emblemOut), h * T.emblemY, d * T.emblemZ], normal: [s, 0, 0], size: h * T.emblemSide }));
    }
  }
  // hatch + antenna (all shapes)
  const hr = w * T.hatchShare;
  b.cylinder(hr, hr, T.hatchH, M.seg, S.hullDark, { x: w * T.hatchX, y: hatchY + T.hatchH / 2, z: d * T.hatchZ });
  b.cylinder(T.antennaR, T.antennaR, T.antennaH, T.antennaSeg, S.frame, { x: w * T.antennaX, y: h + T.antennaH / 2, z: d * T.antennaZ, detail: 0 });
  ub.emblem(bone, emblems);
  ub.socket('turret', bone, [0, h, 0]);
  return { bone, top: h, front: d / 2, mid: h * T.midShare };
}

// ---------------------------------------------------------------- weapons

// Muzzle flash on the flash bone: gun flash (crossed petals + core, UNIT_KIT.flash colours) or energy flash (beam
// forward + ball) in `color`
function flashGlow(g, energy, size, color) {
  const F = M.flash;
  if (energy) {
    const len = size * F.beamLen;
    g.flame(size * F.beamShare, size * F.beamShare * F.beamTip, len, F.beamSeg, color, { ry: Math.PI, intensity: F.beamGlow }, false);   // −Z flame turned forward
    g.sphere(size * F.ball, F.coreSeg[0], F.coreSeg[1], color, {});
    return;
  }
  for (let k = 0; k < F.petals; k++) {
    g.box(F.petalT, size, size * F.petalLen, UNIT_KIT.flash.color, { rz: (k * Math.PI) / F.petals, z: (size * F.petalLen) / 2 });
  }
  g.sphere(size * F.coreShare, F.coreSeg[0], F.coreSeg[1], UNIT_KIT.flash.core, {});
}

/**
 * Weapon on `parent` (usually the turret) at `position` (trunnion): bone `barrel<sfx>` (pitch), `recoil<sfx>`, flash
 * bone, sockets `muzzle<sfx>` (and `launch_<i>` for missiles). kind = cannon | missile | gun | laser | plasma | lightning.
 * sfx = '' for the main weapon, '_2', '_3' … for more (socket muzzle_2 …). Registers meta and fire(socket) effects.
 */
export function weapon(ub, kind, { parent = 'turret', position = [0, 0, 0], length = 2.5, caliber = 0.13, pitch = [-0.1, 0.35], sfx = '', count, rings } = {}) {
  const kit = ub.kit;
  const S = kit.S;
  const u = ub.style;
  const sil = kit.style.silhouette;
  const barrel = ub.bone(`barrel${sfx}`, parent, position);
  if (!ub.meta.barrel) { ub.meta.barrel = barrel; ub.meta.pitch = pitch; }
  const recoil = ub.bone(`recoil${sfx}`, barrel);
  const bb = ub.paint(barrel);
  const rb = ub.paint(recoil);
  const muzzle = `muzzle${sfx}`;
  const meta = ub.meta;
  const fire = { flashes: [], recoils: [], spinners: [], lenses: [], arcs: [] };
  let tip = length;
  let recoilDist = 0;
  let energy = false;
  let flashSize = caliber * M.flash.size;
  let flashColor = u.weaponGlow;
  const c = caliber * (sil === 'angular' ? M.barrel.angularScale : 1);

  switch (kind) {
    case 'missile': {
      const Mi = M.missile;
      const n = count ?? Mi.count;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const pw = cols * (Mi.tubeR * 2 + Mi.tubeGap) + Mi.tubeGap;
      const ph = rows * (Mi.tubeR * 2 + Mi.tubeGap) + Mi.tubeGap;
      const front = Mi.depth * Mi.frontShare;
      unitBox(bb, kit, pw, ph, Mi.depth, S.hullDark, { z: front - Mi.depth / 2 });
      bb.box(pw * M.turret.bandOver, ph * Mi.bandH, Mi.depth * Mi.bandD, S.team, { y: ph * Mi.bandY, z: front - Mi.depth / 2 });
      for (let i = 0; i < n; i++) {
        const tx = -pw / 2 + Mi.tubeGap + Mi.tubeR + (i % cols) * (Mi.tubeR * 2 + Mi.tubeGap);
        const ty = ph / 2 - Mi.tubeGap - Mi.tubeR - Math.floor(i / cols) * (Mi.tubeR * 2 + Mi.tubeGap);
        bb.cylinder(Mi.tubeR, Mi.tubeR, Mi.holeD, M.seg, S.hole, { rx: HALF_PI, x: tx, y: ty, z: front + Mi.holeD / 2 });
        bb.torus(Mi.tubeR, Mi.rim, Mi.rimRadial, M.seg, TAU, S.frame, { x: tx, y: ty, z: front + Mi.rim, detail: 0 });
        ub.socket(`launch${sfx}_${i + 1}`, barrel, [tx, ty, front + Mi.launchOut]);
      }
      tip = front;
      flashSize = Mi.tubeR * M.flash.size;
      flashColor = null;
      break;
    }
    case 'gun': {
      const G = M.gun;
      const front = G.receiver[2] - G.receiverBack;
      bb.box(G.receiver[0], G.receiver[1], G.receiver[2], S.hullDark, { z: G.receiver[2] / 2 - G.receiverBack });
      bb.box(G.ammo[0], G.ammo[1], G.ammo[2], S.accent, { x: G.receiver[0] / 2 + G.ammo[0] / 2, y: G.ammoY, z: G.ammoZ });
      const spin = ub.bone(`spin${sfx}`, recoil, [0, 0, front]);
      const sb = ub.paint(spin);
      for (let k = 0; k < G.barrels; k++) {
        const a = (k / G.barrels) * TAU;
        sb.cylinder(G.barrelR, G.barrelR, length, G.barrelSeg, S.frame, { rx: HALF_PI, x: Math.cos(a) * G.ring, y: Math.sin(a) * G.ring, z: length / 2 });
      }
      sb.torus(G.ring + G.barrelR, G.barrelR * G.clampT, G.clampSeg[0], G.clampSeg[1], TAU, S.frame, { z: length * G.clampZ, detail: 0 });
      fire.spinners.push(meta.spinners.length);
      meta.spinners.push({ bone: spin, axis: 'z', speed: G.spin });
      tip = front + length;
      recoilDist = G.recoil;
      flashSize = G.ring * M.flash.size * G.flashScale;
      flashColor = null;
      break;
    }
    case 'laser': {
      const La = M.laser;
      bb.box(c * La.mantlet[0], c * La.mantlet[1], c * La.mantlet[2], S.hullDark, {});
      rb.cylinder(c * La.taper, c, length, M.seg, S.frame, { rx: HALF_PI, z: length / 2 });
      const ringCount = rings ?? La.rings;
      for (let k = 1; k <= ringCount; k++) rb.torus(c * La.ringR, La.ringT, M.ring.radial, M.seg, TAU, S.trim, { z: (length * k) / (ringCount + 1), detail: 0 });
      rb.cylinder(La.lensR, La.lensR, La.lensD, M.seg, S.lens, { rx: HALF_PI, z: length + La.lensD / 2 });
      const lens = ub.bone(`lens${sfx}`, recoil, [0, 0, length + La.lensD]);
      const lensGlow = ub.glow(lens).point([0, 0, 0], La.lensR * La.halo, u.weaponGlow, { intensity: La.haloGlow });
      if (ringCount > 0) lensGlow.torus(La.lensR * La.haloRing, La.haloRingT, M.ring.radial, M.seg, u.weaponGlow, {});
      fire.lenses.push(meta.lenses.length);
      meta.lenses.push({ bone: lens });
      tip = length + La.lensD;
      recoilDist = La.recoil;
      energy = true;
      break;
    }
    case 'plasma': {
      const P = M.plasma;
      const tubeL = length * P.tubeLen;
      bb.box(c * P.mantlet[0], c * P.mantlet[1], c * P.mantlet[2], S.hullDark, {});
      rb.cylinder(c * P.tubeTop, c, tubeL, M.seg, S.hullDark, { rx: HALF_PI, z: tubeL / 2 });
      const lens = ub.bone(`lens${sfx}`, recoil, [0, 0, tubeL + c * P.core]);
      for (let k = 1; k <= P.coils; k++) rb.torus(c * P.coilR, P.coilT, M.ring.radial, M.seg, TAU, S.trim, { z: (tubeL * k) / (P.coils + 1) });
      rb.sphere(c * P.core, P.coreSeg[0], P.coreSeg[1], S.plasma, { z: tubeL + c * P.core * P.coreZ });
      ub.glow(lens).sphere(c * P.halo, P.haloSeg[0], P.haloSeg[1], u.plasma, { intensity: P.haloGlow })
        .point([0, 0, 0], c * P.core * P.pointShare, u.weaponGlow, {});
      fire.lenses.push(meta.lenses.length);
      meta.lenses.push({ bone: lens });
      tip = tubeL + c * P.core * 2;
      recoilDist = P.recoil;
      energy = true;
      flashColor = u.plasma;
      flashSize = c * P.halo;
      break;
    }
    case 'lightning': {
      const Li = M.lightning;
      const rodL = length * Li.rodLen;
      bb.box(c * Li.mantlet[0], c * Li.mantlet[1], c * Li.mantlet[2], S.hullDark, {});
      rb.cylinder(c * Li.rodTop, c * Li.rodBottom, rodL, M.seg, S.frame, { rx: HALF_PI, z: rodL / 2 });
      rb.torus(c * Li.ringR, Li.prongR * Li.ringT, M.ring.radial, M.seg, TAU, S.neon, { z: length * Li.ringZ });
      const tips = [];
      const spread = c * Li.spread;
      for (let k = 0; k < Li.prongs; k++) {
        const a = (k / Li.prongs) * TAU + HALF_PI;
        const px = Math.cos(a) * spread;
        const py = Math.sin(a) * spread;
        rb.cylinder(0, Li.prongR, Li.prongLen, Li.prongSeg, S.trim, { rx: HALF_PI, x: px, y: py, z: rodL + Li.prongLen / 2 });
        tips.push([px, py, rodL + Li.prongLen * Li.tipAt]);
      }
      // arcs between the prong tips on their own bone (flicker = scale on / off around the recoil origin)
      const arc = ub.bone(`arc${sfx}`, recoil);
      const ag = ub.glow(arc);
      const rng = makeRng(Li.seed);
      for (let k = 0; k < tips.length; k++) {
        const a = tips[k];
        const e = tips[(k + 1) % tips.length];
        let prev = a;
        for (let s = 1; s <= Li.arcSegments; s++) {
          const f = s / Li.arcSegments;
          const j = s === Li.arcSegments ? 0 : Li.arcJitter;
          const p = [a[0] + (e[0] - a[0]) * f + (rng() - 0.5) * 2 * j, a[1] + (e[1] - a[1]) * f + (rng() - 0.5) * 2 * j, a[2] + (rng() - 0.5) * j];
          ag.segment(prev, p, Li.arcT, u.weaponGlow);
          prev = p;
        }
      }
      for (const p of tips) ub.glow(recoil).point(p, Li.ball, u.weaponGlow, {});   // steady tip glow (not scaled)
      fire.arcs.push(meta.arcs.length);
      meta.arcs.push({ bone: arc });
      tip = rodL + Li.prongLen;
      recoilDist = Li.recoil;
      energy = true;
      break;
    }
    default: {   // cannon
      const B = M.barrel;
      unitBox(bb, kit, c * B.mantletW, c * B.mantletH, c * B.mantletD, S.hullDark, {});
      rb.cylinder(c, c, length, M.seg, S.frame, { rx: HALF_PI, z: length / 2 });
      rb.cylinder(c * B.fumeShare, c * B.fumeShare, length * B.fumeLen, M.seg, S.frame, { rx: HALF_PI, z: length * B.fumeZ, detail: 1 });
      const bz = length - (length * B.brakeLen) / 2;
      if (sil === 'angular') rb.box(c * B.brakeBox[0], c * B.brakeBox[1], length * B.brakeLen, S.hullDark, { z: bz });
      else if (sil === 'round') rb.sphere(c * B.brakeShare, B.brakeSeg[0], B.brakeSeg[1], S.hull, { z: bz });
      else if (sil === 'faceted') prism(rb, 4, c * B.brakePrism, c * B.brakePrism, length * B.brakeLen, S.hullDark, { z: bz });
      else rb.cylinder(c * B.brakeShare, c * B.brakeShare, length * B.brakeLen, M.seg, S.hullDark, { rx: HALF_PI, z: bz });
      recoilDist = length * B.recoil;
      flashSize = c * M.flash.size * B.flashScale;
      flashColor = null;
    }
  }
  // flash, recoil, muzzle socket
  const flashParent = kind === 'missile' ? barrel : recoil;
  const flash = ub.bone(`flash${sfx}`, flashParent, [0, 0, tip]);
  flashGlow(ub.glow(flash), energy, flashSize, flashColor ?? u.weaponGlow);
  fire.flashes.push(meta.flashes.length);
  meta.flashes.push({ bone: flash });
  if (recoilDist > 0) {
    fire.recoils.push(meta.recoils.length);
    meta.recoils.push({ bone: recoil, dist: recoilDist });
  }
  ub.socket(muzzle, flashParent, [0, 0, tip + M.flash.muzzleOut]);
  ub.onFire(muzzle, fire);
  if (kind === 'missile') {
    const n = count ?? M.missile.count;
    for (let i = 1; i <= n; i++) ub.onFire(`launch${sfx}_${i}`, fire);
  }
  return { barrel, recoil, tip };
}

// ---------------------------------------------------------------- exhaust (flame by style)

/**
 * Engine nozzle on `parent`, exit at `position` facing −Z (or `rotation` of the exhaust bone), radius r, flame length
 * `length` (× style length). Bone and socket `exhaust_<index>`; the flame scales with the throttle. Flame look by
 * unitStyle.exhaust.kind: ion (hollow blue tube + ring), rocket (long cone + hot core + shock diamonds), plasma (bulb +
 * short cone + halo), beam (thin bright core + halo).
 */
export function exhaust(ub, { parent = 'hull', position, r = 0.25, length = 1.2, index = 1, rotation = [0, 0, 0] }) {
  const kit = ub.kit;
  const S = kit.S;
  const E = M.exhaust;
  const ex = ub.style.exhaust;
  const [x, y, z] = position;
  const b = ub.paint(parent);
  b.cylinder(r * E.front, r * E.bell, E.nozzleLen, E.seg, S.frame, { rx: HALF_PI, x, y, z: z + E.nozzleLen / 2 });
  b.cylinder(r * E.holeShare, r * E.holeShare, E.holeLen, E.seg, S.hole, { rx: HALF_PI, x, y, z: z - E.holeOut });
  const name = `exhaust_${index}`;
  const bone = ub.bone(name, parent, position, { rotation });
  const g = ub.glow(bone);
  const w = ex.width;
  const len = length * ex.length;
  const seg = E.seg;
  // ion: hollow tube (dim centre) + exit ring; rocket: long cone + hot core + shock diamonds; plasma: bulb + cone + halo;
  // beam: thin bright core + halo + exit lens
  const K = Object.hasOwn(E.shapes, ex.kind) ? E.shapes[ex.kind] : E.shapes.ion;
  for (const [near, far, share, intensity, colorKey, open] of K.layers) {
    g.flame(r * near * w, r * far * w, len * share, seg, ex[colorKey], { intensity }, open);
  }
  if (K.balls) for (const [br, bz, intensity] of K.balls) g.sphere(r * br * w, E.ballSeg[0], E.ballSeg[1], ex.core, { z: -len * bz, intensity });
  if (K.bulb) g.sphere(r * K.bulb[0] * w, E.bulbSeg[0], E.bulbSeg[1], ex.core, { z: -r * K.bulb[1], intensity: K.bulb[2] });
  if (K.halo) g.sphere(r * K.halo[0] * w, E.bulbSeg[0], E.bulbSeg[1], ex.outer, { z: -r * K.halo[1], intensity: K.halo[2] });
  if (K.ring) g.torus(r * K.ring[0] * w, r * K.ring[1], E.ringRadial, seg, ex.core, { intensity: K.ring[2] });
  if (K.lens) g.add(new THREE.CircleGeometry(r * K.lens, seg), ex.core, { z: -E.lensOut });
  ub.meta.exhausts.push({ bone: name, idle: ex.idle, flicker: ex.flicker });
  ub.socket(`${name}`, parent, position);   // socket on the parent (the flame bone scales)
  return name;
}

// ---------------------------------------------------------------- status lamp

/** State marker lamp on `parent` at `position` (base); its glow takes the status colour (ProcUnit.setStatus) */
export function statusLamp(ub, { parent = 'hull', position }) {
  const St = M.status;
  const [x, y, z] = position;
  ub.paint(parent).cylinder(St.baseR, St.baseR * St.baseFlare, St.baseH, St.baseSeg, ub.kit.S.dark, { x, y: y + St.baseH / 2, z, detail: 0 });
  const bone = ub.bone('status', parent, [x, y + St.baseH + St.lampR, z]);
  ub.glow(bone).point([0, 0, 0], St.lampR, St.white, {}, 1)
    .point([0, 0, 0], St.halo, St.white, { intensity: St.haloGlow }, 1);
  ub.meta.status = bone;
  return bone;
}

// ---------------------------------------------------------------- aircraft

/** Aircraft fuselage on `bone` centred at y (length L along Z, width W, height H); cockpit; shape by silhouette */
export function fuselage(ub, { bone = 'hull', y = 0, L, W, H }) {
  const kit = ub.kit;
  const S = kit.S;
  const b = ub.paint(bone);
  const sil = kit.style.silhouette;
  const Fu = M.fuselage;
  if (sil === 'angular') {
    const A = Fu.angular;
    b.taperedBox(W, W * A.topW, H, L * A.bodyL, S.hull, { y: y - H / 2, z: L * A.bodyZ }, L * A.topL);
    b.wedge(L * A.noseL, H * A.noseH, W * A.noseW, S.hull, { ry: HALF_PI, y: y - H / 2, z: L * A.noseZ });
    b.box(W * A.canopy[0], H * A.canopy[1], L * A.canopy[2], S.window, { y: y + H / 2 - A.canopySink, z: L * A.canopyZ });
  } else if (sil === 'round') {
    const R = Fu.round;
    b.sphere(1, R.seg[0], R.seg[1], S.hull, { sx: W / 2, sy: H / 2, sz: L / 2, y });
    b.sphere(1, R.canopySeg[0], R.canopySeg[1], S.window, { sx: W * R.canopy[0], sy: H * R.canopy[1], sz: L * R.canopy[2], y: y + H * R.canopyY, z: L * R.canopyZ });
    b.torus(1, M.neon.d, M.ring.radial, M.ring.tubular, TAU, S.neon, { rx: HALF_PI, sx: W / 2 + M.neon.d, sy: L / 2 + M.neon.d, y });
  } else if (sil === 'faceted') {
    const F = Fu.faceted;
    prism(b, 4, W, H, L * F.bodyL, S.hull, { y, z: L * F.bodyZ });
    noseCone(b, 4, W, H, L * F.noseL, S.hull, { y, z: L * F.noseZ });
    noseCone(b, 4, W * F.canopyW, H * F.canopyH, L * F.canopyL, S.window, { y: y + H * F.canopyY, z: L * F.canopyZ });
    for (const side of [1, -1]) neonLine(b, kit, L * F.neonL, { x: side * (W / 2 + M.neon.out), y, z: L * F.bodyZ });
  } else {
    const R = Fu.rounded;
    b.sphere(1, R.seg[0], R.seg[1], S.hull, { sx: W / 2, sy: H / 2, sz: L / 2, y });
    b.sphere(1, R.canopySeg[0], R.canopySeg[1], S.window, { sx: W * R.canopy[0], sy: H * R.canopy[1], sz: L * R.canopy[2], y: y + H * R.canopyY, z: L * R.canopyZ });
    b.box(W * R.bandOver, H * R.bandH, L * R.bandL, S.team, { y, z: L * R.bandZ });
  }
}

// wing planform (one side, x ≥ 0 = left wing) by silhouette; points [x (span), z (chord, + forward)]
function wingOutline(sil, half, rc, tc, sweep) {
  const tipF = rc / 2 - sweep;
  switch (sil) {
    case 'angular': return [[0, rc / 2], [half, tipF], [half, tipF - tc], [0, -rc / 2]];
    case 'round': return null;   // crescent: curves, see wings()
    case 'faceted': {
      const F = M.wing.faceted;
      const tipZ = tipF + sweep * F.tipSweep;
      return [[0, rc / 2], [half * F.kink, rc / 2 + sweep * F.kinkSweep], [half, tipZ], [half * F.tipBack, tipZ - tc], [half * F.rootBack, rc * F.rootTrail], [0, -rc / 2]];
    }
    default: return [[0, rc / 2], [half * M.wing.rootSpan, tipF], [half, tipF - tc * M.wing.tipCurve], [half, tipF - tc], [0, -rc / 2]];
  }
}

/**
 * Pair of wings on `bone` (span = tip to tip, root chord rc, tip chord tc, sweep = how far the tip leading edge is
 * behind the root's), top at y, root centred at z. Nav lights at the tips (glow), emblem decals on the upper sides.
 */
export function wings(ub, { bone = 'hull', y = 0, z = 0, span, rc, tc, sweep }) {
  const kit = ub.kit;
  const S = kit.S;
  const Wg = M.wing;
  const b = ub.paint(bone);
  const sil = kit.style.silhouette;
  const half = span / 2;
  const g = ub.glow(bone);
  for (const side of [1, -1]) {
    const shape = new THREE.Shape();
    const pts = wingOutline(sil, half, rc, tc, sweep);
    if (pts) {
      pts.forEach(([px, pz], i) => (i ? shape.lineTo(side * px, pz) : shape.moveTo(side * px, pz)));
    } else {   // crescent
      shape.moveTo(0, rc / 2);
      const C = Wg.crescent;
      shape.quadraticCurveTo(side * half * C.lead, rc / 2, side * half, -sweep);
      shape.quadraticCurveTo(side * half * C.trail, rc * C.trailZ, 0, -rc / 2);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: Wg.thick, bevelEnabled: false, curveSegments: Wg.curveSegments });
    b.add(geo, S.hull, { rx: HALF_PI, y: y + Wg.thick / 2, z });
    const tip = pts ? pts[Math.floor(pts.length / 2)] : [half, -sweep];
    g.point([side * tip[0], y, z + tip[1]], Wg.navR, M.navColors[side > 0 ? 0 : 1], {});
  }
  ub.emblem(bone, [1, -1].map((s) => ({ position: [s * half * Wg.emblemX, y + Wg.thick / 2 + Wg.emblemOut, z + rc * Wg.emblemZ], normal: [0, 1, 0], up: [0, 0, 1], size: rc * Wg.emblemShare })));
}

/** Tail fins: `count` 1 = vertical, 2 = V-tail (tilted ±tilt), at z on `bone` */
export function tailFins(ub, { bone = 'hull', y = 0, z, h, chord, count = 1, tilt = 0.5 }) {
  const b = ub.paint(bone);
  const S = ub.kit.S;
  for (let i = 0; i < count; i++) {
    const rz = count === 1 ? 0 : (i ? -tilt : tilt);
    const shape = new THREE.Shape();
    shape.moveTo(0, chord / 2);
    shape.lineTo(h, chord * M.fin.tipFront);
    shape.lineTo(h, chord * M.fin.tipBack);
    shape.lineTo(0, -chord / 2);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: M.fin.thick, bevelEnabled: false });
    geo.translate(0, 0, -M.fin.thick / 2);
    geo.rotateX(HALF_PI);   // shape y (chord) → z, extrusion → −y
    geo.rotateZ(HALF_PI);   // span x → y (up)
    b.add(geo, S.hullDark, { y, z, rz });
  }
}

// ---------------------------------------------------------------- artillery outriggers (deploy)

/**
 * Folding legs on `parent`: legs = [{ x, y, z, side }] pivots (side +1 left / −1 right). Folded upright along the
 * hull; setDeployed(1) swings them down and out to the ground (deploy channels on rz). length = pivot → spade.
 */
export function outriggers(ub, { parent = 'hull', legs, length }) {
  const O = M.outrigger;
  const S = ub.kit.S;
  legs.forEach((l, i) => {
    const bone = ub.bone(`leg_${i + 1}`, parent, [l.x, l.y, l.z], { rotation: [0, 0, l.side * O.fold] });
    const b = ub.paint(bone);
    b.box(O.beamT, length, O.beamT, S.frame, { y: -length / 2 });
    b.box(O.spadeW, O.spadeH, O.spadeD, S.dark, { y: -length });
    ub.deploy(bone, 'rz', l.side * O.out);
  });
}
