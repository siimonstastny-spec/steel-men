// Steel Men – grid pathfinding around static obstacles (crewless mechs now, buildings later).
//
// The map is covered by a grid of PATHFINDING.cellSize cells. Obstacles come from "obstacle sources"
// (functions returning shapes), so new kinds of obstacles (buildings, rocks…) only need to register
// a source – see NavGrid.addObstacleSource. Each query inflates the obstacles by the moving unit's
// radius, so the unit's centre can be treated as a point. A* with 8 neighbours finds a cell path,
// which is then smoothed by line of sight against the exact (inflated) shapes. A free straight line
// skips A* completely.
//
// Shapes: { x, z, radius, owner }              – circle
//         { x, z, halfX, halfZ, owner }        – axis-aligned box (buildings)
// owner = the unit / building the shape belongs to (used to ignore the target of an order).
// rift: true = terrain rift (ASCII maps, '-'): blocks everybody except queries with crossRift (hover / air units).
// passTeam: team number = [H1] a passable gate of that team: queries of that team or an allied one (Alliances.areAllies)
//   skip the shape (the gate opens when they arrive); everybody else, queries without a team and obstacles() (building
//   placement, spawn spots) still see it. undefined = blocks everybody.
//
// [R2] Jet crossings (docs/notes/n6-jumpjet.md), straight runs of blocked cells (8 directions) from a free cell to the
// next free cell, centre-to-centre distance ≤ range, cost = length + penalty:
//   flyRange > 0 (JetPack 'flight'): over anything (walls, cliffs, rifts, buildings) – landing waypoint `fly = true`;
//   hopRange > 0 (JumpJet 'hopRun'): only over rift cells (a run touching any other obstacle is not a crossing) –
//                landing waypoint `hop = true`.
// When the landing is the goal itself, findPath returns `goalFly` / `goalHop`. Smoothing never skips a crossing: the
// obstacle between takeoff and landing blocks the line of sight.
//
// [A14-terrain] Terrain cost (setTerrain, findPath opts.terrainClass): per chassis class a grid of cell costs
// 1 / speed factor (resampled from the map's terrain type grid at the nav cell centres; factor 0 = impassable = blocked
// like BLOCK_SOLID). A step costs length × mean cost of its two cells; the heuristic is scaled by the cheapest cell of
// the grid (admissible). With a cost grid the straight line skips A* only when it costs no more than the cheapest
// possible walk, and line-of-sight smoothing only shortcuts when the straight leg costs no more than the planned cells
// (TERRAIN_COST.shortcutTolerance). A class whose cells all cost 1 has no grid (= old behaviour).
import * as THREE from 'three';
import { PATHFINDING, MECH_COLLISION, TERRAIN_COST } from '../config.js';
import { areAllies } from './Alliances.js';
import { terrainFactorByIndex, terrainRulesReady } from './TerrainTypes.js';

const SQRT2 = Math.SQRT2;
const EPSILON = 1e-9; // numeric guard against division by zero (not a tuning value)
const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, SQRT2], [1, -1, SQRT2], [-1, 1, SQRT2], [-1, -1, SQRT2],
];
// [R2] rasterized cell kinds and how a cell was entered (enum values, not tuning)
const BLOCK_SOLID = 1;
const BLOCK_RIFT = 2;
const SOLID_FIRST = [true, false];
const SIG_VALUES = 5; // [H1] refresh(): values per shape in the layout signature (x, z, radius|halfX, halfZ, passTeam)
const NO_PASS_TEAM = -1; // signature value of a shape without passTeam
const CROSS_FLY = 1;
const CROSS_HOP = 2;
const sameNum = (a, b) => a === b || (a !== a && b !== b);

export class NavGrid {
  // [N10] recycled buffers (no per-query allocation). Queries are synchronous and never nested, so one set is enough.
  #shapePool = [];       // inflated shape objects { x, z, radius, halfX, halfZ, rift } (circle: halfX/halfZ undefined; box: radius undefined)
  #shapes = [];          // the list handed out by #inflated / shapesFor: valid until the next call
  #blocked;              // rasterized cells
  #g;                    // A* cost
  #from;                 // A* parent
  #closed;               // A* closed flags
  #entry;                // [R2] how a cell was entered
  #seen;                 // #nearestFree visited flags
  #ringA = [];           // #nearestFree rings (swapped)
  #ringB = [];
  #heap = new MinHeap(); // A* open list
  #origin = new THREE.Vector3(); // #nearestFree scratch
  #centre = new THREE.Vector3();
  #sigValues = [];       // refresh(): rounded obstacle values of the last layout (SIG_VALUES per shape)
  #sigCount = 0;
  // [A14-terrain] per weighted class name: { cost: Float32Array (Infinity = impassable), minCost, impassable: Int32Array }
  // or absent (all cells cost 1). Built by setTerrain, read only by queries.
  #terrain = {};
  #pathG = [];           // [A14-terrain] findPath scratch: A* cost of each path point (smoothing)

