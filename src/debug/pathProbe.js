// Steel Men – pathfinding probe [pathfinding-v2] (docs/notes/pathfinding-v2.md). Debug code only: builds its own
// NavGrid instances with fixed obstacle layouts (never touches world / commandBus) and measures findPath for a unit of
// the HoverTruck's radius – path length vs an ideal polyline, A* expanded nodes, exact edge tests, time per query –
// once with the old centre sampling (PATHFINDING.exactEdges = false) and once with the exact edges.
// Browser console (no main.js entry needed):
//   const p = await import('./src/debug/pathProbe.js'); p.runPathProbe();            – console.table + returned rows
//   p.runPathProbe({ repeats: 200, offsets: [0, 3.5] }); p.runPathProbe({ only: 'tower' })
// runPathProbeRows(opts) is the same without printing (pure logic over NavGrid; wall-clock time only for the printout).
import { PATHFINDING } from '../config.js';
import { NavGrid } from '../game/Pathfinding.js';
import { getStats } from '../data/Stats.js';

const PROBE_MAP_SIZE = 400;       // units – own grid, centred on 0,0
const FALLBACK_RADIUS = 4.3;      // HoverTruck simBody.radius when stats.json is not loaded
const DEFAULT_REPEATS = 50;       // findPath calls per row for the time column
const DEFAULT_OFFSETS = [0, 1.75, 3.5, 5.25]; // units – whole layout shifted by (o, o): grid alignment variants
const GAP_FACTORS = [1.3, 1.5, 1.75, 2.0];    // gap = factor × truck diameter (S1, S2, S3)
const BASE_GAPS = [13.4, 16, 17.6];           // units – street width between base buildings (S5)
const DETOUR_RATIO = 1.15;        // length / ideal above this = the path went around
const BUILDER_RANGE_FALLBACK = 10;

/**
 * @param {object} [opts]
 * @param {number} [opts.radius]   unit radius (default HoverTruck from stats.json)
 * @param {number} [opts.repeats]
 * @param {number[]} [opts.offsets]
 * @param {string} [opts.only]    scenario name filter: 'buildings' | 'wall' | 'corner' | 'base' | 'tower'
 * @returns {object[]} rows
 */
export function runPathProbe(opts = {}) {
  const rows = runPathProbeRows(opts);
  console.table(rows);
  console.log(summarize(rows));
  return rows;
}

export function runPathProbeRows({ radius = truckRadius(), repeats = DEFAULT_REPEATS, offsets = DEFAULT_OFFSETS, only = null } = {}) {
  const infl = radius + PATHFINDING.clearance;
  const reachDist = builderRange() + radius;
  const cases = [];
  for (const f of GAP_FACTORS) cases.push(buildingsCase(f * 2 * radius, infl, f));
  for (const f of GAP_FACTORS) cases.push(wallCase(f * 2 * radius, infl, f));
  for (const f of GAP_FACTORS) cases.push(cornerCase(f * 2 * radius, f));
  for (const g of BASE_GAPS) cases.push(baseCase(g));
  cases.push(towerCase(true, reachDist), towerCase(false, reachDist));
  const rows = [];
  const saved = PATHFINDING.exactEdges;
  try {
    for (const c of cases) {
      if (only && c.kind !== only) continue;
      for (const off of offsets) {
        for (const exact of [false, true]) {
          PATHFINDING.exactEdges = exact;
          rows.push(measure(c, off, exact, radius, repeats));
        }
      }
    }
  } finally {
    PATHFINDING.exactEdges = saved;
  }
  return rows;
}

// ---------- scenarios (shapes = raw obstacles; ideal = polyline the best path follows) ----------

// S1 two buildings side by side, gap along z; the unit crosses diagonally (the straight line hits the buildings)
function buildingsCase(gap, infl, f) {
  const hx = 20, hz = 12;
  return {
    kind: 'buildings', name: `S1 buildings gap ${f}×D`,
    shapes: [box(-(hx + gap / 2), 0, hx, hz), box(hx + gap / 2, 0, hx, hz)],
    from: { x: -30, z: -45 }, to: { x: 30, z: 45 },
    ideal: [{ x: -30, z: -45 }, { x: 0, z: -(hz + infl) }, { x: 0, z: hz + infl }, { x: 30, z: 45 }],
  };
}

// S2 a wall line (posts + thin segments) with a gap between two posts
function wallCase(gap, infl, f) {
  const post = 2.5, seg = 40, thick = 1;
  const px = gap / 2 + post;
  return {
    kind: 'wall', name: `S2 wall gap ${f}×D`,
    shapes: [box(-px, 0, post, post), box(px, 0, post, post),
      box(-(px + post + seg), 0, seg, thick), box(px + post + seg, 0, seg, thick)],
    from: { x: -25, z: -30 }, to: { x: 25, z: 30 },
    ideal: [{ x: -25, z: -30 }, { x: 0, z: -(post + infl) }, { x: 0, z: post + infl }, { x: 25, z: 30 }],
  };
}

