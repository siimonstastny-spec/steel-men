// Steel Men AI – console test mode "AI vs AI" (docs/notes/ai-core.md → Test). After a single-player game started:
//   await steelMen.ai.start({ difficulty: ['normal', 'hard'], minutes: 10 })  – AI on every team, then fast-forward
//   await steelMen.ai.fastForward(300)   – simulates 300 s as fast as the machine can (yields to load models)
//   steelMen.ai.report()                 – console.table of every AI (state, buildings, robots, resources…)
//   steelMen.ai.log(1)                   – recent decisions of team 1
//   steelMen.ai.stop()                   – AIs off
//   [A2-ai] await steelMen.ai.start({ difficulty: 'hard', teams: [1] }) – AI only on team 1 (team 0 unplayed)
//   [A2-ai] await steelMen.ai.takeOver(0, { difficulty: 'normal' }) – a new AI takes over team 0 mid-game
//   [A2-ai] steelMen.ai.release(0)       – team 0's AI off (the team stays, unplayed)
// The fast-forward runs the same steps as the game loop (commands of the tick, world, match rules) and calls the AIs
// after every tick. It stops at the end of the match.
import { SIM, AI } from '../config.js';
import { setSoundMuted } from '../audio/Sound.js'; // [A6]
import { createAi, clearAis, updateAis, aiPlayers } from './index.js';

const handle = () => {
  const h = window.steelMen;
  if (!h?.world || !h?.commandBus || !h?.game) throw new Error('steelMen debug handle missing – start a game first');
  return h;
};

/**
 * Puts an AI on every team of the running match (replacing AIs already there).
 * @param {object} [opts]  difficulty: one id or one per team; minutes: fast-forward right away (0 = no)
 */
export async function startAiVsAi({ difficulty = 'normal', minutes = 0, teams = null } = {}) {
  const { world, commandBus, game } = handle();
  clearAis();
  const list = [].concat(difficulty);
  // [A2-ai] teams: only these teams get an AI (the others stay "human" – nobody plays them); default every team
  const ais = game.races.map((race, team) => (teams && !teams.includes(team) ? null : createAi({
    world, commandBus, team, race, difficulty: list[team] ?? list[0] ?? 'normal', unlocks: game.unlocks?.[team] ?? null,
  }))).filter(Boolean);
  await Promise.all(ais.map((a) => a.ready));
  console.info(`[AI vs AI] ${ais.map((a) => `team ${a.team}: ${a.race} ${a.diff?.id}`).join(', ')}`);
  if (minutes > 0) await aiFastForward(minutes * 60);
  return ais;
}

/**
 * [A2-ai] A new AI takes over `team` in the middle of the match (replaces the team's AI, if any): it reads the base
 * from the world at its first update (src/ai/Resume.js) and plays on. Run it between fastForward calls.
 * @param {number} team
 * @param {object} [opts] difficulty ('easy'|'normal'|'hard'), allies (extra teams never attacked)
 * @returns {Promise<import('./AiPlayer.js').AiPlayer>}
 */
export async function aiTakeOver(team, { difficulty = 'normal', allies = [] } = {}) {
  const { world, commandBus, game } = handle();
  const race = game.races?.[team];
  if (!race) throw new Error(`no team ${team} in this match`);
  const ai = createAi({ world, commandBus, team, race, difficulty, unlocks: game.unlocks?.[team] ?? null, allies });
  await ai.ready;
  console.info(`[AI] team ${team} (${race}) taken over by ${ai.diff?.id} at ${Math.round(world.tick / SIM.tickRate)} s`
    + ` (resumed: ${ai.resumed})`);
  return ai;
}

/** [A2-ai] Removes the team's AI – the team goes on unplayed ("human" who does nothing) */
export function aiRelease(team) {
  const i = aiPlayers.findIndex((a) => a.team === team);
  if (i < 0) return false;
  aiPlayers.splice(i, 1)[0].stop();
  console.info(`[AI] team ${team} released`);
  return true;
}

/**
 * Simulates `seconds` of game time as fast as possible. Works in chunks and yields between them, so produced units
 * (whose models load asynchronously) can appear. @returns {Promise<object[]>} the final report rows
 */
export async function aiFastForward(seconds, { report = true } = {}) {
  const { world, commandBus, game } = handle();
  const dt = 1 / SIM.tickRate;
  const end = world.tick + Math.round(seconds * SIM.tickRate);
  const every = AI.fastForward.reportEverySeconds * SIM.tickRate;
  let nextReport = world.tick + every;
  aiFastForward.busy = true;
  // [I1] the game loop runs no ticks meanwhile (world.paused) – no need to stop requestAnimationFrame any more.
  // A produced unit / building whose model is still loading stalls the tick (world.readyForTick, always on).
  const prevPaused = world.paused;
  world.paused = true;
  setSoundMuted(true); // [A6] fast-forward ticks without sound
  try {
    while (world.tick < end && !game.match?.result) {
      for (let i = 0; i < AI.fastForward.chunkTicks && world.tick < end; i++) {
        if (!world.readyForTick()) break;
        commandBus.executeTick(world, world.tick + 1);
        world.update(dt);
        game.match?.update(dt);
        updateAis(world.tick / SIM.tickRate);
      }
      if (report && world.tick >= nextReport) { aiReport(); nextReport += every; }
      await new Promise((r) => setTimeout(r, 0)); // model loads, rendering
    }
  } finally {
    world.paused = prevPaused;
    setSoundMuted(false);
    aiFastForward.busy = false;
  }
  if (game.match?.result) console.info('[AI vs AI] match over', game.match.result);
  return aiReport();
}

/** console.table of every AI; returns the rows */
export function aiReport() {
  const rows = aiPlayers.map((a) => a.status());
  console.table(rows);
  return rows;
}

/** Recent decisions of a team's AI */
export function aiLog(team) {
  const ai = aiPlayers.find((a) => a.team === team);
  if (!ai) return [];
  console.table(ai.log);
  return ai.log;
}

/** Puts the console helpers on window.steelMen.ai (call once from main.js) */
export function installAiConsole() {
  if (typeof window === 'undefined') return;
  window.steelMen ??= {};
  window.steelMen.ai = {
    start: startAiVsAi, fastForward: aiFastForward, report: aiReport, log: aiLog, stop: clearAis, players: aiPlayers,
    takeOver: aiTakeOver, release: aiRelease, // [A2-ai]
  };
}
