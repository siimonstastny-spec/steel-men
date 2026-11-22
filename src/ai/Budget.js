// Steel Mans AI – budget buckets by game phase (v3, docs/notes/ai-v3.md).
// The research plan (data/ai/research.json → `budget`) gives, per phase (sim time), the share of the AI's spending that
// should go to research. Spending of the two buckets is recorded over a sliding window:
//   army     – everything Production queues (parts, robots, crews, combat vehicles; not trucks / builders)
//   research – research and analysis items
// A bucket gives way while the other one waits for money:
//   research waits and its share is below the phase share − slack → Production spends no normal-priority money on
//     the resources research is short of (high priority – crews, robots, lost trucks – still runs)
//   army is short of money and research is above the phase share + slack → Research queues nothing new
// Without `budget` in the plan (easy: research 'none') everything is allowed, as in v2.
import { costTotal } from './util.js';

export class Budget {
  constructor(ai) {
    this.ai = ai;
    this.spends = [];        // { time, bucket, total }
    this.waiting = new Map(); // bucket -> { time, short: Set of resources }
  }

  get cfg() { return this.ai.researchPlan?.budget ?? null; }
  get now() { return this.ai.now; }

  /** Phase entry of the budget now ({ until, research }) or null */
  phase() {
    const list = this.cfg?.phases ?? [];
    return list.find((p) => p.until === null || p.until === undefined || this.now < p.until) ?? list.at(-1) ?? null;
  }

  /** Wanted research share 0..1 now */
  target() { return this.phase()?.research ?? 0; }

  /** Records money the AI just committed (cost object of the command) */
  record(bucket, cost) {
    if (!this.cfg) return;
    const total = costTotal(cost ?? {});
    if (total <= 0) return;
    this.spends.push({ time: this.now, bucket, total });
    this.#trim();
  }

  #trim() {
    const from = this.now - (this.cfg?.window ?? 180);
    while (this.spends.length && this.spends[0].time < from) this.spends.shift();
  }

  /** Research share of the spending in the window, or null while less than minSpend was spent */
  share() {
    if (!this.cfg) return null;
    this.#trim();
    let total = 0;
    let research = 0;
    for (const s of this.spends) { total += s.total; if (s.bucket === 'research') research += s.total; }
    return total < (this.cfg.minSpend ?? 0) ? null : research / total;
  }

  /** A bucket waits for these resources now (empty list / null = not waiting any more) */
  wait(bucket, shortResources) {
    if (!shortResources?.length) { this.waiting.delete(bucket); return; }
    this.waiting.set(bucket, { time: this.now, short: new Set(shortResources) });
  }

  #waiting(bucket) {
    const w = this.waiting.get(bucket);
    if (!w) return null;
    return this.now - w.time <= (this.cfg?.waitSeconds ?? 10) ? w : null;
  }

  /**
   * May this bucket spend `cost` now (normal priority)? @param {'army'|'research'} bucket
   */
  allows(bucket, cost = {}) {
    const cfg = this.cfg;
    if (!cfg) return true;
    const slack = cfg.slack ?? 0;
    const share = this.share();
    const target = this.target();
    if (bucket === 'army') {
      const w = this.#waiting('research');
      if (!w || target <= 0 || (share ?? 0) >= target - slack) return true;
      return !Object.entries(cost).some(([r, v]) => (v ?? 0) > 0 && w.short.has(r));
    }
    if (bucket === 'research') {
      if (!this.#waiting('army') || share === null) return true;
      return share <= target + slack;
    }
    return true;
  }

  /** status(): "research share / wanted share" in % or '-' */
  summary() {
    if (!this.cfg) return '-';
    const share = this.share();
    return `${share === null ? '-' : Math.round(share * 100)}/${Math.round(this.target() * 100)}%`;
  }
}
