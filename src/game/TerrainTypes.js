// [A8-terrain] Terrain type layer of a map (data only, no three.js).
// Format of the map file keys "terrainTypes" / "lavaCracks": see MAP_TERRAIN in src/config.js and data/README.md.
// [A14-terrain] Speed factor per terrain type and chassis class (stats.json rules.terrain.speed, TERRAIN_COST in config.js):
// Movement scales each ground unit's speed limit by it, NavGrid weights A* with 1 / factor.
import { MAP_TERRAIN, PATHFINDING, TERRAIN_COST } from '../config.js';
import { getStats } from '../data/Stats.js';

const TYPES = MAP_TERRAIN.types;
const DEFAULT_INDEX = Math.max(0, TYPES.indexOf(MAP_TERRAIN.defaultType));
// code character -> type index
const INDEX_OF_CODE = new Map(TYPES.map((name, i) => [MAP_TERRAIN.codes[name], i]));
const CODE_OF_INDEX = TYPES.map((name) => MAP_TERRAIN.codes[name]);
const DIGIT = /[0-9]/;

function solidGrid(cols, reason) {
  console.warn(`[A8-terrain] ${reason} – terrain layer is all '${MAP_TERRAIN.defaultType}'`);
  return new Uint8Array(cols * cols).fill(DEFAULT_INDEX);
}

/**
 * RLE rows ("<count><code>" pairs, count omitted = 1) -> Uint8Array(cols*cols) of MAP_TERRAIN.types indices.
 * Wrong / short data -> all solid + one console.warn.
 * @param {string[]} rows
 * @param {number} cols
 */
export function decodeTerrainRows(rows, cols) {
  if (!Number.isInteger(cols) || cols <= 0) return new Uint8Array(0);
  if (!Array.isArray(rows) || rows.length !== cols) return solidGrid(cols, `expected ${cols} rows, got ${rows?.length}`);
  const out = new Uint8Array(cols * cols);
  for (let r = 0; r < cols; r++) {
    const line = String(rows[r]);
    let c = 0;
    let count = '';
    for (let k = 0; k < line.length; k++) {
      const ch = line[k];
      if (DIGIT.test(ch)) { count += ch; continue; }
      const idx = INDEX_OF_CODE.get(ch);
      const n = count === '' ? 1 : Number(count);
      count = '';
      if (idx === undefined || n <= 0 || c + n > cols) return solidGrid(cols, `bad data in row ${r}`);
      out.fill(idx, r * cols + c, r * cols + c + n);
      c += n;
    }
    if (count !== '' || c !== cols) return solidGrid(cols, `row ${r} has ${c} of ${cols} cells`);
  }
  return out;
}

/**
 * Uint8Array(cols*cols) of type indices -> RLE rows (tools / tests).
 * @param {Uint8Array|number[]} data
 * @param {number} cols
 * @returns {string[]}
 */
export function encodeTerrainRows(data, cols) {
  const rows = [];
  for (let r = 0; r < cols; r++) {
    let line = '';
    let c = 0;
    while (c < cols) {
      const v = data[r * cols + c];
      let n = 1;
      while (c + n < cols && data[r * cols + c + n] === v) n++;
      line += (n > 1 ? n : '') + (CODE_OF_INDEX[v] ?? CODE_OF_INDEX[DEFAULT_INDEX]);
      c += n;
    }
    rows.push(line);
  }
  return rows;
}

/** Terrain type per grid cell; the grid is centred on 0,0 like NavGrid (column 0 = −X, row 0 = −Z) */
export class TerrainTypeGrid {
  /**
   * @param {object} opts
   * @param {number} opts.size      map width = depth (units)
   * @param {number} opts.cellSize  units per cell
   * @param {number} opts.cols      cells per side
   * @param {Uint8Array} [opts.data] cols*cols type indices (missing / wrong length = all solid)
   */
  constructor({ size, cellSize, cols, data }) {
    this.size = size;
    this.half = size / 2;
    this.cellSize = cellSize;
    this.cols = cols;
    this.data = data && data.length === cols * cols ? data : new Uint8Array(cols * cols).fill(DEFAULT_INDEX);
  }

  /** Type index (MAP_TERRAIN.types) at a world point; outside the grid = solid */
  typeAt(x, z) {
    const c = Math.floor((x + this.half) / this.cellSize);
    const r = Math.floor((z + this.half) / this.cellSize);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.cols) return DEFAULT_INDEX;
    return this.data[r * this.cols + c];
  }

  /** Type name at a world point */
  nameAt(x, z) { return TYPES[this.typeAt(x, z)]; }
}

function gridGeometry(map) {
  const cellSize = map.ascii ? map.ascii.cellSize : PATHFINDING.cellSize;
  const cols = map.ascii ? map.ascii.cols : Math.ceil(map.size / cellSize);
  return { size: map.size, cellSize, cols };
}

/**
 * Terrain type grid of a loaded GameMap from map.def.terrainTypes (missing key = all solid, silently;
 * wrong cellSize / cols = all solid + warn).
 * @param {import('./Map.js').GameMap} map
 */
