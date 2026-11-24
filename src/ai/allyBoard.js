// Steel Men AI – what allied computer players tell each other (v3, docs/notes/ai-v3.md). Allies may talk, so this is
// no cheating: an AI publishes the enemy team its attack wave goes for, and allied AIs prefer that team when they
// choose their own target (they attack the same enemy instead of splitting up). Module state like the AI list; an
// entry is only trusted while it is fresh (sim time), so a stale entry from an earlier match does no harm.

/** team -> { targetTeam, point: {x, z}, time } */
const intents = new Map();

/** Publishes the current attack target of a team's AI */
export function shareIntent(team, { targetTeam, point, time }) {
  intents.set(team, { targetTeam, point: point ? { x: point.x, z: point.z } : null, time });
}

/** Current entry of a team or null */
export function intentOf(team) { return intents.get(team) ?? null; }

/** Forgets a team's entry (AI stopped / new match) */
export function clearIntent(team) { intents.delete(team); }
