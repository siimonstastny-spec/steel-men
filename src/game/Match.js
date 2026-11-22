// Steel Mans – the running match: checks the chosen victory condition a few times per second, handles surrender
// and keeps the statistics (MatchStats). One instance per game (created by main.js after the scene is built).
//
// The match is part of the simulation: it never reads the local player. Every team is evaluated the same way, so all
// clients (and the AI) reach the same result; only the end screen (MatchUi) decides what "victory" means locally.
//   match.update(dt)            every sim step with the fixed sim dt (cheap: work happens every VICTORY.checkInterval)
//   match.surrender(team)       the team loses at once (reason 'surrender'); meant to be run from a command;
//                               [N5FIX] its units and buildings vanish (Surrender.js)
//   match.isObserving(team)     [N5FIX] eliminated while an ally still plays (the UI shows it as an observer)
//   match.markDisconnected(teams) [MP-LEAVE] their player left a multiplayer match (lockstep 'playerLeft' command):
//                               [MP-LEAVE2] defeated at once like a surrender (reason 'disconnected', everything of it
//                               vanishes, not among the winners); isDisconnected(team) for the UI
//   match.onEliminated = (team, reason) => …  called when a team drops out while the match goes on
//   match.onEnd = (result) => … called once: { winner, winners, winnerAlliance, reason, stats }
//                               winner = winners[0] ?? null (kept for older code), winners = teams of the winning
//                               alliance that did not surrender (ascending; [] = draw), winnerAlliance = its id or null
//   match.result                null while running
//   [N8] new Match(world, { …, prebuild: minutes }) sets the pre-build phase (src/game/PreBuild.js);
//   match.onPrebuildEnd = () => … called once when it is over (UI notice)
// [N5] Alliances (src/game/Alliances.js): a team still drops out on its own (elimination or surrender = only its own
// defeat); the match ends when at most one alliance has a team left. A match that starts with a single alliance
// (sandbox) ends only when every team is out (a draw).
import { VICTORY } from '../config.js';
import { CONDITIONS, validCondition } from './Victory.js';
import { MatchStats } from './MatchStats.js';
import { allianceOf } from './Alliances.js';
import { startPrebuild, isPrebuild } from './PreBuild.js'; // [N8]
import { vanishTeam, idleTeam } from './Surrender.js'; // [N5FIX], [MP-LEAVE]

/** Alliance id of a team for the end check (a team outside the alliance table counts as its own alliance) */
const sideOf = (team) => allianceOf(team) ?? `team${team}`;

export class Match {
  /**
   * @param {import('./World.js').World} world
   * @param {object} opts
   * @param {string} opts.conditionId  VICTORY.conditions id
   * @param {number} opts.teamCount
   * @param {number[]} [opts.teams]    teams that take part (default: all 0..teamCount-1)
   * @param {number} [opts.prebuild]   [N8] pre-build phase in minutes (PREBUILD.options; 0 / missing = none)
   */
  constructor(world, { conditionId, teamCount, teams, prebuild = 0 }) {
    this.world = world;
    startPrebuild(world, prebuild); // [N8] world.prebuild (src/game/PreBuild.js)
    this.prebuildRunning = !!world.prebuild;
    this.onPrebuildEnd = null; // [N8] () => … called once in the tick the phase is over (UI notice only)
    this.conditionId = validCondition(conditionId);
    this.teamCount = teamCount;
    this.teams = teams ?? Array.from({ length: teamCount }, (_, i) => i);
    this.stats = new MatchStats(world, teamCount);
    this.eliminated = new Set();
    // Teams that gave up: never among the winners, even when their alliance wins. [N5FIX] A team that was only
    // eliminated (not surrendered) IS among the winners of its alliance.
    this.surrendered = new Set();
    this.disconnected = new Set(); // [MP-LEAVE] teams whose player left the multiplayer match ([MP-LEAVE2] defeated)
    this.sideCount = new Set(this.teams.map(sideOf)).size; // alliances at the start
    this.pendingEliminations = [];
    this.result = null;
    this.onEnd = null;
    this.onEliminated = null;
    this.timer = 0;
    this.active = false;
  }

  /** Starts checking (call after the starting units exist, otherwise an empty world would end the game) */
  begin() {
    this.stats.begin();
    this.active = true;
  }

