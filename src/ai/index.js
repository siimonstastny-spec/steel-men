// Steel Men AI – entry point for main.js: the list of computer players of the running match.
//   createAi({ world, commandBus, team, race, difficulty, unlocks, allies }) – adds one AI team (AiPlayer)
//     [A2-ai] also during the match (tick > 0, e.g. a loaded MP game at tick T): it continues the base it finds
//     (src/ai/Resume.js); opts.resumed forces / disables that (debugging)
//   updateAis(simTimeSeconds)  – after each simulation tick (host / single player only)
//   clearAis()                  – new match / back to the menu
import { AiPlayer } from './AiPlayer.js';

/** AI players of the running match */
export const aiPlayers = [];

export function createAi(opts) {
  const old = aiPlayers.findIndex((a) => a.team === opts.team);
  if (old >= 0) aiPlayers.splice(old, 1)[0].stop(); // one AI per team
  const ai = new AiPlayer(opts);
  aiPlayers.push(ai);
  return ai;
}

export function updateAis(simTime) {
  for (const ai of aiPlayers) ai.update(simTime);
}

export function clearAis() {
  for (const ai of aiPlayers) ai.stop();
  aiPlayers.length = 0;
}

export { AiPlayer };
