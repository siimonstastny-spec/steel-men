// Steel Mans – ASCII map grid -> map data (used by GameMap for files with a "rows" array, see docs/notes/maps.md).
//
//   '#' wall (high, impassable)     '?' grass        '.' concrete
//   'S' start (touching S cells = one start)          '-' rift: only hover / air units cross it
//   'o' / '+' ore field (connected area = one field; deposits are placed on '+' cells from the match seed)
// Row 0 is the top of the minimap (−Z), column 0 the left edge (−X). One character = MAPS.ascii.cellSize units
// (file may override with "cellSize"). Short rows and non-square grids are padded with MAPS.ascii.padChar.
// Everything here is pure data and deterministic (no Math.random): the same file + seed gives the same map.
import { MAPS } from '../config.js';

export const CELL = { grass: 0, concrete: 1, wall: 2, field: 3, fieldCore: 4, rift: 5 };
const CFG = MAPS.ascii;

/** Small deterministic generator (mulberry32) */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of any values (numbers / strings) -> uint32 seed */
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const ch of parts.map(String).join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return h >>> 0;
}

/**
 * Parses an ASCII map definition.
 * @param {object} def  map file: { rows: string[], cellSize?, superNode?: 'auto'|'none'|{col,row}, deposit?, superNodeOptions?, seed? }
 * @param {string} id   map id (part of the deposit seed)
 */
export function parseAsciiMap(def, id) {
  const ch = CFG.chars;
  const cellSize = def.cellSize ?? CFG.cellSize;
  const raw = def.rows.map((r) => String(r));
  const n = Math.max(raw.length, ...raw.map((r) => r.length));
  const padTop = Math.floor((n - raw.length) / 2);
  const rows = Array.from({ length: n }, (_, r) => {
    const line = raw[r - padTop] ?? '';
    const left = Math.floor((n - line.length) / 2);
    return CFG.padChar.repeat(left) + line + CFG.padChar.repeat(n - line.length - left);
  });
  const size = n * cellSize;
  const half = size / 2;
  const grid = new Uint8Array(n * n);
  const startCells = new Uint8Array(n * n);
  const typeOf = { [ch.wall]: CELL.wall, [ch.concrete]: CELL.concrete, [ch.field]: CELL.field, [ch.fieldCore]: CELL.fieldCore, [ch.rift]: CELL.rift };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const k = rows[r][c];
      grid[r * n + c] = typeOf[k] ?? CELL.grass; // grass, start and unknown characters are walkable grass
      if (k === ch.start) startCells[r * n + c] = 1;
    }
  }
  const centreX = (c) => (c + 0.5) * cellSize - half;
  const centreZ = (r) => (r + 0.5) * cellSize - half;
  const map = { id, cellSize, cols: n, size, half, grid, centreX, centreZ };

  // Walls -> axis-aligned ridge boxes (greedy rectangles), rifts -> boxes the pathfinding marks as rift
  const rand = seededRandom(hashSeed('walls', id));
  map.obstacles = rectangles(grid, n, CELL.wall).map((b) => ({
    type: 'ridge', ...box(b, cellSize, half),
    height: CFG.wallHeight * (1 + (rand() * 2 - 1) * CFG.wallHeightJitter),
  }));
  map.rifts = rectangles(grid, n, CELL.rift).map((b) => ({ ...box(b, cellSize, half), rift: true }));

  // Starts: 8-connected groups of S cells, in reading order, pushed away from walls
  map.startPositions = components(startCells, n, 1, true).map((cells) => {
    const p = centroid(cells, n, centreX, centreZ);
    return pushFromWalls(p, map);
  });

  // Ore fields: 4-connected areas of 'o' / '+'
  const fieldMask = new Uint8Array(n * n);
  for (let i = 0; i < grid.length; i++) if (grid[i] === CELL.field || grid[i] === CELL.fieldCore) fieldMask[i] = 1;
  map.fields = components(fieldMask, n, 1, false).map((cells) => {
    const core = cells.filter((i) => grid[i] === CELL.fieldCore);
    return { cells, core, ...centroid(core.length ? core : cells, n, centreX, centreZ) };
  });

  // Super node
  map.superNodeField = -1;
  map.superNode = null;
  const sn = def.superNode ?? 'auto';
  const snDef = { ...CFG.superNode, ...(def.superNodeOptions ?? {}) };
  if (sn === 'auto' && map.fields.length) {
    let best = -1;
    let bestDist = Infinity;
    map.fields.forEach((f, i) => { const d = Math.hypot(f.x, f.z); if (d < bestDist) { best = i; bestDist = d; } });
    if (bestDist <= CFG.superNodeMaxCenterShare * size) {
      map.superNodeField = best;
      map.superNode = { ...snDef, x: map.fields[best].x, z: map.fields[best].z };
    }
  } else if (sn && typeof sn === 'object' && Number.isInteger(sn.col) && Number.isInteger(sn.row)) {
    const c = sn.col + Math.floor((n - (raw[sn.row]?.length ?? n)) / 2); // same padding as the row got
    const r = sn.row + padTop;
    map.superNode = { ...snDef, x: centreX(c), z: centreZ(r) };
    map.superNodeField = map.fields.findIndex((f) => f.cells.includes(r * n + c));
  }

  /** Ore deposits of the regular fields for a match seed (the super node's ore is added by GameMap) */
  map.deposits = (seed) => placeDeposits(map, def, seed);
  return map;
}