export function terrainGridForMap(map) {
  const geo = gridGeometry(map);
  const def = map.def?.terrainTypes;
  if (!def) return new TerrainTypeGrid(geo);
  if (def.cols !== geo.cols || (def.cellSize !== undefined && def.cellSize !== geo.cellSize)) {
    return new TerrainTypeGrid({ ...geo, data: solidGrid(geo.cols, `map ${map.id}: terrainTypes ${def.cols}×${def.cellSize} ≠ grid ${geo.cols}×${geo.cellSize}`) });
  }
  return new TerrainTypeGrid({ ...geo, data: decodeTerrainRows(def.rows, geo.cols) });
}

/**
 * Lava fissures of a map in world units: [{ points: [{ x, z }, …], width }] (points and width in units);
 * map.def.lavaCracks points / width are in grid cells (cell centre = col + 0.5). No key = [].
 * @param {import('./Map.js').GameMap} map
 */
export function lavaCracksForMap(map) {
  const list = map.def?.lavaCracks;
  if (!Array.isArray(list)) return [];
  const { size, cellSize } = gridGeometry(map);
  const half = size / 2;
  const out = [];
  for (const crack of list) {
    if (!Array.isArray(crack?.points) || crack.points.length < 2) continue;
    out.push({
      points: crack.points.map(([c, r]) => ({ x: (c + 0.5) * cellSize - half, z: (r + 0.5) * cellSize - half })),
      width: (Number(crack.width) || 1) * cellSize,
    });
  }
  return out;
}

// ---------- [A14-terrain] terrain difficulty ----------

const CLASSES = TERRAIN_COST.classes;
const CLASS_COUNT = CLASSES.length;
const CLASS_INDEX = Object.fromEntries(CLASSES.map((c, i) => [c, i]));
const UNWEIGHTED_INDEX = CLASS_INDEX[TERRAIN_COST.unweightedClass] ?? -1;
let factorTable = null; // Float32Array(types × classes), index typeIndex * CLASS_COUNT + classIndex; built from stats.json

// rules.terrain.speed -> factor table (missing / not a number = 1, negative = 0 = impassable, air class always 1)
function buildFactorTable() {
  let speed = null;
  try { speed = getStats().rules?.terrain?.speed ?? null; } catch { return null; } // stats not loaded yet (menu): no cache
  const table = new Float32Array(TYPES.length * CLASS_COUNT).fill(1);
  for (let t = 0; t < TYPES.length; t++) {
    const row = speed?.[TYPES[t]];
    if (!row) continue;
    for (let c = 0; c < CLASS_COUNT; c++) {
      if (c === UNWEIGHTED_INDEX) continue;
      const v = Number(row[CLASSES[c]]);
      if (Number.isFinite(v)) table[t * CLASS_COUNT + c] = Math.max(0, v);
    }
  }
  return table;
}

function factors() { return factorTable ??= buildFactorTable(); }

/** True once the factor table could be built (stats.json loaded); before that every factor reads 1 */
export function terrainRulesReady() { return factors() !== null; }

/**
 * Re-reads rules.terrain from stats.json (after the data was changed in memory). World.applyTerrainRules() also
 * rebuilds the path cost grids; call that one in a running match.
 */
export function refreshTerrainRules() { factorTable = buildFactorTable(); }

/**
 * Chassis class of a unit from its stats: mechs and crews (stats with loadCapacity / squadSize) = 'legs';
 * mobility.movementType 'hover' / 'air' = that class; other ground vehicles = mobility.chassis ('wheels' | 'tracks'),
 * missing = 'tracks'. No stats / no mobility = 'legs'.
 * @param {object} stats  final unit stats (unit.stats)
 * @returns {'legs'|'wheels'|'tracks'|'hover'|'air'}
 */
export function terrainClassOf(stats) {
  const m = stats?.mobility;
  if (!m || stats.loadCapacity !== undefined || stats.squadSize !== undefined) return TERRAIN_COST.legsClass;
  if (TERRAIN_COST.movementClasses.includes(m.movementType)) return m.movementType;
  return CLASS_INDEX[m.chassis] !== undefined ? m.chassis : TERRAIN_COST.defaultChassis;
}

/**
 * Speed factor of a terrain type for a chassis class (1 = full speed, 0 = impassable; unknown type / class = 1).
 * @param {string} typeName  MAP_TERRAIN.types entry
 * @param {string} cls       terrainClassOf result
 */
export function terrainSpeedFactor(typeName, cls) {
  const t = TYPES.indexOf(typeName);
  const c = CLASS_INDEX[cls];
  if (t < 0 || c === undefined) return 1;
  const table = factors();
  return table ? table[t * CLASS_COUNT + c] : 1;
}

/** Same as terrainSpeedFactor by type index / class name (no string search; simulation hot path) */
export function terrainFactorByIndex(typeIndex, cls) {
  const c = CLASS_INDEX[cls];
  const table = factors();
  if (!table || c === undefined || typeIndex < 0 || typeIndex >= TYPES.length) return 1;
  return table[typeIndex * CLASS_COUNT + c];
}

/**
 * Speed factor of the terrain under a unit (world.terrainTypes at its position, its chassis class); 1 without a layer.
 * Raw data value: 0 = impassable (Movement drives with TERRAIN_COST.escapeFactor there). No allocation.
 * @param {object} unit  { position, stats, world }
 */
export function unitTerrainFactor(unit) {
  const grid = unit.world?.terrainTypes;
  if (!grid) return 1;
  return terrainFactorByIndex(grid.typeAt(unit.position.x, unit.position.z), terrainClassOf(unit.stats));
}
