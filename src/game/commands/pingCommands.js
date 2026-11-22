// Steel Mans – map ping command [N7].
//   { type: 'ping', team, point: { x, z } }
// A ping travels like every command (so allies get it in multiplayer) but changes NOTHING in the simulation and
// nothing in the state hash: execute() is empty. The UI (src/ui/Pings.js) listens with commandBus.onExecuted and
// shows the ping on clients whose local team is an ally of cmd.team.
import { registerCommand } from './CommandBus.js';
import { PING } from '../../config.js';

const finiteCoord = (v) => Number.isFinite(v) && Math.abs(v) <= PING.maxCoord;

registerCommand(PING.commandType, {
  validate: (world, cmd) => finiteCoord(cmd.point?.x) && finiteCoord(cmd.point?.z),
  execute: () => null,
});
