// Steel Mans – who sits at this computer. Replaces the hard-coded PLAYER_TEAM for everything that is about
// "the local player" (UI, fog rendering, team rings, selection). The simulation itself must NEVER read this:
// every client in a multiplayer game (and the AI) runs the same simulation, only the viewpoint differs.
//   localTeam()          – team index of the local player (0 in single player)
//   setLocalTeam(team)   – set once when the match starts (multiplayer: the seat this client took)
//   isLocal(unitOrTeam)  – does the unit / team index belong to the local player?
import { PLAYER_TEAM } from '../config.js';

let team = PLAYER_TEAM;

export const localTeam = () => team;

export function setLocalTeam(value) { team = value; }

export function isLocal(unitOrTeam) {
  const t = typeof unitOrTeam === 'number' ? unitOrTeam : unitOrTeam?.team;
  return t === team;
}
