// WHERE AN END OF A TRIP IS.
//
// The planner has always taken two coordinates, and the app has always assumed the first
// one was the rider's GPS fix. That assumption was baked into the UI as an unchangeable
// line reading "From your location", which is wrong for the two most ordinary questions a
// rider asks: "how do I get home from the office" (asked before leaving the office), and
// "how do I get to the airport from downtown" (asked from bed).
//
// So an end of a trip is one of three things, and they are three DIFFERENT kinds rather
// than one nullable coordinate:
//
//   here  · the rider's GPS fix. Has no coordinate of its own — it borrows whatever
//           `useLive.geo` currently holds every time it is resolved, so it can never go
//           stale independently of the fix the rest of the app is using.
//           NOT a continuously-updating position: `useLive` takes a one-shot
//           `getCurrentPosition` (see `requestLocation`), so today `here` moves only when
//           that is re-taken. Said plainly rather than implied, because "borrows the
//           current fix" and "tracks the rider" are different claims and only the first
//           one is true.
//   stop  · a real stop out of the agency's schedule, with an agency and a stop id.
//           The only kind that can be written to the persisted recents list.
//   pin   · a point on the map with no stop and no agency. This kind exists so
//           `completeMapPick` has somewhere honest to land (see the store), and it is
//           deliberately NOT a `stop` with invented ids: a pin's label is a coordinate
//           the rider chose, not a place the agency published.
//
// Keeping these apart in the type is what stops a map-picked point being written to
// localStorage as a stop and silently discarded on the next boot — the exact failure the
// old `completeMapPick` TODO was left in place to avoid.

import type { RecentPlace } from './search';

export type PlanPoint =
  | { kind: 'here' }
  | { kind: 'stop'; place: RecentPlace }
  | { kind: 'pin'; lat: number; lon: number; label: string };

export interface LatLon { lat: number; lon: number }

/** Narrowly typed and frozen: it is a shared singleton, and a `PlanPoint`-typed export
 *  would lose the `here` narrowing at every use site. */
export const HERE: { kind: 'here' } = Object.freeze({ kind: 'here' as const });

/** U+001F, which cannot occur in a GTFS id. Same delimiter and same reasoning as the
 *  server's `metaKey`: a `/` separator is ambiguous the moment an agency puts one in a
 *  stop_id, and these keys decide whether a rider keeps their answer or watches it
 *  flicker back to a skeleton. */
const SEP = String.fromCharCode(31);

/**
 * The coordinate to send the planner for this end, or null when there isn't one.
 *
 * Null is a real answer and every caller has to handle it: `here` with no GPS fix yet has
 * no coordinate, and a stop the agency published without lat/lon has none either. The
 * planner cannot be called with a guess for either, so it is not called at all.
 */
export function planPointCoords(p: PlanPoint | null, here: LatLon | null): LatLon | null {
  if (p == null) return null;
  if (p.kind === 'here') return here;
  if (p.kind === 'pin') return { lat: p.lat, lon: p.lon };
  const { lat, lon } = p.place;
  return lat == null || lon == null ? null : { lat, lon };
}

/** Does this end need the rider's GPS fix to be answerable at all? */
export const needsFix = (p: PlanPoint | null): boolean => p?.kind === 'here';

/**
 * A STABLE IDENTITY FOR ONE END, used to tell a 60-second refresh of the same question
 * apart from a genuinely new one.
 *
 * `here` deliberately folds in the coordinate rather than being a constant: the rider
 * moving IS a new question, and a key that ignored it would hold a stale answer on screen
 * while they walked away from the stop it was built on.
 *
 * QUANTIZED TO ~11 m. The fix is one-shot today, but the moment it becomes a watched
 * position, raw float precision would make stationary GPS jitter in the sixth decimal a
 * new key on every sample — which drops the answer to a skeleton and refetches, the exact
 * flicker the caller's `isRefresh` check exists to prevent. Four decimals keeps real
 * movement meaningful and makes noise a no-op.
 */
export function planPointKey(p: PlanPoint | null, here: LatLon | null): string {
  if (p == null) return '-';
  if (p.kind === 'here') {
    return here ? `here${SEP}${here.lat.toFixed(4)},${here.lon.toFixed(4)}` : `here${SEP}?`;
  }
  if (p.kind === 'pin') return `pin${SEP}${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  return `stop${SEP}${p.place.agency}${SEP}${p.place.stopId}`;
}

/**
 * Swap the two ends.
 *
 * Total on purpose — there is no arrangement of two ends this cannot reverse, including
 * "from here to the office" becoming "from the office to here". A swap that silently
 * refused half the time is worse than no swap button, and the one case that genuinely
 * cannot be reversed (no destination chosen yet) is a disabled button, not a no-op the
 * rider is left to interpret.
 */
export function swapEnds(
  origin: PlanPoint, target: PlanPoint | null,
): { origin: PlanPoint; target: PlanPoint | null } {
  if (target == null) return { origin, target };
  return { origin: target, target: origin };
}
