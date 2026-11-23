// Steel Mans – faction styles of procedural buildings (data/buildingStyles.json). Loaded once (cached promise, like
// data/Stats.js); building models read a style synchronously, so loadBuildingStyles() must have finished before the
// first procedural model is created (main.js at start, Structure.load and ProcPreview also await it).
// Code never names factions: a race key that is not in the data uses the first style. Visual only.

const STYLES_URL = './data/buildingStyles.json';
const META_PREFIX = '_';          // keys starting with this are documentation / defaults, not styles
const DEFAULTS_KEY = '_defaults';

let stylesPromise = null;
let styles = null;                // key -> resolved style (defaults merged)
let keys = [];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Objects merge recursively, arrays and plain values are replaced; inputs are not mutated
function deepMerge(base, extra) {
  const out = structuredClone(base ?? {});
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  return out;
}

/** Loads data/buildingStyles.json once (returns the same promise on every call) */
export function loadBuildingStyles(url = STYLES_URL) {
  stylesPromise ??= fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`BuildingStyles ${url}: HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      const defaults = data[DEFAULTS_KEY] ?? {};
      keys = Object.keys(data).filter((k) => !k.startsWith(META_PREFIX));
      if (keys.length === 0) throw new Error(`BuildingStyles ${url}: no styles`);
      styles = Object.fromEntries(keys.map((k) => [k, Object.freeze({ key: k, ...deepMerge(defaults, data[k]) })]));
      return styles;
    });
  return stylesPromise;
}

/** True once loadBuildingStyles() has finished */
export const buildingStylesLoaded = () => styles !== null;

/** Style keys in data order */
export function styleKeys() {
  if (!styles) throw new Error('Building styles are not loaded yet – await loadBuildingStyles() first');
  return keys.slice();
}

/** Style key used for a race: the race itself when the data has it, else the first style */
export function resolveStyleKey(race) {
  if (!styles) throw new Error('Building styles are not loaded yet – await loadBuildingStyles() first');
  return Object.hasOwn(styles, race) ? race : keys[0];
}

/** Resolved style of a race (frozen object, defaults merged) – synchronous, needs loadBuildingStyles() done */
export function getBuildingStyle(race) {
  return styles[resolveStyleKey(race)];
}
