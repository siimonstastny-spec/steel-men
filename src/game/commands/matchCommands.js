// Steel Men – match-level commands (src/game/Match.js reached through world.match, set by main.js).
//   { type: 'surrender', team }   the team gives up; Match decides the rest (elimination, end of the match);
//                                 [N5FIX] all its units and buildings vanish in this tick (src/game/Surrender.js)
//   { type: NET_LEAVE.commandType ('playerLeft'), team, teams }   [MP-LEAVE] injected by the lockstep (never sent or
//                                 submitted) in the turn a player is dropped: Match.markDisconnected(teams) idles them
import { registerCommand } from './CommandBus.js';
import { NET_LEAVE } from '../../config.js';

registerCommand('surrender', {
  // [N5FIX] only a team still playing (an eliminated team leaves the game instead; nothing of it would vanish twice)
  validate: (world, cmd) => Boolean(world.match) && !world.match.result && world.match.teams.includes(cmd.team)
    && !world.match.eliminated.has(cmd.team),
  execute: (world, cmd) => { world.match.surrender(cmd.team); },
});

registerCommand(NET_LEAVE.commandType, {
  validate: (world, cmd) => Boolean(world.match) && Array.isArray(cmd.teams),
  execute: (world, cmd) => { world.match.markDisconnected(cmd.teams.filter(Number.isInteger)); },
});