  /**
   * @param {object} opts
   * @param {number} opts.size      map width = depth (units), the map is centred on 0,0
   * @param {number} [opts.cellSize]
   */
  constructor({ size, cellSize = PATHFINDING.cellSize }) {
    this.size = size;
    this.cellSize = cellSize;
    this.cols = Math.ceil(size / cellSize);
    this.half = size / 2;
    this.sources = [];
    this.version = 0;       // bumped whenever the obstacle layout changes -> units re-plan
    const cells = this.cols * this.cols;
    this.#blocked = new Uint8Array(cells);
    this.#g = new Float32Array(cells);
    this.#from = new Int32Array(cells);
    this.#closed = new Uint8Array(cells);
    this.#entry = new Uint8Array(cells);
    this.#seen = new Uint8Array(cells);
  }

  /**
   * Registers a function returning the current obstacle shapes (see file header).
   * Called on every query, so it should be cheap; return only static things (moving units are
   * handled by collisions, not by pathfinding).
   * @returns {Function} call it to unregister the source
   */
  addObstacleSource(fn) {
    this.sources.push(fn);
    this.version++;
    return () => { this.sources = this.sources.filter((s) => s !== fn); this.version++; };
  }

  obstacles() { return this._snapshot?.shapes ?? this.sources.flatMap((fn) => fn()); }

  /**
   * [A14-terrain] Builds the cost grids of the weighted classes (TERRAIN_COST.weightedClasses) from a terrain type grid
   * (TerrainTypes.TerrainTypeGrid, any cellSize / cols: sampled at the nav cell centres) and the current speed factors.
   * null = no terrain (every class uniform). Bumps `version` (units re-plan). Call at map load / after the rules changed.
   * @param {import('./TerrainTypes.js').TerrainTypeGrid|null} typeGrid
   */
  setTerrain(typeGrid) {
    this.#terrain = {};
    this.#typeGrid = typeGrid ?? null;
    this.#terrainBuilt = false;
    this.version++;
    this.#ensureTerrain();
  }

  #typeGrid = null;
  #terrainBuilt = false;

  // Grids are built on the first chance once stats.json is loaded (World.loadMap may run before loadStats in startGame);
  // every query goes through here, so the first query of the match builds them at the latest
  #ensureTerrain() {
    if (this.#terrainBuilt || !terrainRulesReady()) return this.#terrain;
    this.#terrainBuilt = true;
    const typeGrid = this.#typeGrid;
    if (!typeGrid) return this.#terrain;
    const n = this.cols;
    const cells = n * n;
    const c = this.cellSize;
    const types = new Uint8Array(cells);
    for (let i = 0; i < cells; i++) {
      types[i] = typeGrid.typeAt(((i % n) + 0.5) * c - this.half, (Math.floor(i / n) + 0.5) * c - this.half);
    }
    for (const cls of TERRAIN_COST.weightedClasses) {
      const cost = new Float32Array(cells);
      let minCost = Infinity;
      let uniform = true;
      let blockedCount = 0;
      for (let i = 0; i < cells; i++) {
        const f = terrainFactorByIndex(types[i], cls);
        const v = f > 0 ? 1 / f : Infinity;
        cost[i] = v;
        if (v !== 1) uniform = false;
        if (v === Infinity) blockedCount++;
        else if (v < minCost) minCost = v;
      }
      if (uniform) continue;
      const impassable = new Int32Array(blockedCount);
      for (let i = 0, k = 0; i < cells; i++) if (cost[i] === Infinity) impassable[k++] = i;
      this.#terrain[cls] = { cost, minCost: minCost === Infinity ? 1 : minCost, impassable };
    }
    return this.#terrain;
  }

