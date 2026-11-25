// Steel Men – shared kit of the four "enhancer" buildings (attack / defense / recon / construction; T2 aura buildings,
// docs/notes/a9-content.md ch. 2). Visual only: the aura radius, bonuses and footprint come from the simulation (stats.json),
// the ring of glow on the ground is just a decent hint. The kit gives:
//   • context + finishShared(): a PartBuilder / GlowSet / decals bundle and the shared (per style) data of a model
//   • pedestal(): pad + team-painted plinth by style.silhouette (rounded box · angular armoured · round disc · faceted octagon)
//   • shaft(): a tall column / pillar / stem / blade mast by silhouette (also used for the small pylons)
//   • auraRing(), cornerBeacons(): the ground ring glow and two warning lights
//   • haloRingGeometry(): a turning ring with lugs / spikes (one paint mesh)
//   • EnhancerModel: ProcModel base class with the shared wiring (static body, emblem, beacons, aura ring, work easing)
// Origin = centre of the pad on the ground, front = +Z. No allocations in update(); the style data only picks a silhouette.
import * as THREE from 'three';
import { PartBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, GlowSet, styledBox, marking, beacon, neonStrip, spike, teamTrim, emblemDecalGeometry, pulseWave,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Pad, aura ring, animation and tint tuning (model units; visual only) */
export const ENH = {
  detail: 2,                 // team paint stays in LOD2 (docs/notes/proc-teampaint-d.md)
  padH: 0.4, padSegments: 40, neonMin: 0.3, ringInset: 0.6, ringTube: 0.08, edgeStrip: { h: 0.08, d: 0.3, inset: 0.7 },
  // ground glow ring (decent hint, NOT the real aura radius): radius = smallest pad half − inset
  aura: { inset: 1.6, tube: 0.28, inner: 1.3, innerTube: 0.12, lift: 0.08, segments: 72, idle: 0.4, work: 0.9, pulseHz: 0.7 },
  beaconInset: 2.2,
  workEase: 1.6,             // 1/s – how fast the model goes between idle and work
  idleBeacon: 0.4, blinkDuty: 0.5,
  timeWrap: 3600,            // s – `time` wraps here (float precision after hours of play; one tiny pulse jump per wrap)
  phaseStep: 0.57,           // s – animation phase offset per instance
  // tint of the glow layers: the style's neon colour mixed with a role colour (code knows roles, not factions)
  tint: {
    attack: { color: '#ff4a1c', mix: 0.65 },        // aggressive red-orange
    defense: { color: '#3aa0ff', mix: 0.5 },        // shield blue
    recon: { color: '#3dffb0', mix: 0.45 },         // sensor green
    construction: { color: '#ffb020', mix: 0.55 },  // work amber
  },
};

/** Pedestal dimensions by silhouette (shares of the pad half-width X unless noted) */
export const PEDESTAL = {
  rounded: { share: 0.56, h: 4.4, beltH: 1.0, beltOut: 0.02, lipInset: 0.3, markH: 0.6, markY: 1.9, markShare: 0.5 },
  angular: { skirt: 0.72, skirtH: 1.2, share: 0.6, topShare: 0.72, h: 5.0 },
  round: { rBottom: 0.58, rTop: 0.42, h: 4.6, seg: 40, trimInset: 0.5 },
  faceted: { share: 0.5, h: 4.0, outrigger: { at: 0.78, w: 1.6, topW: 0.6, h: 3.2 } },
  decalSize: 4.5, decalYShare: 0.62,
};

export const SILHOUETTES = ['rounded', 'angular', 'round', 'faceted'];
export const silhouetteOf = (kit) => (SILHOUETTES.includes(kit.style.silhouette) ? kit.style.silhouette : 'rounded');

/** Glow colour: the style's neon colour mixed with the role colour (construction time) */
export function tintColor(kit, role) {
  const T = ENH.tint[role];
  return new THREE.Color(kit.glowColors.pulse).lerp(new THREE.Color(T.color), T.mix);
}

// ---------------------------------------------------------------- shared build context

/** Builder bundle of one style: { kit, S, b (static parts), glows, decals, sil } */
export function enhancerContext(kit) {
  return { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], sil: silhouetteOf(kit) };
}

