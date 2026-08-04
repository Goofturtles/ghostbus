// The single-ride planner's arithmetic — pure, so every claim it makes can be
// exercised in a plain Node test with no browser and no network around.
//
// The server hands back a MENU of real single-ride options (see /api/plan). It cannot
// rank them, because ranking depends on how fast the rider walks and that preference
// never leaves their device. This is where the choosing happens.
//
// Three honesty rules govern the arithmetic:
//
//   1. THE RIDE TIME IS THE AGENCY'S, NOT OURS. `rideSec` is the published scheduled
//      running time between the two stops. GhostBus does not model how a trip in
//      progress will run, so it never shortens or pads that number — and the UI says
//      on its face that this is what the figure is.
//   2. A DELAYED BOARDING SHIFTS THE WHOLE PLAN. When the boarding departure has a
//      live prediction or an evidence-backed honest ETA, the plan is built on THAT
//      instant, not on the timetable. The scheduled running time is then added to it,
//      which is an assumption — and a disclosed one.
//   3. AN UNREACHABLE RIDE IS NOT A PLAN. If the rider cannot walk to the boarding
//      stop before it leaves, that option is marked unreachable and never chosen. If
//      none can be reached, the caller gets null and says so, rather than printing a
//      departure nobody can catch.

import type { RideCandidateDto, ItineraryDto } from '@shared/types';
import { walkLegSeconds, type MeasuredWalk, type WalkKind } from './walk';

export interface WalkLeg {
  distanceM: number;
  seconds: number;
  /** 'routed' when these numbers came from a walking route measured along real ways
   *  — the line the map draws. 'direct' is the straight-line estimate. */
  kind: WalkKind;
}

export interface RidePlan {
  candidate: RideCandidateDto;
  /** the rider's walk to the boarding stop. */
  toStop: WalkLeg;
  /** the walk from the alighting stop to the destination. */
  fromStop: WalkLeg;
  /** the instant the plan is built on: live prediction, else honest ETA, else schedule. */
  boardMs: number;
  /** true when `boardMs` is not simply the timetable — i.e. the plan carries a claim. */
  boardIsPredicted: boolean;
  /** the agency's published running time between the two stops, seconds. */
  rideSec: number;
  /** seconds spent waiting at the stop having walked straight there. Never negative. */
  waitSec: number;
  /** when to leave to arrive at the stop exactly as it departs. */
  leaveByMs: number;
  /** when the rider would be standing at their destination. */
  doorMs: number;
  /**
   * Seconds of actually TRAVELLING — walk, ride, walk.
   *
   * Deliberately NOT `doorMs - nowMs`. Measured from now, a 25-minute streetcar ride
   * whose next departure is tomorrow morning reports as a six-hour journey, which is
   * arithmetically true and completely useless. The wait is not hidden — it is what
   * `leaveByMs` and the arrival time say out loud, with the service date beside them.
   */
  totalSec: number;
  /** false when the walk to the boarding stop is longer than the time left. */
  reachable: boolean;
}

export interface PlanOptions {
  /** server-corrected now, epoch ms. */
  nowMs: number;
  /** the rider's walking speed, metres/second (store.paceMps). */
  paceMps: number;
  /**
   * The walk the map has MEASURED to the boarding stop, when it has one for THIS
   * candidate's stop. It replaces the straight-line first leg, so the leave-by a
   * rider is given is the leave-by for the path they can see.
   *
   * DELIBERATELY ABSENT FROM RANKING. `pickBestRide` never receives it, and must not.
   * A measured walk arrives after the plan is chosen, so letting it change the choice
   * would let the answer rewrite the question: option A is picked, the map routes to
   * A's stop, the longer walk makes A unreachable, B is picked, the map routes to B,
   * A becomes reachable again. The plan is chosen on the estimate every candidate
   * shares, and the chosen one is then re-timed with what is actually known about it.
   */
  boardWalk?: MeasuredWalk | null;
}

/**
 * The instant a candidate's boarding departure is actually expected.
 *
 * Identical precedence to a departure row (`DepartureRow`), deliberately: the same
 * departure must not read as one time on the board and another in the planner.
 */
export function boardingInstant(c: RideCandidateDto): { ms: number; predicted: boolean } {
  if (c.liveEtaMs != null) return { ms: c.liveEtaMs, predicted: true };
  if (c.honest.estimateMs != null) return { ms: c.honest.estimateMs, predicted: true };
  return { ms: c.departureMs, predicted: false };
}

