// Steel Men – procedural wall gate (roadmap 18, walls; new building `wallGate`, tier 1). A wall piece that sits between two
// posts like a segment and opens for the owner's units. There is no GLB: for the footprint stats.json can point `model` at
// the segment GLB (3DStructures{race}/MobileWallWall{race}.glb), like the new anti-air turret does for the point defence.
//   • modelled at the NOMINAL length WALL_SPAN (32 GLB units) and stretched along x by the structure (Walls.js holder.scale.x)
//     exactly like a segment; the leaf spans the whole length and its ends sit inside the posts, so no span value is needed
//   • by style.silhouette (GATE_BUILDERS): rounded = sloped panel leaf with hazard stripes and the emblem, angular = heavy
//     plated leaf with ribs and spikes, round = three plasma-lit tubes with a round emblem plate, faceted = no leaf at all:
//     the laser barrier (4 lines + sheet + halos, glow layers) is switched off – the emblem lies on the sill
//   • animation: the leaf SINKS into the ground (hidden by the terrain), the barrier fades; the lights blink while it moves.
//     API: setOpen(open: boolean) – the structure calls it every tick from the simulation state (visual only, the model reads
//     nothing); `openness` 0..1 and `isOpen` read back the visual state
//   • the gate is NOT batched (the leaf moves): enableBatching() is empty, so the meshes are always drawn
// Draw calls: static, leaf, emblem, 1–2 light glow layers = 4–5 (faceted: static, emblem, 3 glow layers + light = 5–6).
// Triangles ≈ 150–400. No allocations in update().
import { PartBuilder, Blinker, smootherstep } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, marking, neonStrip, beacon, spike, emblemDecalGeometry, pulseWave,
} from './ProcModules.js';
import { WALL_SPAN, WALL_LAYOUT, WALL_ANIM, WALL_TEAM, HALF_PI, nextWallInstance, pickBoxGeometry, addPickBox } from './MobileWallProc.js';

const FACE_OUT = 0.02;       // markings / strips stand this far off the leaf face
const both = [-1, 1];

/**
 * Team paint of the gate (S.teamPaint / S.teamShade, see WALL_TEAM; vertices of the sill / leaf geometry, no extra draw call).
 * Bands run along the whole nominal length (they stretch with the gate) but leave a gap `emblemGap` round the emblem, so team
 * paint never touches the emblem decal; the sill (fixed base) is painted too and stays visible when the leaf has sunk.
 */
const GATE_TEAM = { detail: WALL_TEAM.detail, emblemGap: 0.5, plateH: 0.3, plateGrow: 0.4 };

/** Team band on the leaf face: centre height y, height h, depth t at z (face), `len` long; split round an emblem of `gapSize` (0 = whole) */
function teamBand(b, s, { len, h, t, y, z }, gapSize = 0) {
  if (gapSize <= 0) return b.box(len, h, t, s, { y, z, detail: GATE_TEAM.detail });
  const inner = gapSize / 2 + GATE_TEAM.emblemGap;
  const w = len / 2 - inner;
  for (const e of both) b.box(w, h, t, s, { x: e * (inner + w / 2), y, z, detail: GATE_TEAM.detail });
  return b;
}