/** Shared (per style) data: static LODs, glow geometries, emblem decals + `extra` (head geometries etc.) */
export function finishShared(c, extra = {}) {
  return { sil: c.sil, static: c.b.buildLods(), glow: c.glows.build(), emblem: emblemDecalGeometry(c.decals), ...extra };
}

/** Wall decal; `tilt` leans the normal upwards (sloped walls) */
export function wallDecal(c, position, nx, nz, size, tilt = 0) {
  c.decals.push({ position, normal: [nx * Math.cos(tilt), Math.sin(tilt), nz * Math.cos(tilt)], size });
}

// ---------------------------------------------------------------- pad + pedestal

function foundation(c, hx, hz) {
  const { b, S, kit, sil } = c;
  const E = ENH;
  const ring = kit.style.neon >= E.neonMin;
  if (sil === 'round' || sil === 'faceted') {
    const r0 = Math.min(hx, hz);
    const oct = sil === 'faceted';
    const r = oct ? r0 / Math.cos(Math.PI / 8) : r0;
    b.cylinder(r, r, E.padH, oct ? 8 : E.padSegments, S.ground, { y: E.padH / 2, ry: oct ? Math.PI / 8 : 0 });
    if (ring) b.torus(r0 - E.ringInset, E.ringTube, 4, E.padSegments * 2, TAU, S.neon, { rx: Math.PI / 2, y: E.padH + 0.04 });
  } else {
    b.box(hx * 2, E.padH, hz * 2, S.ground, { base: true });
    if (ring) {
      const e = E.edgeStrip;
      for (const s of [-1, 1]) {
        neonStrip(b, kit, hx * 2 - 2 * e.inset, e.h, e.d, { y: E.padH + e.h / 2, z: s * (hz - e.inset) });
        neonStrip(b, kit, e.d, e.h, hz * 2 - 2 * e.inset, { y: E.padH + e.h / 2, x: s * (hx - e.inset) });
      }
    }
  }
}

/**
 * Pad + plinth (team paint) with emblem decals on the four sides. Returns { y: top of the plinth, w: its top width }.
 * `hx`/`hz` = half sizes of the pad (round / faceted pads use the smaller one).
 */