/** Turn one server candidate into a full door-to-door plan at this rider's pace. */
export function buildRidePlan(c: RideCandidateDto, opts: PlanOptions): RidePlan {
  const { nowMs, paceMps } = opts;
  const measured = opts.boardWalk?.kind === 'routed' && opts.boardWalk.stopId === c.board.stopId
    ? opts.boardWalk
    : null;
  const toStop: WalkLeg = measured
    ? { distanceM: measured.distanceM, seconds: measured.seconds, kind: 'routed' }
    : {
      distanceM: c.board.distanceM,
      seconds: walkLegSeconds('direct', c.board.distanceM, paceMps),
      kind: 'direct',
    };
  // The walk from the alighting stop is never routed: it happens at the far end of a
  // ride, in tiles this device has no reason to have loaded. It stays the estimate it
  // has always been, and is marked as one rather than quietly borrowing the other
  // leg's credibility.
  const fromStop: WalkLeg = {
    distanceM: c.alight.distanceM,
    seconds: walkLegSeconds('direct', c.alight.distanceM, paceMps),
    kind: 'direct',
  };

  const board = boardingInstant(c);
  // The agency's own running time. Guarded rather than trusted blindly: a feed row
  // whose arrival is not after its departure would otherwise produce a negative ride.
  const rideSec = Math.max(0, Math.round((c.arrivalMs - c.departureMs) / 1000));

  const leaveByMs = board.ms - toStop.seconds * 1000;
  const waitSec = Math.max(0, Math.round((leaveByMs - nowMs) / 1000));
  const doorMs = board.ms + rideSec * 1000 + fromStop.seconds * 1000;

  return {
    candidate: c,
    toStop,
    fromStop,
    boardMs: board.ms,
    boardIsPredicted: board.predicted,
    rideSec,
    waitSec,
    leaveByMs,
    doorMs,
    // Travel only: leaving-the-door to standing-at-the-destination, which is
    // walk + ride + walk by construction. See the field's note above for why this
    // is not measured from `nowMs`.
    totalSec: Math.max(0, Math.round((doorMs - leaveByMs) / 1000)),
    // Leaving this very second still counts: the rider is allowed to already be late
    // enough that the walk exactly consumes the remaining time.
    reachable: leaveByMs >= nowMs,
  };
}

/**
 * The best plan among the server's candidates, or null when none can be reached.
 *
 * "Best" is the earliest the rider is actually standing at their destination — not the
 * earliest departure, which would happily send them sprinting to a stop to save a
 * minute they then lose walking from the wrong end.
 */
export function pickBestRide(
  candidates: readonly RideCandidateDto[],
  opts: PlanOptions,
): RidePlan | null {
  let best: RidePlan | null = null;
  for (const c of candidates) {
    const plan = buildRidePlan(c, opts);
    if (!plan.reachable) continue;
    if (
      best == null
      || plan.doorMs < best.doorMs
      // A dead heat at the door goes to the one that leaves later — the rider gets to
      // stand around at home rather than at a stop.
      || (plan.doorMs === best.doorMs && plan.leaveByMs > best.leaveByMs)
    ) {
      best = plan;
    }
  }
  return best;
}

/** Every candidate as a plan, soonest door-arrival first — the "later options" list. */
export function allRidePlans(
  candidates: readonly RideCandidateDto[],
  opts: PlanOptions,
): RidePlan[] {
  return candidates
    .map((c) => buildRidePlan(c, opts))
    .sort((a, b) => a.doorMs - b.doorMs || a.leaveByMs - b.leaveByMs);
}

/**
 * TWO RIDES AND THE WALK BETWEEN THEM, timed at this rider's pace.
 *
 * Each leg is built by `buildRidePlan` unchanged — which works out exactly right because
 * of how the server shapes them: a leg's transfer end carries `distanceM: 0`, so leg 1's
 * walk-from and leg 2's walk-to are zero-length by construction and the only walks with
 * time in them are the two real ones, plus the transfer stated separately below.
 */