/** Gate shapes by style.silhouette (GLB units; unknown → rounded). sill = fixed base, leaf = the part that sinks */
export const GATE_SHAPES = {
  rounded: {
    sill: { h: 0.5, d: 3.6 }, lightX: 6,
    leaf: { y0: 0.2, h: 7.0, d: 1.9, topD: 1.5 },
    mark: { len: 11, h: 1.6, y: 2.0, x: 9 },
    team: { len: 31, h: 1.1, y: 5.75, t: 0.1 },        // top band (whole length) …
    sideTeam: { len: 31, h: 2.0, y: 4.1, t: 0.1 },     // … and side panels either side of the emblem
    neon: { len: 30, h: 0.12, y: 6.6, t: 0.06 },
    emblem: { size: 3.0, y: 3.6 },
  },
  angular: {
    sill: { h: 0.6, d: 4.4 }, lightX: 6,
    leaf: { y0: 0.2, h: 7.0, d: 2.6, topD: 2.0 },
    ribs: { count: 5, w: 0.8, h: 6.4, t: 0.5 },
    rust: { len: 31, h: 1.4, y: 1.5, t: 0.1 },
    team: { len: 31, h: 1.2, y: 5.5, t: 0.1 },         // band split round the emblem plate
    spike: { count: 5, h: 0.8, r: 0.2 },
    plate: { size: 3.0, t: 0.3, y: 3.6 },
    emblem: { size: 2.6, y: 3.6 },
  },
  round: {
    sill: { r: 1.8, flat: 0.3, seg: 12 }, lightX: 6, lightY: 0.35, lightZ: 1.4,
    tubes: { ys: [1.2, 3.4, 5.6], r: 0.85, seg: 12, team: [0, 2] },   // team: indices of the tubes painted in the team colour
    plate: { r: 1.9, t: 2.0, seg: 20, y: 3.4 },
    core: { r: 0.2, seg: 6 },
    emblem: { size: 2.8, y: 3.4 },
  },
  faceted: {
    rail: { h: 0.8, d: 1.6 }, lightX: 6,                                 // team rail (split round the emblem)
    lineT: 0.16, sheet: { y: 5.0, h: 7.0, t: 0.1 }, halo: 0.45,
    emblem: { size: 3.4, y: 0.32 },                                      // lies on a neutral plate (GATE_TEAM.plateH) between the rail halves
  },
};

/** Gate movement and look (visual only) */
const GATE_ANIM = {
  sinkExtra: 0.4,            // the leaf sinks its own height + this (below the ground, hidden by the terrain)
};

function lightsOn(b, glows, kit, x, y, z) {
  const lamp = glows.get(kit.style.lights === 'lamp' ? 'beacon' : 'light');
  for (const e of both) beacon(b, lamp, kit, [e * x, y, z]);
}

/** Leaf face half depth at height y for a tapered leaf */
const leafFace = (L, y) => L.d / 2 + ((L.topD - L.d) / 2) * ((y - L.y0) / L.h);

function buildRoundedGate(sill, leaf, glows, kit, P, out) {
  const S = kit.S;
  const L = P.leaf;
  sill.box(WALL_SPAN, P.sill.h, P.sill.d, S.teamShade, { base: true, detail: GATE_TEAM.detail });
  leaf.taperedBox(WALL_SPAN, WALL_SPAN, L.h, L.d, S.hull, { y: L.y0 }, L.topD);
  for (const e of both) {
    const turn = e > 0 ? 0 : Math.PI;
    teamBand(leaf, S.teamPaint, { ...P.team, z: e * leafFace(L, P.team.y) });
    teamBand(leaf, S.teamPaint, { ...P.sideTeam, z: e * leafFace(L, P.sideTeam.y) }, P.emblem.size);
    for (const sx of both) marking(leaf, kit, P.mark.len, P.mark.h, { x: sx * P.mark.x, y: P.mark.y, z: e * (leafFace(L, P.mark.y) + FACE_OUT), ry: turn });
    if (kit.style.neon >= WALL_LAYOUT.neonMin) neonStrip(leaf, kit, P.neon.len, P.neon.h, P.neon.t, { y: P.neon.y, z: e * (leafFace(L, P.neon.y) + P.neon.t / 2) });
    out.emblems.push({ position: [0, P.emblem.y, e * leafFace(L, P.emblem.y)], normal: [0, 0, e], size: P.emblem.size });
  }
  lightsOn(sill, glows, kit, P.lightX, P.sill.h, P.sill.d / 2 - 0.4);
  out.onLeaf = true;
  out.sink = L.y0 + L.h;
}