  update(dt) {
    if (!this.active || this.result) return;
    if (this.prebuildRunning && !isPrebuild(this.world)) { // [N8] limits are gone from this tick on
      this.prebuildRunning = false;
      this.onPrebuildEnd?.();
    }
    this.stats.update(dt);
    if ((this.timer += dt) < VICTORY.checkInterval) return;
    this.timer = 0;
    this.stats.poll();
    this.#check();
  }

  #check() {
    const condition = CONDITIONS[this.conditionId];
    for (const team of this.teams) { // ascending team order: same on every client
      if (!this.eliminated.has(team) && condition.isEliminated(this.world, team)) this.#eliminate(team, this.conditionId);
    }
    this.#evaluate(this.conditionId);
  }

  /**
   * The team gives up and loses immediately (its allies play on). [N5FIX] All its units and buildings vanish in this
   * tick (src/game/Surrender.js): no wrecks, no loot, and they are neither losses nor kills in the statistics.
   */
  surrender(team) {
    if (!this.active || this.result || !this.teams.includes(team) || this.eliminated.has(team)) return;
    this.stats.poll(); // count what was produced / lost up to now, before the team leaves
    this.#leaveMatch(team, 'surrender');
    this.#evaluate('surrender');
  }

  /** [N5FIX] The team gives up: it vanishes from the map (out of the statistics) and is eliminated */
  #leaveMatch(team, reason) {
    this.surrendered.add(team);
    for (const u of vanishTeam(this.world, team)) { // out of the statistics: MatchStats would see them as lost
      this.stats.seen.delete(u);
      this.stats.finished.add(u);
    }
    this.#eliminate(team, reason);
  }

  /**
   * [MP-LEAVE] The player(s) of these teams left (a host takes its AI teams along). Runs inside a sim tick from the
   * lockstep's 'playerLeft' command. [MP-LEAVE2] Defeated at once, like a surrender (units, buildings and their
   * production queues vanish; reason 'disconnected'; never among the winners). One evaluation for all of them, so a
   * single side left wins. A team already out (or a match already over) only idles.
   * [B6] A host that left takes its AI teams along (teams = [host, ...AI]); when one client is all that stays, the
   * lockstep now drops the host too, so this single evaluation ends the match with that client's win.
   */
  markDisconnected(teams) {
    let any = false;
    for (const team of teams ?? []) {
      if (!this.teams.includes(team) || this.disconnected.has(team)) continue;
      this.disconnected.add(team);
      if (!this.active || this.result || this.eliminated.has(team)) { idleTeam(this.world, team); continue; }
      if (!any) this.stats.poll();
      any = true;
      this.#leaveMatch(team, 'disconnected');
    }
    if (any) this.#evaluate('disconnected');
  }

  isDisconnected(team) { return this.disconnected.has(team); }

  /** [N5FIX] Is the team out while an ally of it still plays (observer of its alliance)? */
  isObserving(team) {
    return this.eliminated.has(team) && !this.result
      && this.teams.some((i) => i !== team && !this.eliminated.has(i) && sideOf(i) === sideOf(team));
  }

  #eliminate(team, reason) {
    this.eliminated.add(team);
    this.pendingEliminations.push({ team, reason });
  }

  // The match ends when at most one alliance has a team left: that alliance wins, or a draw if the last teams fell
  // together. Without alliances every team is its own alliance (= at most one team left, as before).
  #evaluate(reason) {
    const alive = this.teams.filter((i) => !this.eliminated.has(i));
    const sides = new Set(alive.map(sideOf));
    const goesOn = sides.size > 1 || (sides.size === 1 && this.sideCount === 1);
    if (goesOn) {
      this.#flushEliminations();
      return;
    }
    this.pendingEliminations.length = 0; // the end screen covers them
    const side = alive.length ? sideOf(alive[0]) : null;
    const winners = side === null ? [] : this.teams.filter((i) => sideOf(i) === side && !this.surrendered.has(i));
    this.#end(winners, side === null ? null : allianceOf(alive[0]), reason);
  }

  #flushEliminations() {
    for (const { team, reason } of this.pendingEliminations.splice(0)) this.onEliminated?.(team, reason);
  }

  #end(winners, winnerAlliance, reason) {
    this.stats.poll(); // final numbers (the last kills of this check)
    this.result = { winner: winners[0] ?? null, winners, winnerAlliance, reason, stats: this.stats.snapshot() };
    this.onEnd?.(this.result);
  }
}