export interface ItineraryPlan {
  itinerary: ItineraryDto;
  /** rider -> first stop -> ride. Its `fromStop` is the zero-length transfer end. */
  leg1: RidePlan;
  /** second ride -> destination. Its `toStop` is the zero-length transfer end. */
  leg2: RidePlan;
  /** the transfer walk, re-timed at THIS rider's pace. */
  transferWalkSec: number;
  /**
   * Alighting to boarding, measured on the instants THIS plan is built on — which is not
   * the same as the server's `ItineraryDto.transferWaitSec` the moment leg 1 carries a
   * live or honest prediction and leg 2 does not.
   */
  transferGapSec: number;
  /**
   * What is left of that gap AFTER the walk — the time the rider actually stands there.
   *
   * NOT the server's field of the same name, which is the WHOLE gap and therefore
   * already includes the walk. Rendering that one beside the walk row printed the walk
   * twice: the legs summed to `totalSec` plus one transfer walk, in all three locales.
   * `transferWalkSec + transferWaitSec === transferGapSec` by construction, which is what
   * makes the rendered rows add up to `totalSec` exactly.
   */
  transferWaitSec: number;
  /**
   * Does the connection still work once leg 1's own prediction is counted?
   *
   * The server chose this pair off the published schedule. When `boardingInstant` then
   * shifts leg 1 onto a live or honest estimate — and leg 2, schedule-only, does not move
   * — the gap shrinks, and past a point the rider is still on the first vehicle when the
   * second one leaves. The card would print leg 1 alighting AFTER leg 2 boards.
   */
  connectionHolds: boolean;
  /** Every leg's plan, in journey order. `leg1`/`leg2` are `legPlans[0]`/`[1]`. */
  legPlans: RidePlan[];
  /**
   * One per seam, in journey order — `connections[i]` joins `legPlans[i]` to `[i+1]`.
   *
   * `scheduledSlackSec` is this seam's own answer to the question `scheduledSlackSec`
   * below answers for the first one, and it is per-seam for the reason the whole field
   * exists: a three-leg journey has two connections, they are not equally tight, and a
   * percentage quoted off the first one would speak for a risk the rider is not taking.
   */
  connections: Array<{
    gapSec: number; walkSec: number; waitSec: number; holds: boolean; scheduledSlackSec: number;
  }>;
  /**
   * THE SLACK AS PUBLISHED — leg 2's scheduled departure, minus leg 1's scheduled arrival,
   * minus the transfer walk at this rider's pace. Seconds.
   *
   * Deliberately NOT `transferWaitSec`, which is measured on the instants this plan is
   * actually built on and therefore already has any live delay priced into it. This one is
   * the question "how much lateness would it take to break this connection?", and the only
   * honest answer to that is measured against the timetable both operators published —
   * which is also the only frame the historical delay distribution is expressed in.
   *
   * It is what `connectionLikelihood` is given, and nothing else reads it.
   */
  scheduledSlackSec: number;
  leaveByMs: number;
  doorMs: number;
  /** walk + ride + transfer walk + wait + ride + walk. */
  totalSec: number;
  reachable: boolean;
}

/**
 * Build one itinerary at this rider's pace.
 *
 * WHOSE PACE DECIDED THIS CONNECTION EXISTS: the server's, and deliberately the SLOW
 * one — see TRANSFER_PACE_MPS in api.ts. So a connection on the menu is one a slow walker
 * could also make, and re-timing it here at a faster pace can only ever add slack. The
 * pace on this device changes what the rider is TOLD the walk takes; it never quietly
 * promotes an unmakeable connection into a makeable one.
 */
