// Steel Men – procedural Archeology Station (salvage / wreck analysis: a scanner gantry over a platform holding a find).
// Built in code from the style modules (ProcModules.js) and the faction style:
//   • simBody (stats.json): halfX 14.85 × halfZ 19.4, height ≈ 19 → pad ±14.85 × ±19.4 (front = +Z), the scanner rails at ≈ 16.5
//   • platform with a salvage find in the middle (crushed vehicle hull on a pedestal + a glowing xeno artifact), a frame of
//     four posts, two rails along Z and gate beams at both ends (the front one carries the emblem)
//   • silhouette: rounded (round posts, hazard marking, rounded deck) · angular (tapered armoured posts with spikes) ·
//     round (elliptic deck, posts with plasma caps) · faceted (octagonal deck, slanted blade posts, neon strips)
//   • scanner = a bridge across the rails that runs back and forth along Z (a carriage with a lens slides along it); under
//     it hangs a glowing scan sheet (vertical plane) with a bright line on the deck – both only while `active`.
//     Idle: the bridge parks at an end, the artifact and lens glow dimly.
// Visual only: update() takes the frame delta (× animScale from ProcModel.tick); no allocations there.
import { PartBuilder, GlowBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, styledBox, marking, neonStrip, beacon, spike, emblemDecalGeometry, pulseWave, teamTrim,
  roofMark,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; style.anim multiplies speeds) */
export const ARCHEOLOGY_ANIM = {
  sweepSpeed: 0.55,       // rad/s of the sweep phase (one pass front → back = π) while active
  carriageSpeed: 1.6,     // rad/s of the lens carriage on the bridge
  carriageIdle: 0.25,     // share of that speed while idle
  sheetOpacity: 0.07,     // opacity of the scan sheet fill (the find stays visible); edge + deck line use the full glow opacity
  sheetEase: 1.6,        // 1/s – scan sheet fades in / out
  idleGlow: 0.4,          // artifact / lens glow share while idle
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.43,        // s – pulse phase offset per instance
  jerkTicks: 40,          // style.anim.jerk > 0: the bridge position moves in steps of 1 / jerkTicks of the range
};

/** Shared layout (model units = world units; origin = centre of the footprint on the ground, front = +Z) */
const LAYOUT = {
  padHalfX: 14.85, padHalfZ: 19.4, padH: 0.2,    // = stats simBody halfX / halfZ
  deck: { halfX: 13.6, halfZ: 18.2, h: 1.0 },    // platform on the pad (top = padH + h)
  railX: 12.6,           // rails at x = ±railX
  railY: 15.5,           // centre height of the rails
  rail: { w: 1.0, h: 1.0 },
  post: { w: 1.4, z: 16.2 },
  gate: { h: 2.4, d: 1.0, decalSize: 2.2 },       // end beams across the frame (front carries the emblem)
  sweepRange: 14.2,      // bridge travel z = ±sweepRange (clear of the gate beams)
  neonMin: 0.3,
};

/** Scanner bridge, carriage and scan sheet (origin of the bridge = its centre on top of the rails) */
const BRIDGE = {
  beam: { h: 0.8, d: 1.6 },
  wheel: { w: 1.2, h: 0.5, d: 1.8 },
  emitter: { h: 0.7, d: 0.8, drop: 0.4 },        // bar under the bridge (drop = gap under the beam)
  lens: { h: 0.12, d: 0.5 },
  carriage: { w: 2.2, h: 1.1, d: 2.0, range: 9, lensR: 0.3 },
  sheet: { t: 0.12, topGap: 0.1, line: { h: 0.12, d: 0.9 } },
  teamLen: 0.3,          // share of the bridge length that is team paint (centre)
};

/** The find on the platform (static) */
const FIND = {
  pedestal: { r: 5.2, h: 0.5, seg: 24 },
  hull: { w: 9, h: 1.8, d: 4.2, rz: 0.12, ry: 0.5, x: -1, z: 0 },
  cab: { w: 3.2, h: 1.5, d: 3.6, x: -4.5, y: 1.2, z: 1.5, rz: -0.2, ry: 0.5 },
  wheel: { r: 0.9, w: 0.7, x: 1.8, z: -2.6 },
  artifact: { x: 3.4, z: 0.4, r: 0.9, y: 2.6, halo: 1.6, ringR: 1.7, ringTube: 0.1, stand: 0.25 },
  markY: 0.02,
};

