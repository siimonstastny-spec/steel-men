// Steel Mans AI – console test mode "AI vs AI" (docs/notes/ai-core.md → Test). After a single-player game started:
//   await steelMans.ai.start({ difficulty: ['normal', 'hard'], minutes: 10 })  – AI on every team, then fast-forward
//   await steelMans.ai.fastForward(300)   – simulates 300 s as fast as the machine can (yields to load models)
//   steelMans.ai.report()                 – console.table of every AI (state, buildings, robots, resources…)
//   steelMans.ai.log(1)                   – recent decisions of team 1
//   steelMans.ai.stop()                   – AIs off
// The fast-forward runs the same steps as the game loop (commands of the tick, world, match rules) and calls the AIs
// after every tick. It stops at the end of the match.
import { SIM, AI } from '../config.js';
import { createAi, clearAis, updateAis, aiPlayers } from './index.js';

const handle = () => {
  const h = window.steelMans;
  if (!h?.world || !h?.commandBus || !h?.game) throw new Error('steelMans debug handle missing – start a game first');
  return h;
};

/**
 * Puts an AI on every team of the running match (replacing AIs already there).
 * @param {object} [opts]  difficulty: one id or one per team; minutes: fast-forward right away (0 = no)
 */
export async function startAiVsAi({ difficulty = 'normal', minutes = 0 } = {}) {
  const { world, commandBus, game } = handle();
  clearAis();
  const list = [].concat(difficulty);
  const ais = game.races.map((race, team) => createAi({
    world, commandBus, team, race, difficulty: list[team] ?? list[0] ?? 'normal', unlocks: game.unlocks?.[team] ?? null,
  }));
  await Promise.all(ais.map((a) => a.ready));
  console.info(`[AI vs AI] ${ais.map((a) => `team ${a.team}: ${a.race} ${a.diff?.id}`).join(', ')}`);
  if (minutes > 0) await aiFastForward(minutes * 60);
  return ais;
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

/** Puts the console helpers on window.steelMans.ai (call once from main.js) */
export function installAiConsole() {
  if (typeof window === 'undefined') return;
  window.steelMans ??= {};
  window.steelMans.ai = {
    start: startAiVsAi, fastForward: aiFastForward, report: aiReport, log: aiLog, stop: clearAis, players: aiPlayers,
  };
}
