// Steel Men AI – entry point for main.js: the list of computer players of the running match.
//   createAi({ world, commandBus, team, race, difficulty, unlocks, allies }) – adds one AI team (AiPlayer)
//     [A2-ai] also during the match (tick > 0, e.g. a loaded MP game at tick T): it continues the base it finds
//     (src/ai/Resume.js); opts.resumed forces / disables that (debugging)
//   updateAis(simTimeSeconds)  – after each simulation tick (host / single player only)
//   clearAis()                  – new match / back to the menu
//   aiTickStats                 – [A4-SIM] counters of the last updateAis call (performance panel; never read by the
//     simulation or the AI): { ais, active, perceived, thought, managers, ticks, perceivedTotal, thoughtTotal }
//     ais = AI players, active = not finished, perceived = AIs whose perception refreshed in this call, thought = AIs
//     with at least one manager think, managers = manager thinks in this call; *Total / ticks = since the match start
//     (resetAiTickStats(); clearAis resets). The time of updateAis is measured by the caller (main.js).
// [A4-SIM] Load spreading: with AI_SPREAD.minAis or more AIs, each AI's timers are shifted by its rank among the AI
// teams (AiPlayer.setPhase, applied once per AI on its first update, deterministic from the teams only), so 7 AIs do
// not perceive / plan in the same tick. Fewer AIs keep the old timing (1v1 AI-vs-AI unchanged).
import { AiPlayer } from './AiPlayer.js';
import { AI, AI_SPREAD } from '../config.js';

/** AI players of the running match */
export const aiPlayers = [];

/** [A4-SIM] counters of the last updateAis call (diagnostics only) */
export const aiTickStats = { ais: 0, active: 0, perceived: 0, thought: 0, managers: 0, ticks: 0, perceivedTotal: 0, thoughtTotal: 0, maxThoughtInTick: 0 };

export function resetAiTickStats() {
  Object.assign(aiTickStats, { ais: 0, active: 0, perceived: 0, thought: 0, managers: 0, ticks: 0, perceivedTotal: 0, thoughtTotal: 0, maxThoughtInTick: 0 });
}

export function createAi(opts) {
  const old = aiPlayers.findIndex((a) => a.team === opts.team);
  if (old >= 0) aiPlayers.splice(old, 1)[0].stop(); // one AI per team
  const ai = new AiPlayer(opts);
  aiPlayers.push(ai);
  return ai;
}

/** [A4-SIM] Timer shift of an AI: rank of its team among the AI teams / their count × perception interval (s) */
function phaseOf(ai) {
  if (aiPlayers.length < AI_SPREAD.minAis) return 0;
  let rank = 0;
  for (const other of aiPlayers) if (other.team < ai.team) rank++;
  return (rank / aiPlayers.length) * AI.perceptionInterval;
}

export function updateAis(simTime) {
  const st = aiTickStats;
  st.ais = aiPlayers.length;
  st.active = 0; st.perceived = 0; st.thought = 0; st.managers = 0;
  for (const ai of aiPlayers) {
    if (!ai.phased && ai.isReady) ai.setPhase(phaseOf(ai));
    const r = ai.update(simTime);
    if (!r) continue;
    st.active++;
    if (r.perceived) st.perceived++;
    if (r.managers) { st.thought++; st.managers += r.managers; }
  }
  st.ticks++;
  st.perceivedTotal += st.perceived;
  st.thoughtTotal += st.thought;
  if (st.thought > st.maxThoughtInTick) st.maxThoughtInTick = st.thought;
}

export function clearAis() {
  for (const ai of aiPlayers) ai.stop();
  aiPlayers.length = 0;
  resetAiTickStats();
}

export { AiPlayer };