/** Dimensions by style.silhouette (unknown → rounded) */
const DIM = {
  rounded: { slab: 'box', post: 'round', bridge: 'box', spikes: 0, edge: 0.8 },
  angular: { slab: 'taper', post: 'taper', bridge: 'box', spikes: 1.3, edge: 1 },
  round: { slab: 'ellipse', post: 'round', bridge: 'tube', spikes: 0, edge: 1 },
  faceted: { slab: 'octagon', post: 'blade', bridge: 'blade', spikes: 0, edge: 1 },
};

// ---------------------------------------------------------------- helpers (construction time only)

/** Pad + platform by kind; returns the deck top height */
function foundation(c, D) {
  const { b, S, kit } = c;
  const L = LAYOUT;
  const K = L.deck;
  const y0 = L.padH;
  b.box(L.padHalfX * 2, L.padH, L.padHalfZ * 2, S.ground, { base: true });
  if (D.slab === 'ellipse') {
    b.cylinder(1, 1, K.h, 40, S.hullDark, { y: y0 + K.h / 2, sx: K.halfX, sz: K.halfZ });
  } else if (D.slab === 'octagon') {
    const k = 1 / Math.cos(Math.PI / 8);
    b.cylinder(1, 1, K.h, 8, S.hullDark, { y: y0 + K.h / 2, ry: Math.PI / 8, sx: K.halfX * k, sz: K.halfZ * k });
  } else if (D.slab === 'taper') {
    b.taperedBox(K.halfX * 2 + 1.2, K.halfX * 2, K.h, K.halfZ * 2 + 1.2, S.hullDark, { y: y0 }, K.halfZ * 2);
  } else {
    styledBox(b, kit, K.halfX * 2, K.h, K.halfZ * 2, S.hullDark, { base: true, y: y0 }, D.edge);
  }
  return y0 + K.h;
}

/** Four posts + two rails + gate beams, all in team paint / frame as suits */
function frame(c, D, deckTop) {
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  const topY = L.railY - L.rail.h / 2;
  for (const sx of [-1, 1]) {
    // rail along Z
    b.box(L.rail.w, L.rail.h, L.post.z * 2 + L.post.w, S.frame, { x: sx * L.railX, y: L.railY });
    for (const sz of [-1, 1]) {
      const x = sx * L.railX;
      const z = sz * L.post.z;
      const h = topY - deckTop;
      if (D.post === 'round') {
        b.cylinder(L.post.w / 2, L.post.w / 2 + 0.2, h, 12, S.teamPaint, { x, y: deckTop + h / 2, z, detail: 2 });
        if (kit.style.neon >= L.neonMin) b.torus(L.post.w / 2 + 0.1, 0.06, 4, 16, TAU, S.neon, { rx: Math.PI / 2, x, y: deckTop + h * 0.4, z });
      } else if (D.post === 'taper') {
        b.taperedBox(L.post.w + 0.6, L.post.w - 0.3, h, L.post.w + 0.6, S.teamPaint, { x, y: deckTop, z, detail: 2 }, L.post.w - 0.3);
      } else {
        b.taperedBox(L.post.w, L.post.w * 0.55, h, L.post.w, S.teamPaint, { x, y: deckTop, z, ry: Math.PI / 4, detail: 2 }, L.post.w * 0.55);
        if (kit.rich) neonStrip(b, kit, 0.08, h * 0.8, 0.08, { x: x - sx * (L.post.w * 0.6), y: deckTop + h * 0.45, z });
      }
      beacon(b, glows.get('beaconA'), kit, [x, L.railY + L.rail.h / 2, z]);
      if (D.spikes > 0) spike(b, kit, { x: x + sx * 0.9, y: L.railY + L.rail.h / 2, z: z + sz * 0.9, h: D.spikes, r: 0.3 });
    }
  }
  // gate beams across both ends; the front one carries the emblem
  const G = L.gate;
  for (const e of [-1, 1]) {
    b.box(L.railX * 2 + L.rail.w, G.h, G.d, S.hull, { y: L.railY - L.rail.h / 2 + G.h / 2 - 0.6, z: e * L.post.z });
  }
  const gy = L.railY - L.rail.h / 2 + G.h / 2 - 0.6;
  c.decals.push({ position: [0, gy, L.post.z + G.d / 2 + 0.02], normal: [0, 0, 1], size: G.decalSize });
  marking(b, kit, 12, 0.5, { y: gy - G.h / 2 + 0.3, z: L.post.z + G.d / 2 + 0.03 });
}

