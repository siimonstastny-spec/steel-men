// Steel Men AI – simple scouting: while no enemy building is known, one fast army unit visits the start positions
// that are not explored yet (nearest first). It is released (back to the army) once an enemy building is known,
// it dies, or there is nothing left to look at. Off on difficulties with scout.enabled = false (the attack wave
// then explores by itself).
import { AI } from '../../config.js';
import { resolve } from '../../game/commands/CommandBus.js';
import { PRIORITY, dist, posOf, alive } from '../util.js';

export class ScoutManager {
  constructor(ai) {
    this.ai = ai;
    this.waypoint = null;
  }

  think(now) {
    const ai = this.ai;
    const cfg = ai.diff.scout ?? {};
    const p = ai.perception;
    const bb = ai.bb;
    if (!cfg.enabled || now < (cfg.startAt ?? 0)) return;
    let scout = bb.scoutEid === null ? null : resolve(ai.world, bb.scoutEid);
    if (scout && (!alive(scout) || (scout.isMech && !scout.crew))) scout = null;
    if (bb.recon && !bb.recon.done) { this.#recon(scout, now); return; } // v5: look before the attack (Strategy)
    if (p.knownStructures().length || bb.state !== 'build') { this.#release(); return; }
    // v3: most likely enemy start first (map symmetry, Perception.enemyStartGuesses)
    const points = p.enemyStartGuesses().filter((s) => !p.isExplored(s));
    if (!points.length) { this.#release(); return; }
    if (!scout) {
      scout = this.#pick();
      if (!scout) return;
      bb.scoutEid = scout.eid;
      this.waypoint = null;
      ai.note('scout sent');
    }
    if (this.waypoint && (p.isExplored(this.waypoint) || dist(posOf(scout), this.waypoint) < AI.scoutWaypointRadius)) this.waypoint = null;
    if (!this.waypoint) {
      this.waypoint = points[0];
      ai.issue({ type: 'move', units: [scout.eid], point: { ...this.waypoint }, queued: false }, { priority: PRIORITY.normal });
    }
  }

  /**
   * v5: reconnaissance asked by Strategy (bb.recon): the scout drives to the nearest known enemy building (else the
   * most likely enemy start). Done when it gets within AI.recon.arriveRadius, or dies on the way (it saw something).
   * Then the grown army estimate is replaced by what is known now and the scout goes back to the rally point.
   */
  #recon(scout, now) {
    const ai = this.ai;
    const p = ai.perception;
    const bb = ai.bb;
    const r = bb.recon;
    if (bb.state === 'defend') { this.#reconDone(now, 'defending'); return; }
    if (r.eid !== undefined && !scout) { this.#reconDone(now, 'scout lost'); return; } // died there: what it saw counts
    if (!scout) {
      scout = this.#pick();
      if (!scout) return; // Strategy times out (reconWait)
      bb.scoutEid = scout.eid;
      r.eid = scout.eid;
    }
    const anchor = p.own.anchor;
    const building = anchor ? p.knownStructures().sort((a, b) => dist(a, anchor) - dist(b, anchor))[0] : null;
    const point = building ? { x: building.x, z: building.z } : p.enemyStartGuesses()[0];
    if (!point) { this.#reconDone(now, 'nothing to look at'); return; }
    if (dist(posOf(scout), point) < AI.recon.arriveRadius) { this.#reconDone(now, 'arrived'); return; }
    if (!this.waypoint || dist(this.waypoint, point) > AI.scoutWaypointRadius) {
      this.waypoint = point;
      ai.issue({ type: 'move', units: [scout.eid], point: { ...point }, queued: false }, { priority: PRIORITY.high });
    }
  }

  #reconDone(now, why) {
    const ai = this.ai;
    ai.bb.recon.done = true;
    ai.bb.recon.doneAt = now;
    ai.perception.refreshPeak(now);
    const scout = ai.bb.scoutEid === null ? null : resolve(ai.world, ai.bb.scoutEid);
    if (scout && alive(scout) && ai.bb.rally) {
      ai.issue({ type: 'move', units: [scout.eid], point: { ...ai.bb.rally }, queued: false }, { priority: PRIORITY.high });
    }
    ai.note(`recon done (${why}): enemy army known ${Math.round(ai.perception.knownEnemyStrength())}`);
    this.#release();
  }

  /** Fastest active army unit (combat vehicles count) */
  #pick() {
    const army = this.ai.perception.own.army.filter((u) => (u.isMech ? u.active : true));
    if (army.length < 2) return null; // never send away the only defender
    const speed = (u) => u.stats?.mobility?.moveSpeed ?? 0;
    return army.reduce((best, u) => (speed(u) > speed(best) ? u : best));
  }

  #release() {
    if (this.ai.bb.scoutEid !== null) this.ai.note('scout released');
    this.ai.bb.scoutEid = null;
    this.waypoint = null;
  }
}
