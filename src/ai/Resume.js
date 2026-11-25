// Steel Men AI – [A2-ai] takeover of a game in progress (docs/notes/a2-ai.md).
// An AI created at tick > 0 (loaded multiplayer game, a seat taken over from a human or from an AI with other
// settings) finds a running base. Most of what the managers know is read from the world on every think anyway
// (buildings finished / under construction, units, crews, research done and running, production queues, part stock,
// energy, deposits, robots in bay service), so only the memory that is NOT in the world is derived here, once, at
// the first update after the AI's data loaded:
//   Construction – build order steps whose buildings stand are passed; defence items that stand are skipped
//   Strategy     – the build phase starts now (no instant wave), wave size as if the earlier waves had been sent
//   Military     – a wave of the previous owner on its way is adopted; patrol / guard orders end (rally point)
// Only deterministic world state and sim time are read; nothing random is drawn (ai.rng untouched).

/**
 * @param {import('./AiPlayer.js').AiPlayer} ai  ready AI whose Perception has just read its own units
 * @param {number} now  sim time (s)
 */
export function resumeFromWorld(ai, now) {
  const own = ai.perception.own;
  const wavesBefore = ai.strategy.resume(now);
  const built = ai.construction.resume(now);
  const army = ai.military.resume(now);
  if (army.wave > 0 && wavesBefore > 0) ai.strategy.wavesBefore = wavesBefore - 1; // the adopted wave is one of them
  ai.stats.resumedAt = now;
  const research = ai.researcher?.summary() ?? '-';
  const running = ai.researcher?.running() ?? '-';
  ai.note(`took over at ${Math.round(now)} s: ${own.complete.length} buildings + ${own.building.length} unfinished, `
    + `${own.crewedMechs.length}/${own.mechs.length} robots crewed, ${own.vehicles.length} vehicles, `
    + `build step ${built.step}/${ai.buildOrder?.length ?? 0}, defence items skipped ${built.defence}, `
    + `research ${research} (running ${running}), waves assumed ${ai.strategy.wavesBefore}, `
    + `wave adopted ${army.wave}, recalled ${army.recalled}`);
}