function buildAngularGate(sill, leaf, glows, kit, P, out) {
  const S = kit.S;
  const L = P.leaf;
  sill.box(WALL_SPAN, P.sill.h, P.sill.d, S.teamShade, { base: true, detail: GATE_TEAM.detail });
  leaf.taperedBox(WALL_SPAN, WALL_SPAN, L.h, L.d, S.hull, { y: L.y0 }, L.topD);
  const R = P.ribs;
  const pitch = WALL_SPAN / R.count;
  for (const e of both) {
    leaf.box(P.rust.len, P.rust.h, P.rust.t, S.lower, { y: P.rust.y, z: e * (leafFace(L, P.rust.y) + P.rust.t / 2) });
    teamBand(leaf, S.teamPaint, { ...P.team, z: e * (leafFace(L, P.team.y) + P.team.t / 2) }, P.plate.size);
    for (let i = 0; i < R.count; i++) {
      const x = -WALL_SPAN / 2 + pitch * (i + 0.5);
      if (Math.abs(x) < P.plate.size) continue;   // the emblem plate takes the middle
      leaf.box(R.w, R.h, R.t, S.teamShade, { base: true, x, y: L.y0, z: e * leafFace(L, L.y0), detail: GATE_TEAM.detail });   // team ribs, centred on the face: half sunk in
    }
    const front = leafFace(L, P.plate.y - P.plate.size / 2) + P.plate.t / 2;
    leaf.box(P.plate.size, P.plate.size, P.plate.t, S.hullDark, { y: P.plate.y, z: e * front });
    out.emblems.push({ position: [0, P.emblem.y, e * (front + P.plate.t / 2)], normal: [0, 0, e], size: P.emblem.size });
  }
  const S2 = P.spike;
  const sp = WALL_SPAN / S2.count;
  for (let i = 0; i < S2.count; i++) spike(leaf, kit, { x: -WALL_SPAN / 2 + sp * (i + 0.5), y: L.y0 + L.h, z: 0, h: S2.h, r: S2.r });
  lightsOn(sill, glows, kit, P.lightX, P.sill.h, P.sill.d / 2 - 0.4);
  out.onLeaf = true;
  out.sink = L.y0 + L.h + S2.h;
}

function buildRoundGate(sill, leaf, glows, kit, P, out) {
  const S = kit.S;
  const T = P.tubes;
  sill.cylinder(P.sill.r, P.sill.r, WALL_SPAN, P.sill.seg, S.teamShade, { rz: HALF_PI, sx: P.sill.flat, y: 0, detail: GATE_TEAM.detail }, true);
  T.ys.forEach((y, i) => {
    const team = T.team.includes(i);   // the outer tubes are team paint
    leaf.cylinder(T.r, T.r, WALL_SPAN, T.seg, team ? S.teamPaint : S.hull, { rz: HALF_PI, y, detail: team ? GATE_TEAM.detail : null }, true);
  });
  const C = P.core;
  leaf.cylinder(C.r, C.r, WALL_SPAN, C.seg, S.plasma, { rz: HALF_PI, y: P.plate.y }, true);
  leaf.cylinder(P.plate.r, P.plate.r, P.plate.t, P.plate.seg, S.hullDark, { rx: HALF_PI, y: P.plate.y });   // disc thicker than the tube: its faces carry the emblem
  for (const e of both) out.emblems.push({ position: [0, P.emblem.y, (e * P.plate.t) / 2], normal: [0, 0, e], size: P.emblem.size });
  lightsOn(sill, glows, kit, P.lightX, P.lightY, P.lightZ);
  out.onLeaf = true;
  out.sink = T.ys[T.ys.length - 1] + T.r;
}

function buildFacetedGate(sill, leaf, glows, kit, P, out) {
  const S = kit.S;
  const gap = P.emblem.size / 2 + GATE_TEAM.emblemGap;   // the team rail leaves the emblem free (it lies on a neutral plate)
  const railW = WALL_SPAN / 2 - gap;
  for (const e of both) sill.box(railW, P.rail.h, P.rail.d, S.teamPaint, { base: true, x: e * (gap + railW / 2), detail: GATE_TEAM.detail });
  sill.box(P.emblem.size + GATE_TEAM.plateGrow, GATE_TEAM.plateH, P.emblem.size + GATE_TEAM.plateGrow, S.hullDark, { base: true });
  const lines = glows.get('line');
  const halo = glows.get('halo');
  const sheet = glows.get('sheet');
  for (const y of WALL_LAYOUT.barrierYs) {
    lines.box(WALL_SPAN, P.lineT, P.lineT, { y });
    halo.box(WALL_SPAN, P.halo, P.halo, { y });
  }
  sheet.box(WALL_SPAN, P.sheet.h, P.sheet.t, { y: P.sheet.y });
  out.emblems.push({ position: [0, P.emblem.y, 0], normal: [0, 1, 0], size: P.emblem.size });
  lightsOn(sill, glows, kit, P.lightX, P.rail.h, 0);
  out.onLeaf = false;
  out.sink = 0;
}