export function pedestal(c, hx, hz = hx) {
  const { b, S, kit, sil } = c;
  const E = ENH;
  const P = PEDESTAL[sil];
  const y0 = E.padH;
  foundation(c, hx, hz);
  const size = PEDESTAL.decalSize;
  if (sil === 'rounded') {
    const w = 2 * hx * P.share;
    const y1 = y0 + P.h;
    styledBox(b, kit, w, P.h, w, S.hull, { base: true, y: y0 });
    b.box(w + 2 * P.beltOut, P.beltH, w + 2 * P.beltOut, S.teamPaint, { y: y0 + P.beltH / 2, detail: E.detail });
    teamTrim(b, kit, { y: y1, w: w - P.lipInset, d: w - P.lipInset }, { detail: E.detail });
    for (const e of [-1, 1]) {
      wallDecal(c, [0, y0 + P.h * PEDESTAL.decalYShare, e * w / 2], 0, e, size);
      wallDecal(c, [e * w / 2, y0 + P.h * PEDESTAL.decalYShare, 0], e, 0, size);
    }
    marking(b, kit, w * P.markShare, P.markH, { y: y0 + P.markY, z: w / 2 + P.beltOut });
    return { y: y1, w };
  }
  if (sil === 'angular') {
    const sk = 2 * hx * P.skirt;
    b.box(sk, P.skirtH, sk, S.hullDark, { base: true, y: y0 });
    const w = 2 * hx * P.share;
    const topW = w * P.topShare;
    const yb = y0 + P.skirtH;
    b.taperedBox(w, topW, P.h, w, S.teamPaint, { y: yb, detail: E.detail }, topW);
    const tilt = Math.atan2((w - topW) / 2, P.h);
    const half = w / 2 - ((w - topW) / 2) * PEDESTAL.decalYShare;
    for (const e of [-1, 1]) {
      wallDecal(c, [0, yb + P.h * PEDESTAL.decalYShare, e * half], 0, e, size, tilt);
      wallDecal(c, [e * half, yb + P.h * PEDESTAL.decalYShare, 0], e, 0, size, tilt);
    }
    return { y: yb + P.h, w: topW };
  }
  if (sil === 'round') {
    const rB = hx * P.rBottom;
    const rT = hx * P.rTop;
    const y1 = y0 + P.h;
    teamTrim(b, kit, { y: y0, r: Math.min(hx, hz) - P.trimInset }, { detail: E.detail });
    b.cylinder(rT, rB, P.h, P.seg, S.hull, { y: y0 + P.h / 2 });
    const slope = rB - rT;
    const nl = Math.hypot(P.h, slope);
    const rMid = (rB + rT) / 2;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      c.decals.push({
        position: [Math.cos(a) * rMid, y0 + P.h * PEDESTAL.decalYShare, Math.sin(a) * rMid],
        normal: [(P.h / nl) * Math.cos(a), slope / nl, (P.h / nl) * Math.sin(a)], size,
      });
    }
    // team ring round the base (lower third of the cone)
    b.cylinder(rB - slope * 0.3, rB, P.h * 0.3, P.seg, S.teamPaint, { y: y0 + P.h * 0.15, detail: E.detail });
    return { y: y1, w: rT * 2 };
  }
  // faceted
  const w = 2 * hx * P.share;
  const y1 = y0 + P.h;
  styledBox(b, kit, w, P.h, w, S.teamPaint, { base: true, y: y0, detail: E.detail });
  const O = P.outrigger;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) b.taperedBox(O.w, O.topW, O.h, O.w, S.teamShade, { x: sx * hx * O.at, y: y0, z: sz * Math.min(hx, hz) * O.at, detail: E.detail });
  }
  for (const e of [-1, 1]) {
    wallDecal(c, [0, y0 + P.h * PEDESTAL.decalYShare, e * w / 2], 0, e, size);
    wallDecal(c, [e * w / 2, y0 + P.h * PEDESTAL.decalYShare, 0], e, 0, size);
  }
  return { y: y1, w };
}

// ---------------------------------------------------------------- column

/** Column shapes by silhouette (shares of the width `w` unless noted) */
const SHAFT = {
  rounded: { teamShare: 0.3, seg: 20, neon: { ks: [0.45, 0.8], tube: 0.12, over: 0.04 }, collar: { h: 1.0, grow: 1.5, growBottom: 1.2 } },
  angular: {
    buttress: { w: 0.22, topW: 0.1, h: 0.45, d: 0.35, topD: 0.18, at: 0.5 }, spike: { h: 0.08, r: 0.05 }, cap: { grow: 1.3, h: 0.8 },
  },
  round: { teamShare: 0.7, seg: 20, saucers: { ks: [0.35, 0.62, 0.88], r: 0.62, flat: 0.28, tube: 0.07 }, cradle: { h: 1.0, grow: 1.7, growBottom: 1.1 } },
  faceted: { blade: { w: 0.16, topW: 0.05, h: 0.6, d: 0.5, at: 0.5, topD: 0.18 }, strip: { w: 0.08, at: 0.52 } },
};

/**
 * Tall column on the plinth by silhouette: rounded = cylinder with neon rings and a collar · angular = tapered pillar with
 * buttresses and spikes · round = stem with saucers · faceted = blade mast. `w` / `topW` = widths at the foot / top.
 * Returns the y of its top.
 */