export function buildItineraryPlan(it: ItineraryDto, opts: PlanOptions): ItineraryPlan {
  // EVERY leg, not two: an itinerary is two legs or three, and the arithmetic below is
  // stated per PAIR so a third leg cannot slip through unjudged. Only the first leg is
  // re-timed on a MEASURED walk — `boardWalk` belongs to the rider's own first leg, and
  // letting it match a later one would apply a path measured under the rider's feet to a
  // stop somewhere out in the network.
  const legPlans = it.legs.map((leg, i) =>
    buildRidePlan(leg, i === 0 ? opts : { ...opts, boardWalk: null }));
  const leg1 = legPlans[0];
  const leg2 = legPlans[1];
  const last = legPlans[legPlans.length - 1];

  /**
   * One connection per leg pair, each judged on its own.
   *
   * The gap is measured on the instants this plan is ACTUALLY built on: `boardMs` is the
   * predicted boarding where there is a prediction, and the ride time after it is the
   * agency's, so this is when the rider really steps off that vehicle.
   */
  const connections = it.transfers.map((t, i) => {
    const alightMs = legPlans[i].boardMs + legPlans[i].rideSec * 1000;
    const gapSec = Math.round((legPlans[i + 1].boardMs - alightMs) / 1000);
    const walkSec = walkLegSeconds('direct', t.distanceM, opts.paceMps);
    // Published timetable only — see `scheduledSlackSec`'s note. `legs[i].arrivalMs` is
    // this leg's scheduled arrival at the transfer stop and `legs[i + 1].departureMs` the
    // next leg's scheduled departure from it, both straight off the agencies' schedules.
    const scheduledSlackSec = Math.round(
      (it.legs[i + 1].departureMs - it.legs[i].arrivalMs) / 1000,
    ) - walkSec;
    return {
      gapSec, walkSec, waitSec: Math.max(0, gapSec - walkSec), holds: gapSec >= walkSec,
      scheduledSlackSec,
    };
  });
  const transferGapSec = connections[0].gapSec;
  const transferWalkSec = connections[0].walkSec;
  const scheduledSlackSec = connections[0].scheduledSlackSec;
  // The TIGHTEST seam decides the journey: one broken connection breaks all of it.
  const allConnectionsHold = connections.every((c) => c.holds);

  return {
    itinerary: it,
    leg1,
    leg2,
    legPlans,
    connections,
    transferWalkSec,
    transferGapSec,
    scheduledSlackSec,
    // Floored at zero so a broken connection cannot render as a negative wait; the
    // itinerary is refused by `connectionHolds` below rather than shown with a 0.
    transferWaitSec: Math.max(0, transferGapSec - transferWalkSec),
    connectionHolds: allConnectionsHold,
    leaveByMs: leg1.leaveByMs,
    doorMs: last.doorMs,
    // Travel only, on the same definition `RidePlan.totalSec` uses and for the same
    // reason: measured from `leaveByMs`, so an itinerary whose first leg is tomorrow
    // morning does not report as a sixteen-hour journey.
    totalSec: Math.max(0, Math.round((last.doorMs - leg1.leaveByMs) / 1000)),
    // TWO ways an itinerary stops being one. The rider cannot reach the first stop in
    // time — or they can, and the first leg's own predicted delay has since eaten the
    // connection. The server judged the second question against the published schedule
    // at a slow pace; it could not have judged it against a prediction that did not
    // exist yet. Both are refusals, because itinerary.ts's first rule is the same on
    // this side of the wire: a connection the rider cannot make is not a connection.
    reachable: leg1.reachable && allConnectionsHold,
  };
}

/**
 * Every itinerary as a plan, soonest door-arrival first — the two-leg tier's answer to
 * `allRidePlans`, and the list the options view ranks.
 *
 * Same order, same tie-break, and deliberately UNFILTERED for the same reason
 * `allRidePlans` is: the caller decides what an unreachable option is worth showing, and
 * a list function that silently drops rows is a list function nobody can audit.
 */
export function allItineraryPlans(
  itineraries: readonly ItineraryDto[],
  opts: PlanOptions,
): ItineraryPlan[] {
  return itineraries
    .map((it) => buildItineraryPlan(it, opts))
    .sort((a, b) => a.doorMs - b.doorMs || a.leaveByMs - b.leaveByMs);
}

/** The best itinerary: soonest at the destination, ties to the later departure. */
export function pickBestItinerary(
  itineraries: readonly ItineraryDto[],
  opts: PlanOptions,
): ItineraryPlan | null {
  let best: ItineraryPlan | null = null;
  for (const it of itineraries) {
    const plan = buildItineraryPlan(it, opts);
    if (!plan.reachable) continue;
    if (
      best == null
      || plan.doorMs < best.doorMs
      || (plan.doorMs === best.doorMs && plan.leaveByMs > best.leaveByMs)
    ) best = plan;
  }
  return best;
}

/**
 * A directions deep link for a journey this tier cannot plan.
 *
 * DESTINATION ONLY, deliberately. The rider's own position is exactly the thing this
 * app promises never to send anywhere, and a maps app already knows where its user is
 * — so putting a live location into a third-party URL would buy nothing and cost the
 * one guarantee that matters.
 */
export function transitDirectionsUrl(to: { lat: number; lon: number }): string {
  const dest = `${to.lat.toFixed(6)},${to.lon.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&travelmode=transit&destination=${encodeURIComponent(dest)}`;
}