  // Cost grid of a class for a query (undefined = uniform; TERRAIN_COST.weightedPath off = always uniform)
  #terrainOf(terrainClass) {
    if (!terrainClass || !TERRAIN_COST.weightedPath) return undefined;
    return this.#ensureTerrain()[terrainClass];
  }

  /**
   * [A14-terrain] Terrain cost of the straight segment a -> b for a class, in world units (length × sampled cell cost);
   * the plain length without a cost grid (or with TERRAIN_COST.weightedPath off). Infinity = crosses impassable terrain.
   */
  terrainSegmentCost(a, b, terrainClass) {
    const t = this.#terrainOf(terrainClass);
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    return t ? this.#segmentCost(a, b, t.cost) * this.cellSize : len;
  }

  /**
   * [A14-terrain] May a unit at `p` head straight to `next`, skipping the waypoint `via`? True without a cost grid;
   * otherwise when the straight leg costs no more than the walk over `via` (+ TERRAIN_COST.shortcutTolerance).
   * Obstacles are not checked here (segmentClear). No allocation.
   */
  shortcutOk(p, via, next, terrainClass) {
    const t = this.#terrainOf(terrainClass);
    if (!t) return true;
    const direct = this.#segmentCost(p, next, t.cost);
    if (direct === Infinity) return false;
    return direct <= (this.#segmentCost(p, via, t.cost) + this.#segmentCost(via, next, t.cost)) * (1 + TERRAIN_COST.shortcutTolerance);
  }

  // Cost of a -> b in cells: the segment cut into equal pieces of at most TERRAIN_COST.sampleStep cells, each weighted
  // by the cost of the cell under its middle
  #segmentCost(a, b, cost) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) / this.cellSize;
    if (len <= 0) return 0;
    const steps = Math.ceil(len / TERRAIN_COST.sampleStep);
    const piece = len / steps;
    let sum = 0;
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      sum += cost[this.#col(a.z + dz * t) * this.cols + this.#col(a.x + dx * t)];
    }
    return sum * piece;
  }

  /**
   * Runs `fn` with a frozen obstacle list: obstacles() is built once and reused by every query inside (e.g. hundreds
   * of canPlace tests of one AI spot search). Only for callers OUTSIDE the simulation tick (the AI thinks between
   * ticks, when nothing moves), so the shapes cannot change meanwhile and every answer is the same as without it.
   * The simulation never uses it. The snapshot is also dropped when `version` changes. Nested calls share it.
   */
  withObstacleSnapshot(fn) {
    if (this._snapshot && this._snapshot.version === this.version) return fn();
    const outer = this._snapshot ?? null;
    this._snapshot = { version: this.version, shapes: this.sources.flatMap((s) => s()) };
    try { return fn(); } finally { this._snapshot = outer; }
  }

  /** Call once per frame: bumps `version` when obstacles appeared, vanished or moved */
  refresh() {
    // [N10] same test as comparing a string of the rounded values, without building it every tick
    const prev = this.#sigValues;
    let n = 0;
    this.#sigChanged = false;
    const snap = this._snapshot?.shapes;
    if (snap) n = this.#signShapes(snap, n, prev);
    else for (let i = 0; i < this.sources.length; i++) n = this.#signShapes(this.sources[i](), n, prev);
    const changed = this.#sigChanged || n !== this.#sigCount;
    this.#sigCount = n;
    if (changed) this.version++;
  }

  #sigChanged = false;

  // Writes the rounded values of `list` into `prev` from shape index n (SIG_VALUES per shape); flags a difference to the old values
  // ([H1] passTeam included: a gate becoming passable for its team re-plans the paths)
  #signShapes(list, n, prev) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const v0 = Math.round(s.x), v1 = Math.round(s.z), v2 = Math.round(s.radius ?? s.halfX), v3 = Math.round(s.halfZ ?? 0);
      const v4 = s.passTeam ?? NO_PASS_TEAM;
      const o = n * SIG_VALUES;
      // (NaN compares equal to NaN, as it did in the string)
      if (!sameNum(prev[o], v0) || !sameNum(prev[o + 1], v1) || !sameNum(prev[o + 2], v2) || !sameNum(prev[o + 3], v3)
        || prev[o + 4] !== v4) this.#sigChanged = true;
      prev[o] = v0; prev[o + 1] = v1; prev[o + 2] = v2; prev[o + 3] = v3; prev[o + 4] = v4;
      n++;
    }
    return n;
  }

  /**
   * Plans a path for a unit's centre.
   * @param {{x:number,z:number}} from
   * @param {{x:number,z:number}} to
   * @param {object} [opts]
   * @param {number} [opts.radius]   radius of the moving unit (obstacles get inflated by it)
   * @param {Array}  [opts.ignore]   owners whose shapes do not count (the unit itself, its attack / board target)
   * @param {boolean} [opts.crossRift]  hover / air unit: rift shapes do not block it
   * @param {number} [opts.flyRange]   [R2] max flight length over any obstacle (units, 0 = cannot fly), see file header
   * @param {number} [opts.flyPenalty] [R2] extra cost of one flight (units)
   * @param {number} [opts.hopRange]   [R2] max hop length over rifts only (units, 0 = cannot hop)
   * @param {number} [opts.hopPenalty] [R2] extra cost of one hop (units)
   * @param {object} [opts.body]  [W7] the moving unit itself: its collision circles replace `radius` (see #inflated)
   * @param {number} [opts.team]  [H1] team of the moving unit (default body.team): own / allied gates do not block (passTeam)
   * @param {string} [opts.terrainClass]  [A14-terrain] chassis class (TerrainTypes.terrainClassOf): weights the path by
   *   that class's terrain cost grid (see file header); missing / unweighted class = uniform cost
   * @returns {{ waypoints: THREE.Vector3[], goal: THREE.Vector3, direct: boolean, goalFly: boolean, goalHop: boolean }}
   *   waypoints = intermediate points (without the goal); goal = where the unit can actually get –
   *   the target itself, or the nearest free spot when the target lies inside an obstacle.
   *   A waypoint with `fly` / `hop` = true (goalFly / goalHop) = the leg to that point is a flight / hop.
   */
  findPath(from, to, {
    radius = 0, ignore = [], crossRift = false, flyRange = 0, flyPenalty = 0, hopRange = 0, hopPenalty = 0, body = null, team = body?.team,
    terrainClass = null,
  } = {}) {
    const shapes = this.#inflated(radius, ignore, crossRift, body, team);
    // [A14-terrain] cost grid of the query's class (null = uniform, the code below then runs exactly as before A14)
    const terrain = this.#terrainOf(terrainClass) ?? null;
    const goal = new THREE.Vector3(to.x, 0, to.z);
    const none = (g) => ({ waypoints: [], goal: g, direct: true, goalFly: false, goalHop: false });
    if ((!shapes.length || this.segmentClear(from, goal, shapes)) && (!terrain || this.#cheapest(from, goal, terrain))) return none(goal);

    const blocked = this.#rasterize(shapes, terrain);
    const start = this.#cellOf(from);
    let end = this.#cellOf(goal);
    if (blocked[end] || insideAny(goal, shapes)) {
      end = this.#nearestFree(end, blocked, from, goal);
      if (end < 0) return none(new THREE.Vector3(from.x, 0, from.z));
      this.#cellCentre(end, goal);
    }

    // Unit pressed into an obstacle: first step out to the nearest free cell
    const free = this.#nearestFree(start, blocked, null, from);
    if (free < 0) return none(goal);
    const jets = {
      fly: Math.floor(flyRange / this.cellSize) >= 2 ? flyRange : 0,
      flyPenalty,
      hop: Math.floor(hopRange / this.cellSize) >= 2 ? hopRange : 0,
      hopPenalty,
      entry: null,
    };
    // [R2] how each cell was entered: CROSS_FLY / CROSS_HOP, 0 = walked
    if (jets.fly || jets.hop) jets.entry = this.#entry.fill(0);
    const cells = this.#astar(free, end, blocked, jets, terrain);
    if (free !== start) cells.unshift(start);
    const reachedEnd = cells[cells.length - 1] === end;
    const entry = jets.entry;
    const pathG = this.#pathG;
    pathG.length = 0;
    const points = cells.slice(1).map((c) => {
      const p = this.#cellCentre(c, new THREE.Vector3());
      if (entry?.[c] === CROSS_FLY) p.fly = true;
      else if (entry?.[c] === CROSS_HOP) p.hop = true;
      if (terrain) pathG.push(this.#g[c]); // [A14-terrain] A* cost to this point (cells), for the smoothing check
      return p;
    });
    const takeFlags = (src) => { if (src.fly) goal.fly = true; if (src.hop) goal.hop = true; };
    if (reachedEnd && points.length) { // exact goal instead of the cell centre
      takeFlags(points[points.length - 1]);
      points[points.length - 1] = goal;
    } else if (!reachedEnd) { // unreachable – go as close as possible
      if (points.length) {
        takeFlags(points[points.length - 1]);
        goal.copy(points[points.length - 1]);
        points[points.length - 1] = goal; // the goal object ends the list, so smoothing can clear its flags
      } else goal.set(from.x, 0, from.z);
    }
    if (!points.length) return none(goal);
    const smooth = this.#smooth(from, points, shapes, terrain);
    pathG.length = 0;
    smooth.pop(); // the last point is the goal
    return { waypoints: smooth, goal, direct: smooth.length === 0, goalFly: goal.fly === true, goalHop: goal.hop === true };
  }

  /** True when the straight segment a -> b does not cross any inflated shape */
  segmentClear(a, b, shapes) {
    for (let i = 0; i < shapes.length; i++) if (segmentHits(a, b, shapes[i])) return false;
    return true;
  }

  /** [A7b] True when the point (x, z) lies outside every shape (shapes from shapesFor) */
  pointClear(p, shapes) { return !insideAny(p, shapes); }

  /**
   * [A7b] Free distance from p along the unit direction (dx, dz) to the first shape (shapes from shapesFor), at most
   * maxDist; 0 when p lies inside a shape. Corridor width across a path = rayClearance(+side) + rayClearance(-side).
   * Read-only query, no allocation.
   */
  rayClearance(p, dx, dz, maxDist, shapes) {
    let best = maxDist;
    for (let i = 0; i < shapes.length; i++) {
      const s = shapes[i];
      if (inside(p, s)) return 0;
      const t = rayEntry(p.x, p.z, dx, dz, s);
      if (t < best) best = t;
    }
    return best;
  }

  /**
   * Inflated shapes for a unit of the given radius (also used to test line of sight while walking).
   * [W7] With `body` (the moving unit) each obstacle is inflated by the circle of the unit that touches it
   * (collisionReach); without it every obstacle is inflated by `radius` as before.
   * [H1] `team` (default body.team): gates passable for that team are left out (see passTeam in the file header).
   */
  shapesFor(radius, ignore = [], crossRift = false, body = null, team = body?.team) { return this.#inflated(radius, ignore, crossRift, body, team); }

  // ---------- internal ----------

  #inflated(radius, ignore, crossRift = false, body = null, team = undefined) {
    // [N10] shapes are written into recycled objects; the returned list is valid until the next call (all callers use it at once)
    const out = this.#shapes;
    let n = 0;
    const snap = this._snapshot?.shapes;
    if (snap) n = this.#inflateList(snap, n, radius, ignore, crossRift, body, team);
    else for (let i = 0; i < this.sources.length; i++) n = this.#inflateList(this.sources[i](), n, radius, ignore, crossRift, body, team);
    out.length = n;
    return out;
  }

  #inflateList(list, n, radius, ignore, crossRift, body, team) {
    const hasTeam = team !== undefined && team !== null;
    const clearance = PATHFINDING.clearance;
    const pool = this.#shapePool;
    const out = this.#shapes;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (ignore.includes(s.owner) || (crossRift && s.rift)) continue;
      if (hasTeam && s.passTeam !== undefined && areAllies(team, s.passTeam)) continue; // [H1] own / allied gate
      let own = s.radius;
      let pad = radius;
      if (body) {
        const owner = s.owner;
        if (owner?.isMech) { // a crewless mech: shoulders against mechs / tall units, legs against the rest
          own = collisionReach(owner, Boolean(body.isMech), body.bodyHeight ?? 0);
          pad = collisionReach(body, true, 0);
        } else pad = collisionReach(body, false, obstacleHeight(s));
      }
      pad += clearance;
      const o = pool[n] ??= { x: 0, z: 0, radius: undefined, halfX: undefined, halfZ: undefined, rift: false };
      o.x = s.x; o.z = s.z; o.rift = s.rift === true;
      if (s.radius !== undefined) { o.radius = own + pad; o.halfX = undefined; o.halfZ = undefined; }
      else { o.radius = undefined; o.halfX = s.halfX + pad; o.halfZ = s.halfZ + pad; }
      out[n++] = o;
    }
    return n;
  }

  // Cell values: 0 free, BLOCK_SOLID (any obstacle but a rift), BLOCK_RIFT (only rifts) – [R2] hops cross BLOCK_RIFT only
  // [A14-terrain] terrain (or null): its impassable cells (speed factor 0) are BLOCK_SOLID too
  #rasterize(shapes, terrain = null) {
    const n = this.cols;
    const blocked = this.#blocked.fill(0);
    const c = this.cellSize;
    for (let pass = 0; pass < SOLID_FIRST.length; pass++) for (let si = 0; si < shapes.length; si++) { // solid shapes first: a rift never downgrades a cell
      const solid = SOLID_FIRST[pass];
      const s = shapes[si];
      if (s.rift === solid) continue;
      const mark = solid ? BLOCK_SOLID : BLOCK_RIFT;
      const ex = s.radius ?? s.halfX;
      const ez = s.radius ?? s.halfZ;
      const x0 = this.#col(s.x - ex), x1 = this.#col(s.x + ex);
      const z0 = this.#col(s.z - ez), z1 = this.#col(s.z + ez);
      for (let iz = z0; iz <= z1; iz++) {
        for (let ix = x0; ix <= x1; ix++) {
          const i = iz * n + ix;
          if (!blocked[i] && insideXZ((ix + 0.5) * c - this.half, (iz + 0.5) * c - this.half, s)) blocked[i] = mark;
        }
      }
    }
    if (terrain) {
      const list = terrain.impassable;
      for (let k = 0; k < list.length; k++) if (!blocked[list[k]]) blocked[list[k]] = BLOCK_SOLID;
    }
    return blocked;
  }

  // [A14-terrain] Does the straight segment cost no more than walking it on the cheapest cells of the grid?
  #cheapest(a, b, terrain) {
    const len = Math.hypot(b.x - a.x, b.z - a.z) / this.cellSize;
    return this.#segmentCost(a, b, terrain.cost) <= len * terrain.minCost * (1 + TERRAIN_COST.shortcutTolerance);
  }

  // A* over the grid; returns the cell path (start first). Never enters a blocked cell.
  // Unreachable goal -> path to the reachable cell closest to it.
  // [R2] jets (or null): { fly, flyPenalty, hop, hopPenalty, entry } – crossing edges (see file header); entry marks
  // how each cell on the best path so far was entered.
  // [A14-terrain] terrain (or null): step cost × mean cell cost, heuristic × the grid's cheapest cell (stays admissible)
  #astar(start, end, blocked, jets = null, terrain = null) {
    const entry = jets?.entry ?? null;
    const n = this.cols;
    const g = this.#g.fill(Infinity);
    const from = this.#from.fill(-1);
    const closed = this.#closed.fill(0);
    const ex = end % n, ez = Math.floor(end / n);
    const cellCost = terrain ? terrain.cost : null;
    const hScale = terrain ? terrain.minCost : 1;
    const h = (i) => {
      const dx = Math.abs((i % n) - ex), dz = Math.abs(Math.floor(i / n) - ez);
      return (Math.max(dx, dz) + (SQRT2 - 1) * Math.min(dx, dz)) * hScale;
    };
    const open = this.#heap;
    open.clear();
    g[start] = 0;
    open.push(start, h(start));
    let best = start;
    let bestH = h(start);
    while (open.size) {
      const cur = open.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === end) { best = end; break; }
      const hc = h(cur);
      if (hc < bestH) { best = cur; bestH = hc; }
      const cx = cur % n, cz = Math.floor(cur / n);
      for (let k = 0; k < NEIGHBOURS.length; k++) {
        const nb = NEIGHBOURS[k];
        const dx = nb[0], dz = nb[1], cost = nb[2];
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const ni = nz * n + nx;
        if (blocked[ni] || closed[ni]) continue;
        // No corner cutting past a blocked cell
        if (dx && dz && (blocked[cz * n + nx] || blocked[nz * n + cx])) continue;
        const ng = g[cur] + (cellCost ? cost * (cellCost[cur] + cellCost[ni]) * 0.5 : cost);
        if (ng < g[ni]) { g[ni] = ng; from[ni] = cur; if (entry) entry[ni] = 0; open.push(ni, ng + h(ni)); }
      }
      if (jets?.fly) this.#crossEdges(cur, cx, cz, blocked, closed, g, from, entry, open, h, jets.fly, jets.flyPenalty, false);
      if (jets?.hop) this.#crossEdges(cur, cx, cz, blocked, closed, g, from, entry, open, h, jets.hop, jets.hopPenalty, true);
    }
    const path = [];
    for (let c = best; c >= 0; c = from[c]) path.push(c);
    return path.reverse();
  }

  // [R2] From a free cell, in each of the 8 directions whose first cell is blocked: walk over the blocked run to the
  // first free cell; when it is within range (centre to centre), it is a neighbour costing length + penalty.
  // riftOnly (hop): every cell of the run must be BLOCK_RIFT – a run touching a solid obstacle is no crossing.
  #crossEdges(cur, cx, cz, blocked, closed, g, from, entry, open, h, range, rangePenalty, riftOnly) {
    const n = this.cols;
    const penalty = rangePenalty / this.cellSize; // A* costs are in cells
    const mark = riftOnly ? CROSS_HOP : CROSS_FLY;
    for (let d = 0; d < NEIGHBOURS.length; d++) {
      const nb = NEIGHBOURS[d];
      const dx = nb[0], dz = nb[1], cost = nb[2];
      let nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const first = blocked[nz * n + nx];
      if (!first || (riftOnly && first !== BLOCK_RIFT)) continue; // walkable – a plain step / not a rift
      for (let k = 2; k * cost * this.cellSize <= range; k++) {
        nx += dx; nz += dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) break;
        const ni = nz * n + nx;
        if (blocked[ni]) {
          if (riftOnly && blocked[ni] !== BLOCK_RIFT) break;
          continue;
        }
        if (!closed[ni]) {
          const ng = g[cur] + k * cost + penalty;
          if (ng < g[ni]) { g[ni] = ng; from[ni] = cur; entry[ni] = mark; open.push(ni, ng + h(ni)); }
        }
        break; // the first free cell ends the run (no crossing over free ground)
      }
    }
  }

  // Greedy line-of-sight smoothing: from each anchor jump to the farthest visible point
  // [A14-terrain] with terrain: …whose straight leg costs no more than the planned cells (this.#pathG = A* cost per point)
  #smooth(from, points, shapes, terrain = null) {
    const out = [];
    const pathG = this.#pathG;
    const tol = 1 + TERRAIN_COST.shortcutTolerance;
    let anchor = from;
    let anchorG = 0;
    let i = 0;
    while (i < points.length) {
      let j = points.length - 1;
      while (j > i && (!this.segmentClear(anchor, points[j], shapes)
        || (terrain && this.#segmentCost(anchor, points[j], terrain.cost)
          > (pathG[j] - anchorG) * tol + TERRAIN_COST.shortcutSlack * terrain.minCost))) j--;
      if (terrain) anchorG = pathG[j];
      // [R2] a flight / hop landing seen in plain sight from the anchor is simply walked to
      if ((points[j].fly || points[j].hop) && (j > i || this.segmentClear(anchor, points[j], shapes))) {
        points[j].fly = false;
        points[j].hop = false;
      }
      out.push(points[j]);
      anchor = points[j];
      i = j + 1;
    }
    return out;
  }

  // Breadth-first search (ring by ring) for the free cell nearest to a blocked one. Rings are squares,
  // so once a free cell shows up, a few more rings are checked for a cell that is really (Euclidean)
  // nearer; `prefer` (the unit's position) slightly favours the side the unit comes from.
  #nearestFree(cell, blocked, prefer = null, point = null) {
    const n = this.cols;
    if (!blocked[cell]) return cell;
    const seen = this.#seen.fill(0);
    let ring = this.#ringA;
    let next = this.#ringB;
    ring.length = 0;
    ring.push(cell);
    seen[cell] = 1;
    const origin = point ? this.#origin.set(point.x, 0, point.z) : this.#cellCentre(cell, this.#origin);
    const centre = this.#centre;
    let best = -1;
    let bestScore = Infinity;
    let lastRing = Infinity;
    for (let k = 0; ring.length && k <= lastRing; k++) {
      for (let ri = 0; ri < ring.length; ri++) {
        const c = ring[ri];
        if (blocked[c]) continue;
        this.#cellCentre(c, centre);
        const score = centre.distanceTo(origin)
          + (prefer ? PATHFINDING.sidePreference * Math.hypot(centre.x - prefer.x, centre.z - prefer.z) : 0);
        if (score < bestScore) { best = c; bestScore = score; }
      }
      if (best >= 0 && lastRing === Infinity) lastRing = Math.ceil(k * SQRT2) + 1;
      next.length = 0;
      for (let ri = 0; ri < ring.length; ri++) {
        const cur = ring[ri];
        const cx = cur % n, cz = Math.floor(cur / n);
        for (let d = 0; d < NEIGHBOURS.length; d++) {
          const nx = cx + NEIGHBOURS[d][0], nz = cz + NEIGHBOURS[d][1];
          if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
          const ni = nz * n + nx;
          if (!seen[ni]) { seen[ni] = 1; next.push(ni); }
        }
      }
      const swap = ring; ring = next; next = swap;
    }
    return best;
  }

  #col(v) { return THREE.MathUtils.clamp(Math.floor((v + this.half) / this.cellSize), 0, this.cols - 1); }
  #cellOf(p) { return this.#col(p.z) * this.cols + this.#col(p.x); }
  #cellCentre(i, out) {
    const c = this.cellSize;
    return out.set(((i % this.cols) + 0.5) * c - this.half, 0, (Math.floor(i / this.cols) + 0.5) * c - this.half);
  }
}