/** The salvage find: wrecked hull on a pedestal and a glowing xeno artifact beside it */
function salvage(c, deckTop) {
  const { b, S, glows } = c;
  const F = FIND;
  const pg = glows.get('pulse');
  b.cylinder(F.pedestal.r, F.pedestal.r + 0.4, F.pedestal.h, F.pedestal.seg, S.frame, { y: deckTop + F.pedestal.h / 2 });
  const y = deckTop + F.pedestal.h;
  b.box(F.hull.w, F.hull.h, F.hull.d, S.lower, { x: F.hull.x, y: y + F.hull.h / 2 + 0.2, z: F.hull.z, rz: F.hull.rz, ry: F.hull.ry });
  b.box(F.cab.w, F.cab.h, F.cab.d, S.dark, { x: F.cab.x, y: y + F.cab.y, z: F.cab.z, rz: F.cab.rz, ry: F.cab.ry });
  b.cylinder(F.wheel.r, F.wheel.r, F.wheel.w, 10, S.rubber, { x: F.wheel.x, y: y + F.wheel.r, z: F.wheel.z, rz: Math.PI / 2 });
  const A = F.artifact;
  b.cylinder(A.stand, A.stand * 1.6, A.y - A.r, 8, S.trim, { x: A.x, y: y + (A.y - A.r) / 2, z: A.z });
  b.sphere(A.r, 14, 10, S.plasma, { x: A.x, y: y + A.y, z: A.z });
  b.torus(A.ringR, A.ringTube, 5, 24, TAU, S.trim, { ry: Math.PI / 2, x: A.x, y: y + A.y, z: A.z });
  pg.sphere(A.halo, 12, 8, { x: A.x, y: y + A.y, z: A.z });
}

// ---------------------------------------------------------------- animated parts

/** Scanner bridge: spans the rails, wheels, emitter bar with a lens strip (origin = centre of the beam) */
function bridgeGeometry(kit, D) {
  const S = kit.S;
  const L = LAYOUT;
  const B = BRIDGE;
  const len = L.railX * 2 + L.rail.w + 1.0;
  const b = new PartBuilder();
  if (D.bridge === 'tube') b.cylinder(B.beam.h * 0.6, B.beam.h * 0.6, len, 10, S.hullDark, { rz: Math.PI / 2 });
  else b.box(len, B.beam.h, B.beam.d, S.hullDark, {});
  b.box(len * B.teamLen, B.beam.h * 1.15, B.beam.d * 1.1, S.teamPaint, { detail: 2 });
  for (const s of [-1, 1]) b.box(B.wheel.w, B.wheel.h, B.wheel.d, S.frame, { x: s * L.railX, y: -B.beam.h / 2 + B.wheel.h / 2 - 0.1 });
  const ey = -B.beam.h / 2 - B.emitter.drop - B.emitter.h / 2;
  const elen = len - 3;
  if (D.bridge === 'blade') b.taperedBox(elen, elen - 6, B.emitter.h, B.emitter.d, S.frame, { y: ey - B.emitter.h / 2 }, B.emitter.d);
  else b.box(elen, B.emitter.h, B.emitter.d, S.frame, { y: ey });
  b.box(elen - 0.4, B.lens.h, B.lens.d, S.lens, { y: ey - B.emitter.h / 2 - B.lens.h / 2 + 0.02 });
  for (const s of [-1, 1]) b.box(0.3, B.emitter.drop + 0.2, 0.3, S.frame, { x: s * (elen / 2 - 0.4), y: -B.beam.h / 2 - B.emitter.drop / 2 });
  return { geometry: b.build(), lensY: ey - B.emitter.h / 2 - B.lens.h, elen };
}

/** Lens carriage that slides along the bridge (origin = its centre) */
function carriageGeometry(kit) {
  const S = kit.S;
  const C = BRIDGE.carriage;
  const b = new PartBuilder();
  b.box(C.w, C.h, C.d, S.hull, {});
  b.box(C.w * 1.04, C.h * 0.25, C.d * 1.04, S.teamPaint, { y: C.h * 0.15, detail: 2 });
  b.cylinder(C.lensR, C.lensR, 0.2, 10, S.lens, { y: -C.h / 2 - 0.08 });
  return b.build();
}

