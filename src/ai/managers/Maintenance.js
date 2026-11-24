// Steel Men AI – repairs (v2), by difficulty.repair:
//   • bay:   a robot below bayBelow HP share – or, with `armless`, missing an arm or with a broken (0 HP) arm while an
//            arm is in stock – drives into
//            a free own assembly bay (enterBay). In the bay: a missing arm is mounted from the shared stock (serviceSwap),
//            then the robot is repaired (serviceRepair), then let out (serviceRelease; its crew boards again by itself).
//            Bays in use are kept free of new assemblies (bb.serviceBays, read by Production).
//   • arms:  an armless robot at home picks up a visible arm wreck nearby (collect) – free and fast. R3 (makeArms):
//            with no arm in stock or queued, one is ordered at a part factory for the bay swap.
//   • field: idle HoverTrucks (repair ability) repair damaged robots / vehicles at home and damaged buildings
//            (repairUnit), only while Construction does not need them as builders.
// Robots handled here are in bb.maintaining: Military leaves them alone until they are back.
import { AI, ARMS } from '../../config.js';
import { partStats, weaponDps } from '../../data/Stats.js';
import { armModel, stockKey } from '../../game/PartStock.js';
import { PRODUCES } from '../../game/Production.js';
import { resolve } from '../../game/commands/CommandBus.js';
import { Perception } from '../Perception.js';
import { PRIORITY, dist, posOf, isIdle, alive, nearest, missingArmSlots, affordsAbove } from '../util.js';

/** Seconds between two service commands for the same bay (the previous one runs at the next tick) */
const SERVICE_COMMAND_GAP = 3;
/** R3: an arm part ordered for a swap counts as queued this long (s) – the command runs at the next tick */
const ARM_ORDER_SECONDS = 5;
/** R3: a part factory holding this many items gets no repair arm order (Production's queues stay short) */
const ARM_FACTORY_QUEUE = 2;
const ARM_SIDES = ['leftArm', 'rightArm'];
const groundDps = (st) => (st.weapons ?? []).filter((w) => (w.targets ?? ['ground']).includes('ground')).reduce((s, w) => s + weaponDps(w), 0);
/** A released robot counts as maintained until its crew is back on board, at most this long (s) */
const RELEASE_GRACE = 20;

const hpRatio = (u) => Perception.hpRatio(u);

export class MaintenanceManager {
  constructor(ai) {
    this.ai = ai;
    this.toBay = new Map();     // mech eid -> { bay eid, since, released: time|null }
    this.bayCmdAt = new Map();  // bay eid -> sim time of the last service command
    this.collecting = new Map(); // mech eid -> { wreck eid, until }
    this.truckJobs = new Map(); // truck eid -> { target eid, until }
    this.cooldown = new Map();  // mech eid -> sim time before which it is not sent to a bay again
    this.stats = { bayVisits: 0, swaps: 0, bayRepairs: 0, fieldRepairs: 0, collects: 0 };
  }

  get cfg() { return this.ai.diff.repair ?? {}; }
  get own() { return this.ai.perception.own; }
  get prod() { return this.ai.world.production; }

  think(now) {
    const cfg = this.cfg;
    if (cfg.bay) this.#bays(now);
    if (cfg.bay && cfg.armless && cfg.makeArms) this.#makeArms(now);
    if (cfg.armless) this.#collectArms(now);
    if (cfg.field) this.#field(now);
    // Blackboard for the other managers
    const bb = this.ai.bb;
    bb.maintaining = new Set([...this.toBay.keys(), ...this.collecting.keys(),
      ...[...this.truckJobs.values()].map((j) => j.target).filter((eid) => resolve(this.ai.world, eid)?.isMech)]);
    bb.serviceBays = new Set([...this.toBay.values()].filter((e) => !e.released).map((e) => e.bay));
    bb.truckJobs = new Set(this.truckJobs.keys());
  }

