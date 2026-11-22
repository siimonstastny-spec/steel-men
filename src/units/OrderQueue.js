// Steel Mans – order queue shared by all units that take orders (ModularMech, Crew, Vehicle, CombatVehicle).
//   issueOrder(unit, entry, queued)  – queued (Shift held): waits behind the current order; otherwise replaces
//                                       the queue and runs at once
//   advanceQueue(unit)               – call at the start of the unit's update: an idle unit takes the next order
//   clearQueue(unit)                 – drops the queued orders (stop, a crew boarding a mech…)
//   orderTargets(unit)               – where the current and queued orders lead (ground markers, OrderQueueMarkers)
// An entry is { type, ref, run }: type = order name, ref = order-like object with the target
// ({ target } point or unit, { unit }, { structure }, { deposit }, { wreck }, { bay }, { mech }) and
// run() = issues the order on the unit, returns false when it is no longer possible (then the next one runs).
import { ORDER_QUEUE } from '../config.js';

/** The unit's queue (created on first use) */
export const queueOf = (unit) => (unit.orderQueue ??= []);

/** Drops all queued orders (the array is kept: callers may hold it) */
export function clearQueue(unit) {
  if (unit.orderQueue) unit.orderQueue.length = 0;
}

/**
 * The order the player gave and the unit is carrying out, or null while it only reacts by its behaviour
 * (an automatic fight, walking back home, a crew running away). A fight inside attack-move / patrol / guard
 * counts as that order.
 */
export function playerOrder(unit) {
  const o = unit.order;
  if (!o) return null;
  if (o.resume) return o.resume;
  if (o.auto || o.home || o.type === 'flee') return null;
  return o;
}

/**
 * Gives an order. Not queued: the queue is dropped and the order runs now. Queued: an idle unit runs it now,
 * a busy one adds it to the queue; after a patrol, move / patrol orders become patrol points and other
 * orders are refused.
 * @param {{ type: string, ref: object, run: () => boolean }} entry
 * @returns {boolean} false when the order was refused
 */
export function issueOrder(unit, entry, queued = false) {
  const q = queueOf(unit);
  if (!queued) { q.length = 0; return entry.run(); }
  if (!q.length && !playerOrder(unit)) return entry.run();
  const tail = q.at(-1);
  const current = playerOrder(unit);
  if ((tail?.type ?? current?.type) === 'patrol') {
    const point = entry.ref?.target;
    if (!ORDER_QUEUE.patrolWaypointOrders.includes(entry.type) || !point?.isVector3) return false;
    if (tail) (tail.extraPoints ??= []).push(point.clone());
    else current.points.push(point.clone());
    return true;
  }
  if (q.length >= ORDER_QUEUE.maxLength) return false;
  q.push(entry);
  return true;
}

/**
 * Starts the next queued order once the unit has none (orders that are no longer possible are skipped).
 * @returns {boolean} true when an order was started
 */
export function advanceQueue(unit) {
  const q = unit.orderQueue;
  if (!q?.length || unit.order) return false;
  while (q.length) {
    const next = q.shift();
    const rest = q.splice(0); // run() may drop the queue (vehicle orders do) – the rest is put back
    const ok = next.run();
    q.push(...rest);
    if (ok) {
      if (next.extraPoints && unit.order?.type === 'patrol') unit.order.points.push(...next.extraPoints);
      return true;
    }
  }
  return false;
}

/** World position an order leads to (null when unknown) */
export function orderPosition(o) {
  const t = o?.target ?? o?.point ?? o?.unit ?? o?.structure ?? o?.deposit ?? o?.bay ?? o?.mech ?? o?.wreck;
  if (!t) return null;
  if (t.isVector3) return t;
  return t.position ?? t.object?.position ?? t.part?.object?.position ?? null;
}

/**
 * Targets of the current order and the queued ones, in order: [{ type, points: [Vector3] }]. A patrol gives
 * all its points (it loops), anything else one point.
 */
export function orderTargets(unit) {
  const out = [];
  const add = (type, o, extra = []) => {
    if (type === 'patrol') {
      const points = [...(o.points ?? [orderPosition(o)]), ...extra].filter(Boolean);
      if (points.length) out.push({ type, points });
      return;
    }
    const p = orderPosition(o);
    if (p) out.push({ type, points: [p] });
  };
  const cur = playerOrder(unit);
  if (cur) add(cur.type, cur);
  for (const e of unit.orderQueue ?? []) add(e.type, e.ref, e.extraPoints);
  return out;
}