// ---------- [W7] collision bodies ----------

/**
 * Radius of `unit` that touches another body (docs/notes/w7-crew-collision.md). A mech has two circles: its shoulder
 * circle (`radius`: body + arms) touches other mechs and anything at least as tall as its shoulders
 * (`shoulderHeight`), its foot circle (`footRadius`) touches everything lower. Other units have one circle (`radius`).
 * @param {object} unit
 * @param {boolean} otherIsMech  the other body is a mech
 * @param {number} otherHeight   height of the other body (units; Infinity = tall)
 */
export function collisionReach(unit, otherIsMech, otherHeight) {
  if (!unit.isMech || unit.footRadius === undefined) return unit.radius;
  return otherIsMech || otherHeight >= unit.shoulderHeight ? unit.radius : unit.footRadius;
}

/** Height of a pathfinding obstacle: own `height`, the building's height, 0 for a rift, else MECH_COLLISION default */
function obstacleHeight(s) {
  if (s.rift) return 0;
  return s.height ?? (s.owner?.isStructure ? s.owner.bodyHeight : undefined) ?? MECH_COLLISION.unknownObstacleHeight;
}

// ---------- geometry helpers ----------

function inside(p, s) {
  if (s.radius !== undefined) return Math.hypot(p.x - s.x, p.z - s.z) < s.radius;
  return Math.abs(p.x - s.x) < s.halfX && Math.abs(p.z - s.z) < s.halfZ;
}