// S3 two buildings meeting corner to corner (base corner): the passage runs diagonally between the two corners
function cornerCase(gap, f) {
  const h = 15;
  const s = gap / (2 * Math.SQRT2); // corners at (-s, s) and (s, -s), gap = their distance
  return {
    kind: 'corner', name: `S3 corner gap ${f}×D`,
    shapes: [box(-(h + s), h + s, h, h), box(h + s, -(h + s), h, h)],
    from: { x: -40, z: -20 }, to: { x: 20, z: 40 },
    ideal: [{ x: -40, z: -20 }, { x: 0, z: 0 }, { x: 20, z: 40 }],
  };
}

// S5 3×3 block of base buildings with streets of width `gap`; from the west along a street, then north
function baseCase(gap) {
  const h = 10, pitch = 2 * h + gap, street = h + gap / 2;
  const shapes = [];
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) shapes.push(box(i * pitch, j * pitch, h, h));
  const far = pitch + h + 25;
  return {
    kind: 'base', name: `S5 base streets ${gap} u`,
    shapes,
    from: { x: -far, z: -street }, to: { x: street, z: far },
    ideal: [{ x: -far, z: -street }, { x: street, z: -street }, { x: street, z: far }],
  };
}

// S4 tower on a wall post. pocket = the builder's (north) side is closed by a U of buildings: its free cells lie
// nearest to the tower but cannot be reached – the builder must use the south side, around the wall end.
function towerCase(pocket, reachDist) {
  const post = 2.5, seg = 15, thick = 1;
  const shapes = [box(0, 0, post, post), box(-(post + seg), 0, seg, thick), box(post + seg, 0, seg, thick)];
  if (pocket) shapes.push(box(-17, 11.5, 5, 10.5), box(17, 11.5, 5, 10.5), box(0, 19.5, 12, 2.5));
  return {
    kind: 'tower', name: pocket ? 'S4 tower, own side closed' : 'S4 tower, open',
    shapes, from: { x: 0, z: 40 }, to: { x: 0, z: 0 },
    reach: { x: 0, z: 0, halfX: post, halfZ: post, dist: reachDist },
    ideal: null,
  };
}

// ---------- measuring ----------

function measure(c, off, exact, radius, repeats) {
  const nav = new NavGrid({ size: PROBE_MAP_SIZE });
  const shapes = c.shapes.map((s) => ({ ...s, x: s.x + off, z: s.z + off, owner: null }));
  nav.addObstacleSource(() => shapes);
  const from = { x: c.from.x + off, z: c.from.z + off };
  const to = { x: c.to.x + off, z: c.to.z + off };
  const reach = c.reach ? { ...c.reach, x: c.reach.x + off, z: c.reach.z + off } : null;
  const queryOpts = { radius, reach: exact ? reach : null }; // 'old' = the state before v2: no reach (nearest free spot)
  const res = nav.findPath(from, to, queryOpts);
  const expanded = nav.stats.expanded;
  const edgeTests = nav.stats.edgeTests;
  const t0 = performance.now();
  for (let k = 0; k < repeats; k++) nav.findPath(from, to, queryOpts);
  const usPerQuery = ((performance.now() - t0) * 1000) / Math.max(1, repeats);
  const length = polyLength([from, ...res.waypoints, res.goal]);
  const row = {
    scenario: c.name, offset: off, mode: exact ? 'exact' : 'old',
    length: round(length), ideal: null, ratio: null, detour: null,
    expanded, edgeTests, us: round(usPerQuery), waypoints: res.waypoints.length,
  };
  if (c.ideal) {
    const ideal = polyLength(c.ideal);
    row.ideal = round(ideal);
    row.ratio = round(length / ideal);
    row.detour = length / ideal > DETOUR_RATIO;
  }
  if (reach) { // S4: does the stand spot lie within the builder's reach (else the builder waits forever)?
    const g = res.goal;
    const d = Math.hypot(Math.max(Math.abs(g.x - reach.x) - reach.halfX, 0), Math.max(Math.abs(g.z - reach.z) - reach.halfZ, 0));
    row.inReach = d <= reach.dist;
    row.side = g.z - reach.z >= 0 ? 'north' : 'south';
  }
  return row;
}

function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const k = r.mode;
    by[k] ??= { rows: 0, detours: 0, expanded: 0, edgeTests: 0, us: 0, outOfReach: 0 };
    const b = by[k];
    b.rows++; b.expanded += r.expanded; b.edgeTests += r.edgeTests; b.us += r.us;
    if (r.detour) b.detours++;
    if (r.inReach === false) b.outOfReach++;
  }
  return Object.entries(by).map(([k, b]) => `${k}: ${b.rows} runs, ${b.detours} detours, ${b.outOfReach} stand spots out of reach, `
    + `expanded Σ ${b.expanded}, edge tests Σ ${b.edgeTests}, time Σ ${round(b.us)} µs`).join('\n');
}

const box = (x, z, halfX, halfZ) => ({ x, z, halfX, halfZ });
const round = (v) => Math.round(v * 100) / 100;

function polyLength(points) {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return sum;
}

function truckRadius() {
  try { return getStats()?.vehicles?.hoverTruck?.simBody?.radius ?? FALLBACK_RADIUS; } catch { return FALLBACK_RADIUS; }
}

function builderRange() {
  try { return getStats()?.rules?.construction?.builderRange ?? BUILDER_RANGE_FALLBACK; } catch { return BUILDER_RANGE_FALLBACK; }
}
