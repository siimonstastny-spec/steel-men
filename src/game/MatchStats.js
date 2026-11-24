// Steel Men – match statistics of every team: units produced / lost, enemy units and buildings destroyed,
// resources gathered / spent, finished research, game duration. Collected without touching the units: poll()
// compares the world with what it saw before (units first seen after begin() were produced, units that are
// gone were lost, the killer is unit.lastAttacker); resource flows come from Economy.onFlow.
// [N5] One record per team of the match (teamCount = player count); kills count only against enemies (an ally's
// unit destroyed by friendly fire is lost for its owner but credited to nobody); snapshot().alliances lists the
// alliance id of every team for the end screen.
// [B4] tribute.sent / tribute.received (resource -> amount) from the diplomacy tribute flows; score(team) and
// allianceScore(team) = the "value" shown by src/ui/PlayerStatsBar.js (weights PLAYER_STATS_BAR.score), allocation-free.
import { DIPLOMACY, MATCH_STATS, PLAYER_STATS_BAR } from '../config.js';
import { areAllies, allianceOf } from './Alliances.js';

const isGone = (u) => u.destroyed || u.dead || u.removed;
const emptyCounts = () => Object.fromEntries(MATCH_STATS.unitKinds.map((k) => [k, 0]));
/** bag[key] += v (module function: #flow runs on every economy change, no closure per call) */
function bump(bag, key, v) { bag[key] = (bag[key] ?? 0) + v; }

export class MatchStats {
  /** @param {import('./World.js').World} world  @param {number} teamCount */
  constructor(world, teamCount) {
    this.world = world;
    this.time = 0;
    this.teams = Array.from({ length: teamCount }, () => ({
      produced: emptyCounts(),
      lost: emptyCounts(),
      kills: { units: 0, structures: 0 },  // enemy units / buildings destroyed
      gathered: {}, spent: {},             // resource -> amount
      research: 0,
      tribute: { sent: {}, received: {} }, // [B4] resource -> amount (sent = paid by the sender, received = arrived)
    }));
    this.seen = new Map();   // unit -> { unit, kind, team, counted, killerTeam, stamp }
    this.finished = new WeakSet(); // units already counted as lost
    this.stamp = 0;          // [B4] scan counter: a seen unit whose rec.stamp is older was not in the world any more
    this.baseline = false;
  }

  /** Call once the starting scene exists: everything alive now is not "produced" */
  begin() {
    this.#scan(true);
    this.baseline = true;
    const eco = this.world.economy;
    if (eco) eco.onFlow = (team, resource, amount, kind) => this.#flow(team, resource, amount, kind);
  }

  update(dt) { this.time += dt; }

  #flow(team, resource, amount, kind) {
    const t = this.teams[team];
    if (!t) return;
    if (kind === DIPLOMACY.flowKinds.sent) bump(t.tribute.sent, resource, -amount);           // [B4]
    else if (kind === DIPLOMACY.flowKinds.received) bump(t.tribute.received, resource, amount);
    else if (MATCH_STATS.gatherKinds.includes(kind) && amount > 0) bump(t.gathered, resource, amount);
    else if (MATCH_STATS.spendKinds.includes(kind)) bump(t.spent, resource, -amount);
    else if (MATCH_STATS.refundKinds.includes(kind)) bump(t.spent, resource, -amount);
  }

  // [B4] walks the unit lists directly (world.allUnits builds a new array, includes() per unit was O(n²))
  #scan(initial = false) {
    const w = this.world;
    const stamp = ++this.stamp;
    this.#scanList(w.mechs, 'mech', stamp, initial);
    this.#scanList(w.crews, 'crew', stamp, initial);
    this.#scanList(w.vehicles, 'vehicle', stamp, initial);
    this.#scanList(w.structures, 'structure', stamp, initial);
    // Removed from the world between two polls (deleting the current entry while iterating a Map is safe)
    for (const rec of this.seen.values()) if (rec.stamp !== stamp) this.#lose(rec.unit, rec);
  }

  #scanList(list, listKind, stamp, initial) {
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      if (this.finished.has(u)) continue; // already counted as lost, still lying around as a wreck
      const kind = u.isStructure ? 'structure' : listKind;
      let rec = this.seen.get(u);
      if (!rec) { rec = { unit: u, kind, team: u.team, counted: false, killerTeam: null, stamp }; this.seen.set(u, rec); }
      rec.stamp = stamp;
      // A building only counts once it is finished (a cancelled construction site is neither produced nor lost)
      const ready = kind !== 'structure' || u.complete;
      if (ready && !rec.counted) {
        rec.counted = true;
        if (!initial && this.teams[u.team]) this.teams[u.team].produced[kind]++;
      }
      const killer = u.lastAttacker;
      if (killer && !areAllies(killer.team, u.team)) rec.killerTeam = killer.team;
      if (isGone(u)) this.#lose(u, rec);
    }
  }

  #lose(u, rec) {
    this.seen.delete(u);
    this.finished.add(u);
    if (!rec.counted || !this.teams[rec.team]) return;
    if (u.upgraded) return; // [H1] a wall segment rebuilt into a gate (upgradeGate): neither lost nor killed
    this.teams[rec.team].lost[rec.kind]++;
    // The attacker is still on the unit object even when it vanished between two polls
    const last = u.lastAttacker;
    const killerTeam = last && !areAllies(last.team, rec.team) ? last.team : rec.killerTeam;
    const killer = this.teams[killerTeam];
    if (killer) killer.kills[rec.kind === 'structure' ? 'structures' : 'units']++;
  }

  /** Samples units and research; call a few times per second */
  poll() {
    if (!this.baseline) return;
    this.#scan();
    const research = this.world.research?.teams;
    for (let i = 0; i < this.teams.length; i++) this.teams[i].research = research?.[i]?.completed?.size ?? 0;
  }

  /** [B4] "Value" of one team: weighted gathered resources, enemy kills and finished research (no allocations) */
  score(team) {
    const t = this.teams[team];
    if (!t) return 0;
    const w = PLAYER_STATS_BAR.score;
    let gathered = 0;
    for (const r in t.gathered) gathered += t.gathered[r];
    return Math.round(gathered * w.gathered + t.kills.units * w.unitKill + t.kills.structures * w.structureKill
      + t.research * w.research);
  }

  /** [B4] Sum of score() over the team and its allies */
  allianceScore(team) {
    let sum = 0;
    for (let i = 0; i < this.teams.length; i++) if (areAllies(i, team)) sum += this.score(i);
    return sum;
  }

  /** Per-team plain data for the end screen */
  snapshot() {
    return {
      time: Math.min(this.time, MATCH_STATS.maxSecondsShown),
      teams: this.teams.map((t) => JSON.parse(JSON.stringify(t))),
      alliances: this.teams.map((_, team) => allianceOf(team) ?? team), // alliance id per team (team itself outside the table)
    };
  }
}
