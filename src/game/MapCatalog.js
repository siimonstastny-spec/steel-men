// Steel Men – list of playable maps for the New game menu and the lobby (MAPS.list in config.js).
// Loads every map file once (GameMap without visuals: size, starts, walls, fields) and keeps it for previews.
import { MAPS } from '../config.js';
import { GameMap, resolveMapId } from './Map.js';

let catalog = null; // Promise<GameMap[]>

/** All maps of MAPS.list in list order (a map that fails to load is left out and logged) */
export function loadMapCatalog() {
  catalog ??= Promise.all(MAPS.list.map((m) => GameMap.load(m.id).catch((err) => { console.warn(err); return null; })))
    .then((maps) => maps.filter(Boolean));
  return catalog;
}

/** [W5a] Lobby choice "Random map": the host draws a real map at start (pickRandomMap) */
export const RANDOM_MAP = 'random';

export const isRandomMap = (id) => id === RANDOM_MAP;

/** Map choice incl. Random: RANDOM_MAP stays, anything else is validated like validMapId */
export function validMapChoice(id) {
  return isRandomMap(id) ? RANDOM_MAP : validMapId(id);
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

/** Canonical id of a saved / received map id, or the default map when it is not in the list */
export function validMapId(id) {
  const resolved = resolveMapId(id ?? MAPS.defaultMap);
  return MAPS.list.some((m) => m.id === resolved) ? resolved : MAPS.defaultMap;
}
