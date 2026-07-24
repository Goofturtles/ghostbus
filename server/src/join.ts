// Identity join (the Phase-2 headline): match GTFS-realtime entities to static
// trips WITHOUT a shared trip_id.
//
// Measured reality of the TTC feed (see BLOCKERS.md):
//   - RT trip_id does NOT match the static trip_id (~0.1%).
//   - RT TripDescriptor omits start_time AND start_date (both empty strings).
//   - RT route_id DOES match the static route_id.
//   - Each StopTimeUpdate carries stop_id + an explicit delay + a predicted time.
//
// So the only sound handle is the schedule itself: for a stop a trip update covers,
//   scheduled_time_at_stop = predicted_time - delay        (delay is defined relative
//                                                            to the static schedule)
// which, converted to seconds-past-service-midnight, must equal the static
// stop_time.departure_s of the trip actually running. Matching an RT trip against a
// static trip on several such (stop, scheduled-second) points is a strict
// generalization of the spec's (route_id, start_time) key — and is exact by the GTFS
// definition of `delay` when the RT feed and the loaded static are the same board.
//
// This module is pure (no DB, no clock) so the claim logic is unit-tested directly.

/** A static stop_time reference, grouped by (route_id, stop_id) into the index. */
export interface StopTimeRef {
  tripId: string;
  depSec: number; // seconds-past-service-midnight
}

/** (route_id, stop_id) -> sorted-by-nothing list of static stop_times on that route. */
export type RouteStopIndex = Map<string, StopTimeRef[]>;

export function indexKey(routeId: string, stopId: string): string {
  return routeId + '|' + stopId;
}

/** Build the inverted index from a flat list of active static stop_times. */
export function buildRouteStopIndex(
  rows: Array<{ routeId: string; stopId: string; depSec: number; tripId: string }>,
): RouteStopIndex {
  const idx: RouteStopIndex = new Map();
  for (const r of rows) {
    const k = indexKey(r.routeId, r.stopId);
    let a = idx.get(k);
    if (!a) { a = []; idx.set(k, a); }
    a.push({ tripId: r.tripId, depSec: r.depSec });
  }
  return idx;
}

/** One reconstructed observation from an RT StopTimeUpdate. */
export interface RtStopObs {
  stopId: string;
  schedSec: number; // reconstructed seconds-past-service-midnight (predicted - delay)
}

export interface RtTripInput {
  rtTripId: string;
  routeId: string;
  stops: RtStopObs[];
}

export interface ClaimOptions {
  /** ± seconds a reconstructed schedule second may differ from a static departure. */
  tolSec: number;
  /** minimum matching stops before a static trip may be claimed. */
  minVotes: number;
  /** service-day length in seconds for wrap handling (default 86400). */
  dayLenSec?: number;
}

export interface ClaimResult {
  /** rtTripId -> claimed static trip_id. */
  claims: Map<string, string>;
  /** the set of static trip_ids that are claimed (== "present"). */
  claimedStatic: Set<string>;
  /** rtTripId -> winning vote count. */
  votes: Map<string, number>;
  /** RT trips that produced votes but were skipped for an unbroken top tie. */
  ambiguous: number;
  /** RT trips that matched no static trip at all. */
  unmatched: number;
}

interface Candidate {
  rtTripId: string;
  staticTripId: string;
  votes: number;
}

/** Count votes for each static trip that an RT trip's stops are consistent with. */
function tallyVotes(rt: RtTripInput, index: RouteStopIndex, tolSec: number, dayLenSec: number): Map<string, number> {
  const votes = new Map<string, number>();
  for (const s of rt.stops) {
    const cands = index.get(indexKey(rt.routeId, s.stopId));
    if (!cands) continue;
    const counted = new Set<string>(); // one vote per static trip per stop
    for (const c of cands) {
      const diff = Math.abs(c.depSec - s.schedSec);
      const wrapped = Math.abs(diff - dayLenSec); // handle 24h/service-midnight wrap
      if ((diff <= tolSec || wrapped <= tolSec) && !counted.has(c.tripId)) {
        votes.set(c.tripId, (votes.get(c.tripId) ?? 0) + 1);
        counted.add(c.tripId);
      }
    }
  }
  return votes;
}

/**
 * Claim static trips for RT trips. A static trip is claimed at most once per call
 * (once per service date, in the caller); when two RT trips want the same static trip
 * the one with more votes wins and the loser falls back to its next-best candidate.
 * RT trips whose winning vote is a tie with the runner-up are left unmatched (counted
 * as ambiguous) rather than guessed.
 */
export function claimTrips(rtTrips: RtTripInput[], index: RouteStopIndex, opts: ClaimOptions): ClaimResult {
  const dayLenSec = opts.dayLenSec ?? 86400;
  const claims = new Map<string, string>();
  const claimedStatic = new Set<string>();
  const votesOut = new Map<string, number>();
  let ambiguous = 0;
  let unmatched = 0;

  // Per-RT ranked candidate lists (votes desc), and detect top ties up front.
  const ranked = new Map<string, Candidate[]>();
  const rtAmbiguous = new Set<string>();
  const noVotes = new Set<string>();
  for (const rt of rtTrips) {
    const votes = tallyVotes(rt, index, opts.tolSec, dayLenSec);
    if (votes.size === 0) { noVotes.add(rt.rtTripId); continue; }
    const list: Candidate[] = [...votes].map(([staticTripId, v]) => ({ rtTripId: rt.rtTripId, staticTripId, votes: v }));
    list.sort((a, b) => b.votes - a.votes || (a.staticTripId < b.staticTripId ? -1 : 1));
    if (list.length >= 2 && list[0].votes === list[1].votes) { rtAmbiguous.add(rt.rtTripId); continue; }
    if (list[0].votes < opts.minVotes) { noVotes.add(rt.rtTripId); continue; }
    ranked.set(rt.rtTripId, list.filter((c) => c.votes >= opts.minVotes));
  }

  // Greedy 1:1 assignment by descending winning votes (order-independent).
  const heads: Candidate[] = [];
  for (const list of ranked.values()) if (list.length) heads.push(list[0]);
  heads.sort((a, b) => b.votes - a.votes || (a.rtTripId < b.rtTripId ? -1 : 1));

  const assignedRt = new Set<string>();
  // Iterate until no more progress; losers fall back to next-best unclaimed candidate.
  let progress = true;
  while (progress) {
    progress = false;
    heads.sort((a, b) => b.votes - a.votes || (a.rtTripId < b.rtTripId ? -1 : 1));
    for (const head of heads) {
      if (assignedRt.has(head.rtTripId)) continue;
      const list = ranked.get(head.rtTripId)!;
      // advance to the next candidate not already claimed by someone else
      let picked: Candidate | null = null;
      for (const c of list) {
        if (!claimedStatic.has(c.staticTripId)) { picked = c; break; }
      }
      if (!picked) { assignedRt.add(head.rtTripId); unmatched++; progress = true; continue; }
      claims.set(head.rtTripId, picked.staticTripId);
      claimedStatic.add(picked.staticTripId);
      votesOut.set(head.rtTripId, picked.votes);
      assignedRt.add(head.rtTripId);
      progress = true;
    }
  }

  ambiguous = rtAmbiguous.size;
  unmatched += noVotes.size;
  return { claims, claimedStatic, votes: votesOut, ambiguous, unmatched };
}