const GATE_BUILDERS = { rounded: buildRoundedGate, angular: buildAngularGate, round: buildRoundGate, faceted: buildFacetedGate };

/** Shared record of the gate of one style: { static, leaf?, glow, emblem, onLeaf, sink } */
function buildShared(kit) {
  const key = Object.hasOwn(GATE_BUILDERS, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const sill = new PartBuilder();
  const leaf = new PartBuilder();
  const glows = new GlowSet();
  const out = { emblems: [], onLeaf: false, sink: 0 };
  GATE_BUILDERS[key](sill, leaf, glows, kit, GATE_SHAPES[key], out);
  const hasLeaf = leaf.parts.length > 0;   // (build() empties the builder, so ask first)
  return {
    static: sill.build(),
    leaf: hasLeaf ? leaf.build() : null,
    glow: glows.build(),
    emblem: emblemDecalGeometry(out.emblems),
    pick: hasLeaf ? null : pickBoxGeometry(GATE_SHAPES.faceted.sheet.y, GATE_SHAPES.faceted.sheet.h),   // leaf-less barrier gate: invisible click box
    onLeaf: hasLeaf && out.onLeaf,
    sink: out.sink + GATE_ANIM.sinkExtra,
  };
}

const GATE_CACHE = createSharedCache(buildShared);

export class WallGateProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: GATE_CACHE, name: 'WallGateProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const an = this.kit.style.anim;
    const gc = this.kit.glowColors;
    const seq = nextWallInstance();
    this.paintMesh(sh.static);
    this.leaf = sh.leaf ? this.paintMesh(sh.leaf) : null;
    if (sh.pick) addPickBox(this, sh.pick);
    this.emblem(sh.emblem, sh.onLeaf && this.leaf ? this.leaf : this);
    const layer = (name, color, opacity, visible = true) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { opacity, visible }) : null);
    this.beaconGlow = layer('beacon', gc.beacon, undefined, false);
    this.lightGlow = layer('light', gc.pulse, undefined, false);
    this.lineGlow = layer('line', gc.pulse, undefined);
    this.sheetGlow = layer('sheet', gc.pulse, WALL_ANIM.sheetOpacity);
    this.haloGlow = layer('halo', gc.pulse, WALL_ANIM.haloOpacity);
    this.sink = sh.sink;
    this.target = 0;          // 0 = closed, 1 = open (setOpen)
    this.openness = 0;        // visual state 0..1
    this.time = seq * WALL_ANIM.phaseStep;
    this.blink = new Blinker({ period: an.blink, duty: WALL_ANIM.blinkDuty, phase: (seq * WALL_ANIM.phaseStep) % 1 });
    this.pulseHz = an.pulse;
  }

  /** The gate opens (true) or closes (false); the model eases to it at WALL_ANIM.gateSpeed. Visual only. */
  setOpen(open) { this.target = open ? 1 : 0; }

  /** Target state (what setOpen asked for) */
  get isOpen() { return this.target === 1; }

  /** A moving leaf cannot be a frozen instance */
  enableBatching() {}

  /** Per-frame animation (numbers only, no allocations); `active` is unused */
  update(delta) {
    if (!this.shared) return;
    this.time += delta;
    const step = delta * WALL_ANIM.gateSpeed;
    if (this.target > this.openness) this.openness = Math.min(this.target, this.openness + step);
    else if (this.target < this.openness) this.openness = Math.max(this.target, this.openness - step);
    const eased = smootherstep(this.openness);
    if (this.leaf) {
      this.leaf.position.y = -this.sink * eased;
      this.leaf.visible = eased < 1;
    }
    const moving = this.openness > 0 && this.openness < 1;
    this.blink.update(delta, moving);
    const lit = moving ? (this.blink.on ? 1 : 0) : this.openness;   // blinking while it moves, steady when open, off when closed
    this.beaconGlow?.setIntensity(lit);
    const barrier = (1 - eased) * pulseWave(this.time, this.pulseHz);
    this.lightGlow?.setIntensity(lit);
    this.lineGlow?.setIntensity(1 - eased);
    this.sheetGlow?.setIntensity(barrier);
    this.haloGlow?.setIntensity(barrier);
  }
}
