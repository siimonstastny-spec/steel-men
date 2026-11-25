// Steel Men – [A9-F3] superweapon launch command (src/game/Superweapons.js).
//   launchSuperweapon { type, team, structure: eid, point: { x, z } }
// Any point inside the map (fog does not matter). The building must be the team's own, finished and 'ready', and the
// match option superweapons on. Result (local only): the strike object, or null.
import { registerCommand, resolve } from './CommandBus.js';
import { SUPERWEAPON } from '../../config.js';

/** A point inside the map: finite coordinates within the pathfinding grid (nav.half) */
function insideMap(world, p) {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return false;
  const half = world.nav?.half ?? Infinity;
  return Math.abs(p.x) <= half && Math.abs(p.z) <= half;
}

/** Command object for UI / AI: commandBus.submit(launchCommand(team, building, x, z)) */
export function launchCommand(team, structure, x, z) {
  return { type: SUPERWEAPON.commandType, team, structure: typeof structure === 'number' ? structure : structure.eid, point: { x, z } };
}

registerCommand(SUPERWEAPON.commandType, {
  validate(world, cmd) {
    const s = resolve(world, cmd.structure);
    return Boolean(s && s.team === cmd.team && world.superweapons?.canLaunch(s) && insideMap(world, cmd.point));
  },
  execute(world, cmd) {
    const s = resolve(world, cmd.structure);
    return world.superweapons.launch(s, cmd.point.x, cmd.point.z);
  },
});