/** Scan sheet + deck line (additive; local to the bridge), and the lens halo of the carriage */
function sheetGeometry(bridgeY, lensY, deckTop, width) {
  const B = BRIDGE;
  const set = new GlowSet();
  const top = lensY - B.sheet.topGap;
  const bottom = deckTop - bridgeY + 0.1;
  set.get('sheet').box(width, top - bottom, B.sheet.t, { y: (top + bottom) / 2 });   // faint fill (low opacity layer)
  const edge = set.get('edge');                                                      // bright scan line on the deck + top edge
  edge.box(width, B.sheet.line.h, B.sheet.line.d, { y: bottom });
  edge.box(width, 0.18, B.sheet.t * 1.6, { y: top });
  return set.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(DIM, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const D = DIM[sil];
  const L = LAYOUT;
  const c = { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [] };
  const deckTop = foundation(c, D);
  teamTrim(c.b, kit, { y: deckTop, w: L.deck.halfX * 2 - 0.6, d: L.deck.halfZ * 2 - 0.6 }, { detail: 2 });
  roofMark(c.b, kit, { y: deckTop, z: L.deck.halfZ - 3.2, w: 8, d: 3 }, { detail: 2 });
  frame(c, D, deckTop);
  salvage(c, deckTop);
  const bridge = bridgeGeometry(kit, D);
  const bridgeY = L.railY + L.rail.h / 2 + BRIDGE.beam.h / 2;
  const width = bridge.elen - 1.0;
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    bridge: bridge.geometry,
    bridgeY,
    carriage: carriageGeometry(kit),
    carriageY: -BRIDGE.beam.h / 2 - BRIDGE.carriage.h / 2 - 0.05,
    sheet: sheetGeometry(bridgeY, bridge.lensY, deckTop, width),
    carriageLens: new GlowBuilder().point([0, 0, 0], BRIDGE.carriage.lensR * 1.8).build(),
  };
}

const ARCHEOLOGY_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class ArcheologyStationProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: ARCHEOLOGY_CACHE, name: 'ArcheologyStationProc' });
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
    const A = ARCHEOLOGY_ANIM;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);

    // scanner bridge (far LOD: frozen in its last pose), lens carriage, scan sheet (child of the bridge)
    this.bridge = this.paintMesh(sh.bridge, this, { far: true });
    this.bridge.position.set(0, sh.bridgeY, -LAYOUT.sweepRange);
    this.carriage = this.paintMesh(sh.carriage, this.bridge);
    this.carriage.position.y = sh.carriageY;
    this.sheet = this.glowLayer(sh.sheet.sheet, gc.beam, { parent: this.bridge, visible: false, opacity: ARCHEOLOGY_ANIM.sheetOpacity });
    this.sheetEdge = this.glowLayer(sh.sheet.edge, gc.beam, { parent: this.bridge, visible: false });
    this.carriageGlow = this.glowLayer(sh.carriageLens, gc.beam, { parent: this.carriage });
    this.carriageGlow.mesh.position.y = -BRIDGE.carriage.h / 2 - 0.1;

    this.phase = 0;                       // sweep phase: z = −range · cos(phase); idle holds at a multiple of π
    this.carriagePhase = seq * 1.3;
    this.sheetLevel = 0;
    this.time = seq * A.phaseStep;
    this.jerkStep = an.jerk > 0 ? 1 / A.jerkTicks : 0;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). Active: the bridge sweeps along the platform (front ↔ back), the scan sheet shines
   * and the carriage lens slides across; idle: the bridge finishes its pass, parks at the end, the sheet fades out.
   * @param {number} delta   seconds (× animScale)
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = ARCHEOLOGY_ANIM;
    this.time += delta;

    const step = delta * A.sweepSpeed * an.spin;
    let moving = active;
    if (active) this.phase = (this.phase + step) % TAU;   // wrapped: z = −range · cos(phase) is 2π-periodic, the ends (multiples of π) stay
    else {
      const park = Math.ceil(this.phase / Math.PI - 1e-6) * Math.PI;   // next end of the track
      moving = this.phase < park;
      this.phase = Math.min(park, this.phase + step);
    }
    let t = 0.5 - 0.5 * Math.cos(this.phase);   // 0 = rear end, 1 = front end
    if (this.jerkStep > 0) t = Math.round(t / this.jerkStep) * this.jerkStep;
    this.bridge.position.z = -LAYOUT.sweepRange + 2 * LAYOUT.sweepRange * t;

    this.carriagePhase += delta * A.carriageSpeed * an.spin * (moving ? 1 : A.carriageIdle);
    this.carriage.position.x = Math.sin(this.carriagePhase) * BRIDGE.carriage.range;

    this.sheetLevel += ((moving ? 1 : 0) - this.sheetLevel) * Math.min(1, delta * A.sheetEase);
    const glow = pulseWave(this.time, an.pulse) * (active ? 1 : A.idleGlow);
    const sweepGlow = this.sheetLevel * pulseWave(this.time * 2, an.pulse, 0.2);
    this.sheet.setIntensity(sweepGlow);
    this.sheetEdge.setIntensity(sweepGlow);
    this.carriageGlow.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