export function shaft(c, { x = 0, z = 0, y, h, w, topW, seg }) {
  const { b, S, kit, sil } = c;
  const E = ENH;
  const D = SHAFT[sil];
  const sg = seg ?? D.seg;                       // radial segments of round parts (small pylons pass fewer)
  const rings = Math.max(8, Math.round(sg * 1.4));   // segments of tori / saucers round the column
  const saucer = [Math.max(8, sg), Math.max(5, Math.round(sg / 2))];
  const rB = w / 2;
  const rT = topW / 2;
  if (sil === 'rounded') {
    const kt = D.teamShare;
    const rSplit = rB + (rT - rB) * kt;
    b.cylinder(rSplit, rB, h * kt, sg,S.teamPaint, { x, y: y + (h * kt) / 2, z, detail: E.detail });
    b.cylinder(rT, rSplit, h * (1 - kt), sg,S.hull, { x, y: y + h * kt + (h * (1 - kt)) / 2, z });
    if (kit.style.neon >= E.neonMin) {
      for (const k of D.neon.ks) b.torus(rB + (rT - rB) * k + D.neon.over, D.neon.tube, 4, rings, TAU, S.neon, { rx: Math.PI / 2, x, y: y + h * k, z });
    }
    b.cylinder(rT * D.collar.grow, rT * D.collar.growBottom, D.collar.h, sg,S.hullDark, { x, y: y + h - D.collar.h / 2, z });
  } else if (sil === 'angular') {
    b.taperedBox(w, topW, h, w, S.hull, { x, y, z }, topW);
    const B = D.buttress;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.taperedBox(w * B.w, w * B.topW, h * B.h, w * B.d, S.hullDark, { x: x + sx * w * B.at, y, z: z + sz * w * B.at, ry: Math.atan2(sx, sz) }, w * B.topD);
        spike(b, kit, { x: x + sx * topW * 0.5, y: y + h, z: z + sz * topW * 0.5, h: w * D.spike.h * 2, r: w * D.spike.r });
      }
    }
    b.box(topW * D.cap.grow, D.cap.h, topW * D.cap.grow, S.hullDark, { base: true, x, y: y + h - D.cap.h, z });
  } else if (sil === 'round') {
    const kt = D.teamShare;
    const rSplit = rB + (rT - rB) * kt;
    b.cylinder(rSplit, rB, h * kt, sg,S.teamPaint, { x, y: y + (h * kt) / 2, z, detail: E.detail });
    b.cylinder(rT, rSplit, h * (1 - kt), sg,S.hull, { x, y: y + h * kt + (h * (1 - kt)) / 2, z });
    D.saucers.ks.forEach((k, i) => {
      const teamed = i === 0 || i === 2;
      b.sphere(w * D.saucers.r, saucer[0], saucer[1], teamed ? S.teamPaint : S.hullDark, { x, y: y + h * k, z, sy: D.saucers.flat, ...(teamed ? { detail: E.detail } : {}) });
      if (kit.rich) b.torus(w * D.saucers.r, D.saucers.tube, 4, rings, TAU, S.neon, { rx: Math.PI / 2, x, y: y + h * k, z });
    });
    b.cylinder(rT * D.cradle.grow, rT * D.cradle.growBottom, D.cradle.h, sg,S.hullDark, { x, y: y + h - D.cradle.h / 2, z });
  } else {
    b.taperedBox(w, topW, h, w, S.hullDark, { x, y, z, ry: Math.PI / 4 }, topW);
    const Bl = D.blade;
    for (let k = 0; k < 4; k++) {
      const ry = (k * Math.PI) / 2;
      const sx = Math.round(Math.sin(ry));
      const sz = Math.round(Math.cos(ry));
      b.taperedBox(w * Bl.w, w * Bl.topW, h * Bl.h, w * Bl.d, S.hull, { x: x + sx * w * Bl.at, y, z: z + sz * w * Bl.at, ry }, w * Bl.topD);
      if (kit.rich) neonStrip(b, kit, w * D.strip.w, h * Bl.h * 0.95, w * D.strip.w, { x: x + sx * w * D.strip.at, y: y + (h * Bl.h * 0.95) / 2, z: z + sz * w * D.strip.at });
    }
  }
  return y + h;
}

// ---------------------------------------------------------------- aura ring, beacons, halo ring

/** Decent ring of glow on the pad (hint only): outer ring + a thin inner one. Layer 'aura'. */
export function auraRing(c, half) {
  const A = ENH.aura;
  const g = c.glows.get('aura');
  const r = half - A.inset;
  const y = ENH.padH + A.lift;
  g.torus(r, A.tube, 4, A.segments, TAU, { rx: Math.PI / 2, y });
  g.torus(r - A.inner, A.innerTube, 4, A.segments, TAU, { rx: Math.PI / 2, y });
}

