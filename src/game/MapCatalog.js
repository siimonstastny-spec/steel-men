// Steel Mans – list of playable maps for the New game menu and the lobby (MAPS.list in config.js).
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

/** Canonical id of a saved / received map id, or the default map when it is not in the list */
export function validMapId(id) {
  const resolved = resolveMapId(id ?? MAPS.defaultMap);
  return MAPS.list.some((m) => m.id === resolved) ? resolved : MAPS.defaultMap;
}