/** Cell type at a world point (outside the grid = wall) */
export function cellAt(map, x, z) {
  const c = Math.floor((x + map.half) / map.cellSize);
  const r = Math.floor((z + map.half) / map.cellSize);
  if (c < 0 || r < 0 || c >= map.cols || r >= map.cols) return CELL.wall;
  return map.grid[r * map.cols + c];
}

// ---------- internals ----------

function placeDeposits(map, def, seed) {
  const n = map.cols;
  const dep = { ...CFG.deposit, ...(def.deposit ?? {}) };
  const out = [];
  map.fields.forEach((field, fi) => {
    if (fi === map.superNodeField) return;
    const count = Math.min(CFG.maxPerField, Math.max(1, Math.round(field.cells.length / CFG.cellsPerDeposit)));
    const pool = [...(field.core.length ? field.core : field.cells)];
    const rand = seededRandom(hashSeed('ore', map.id, seed ?? def.seed ?? 0, fi));
    for (let i = pool.length - 1; i > 0; i--) { // Fisher–Yates
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const chosen = [];
    for (const idx of pool) {
      if (chosen.length >= count) break;
      const c = idx % n, r = Math.floor(idx / n);
      if (chosen.every((o) => Math.hypot(o % n - c, Math.floor(o / n) - r) >= CFG.minSpacing)) chosen.push(idx);
    }
    for (const idx of chosen) out.push({ ...dep, x: map.centreX(idx % n), z: map.centreZ(Math.floor(idx / n)) });
  });
  return out;
}

// Greedy merge of cells of one type into rectangles { c0, r0, c1, r1 } (inclusive)
function rectangles(grid, n, type) {
  const used = new Uint8Array(n * n);
  const out = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (grid[i] !== type || used[i]) continue;
      let c1 = c;
      while (c1 + 1 < n && grid[r * n + c1 + 1] === type && !used[r * n + c1 + 1]) c1++;
      let r1 = r;
      const rowFree = (rr) => { for (let k = c; k <= c1; k++) if (grid[rr * n + k] !== type || used[rr * n + k]) return false; return true; };
      while (r1 + 1 < n && rowFree(r1 + 1)) r1++;
      for (let rr = r; rr <= r1; rr++) for (let k = c; k <= c1; k++) used[rr * n + k] = 1;
      out.push({ c0: c, r0: r, c1, r1 });
    }
  }
  return out;
}

function box({ c0, r0, c1, r1 }, cell, half) {
  return {
    x: ((c0 + c1 + 1) / 2) * cell - half, z: ((r0 + r1 + 1) / 2) * cell - half,
    halfX: ((c1 - c0 + 1) * cell) / 2, halfZ: ((r1 - r0 + 1) * cell) / 2,
  };
}

// Connected components of mask === value, each a list of cell indices in scan order; components in reading order
function components(mask, n, value, diagonal) {
  const seen = new Uint8Array(n * n);
  const steps = diagonal
    ? [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
    : [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const out = [];
  for (let i = 0; i < n * n; i++) {
    if (mask[i] !== value || seen[i]) continue;
    const cells = [];
    const queue = [i];
    seen[i] = 1;
    while (queue.length) {
      const cur = queue.shift();
      cells.push(cur);
      const c = cur % n, r = Math.floor(cur / n);
      for (const [dc, dr] of steps) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= n || nr >= n) continue;
        const ni = nr * n + nc;
        if (mask[ni] === value && !seen[ni]) { seen[ni] = 1; queue.push(ni); }
      }
    }
    out.push(cells.sort((a, b) => a - b));
  }
  return out;
}

function centroid(cells, n, cx, cz) {
  let sx = 0, sz = 0;
  for (const i of cells) { sx += cx(i % n); sz += cz(Math.floor(i / n)); }
  return { x: sx / cells.length, z: sz / cells.length };
}

// Steps a start away from nearby wall cells (one cell per step) until none is within startClearance
function pushFromWalls(p, map) {
  const { cols: n, cellSize: cell, grid } = map;
  const reach = Math.ceil(CFG.startClearance / cell);
  const maxSteps = Math.floor(CFG.startMaxShift / cell);
  let { x, z } = p;
  for (let step = 0; step <= maxSteps; step++) {
    const pc = Math.floor((x + map.half) / cell), pr = Math.floor((z + map.half) / cell);
    let vx = 0, vz = 0, hits = 0;
    for (let r = pr - reach; r <= pr + reach; r++) {
      for (let c = pc - reach; c <= pc + reach; c++) {
        const wall = c < 0 || r < 0 || c >= n || r >= n || grid[r * n + c] === CELL.wall;
        if (!wall) continue;
        const dx = x - map.centreX(c), dz = z - map.centreZ(r);
        const d = Math.hypot(dx, dz);
        if (d >= CFG.startClearance || d === 0) continue;
        vx += dx / d; vz += dz / d; hits++;
      }
    }
    const len = Math.hypot(vx, vz);
    if (!hits || len === 0 || step === maxSteps) break;
    x += (vx / len) * cell;
    z += (vz / len) * cell;
  }
  return { x, z };
}
