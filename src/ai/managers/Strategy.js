// Steel Men AI – strategy: a small state machine over the blackboard.
//   build  – economy and army grow (the opening build order runs in Construction)
//   attack – Military forms a wave and attacks; ends when the wave is spent or retreats
//   defend – enemies at the base for longer than the reaction delay; ends when the threat is gone
// Attacking needs enough units (wave size grows with every wave) and either more strength than the known enemy
// army × strengthRatio, or waiting longer than maxWait. The first wave never starts before firstWaveAt.
// stats.wavesSent counts waves that LEFT the rally point (Military, v2 fix: it stayed 0 while a wave never ended).
// v3: in 'build', an ally's base under attack (Perception.allyThreat, longer than the reaction delay, within
// AI.allyHelp.radius, our home units strong enough for minShare of the attackers) sets bb.allyHelp = point: Military
// sends the home units there (difficulty.squads.helpAllies). It never changes the state.
import { AI } from '../../config.js';
import { dist } from '../util.js';

export class StrategyManager {
  constructor(ai) {
    this.ai = ai;
    this.buildSince = 0;
  }

  get waveSize() {
    const a = this.ai.diff.attack;
    return Math.min(a.maxWave, a.minWave + a.waveGrowth * this.ai.stats.wavesSent);
  }

  think(now) {
    const ai = this.ai;
    const bb = ai.bb;
    const p = ai.perception;
    const diff = ai.diff;
    const threat = p.threat;
    const threatened = threat.active && threat.strength >= (diff.defend?.minThreatStrength ?? 0)
      && now - threat.since >= diff.reactionDelay;

    this.#allyHelp(now, threatened);
    if (bb.state === 'defend') {
      if (!threat.active) this.#set('build', now, 'threat over');
      return;
    }
    // v2: while a wave is on its way, the home squad handles a threat it can beat (bb.homeDefense); the wave is
    // recalled (state defend) only when the units at home are too weak
    bb.homeDefense = false;
    if (threatened && bb.state === 'attack' && bb.wave?.phase === 'go' && !bb.wave.ended && diff.squads?.concurrentDefense) {
      const home = ai.military?.homeStrength() ?? 0;
      if (home >= threat.strength) {
        bb.homeDefense = true;
        if (!this.homeNoted) { ai.note(`home squad defends (${Math.round(home)} vs ${Math.round(threat.strength)}), wave goes on`); this.homeNoted = true; }
        return;
      }
    }
    this.homeNoted = false;
    if (threatened && bb.state !== 'defend') {
      if (bb.wave && !bb.wave.ended) ai.stats.wavesRecalled++;
      this.#set('defend', now, `threat ${Math.round(threat.strength)} at base`);
      return;
    }
    if (bb.state === 'attack') {
      if (bb.wave?.ended) {
        this.#set('build', now, `wave over (${bb.wave.ended})`);
        bb.wave = null;
      }
      return;
    }
    // build → attack?
    const a = diff.attack;
    const army = p.own.army;
    const strength = p.own.armyStrength;
    const enemy = p.enemyEstimate(now); // v5: grows while the enemy army is unseen (difficulty.estimate)
    this.lastEstimate = enemy;
    if (now < a.firstWaveAt && ai.stats.wavesSent === 0) return;
    if (bb.allyHelp) return; // v3: helping an ally first
    const squad = ai.military?.nodeCount ?? 0; // v3: the super node squad never joins a wave
    const enough = (army.length - squad) * (1 - (diff.squads?.homeGuard ?? 0)) >= this.waveSize;
    const stronger = strength >= enemy * a.strengthRatio;
    // v5: the first wave's maxWait counts from firstWaveAt (it counted from 0, so the first wave always left at
    // firstWaveAt whatever the enemy had). Only with scoutFirst (hard) – normal / easy keep their measured timing.
    const since = a.scoutFirst && ai.stats.wavesSent === 0 ? Math.max(this.buildSince, a.firstWaveAt) : this.buildSince;
    const waitedLong = now - since >= a.maxWait && army.length >= a.minWave;
    if ((enough && stronger) || waitedLong) {
      if (!this.#recon(now)) return; // v5: look at the enemy first when what we know is old
      this.#set('attack', now, `army ${army.length} (${Math.round(strength)}) vs est. ${Math.round(enemy)} (known ${Math.round(p.knownEnemyStrength())})`);
    }
  }

  /**
   * v5: reconnaissance before a wave (difficulty.attack.scoutFirst). When no armed enemy was seen for intelFresh s,
   * bb.recon asks Scout to look at the enemy base; the attack waits until the scout got there (or died) or reconWait
   * s passed, and is decided again with what it saw. @returns {boolean} the attack may start now
   */
  #recon(now) {
    const ai = this.ai;
    const a = ai.diff.attack;
    const bb = ai.bb;
    if (!a.scoutFirst || ai.perception.intelAge(now) <= (a.intelFresh ?? 60)) return true;
    const r = bb.recon;
    if (r?.done && now - r.doneAt <= (a.intelFresh ?? 60)) return true; // just looked (saw no army): go
    if (!r || r.done) {
      bb.recon = { since: now, done: false, doneAt: null };
      ai.note('recon before the attack');
      return false;
    }
    if (now - r.since < (a.reconWait ?? 45)) return false;
    r.done = true; r.doneAt = now; // timed out (no scout / too far): decide with what we have
    return true;
  }

  /** v3: should the home units help an attacked ally? Sets / clears bb.allyHelp (a point) */
  #allyHelp(now, threatened) {
    const ai = this.ai;
    const bb = ai.bb;
    const a = ai.perception.allyThreat;
    const anchor = ai.perception.own.anchor;
    const home = ai.military?.homeStrength() ?? 0;
    const help = Boolean(ai.diff.squads?.helpAllies) && bb.state === 'build' && !threatened && a.active && a.point
      && now - a.since >= ai.diff.reactionDelay && anchor && dist(anchor, a.point) <= AI.allyHelp.radius
      && home > 0 && home >= a.strength * AI.allyHelp.minShare;
    if (help) {
      if (!bb.allyHelp) {
        ai.military.stats.allyHelps++;
        ai.note(`helping ally ${a.team} (${Math.round(home)} vs ${Math.round(a.strength)})`);
      }
      // the point moves only by repoint or more: every move is a new order for every helper (APM)
      if (!bb.allyHelp || dist(bb.allyHelp, a.point) >= AI.allyHelp.repoint) bb.allyHelp = { x: a.point.x, z: a.point.z };
    } else if (bb.allyHelp) {
      bb.allyHelp = null;
      ai.note('ally help over');
    }
  }

  #set(state, now, why) {
    const bb = this.ai.bb;
    if (bb.state === state) return;
    bb.state = state;
    if (state === 'build') this.buildSince = now;
    if (state === 'attack' && this.ai.stats.firstAttackAt === null) this.ai.stats.firstAttackAt = now;
    this.ai.note(`state → ${state}: ${why}`);
  }
}
