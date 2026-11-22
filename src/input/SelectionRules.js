// Steel Mans – selection helpers (local UI only, never touches the simulation or its hash).
//   unitTypeKey(unit)   same kind of entity: mechs = same legs + torso set, vehicles = same unit id, crews = same race
//   isCombatUnit(unit)  every mech (also armless) and armed vehicles; builders, harvesters, unarmed crews and buildings not
//   preferCombat(units) drag-select filter: when any combat unit is inside, only the combat units stay
import * as THREE from 'three';
import { SELECTION } from '../config.js';
import { Crew } from '../units/Crew.js';
import { getSettings } from '../core/Profile.js';

/** Type identity used by the double click. Structures have no key (they are never group-selected). */
export function unitTypeKey(u) {
  if (!u || u.isStructure) return null;
  if (u.isMech) return `mech:${u.parts?.legs?.stats?.set ?? ''}:${u.parts?.torso?.stats?.set ?? ''}`;
  if (u.isVehicle) return `vehicle:${u.unitId}`;
  if (u instanceof Crew) return `crew:${u.race}`;
  return null;
}

/**
 * True for units that can fight (data driven: they carry weapons). Crews on foot carry none.
 * [N1] A mech is always a combat unit, also without (working) arms – it must stay in drag selections of the army.
 */
export const isCombatUnit = (u) => !u.isStructure && (Boolean(u.isMech) || (u.weapons?.length ?? 0) > 0);

export const preferCombatEnabled = () => getSettings().ui?.preferCombatOnDrag ?? SELECTION.preferCombatDefault;

/** With the setting on and at least one combat unit among `units`, only the combat units are returned */
export function preferCombat(units) {
  if (!preferCombatEnabled() || !units.some(isCombatUnit)) return units;
  return units.filter(isCombatUnit);
}

const _p = new THREE.Vector3();
/** Unit (feet or body centre) projects into the camera view */
export function isOnScreen(u, camera) {
  const m = SELECTION.screenMargin;
  for (const h of [0, u.aimHeight ?? 1]) {
    _p.copy(u.position).setY(u.position.y + h).project(camera);
    if (_p.z < 1 && Math.abs(_p.x) <= m && Math.abs(_p.y) <= m) return true;
  }
  return false;
}