function insideXZ(px, pz, s) {
  if (s.radius !== undefined) return Math.hypot(px - s.x, pz - s.z) < s.radius;
  return Math.abs(px - s.x) < s.halfX && Math.abs(pz - s.z) < s.halfZ;
}

function insideAny(p, shapes) {
  for (let i = 0; i < shapes.length; i++) if (inside(p, shapes[i])) return true;
  return false;
}

// [A7b] Distance along the ray (px, pz) + t·(dx, dz) (unit direction, start outside s) where it enters s; Infinity = never
function rayEntry(px, pz, dx, dz, s) {
  if (s.radius !== undefined) {
    const fx = px - s.x, fz = pz - s.z;
    const b = fx * dx + fz * dz;
    const c = fx * fx + fz * fz - s.radius * s.radius;
    const disc = b * b - c;
    if (disc < 0) return Infinity;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : Infinity;
  }
  let t0 = 0, t1 = Infinity;
  if (Math.abs(dx) < EPSILON) { if (Math.abs(px - s.x) >= s.halfX) return Infinity; } else {
    let ta = (s.x - s.halfX - px) / dx, tb = (s.x + s.halfX - px) / dx;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 >= t1) return Infinity;
  }
  if (Math.abs(dz) < EPSILON) { if (Math.abs(pz - s.z) >= s.halfZ) return Infinity; } else {
    let ta = (s.z - s.halfZ - pz) / dz, tb = (s.z + s.halfZ - pz) / dz;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 >= t1) return Infinity;
  }
  return t0;
}