  /** Robots away on a mission (attacking wave, harass squad) are not pulled out here */
  #away() {
    const bb = this.ai.bb;
    const ids = new Set(bb.wave && !bb.wave.ended && bb.wave.phase === 'go' ? bb.wave.units : []);
    for (const eid of this.ai.military?.harass?.units ?? []) ids.add(eid);
    return ids;
  }

  // ---------- assembly bay service ----------

  /** Best arm in the shared stock: { key (stock key), dps } or null */
  #bestStockArm() {
    const ai = this.ai;
    let best = null;
    for (const entry of this.prod.stockedParts(ai.team, 'arm')) {
      const st = partStats(entry.path, 'leftArm', ai.race, ai.team);
      const dps = (st.weapons ?? []).filter((w) => (w.targets ?? ['ground']).includes('ground')).reduce((s, w) => s + weaponDps(w), 0);
      if (dps > 0 && (!best || dps > best.dps)) best = { key: entry.path, dps };
    }
    return best;
  }

  // A broken arm (0 HP, still mounted) is "damaged" since R1 (bay / field repair restores it); missingArmSlots counts it
  // too (part.alive === false), so the armless rule may also swap it for a stocked arm (faster than the repair).
  #needsBay(m, armInStock) {
    const cfg = this.cfg;
    if (hpRatio(m) < (cfg.bayBelow ?? 0) && m.damaged) return true;
    return Boolean(cfg.armless && armInStock && missingArmSlots(m).length);
  }

  #bays(now) {
    const ai = this.ai;
    const world = ai.world;
    const bays = this.prod.producersOf(ai.team, PRODUCES.mech).filter((b) => b.complete);
    // Bookkeeping: arrived, gave up, released robots back in action
    for (const [eid, e] of this.toBay) {
      const m = resolve(world, eid);
      const bay = resolve(world, e.bay);
      if (!m || !alive(m) || !bay || !alive(bay)) { this.toBay.delete(eid); continue; }
      if (e.released !== null) {
        if (m.active || now - e.released > RELEASE_GRACE) {
          this.toBay.delete(eid);
          this.cooldown.set(eid, now + AI.maintenance.bayTimeout); // e.g. released unrepaired for lack of ore
        }
        continue;
      }
      if (m.bay === bay) continue; // being serviced
      const going = m.order?.type === 'enterBay' && m.order.bay === bay;
      if (now - e.since > AI.maintenance.bayTimeout || (!going && now - e.since > SERVICE_COMMAND_GAP * 2 && !ai.isQueued(`bay:${eid}`))) {
        this.toBay.delete(eid);
        if (m.order?.type === 'enterBay') ai.issue({ type: 'stop', units: [eid] }, { priority: PRIORITY.normal, key: `bay:${eid}` });
      }
    }
    const stockArm = this.#bestStockArm();
    // Robots in a bay: arm first, then repair, then out
    for (const bay of bays) {
      const s = bay.service;
      if (!s?.mech || s.mech.team !== ai.team) continue;
      if (now - (this.bayCmdAt.get(bay.eid) ?? -Infinity) < SERVICE_COMMAND_GAP) continue;
      const entry = this.toBay.get(s.mech.eid) ?? { bay: bay.eid, since: now, released: null };
      this.toBay.set(s.mech.eid, entry);
      if (s.task && s.stopped !== 'noResources') continue;
      const missing = missingArmSlots(s.mech);
      let cmd = null;
      const econHold = Boolean(ai.bb.econ?.hold); // v4: no paid service while the economy waits for trucks
      if (econHold && !s.task) {
        cmd = { type: 'serviceRelease', bay: bay.eid };
        entry.released = now;
      } else if (missing.length && stockArm && !s.task) {
        cmd = { type: 'serviceSwap', bay: bay.eid, slot: missing[0], path: armModel(stockArm.key, missing[0]) };
        this.stats.swaps++;
      } else if (s.mech.damaged && !s.task && s.stopped !== 'noResources') {
        cmd = { type: 'serviceRepair', bay: bay.eid };
        this.stats.bayRepairs++;
      } else {
        cmd = { type: 'serviceRelease', bay: bay.eid };
        entry.released = now;
      }
      if (!this.prod.check({ ...cmd, team: ai.team }).ok) {
        if (cmd.type !== 'serviceRelease') cmd = { type: 'serviceRelease', bay: bay.eid };
        if (!this.prod.check({ ...cmd, team: ai.team }).ok) continue; // a swap is mounting: wait
        entry.released = now;
      }
      this.bayCmdAt.set(bay.eid, now);
      ai.issue(cmd, { priority: PRIORITY.high, key: `service:${bay.eid}` });
    }
    // New visits: worst robots first, nearest free bay (v4: not in the economy hold – repairs cost ore)
    if (ai.bb.state === 'defend' || ai.bb.econ?.hold) return;
    const taken = new Set([...this.toBay.values()].map((e) => e.bay));
    const free = bays.filter((b) => !b.service && !b.assemblyBusy && !b.serviceWaiting && !taken.has(b.eid)
      && !this.prod.itemsOf(b.eid).length);
    if (!free.length) return;
    const away = this.#away();
    const candidates = this.own.crewedMechs
      .filter((m) => m.active && !this.toBay.has(m.eid) && !away.has(m.eid) && m.eid !== ai.bb.scoutEid
        && !((this.cooldown.get(m.eid) ?? -Infinity) > now) && this.#needsBay(m, Boolean(stockArm)))
      .sort((a, b) => hpRatio(a) - hpRatio(b));
    for (const m of candidates) {
      const bay = nearest(free, posOf(m));
      if (!bay) break;
      free.splice(free.indexOf(bay), 1);
      this.toBay.set(m.eid, { bay: bay.eid, since: now, released: null });
      this.stats.bayVisits++;
      ai.issue({ type: 'enterBay', units: [m.eid], bay: bay.eid, queued: false }, { priority: PRIORITY.high, key: `bay:${m.eid}` });
      ai.note(`robot to bay (${Math.round(hpRatio(m) * 100)}% hp, ${missingArmSlots(m).length} arm(s) missing)`);
    }
  }

  // ---------- arms for swaps (R3) ----------

  /**
   * difficulty.repair.makeArms: a robot at home lost an arm (detached; a broken one is repaired since R1) and no arm is
   * in stock or queued → one arm is ordered at a part factory: the other side's type when the team can make it, else the best
   * ground arm per cost. Once it is in stock, #bays sends the robot in for serviceSwap. Not in the economy hold,
   * only above the reserved resources (Construction / Research).
   */
  #makeArms(now) {
    const ai = this.ai;
    const bb = ai.bb;
    if (bb.econ?.hold || bb.state === 'defend' || (this.armOrderUntil ?? -Infinity) > now) return;
    if (this.#bestStockArm()) return;
    const team = ai.team;
    if (this.prod.itemsOfTeam(team).some((i) => i.kind === 'part' && i.slot === ARMS.slot)) return; // one is coming
    const away = this.#away();
    // [v20] only a lost (detached) arm: a broken one is still mounted and the bay / field repair restores it (R1)
    const lostArm = (m) => ARM_SIDES.some((slot) => !m.parts?.[slot]);
    const mech = this.own.crewedMechs.find((m) => m.active && !away.has(m.eid) && m.eid !== bb.scoutEid && lostArm(m));
    if (!mech) return;
    const options = this.prod.partOptions(team, ARMS.slot);
    // the lost arm's type is unknown – the other side's type keeps the robot symmetric
    const lost = ARM_SIDES.map((slot) => mech.parts?.[slot]?.stats?.path).find(Boolean);
    let path = lost ? options.find((e) => stockKey(e.path) === stockKey(lost))?.path ?? null : null;
    if (path && groundDps(partStats(path, ARMS.canonicalSlot, ai.race, team)) <= 0) path = null;
    if (!path) {
      let best = -Infinity;
      for (const e of options) {
        const st = partStats(e.path, ARMS.canonicalSlot, ai.race, team);
        const value = groundDps(st) / Math.max(1, (st.cost?.ore ?? 0) + (st.cost?.energy ?? 0));
        if (value > 0 && value > best) { best = value; path = e.path; }
      }
    }
    if (!path) return;
    const factory = this.prod.producersOf(team, PRODUCES.part)
      .filter((s) => s.complete && this.prod.itemsOf(s.eid).length < ARM_FACTORY_QUEUE)
      .sort((a, b) => this.prod.itemsOf(a.eid).length - this.prod.itemsOf(b.eid).length)[0];
    if (!factory) return;
    const cmd = { type: 'queuePart', producer: factory.eid, slot: ARMS.slot, path };
    const res = this.prod.check({ ...cmd, team });
    if (!res.ok || !affordsAbove(ai.world.economy, team, res.cost, bb.reserved ?? {})) return;
    this.armOrderUntil = now + ARM_ORDER_SECONDS;
    this.stats.armsOrdered = (this.stats.armsOrdered ?? 0) + 1;
    ai.issue(cmd, { priority: PRIORITY.normal, key: 'repairArm' });
    ai.note(`arm ordered for a swap (${stockKey(path)})`);
  }

  // ---------- picking up arm wrecks ----------

  #collectArms(now) {
    const ai = this.ai;
    const p = ai.perception;
    for (const [eid, c] of this.collecting) {
      const m = resolve(ai.world, eid);
      if (!m || !alive(m) || c.until <= now || (m.order?.type !== 'collect' && !ai.isQueued(`collect:${eid}`))) this.collecting.delete(eid);
    }
    if (ai.bb.state === 'defend') return;
    const away = this.#away();
    const taken = new Set([...this.collecting.values()].map((c) => c.wreck));
    const wrecks = (ai.world.wrecks ?? []).filter((w) => w.available && w.part?.isArm && w.eid != null && !taken.has(w.eid)
      && w.object?.position && p.isVisible(w.object.position));
    if (!wrecks.length) return;
    for (const m of this.own.crewedMechs) {
      if (!m.active || this.collecting.has(m.eid) || this.toBay.has(m.eid) || away.has(m.eid)) continue;
      if (!(m.freeArmSlots?.length)) continue;
      const w = nearest(wrecks, posOf(m), (o) => o.object.position);
      if (!w || dist(w.object.position, posOf(m)) > AI.maintenance.collectRadius) continue;
      wrecks.splice(wrecks.indexOf(w), 1);
      this.collecting.set(m.eid, { wreck: w.eid, until: now + AI.maintenance.bayTimeout / 2 });
      this.stats.collects++;
      ai.issue({ type: 'collect', units: [m.eid], wreck: w.eid, queued: false }, { priority: PRIORITY.normal, key: `collect:${m.eid}` });
      if (!wrecks.length) return;
    }
  }

  // ---------- field repair by HoverTrucks ----------

  #field(now) {
    const ai = this.ai;
    const cfg = this.cfg;
    const world = ai.world;
    const construction = ai.construction;
    for (const [eid, j] of this.truckJobs) {
      const v = resolve(world, eid);
      const target = resolve(world, j.target);
      const working = v && alive(v) && v.order?.type === 'repair';
      if (!v || !alive(v) || !target || j.until <= now || (!working && !ai.isQueued(`truck:${eid}`))) this.truckJobs.delete(eid);
    }
    // Construction needs a builder: give one truck back
    if (construction?.needsBuilder(now) && this.truckJobs.size) {
      const [eid] = this.truckJobs.keys();
      this.truckJobs.delete(eid);
      ai.issue({ type: 'stop', units: [eid] }, { priority: PRIORITY.high, key: `truck:${eid}` });
      return;
    }
    if (construction?.needsBuilder(now)) return;
    const p = ai.perception;
    const own = p.own;
    const idle = (construction ? construction.idleBuilders() : own.builders.filter(isIdle))
      .filter((v) => v.repairer && !this.truckJobs.has(v.eid) && !(v.cargo?.length) && !ai.bb.truckJobs?.has(v.eid));
    if (!idle.length) return;
    // Keep one builder free unless the team has more trucks than builders it wants
    const spare = own.builders.length > (ai.diff.builders ?? 1) ? idle.length : idle.length - 1;
    if (spare <= 0) return;
    const anchor = own.anchor;
    const rally = ai.bb.rally ?? anchor;
    const near = (u) => Math.min(dist(posOf(u), anchor), dist(posOf(u), rally)) <= AI.maintenance.fieldRadius;
    const away = this.#away();
    const taken = new Set([...this.truckJobs.values()].map((j) => j.target));
    const threat = p.threat.active;
    const targets = [];
    if (!threat) {
      for (const m of own.crewedMechs) {
        if (!m.active || !m.damaged || away.has(m.eid) || this.toBay.has(m.eid) || taken.has(m.eid)) continue;
        if (hpRatio(m) < (cfg.fieldBelow ?? 0) && near(m)) targets.push({ u: m, need: hpRatio(m) });
      }
      for (const v of own.vehicles) {
        if (taken.has(v.eid) || !(v.hp < v.maxHp) || !near(v)) continue;
        if (v.hp / Math.max(1, v.maxHp) < (cfg.fieldBelow ?? 0)) targets.push({ u: v, need: v.hp / v.maxHp });
      }
    }
    for (const s of own.complete) {
      if (taken.has(s.eid) || !(s.hp < s.maxHp)) continue;
      const r = s.hp / Math.max(1, s.maxHp);
      if (r < (cfg.buildingBelow ?? 0)) targets.push({ u: s, need: r });
    }
    targets.sort((a, b) => a.need - b.need);
    for (const { u } of targets.slice(0, spare)) {
      const truck = nearest(idle, posOf(u));
      if (!truck) return;
      idle.splice(idle.indexOf(truck), 1);
      construction?.busyBuilders.set(truck.eid, now + AI.maintenance.truckReserveSeconds);
      this.truckJobs.set(truck.eid, { target: u.eid, until: now + AI.maintenance.bayTimeout });
      this.stats.fieldRepairs++;
      ai.issue({ type: 'repairUnit', units: [truck.eid], target: u.eid, queued: false }, { priority: PRIORITY.normal, key: `truck:${truck.eid}` });
    }
  }
}
