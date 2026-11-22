// Steel Mans – registry of Structure subclasses (armed buildings, wall posts, wall segments). Construction.js asks
// it which class to create for a building's stats; the subclasses register themselves when their module loads.
// No imports on purpose: it breaks the Structure ↔ Construction import cycle.
const pickers = [];

/** Registers a picker (stats) => Class | null; the first one returning a class wins */
export function registerStructureClass(picker) { pickers.push(picker); }

/** Class for these resolved structure stats, or `fallback` when no registered picker claims them */
export function structureClassFor(stats, fallback) {
  for (const pick of pickers) {
    const cls = pick(stats);
    if (cls) return cls;
  }
  return fallback;
}