/**
 * Does the segment a -> b enter shape s? A segment starting inside the shape only counts when it
 * heads deeper in (a unit pressed against an obstacle may still walk away from it).
 */
function segmentHits(a, b, s) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (s.radius !== undefined) {
    const fx = a.x - s.x, fz = a.z - s.z;
    if (fx * fx + fz * fz < s.radius * s.radius) return fx * dx + fz * dz < 0;
    const len2 = dx * dx + dz * dz || EPSILON;
    const t = THREE.MathUtils.clamp(-(fx * dx + fz * dz) / len2, 0, 1);
    return Math.hypot(fx + dx * t, fz + dz * t) < s.radius;
  }
  if (inside(a, s)) { // inside a box: allowed only if moving away from its centre
    return (a.x - s.x) * dx + (a.z - s.z) * dz < 0;
  }
  // Slab test against the box
  // x slab, then z slab (inline: no temporary arrays)
  let t0 = 0, t1 = 1;
  if (Math.abs(dx) < EPSILON) { if (Math.abs(a.x - s.x) >= s.halfX) return false; } else {
    let ta = (s.x - s.halfX - a.x) / dx, tb = (s.x + s.halfX - a.x) / dx;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  if (Math.abs(dz) < EPSILON) { if (Math.abs(a.z - s.z) >= s.halfZ) return false; } else {
    let ta = (s.z - s.halfZ - a.z) / dz, tb = (s.z + s.halfZ - a.z) / dz;
    if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 >= t1) return false;
  }
  return true;
}

// Minimal binary heap of (item, priority)
class MinHeap {
  constructor() { this.items = []; this.prio = []; }
  get size() { return this.items.length; }
  clear() { this.items.length = 0; this.prio.length = 0; }
  push(item, p) {
    const it = this.items, pr = this.prio;
    let i = it.length;
    it.push(item); pr.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pr[parent] <= p) break;
      it[i] = it[parent]; pr[i] = pr[parent];
      i = parent;
    }
    it[i] = item; pr[i] = p;
  }
  pop() {
    const it = this.items, pr = this.prio;
    const top = it[0];
    const lastItem = it.pop(), lastP = pr.pop();
    if (it.length) {
      let i = 0;
      const n = it.length;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= lastP) break;
        it[i] = it[c]; pr[i] = pr[c];
        i = c;
      }
      it[i] = lastItem; pr[i] = lastP;
    }
    return top;
  }
}