/** Two warning lights on opposite pad corners (not on the +X/+Z one, which buildings may use for equipment) */
export function cornerBeacons(c, half) {
  const o = half - ENH.beaconInset;
  const g = c.glows.get('beaconA');
  beacon(c.b, g, c.kit, [-o, ENH.padH, o]);
  beacon(c.b, g, c.kit, [o, ENH.padH, -o]);
}

/**
 * Turning ring (one geometry, origin at its centre): trim torus, team lugs and (angular / faceted) spikes round it.
 * plane 'h' = horizontal ring, 'v' = vertical ring (turns round Y like a gyroscope hoop).
 */
export function haloRingGeometry(kit, { r, tube = 0.3, lugs = 6, lug = [1.6, 1.0, 1.0], spikes = 0, plane = 'h', phase = 0 }) {
  const S = kit.S;
  const b = new PartBuilder();
  const flat = plane === 'h';
  b.torus(r, tube, 5, 28, TAU, S.trim, flat ? { rx: Math.PI / 2 } : {});
  for (let i = 0; i < lugs; i++) {
    const a = phase + (i / lugs) * TAU;
    const x = Math.cos(a) * r;
    const o = Math.sin(a) * r;
    b.box(lug[0], lug[1], lug[2], S.teamPaint, flat ? { x, z: o, ry: -a } : { x, y: o, rz: a });
    if (spikes > 0) {
      const d = r + lug[0] * 0.5 + spikes * 0.5;
      if (flat) b.cylinder(0, tube * 1.4, spikes, 4, S.frame, { x: Math.cos(a) * d, z: Math.sin(a) * d, rz: -Math.PI / 2, ry: -a });
      else b.cylinder(0, tube * 1.4, spikes, 4, S.frame, { x: Math.cos(a) * d, y: Math.sin(a) * d, rz: a - Math.PI / 2 });
    }
  }
  return b.build();
}

/** Unit horizontal torus used for rings that grow / rise (scaled in x / z by update()) */
export function unitRingGlow(glows, name, tube = 0.06, segments = 64) {
  glows.get(name).torus(1, tube, 4, segments, TAU, { rx: Math.PI / 2 });
}

// ---------------------------------------------------------------- model base class

let instanceCounter = 0;

/**
 * ProcModel with the wiring all enhancers share: static body, emblem, `beacons`, `aura` ring (glow layers 'beaconA' / 'aura'),
 * `work` (0 idle … 1 active, eased), `time` (seconds of powered animation, offset per instance). Subclasses call
 * `enhancerLayers()` then add their own parts, and call `beginUpdate(delta, active)` first in update().
 */
export class EnhancerModel extends ProcModel {
  constructor({ race, teamColor, cache, name, role }) {
    super({ race, teamColor, cache, name });
    this.role = role;
    this.seq = instanceCounter++;
    this.time = this.seq * ENH.phaseStep;
    this.work = 0;
    this.glowTint = tintColor(this.kit, role);
    this.blink = new Blinker({ period: this.kit.style.anim.blink, duty: ENH.blinkDuty });
    this.beacons = null;
    this.aura = null;
  }

  /** Glow layer by shared name (null when the style has none); starts hidden */
  layerOf(name, color = this.glowTint, opts = {}) {
    const g = this.shared.glow[name];
    return g ? this.glowLayer(g, color, { visible: false, ...opts }) : null;
  }

  /** Static body, emblem, beacons, aura ring */
  enhancerLayers() {
    const sh = this.shared;
    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    this.beacons = this.layerOf('beaconA', this.kit.glowColors.beacon, { visible: true });
    this.aura = this.layerOf('aura');
  }

  /** Time, work easing, aura pulse and beacons – first call of update(). No allocations. */
  beginUpdate(delta, active) {
    const A = ENH.aura;
    this.time = (this.time + delta) % ENH.timeWrap;
    this.work += ((active ? 1 : 0) - this.work) * Math.min(1, delta * ENH.workEase);
    this.blink.update(delta, active);
    const pulse = pulseWave(this.time, this.kit.style.anim.pulse * A.pulseHz);
    this.aura?.setIntensity((A.idle + (A.work - A.idle) * this.work) * pulse);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : ENH.idleBeacon);
  }
}
