// Steel Men – list of playable maps for the New game menu and the lobby (MAPS.list in config.js).
// Loads every map file once (GameMap without visuals: size, starts, walls, fields) and keeps it for previews.
import { MAPS, MAP_MODES, MAP_MODE_ANY } from '../config.js';
import { GameMap, resolveMapId } from './Map.js';

const loaded = new Map(); // map id -> Promise<GameMap | null> (shared by all modes: a map is loaded once)

/** Modes a list item is offered in (item.modes or MAPS.defaultModes) */
const modesOf = (item) => item.modes ?? MAPS.defaultModes;

/** True when the (canonical or alias) id is in MAPS.list and offered in `mode` (MAP_MODE_ANY = any listed map) */
export function mapAllowed(id, mode = MAP_MODES.skirmish) {
  const resolved = resolveMapId(id ?? MAPS.defaultMap);
  const item = MAPS.list.find((m) => m.id === resolved);
  return !!item && (mode === MAP_MODE_ANY || modesOf(item).includes(mode));
}

/** MAPS.list items offered in `mode`, list order, nothing is loaded */
export const mapsForMode = (mode = MAP_MODES.skirmish) => MAPS.list.filter((m) => mapAllowed(m.id, mode));

// Start-up check: the default map must be offered in skirmish and multiplayer
for (const mode of [MAP_MODES.skirmish, MAP_MODES.multiplayer]) {
  if (!mapAllowed(MAPS.defaultMap, mode)) console.warn(`[MapCatalog] default map ${MAPS.defaultMap} is not allowed in mode ${mode}`);
}

/** GameMaps of the maps offered in `mode` in list order (a map that fails to load is left out and logged) */
export function loadMapCatalog(mode = MAP_MODES.skirmish) {
  return Promise.all(mapsForMode(mode).map((m) => {
    if (!loaded.has(m.id)) loaded.set(m.id, GameMap.load(m.id).catch((err) => { console.warn(err); return null; }));
    return loaded.get(m.id);
  })).then((maps) => maps.filter(Boolean));
}

/** [W5a] Lobby choice "Random map": the host draws a real map at start (pickRandomMap) */
export const RANDOM_MAP = 'random';

export const isRandomMap = (id) => id === RANDOM_MAP;

/** Map choice incl. Random: RANDOM_MAP stays, anything else is validated like validMapId */
export function validMapChoice(id, mode = MAP_MODES.skirmish) {
  return isRandomMap(id) ? RANDOM_MAP : validMapId(id, mode);
}

/**
 * Deterministic draw of a real map id for `players` seats: only maps with enough start positions are candidates
 * (none fits: the maps with the most starts); the index comes from the integer `seed`, so the same seed gives the same map.
 * @param {{id: string, players: number}[]} maps  catalogue (GameMap list, list order)
 */
export function pickRandomMap(maps, players, seed) {
  if (!maps.length) return MAPS.defaultMap;
  let fit = maps.filter((m) => m.players >= players);
  if (!fit.length) {
    const most = Math.max(...maps.map((m) => m.players));
    fit = maps.filter((m) => m.players === most);
  }
  return fit[Math.abs(Math.trunc(Number(seed)) || 0) % fit.length].id;
}

/** Most start positions of any map in the catalogue (seat limit of a Random lobby) */
export const maxMapPlayers = (maps) => maps.reduce((n, m) => Math.max(n, m.players), 0);

/** Canonical id of a saved / received map id, or the default map when it is not in the list or not allowed in `mode` */
export function validMapId(id, mode = MAP_MODES.skirmish) {
  return mapAllowed(id, mode) ? resolveMapId(id ?? MAPS.defaultMap) : MAPS.defaultMap;
}
