// The single-ride planner's arithmetic, exercised end to end.
//
// These tests are about the CLAIMS, not the plumbing: that a plan is built on the
// instant a departure is actually expected, that the agency's running time is never
// quietly reshaped, that a ride nobody can walk to is not offered, and that the
// destination deep link cannot leak the rider's own position.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { RideCandidateDto, ItineraryDto } from '../../../shared/types.ts';
import {
  boardingInstant, buildRidePlan, pickBestRide, allRidePlans, transitDirectionsUrl,
  buildItineraryPlan, pickBestItinerary,
} from './plan.ts';
import en from '../i18n/en.ts';
import es from '../i18n/es.ts';
import frCA from '../i18n/frCA.ts';

const T0 = Date.parse('2026-07-27T13:00:00Z'); // the reference "now" for every case
/** average pace, as store.paceMps resolves it: 4.8 km/h -> 1.333 m/s */
const PACE = 4.8 / 3.6;

function candidate(o: Partial<RideCandidateDto> & {
  tripId: string; departureMs: number; arrivalMs: number;
  boardDistanceM?: number; alightDistanceM?: number;
} ): RideCandidateDto {
  const { boardDistanceM = 200, alightDistanceM = 150, ...rest } = o;
  return {
    routeId: '504', shortName: '504', longName: 'King', routeType: 0, color: 'ED1C24',
    headsign: 'East - 504A King towards Distillery Loop', directionId: 0,
    directionLabel: 'East - 504A King towards Distillery Loop',
    board: {
      agency: 'ttc', stopId: 'B1', name: 'King St West at Spadina Ave', lat: 43.64537, lon: -79.395811,
      wheelchairBoarding: 1, distanceM: boardDistanceM,
    },
    alight: {
      agency: 'ttc', stopId: 'A1', name: 'Dundas West Station', lat: 43.656862, lon: -79.453415,
      wheelchairBoarding: 1, distanceM: alightDistanceM,
    },
    boardStopSequence: 14, alightStopSequence: 38, stopsRidden: 24,
    liveEtaMs: null,
    honest: { estimateMs: null, bandLowMs: null, bandHighMs: null, medianDelaySec: null },
    evidence: { n: 0, windowDays: 14, bucket: 'none' },
    ...rest,
  };
}

const opts = { nowMs: T0, paceMps: PACE };

// ---------------- which instant a plan is built on ----------------

test('a schedule-only candidate is planned on the timetable, and says so', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const b = boardingInstant(c);
  assert.equal(b.ms, c.departureMs);
  assert.equal(b.predicted, false);
  assert.equal(buildRidePlan(c, opts).boardIsPredicted, false);
});

test('a live prediction outranks both the honest ETA and the timetable', () => {
  const c = candidate({
    tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000,
    liveEtaMs: T0 + 900_000,
    honest: { estimateMs: T0 + 700_000, bandLowMs: null, bandHighMs: null, medianDelaySec: 100 },
  });
  const b = boardingInstant(c);
  assert.equal(b.ms, T0 + 900_000);
  assert.equal(b.predicted, true);
});

test('an evidence-backed honest ETA is used when there is no live prediction', () => {
  const c = candidate({
    tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000,
    honest: { estimateMs: T0 + 780_000, bandLowMs: null, bandHighMs: null, medianDelaySec: 180 },
  });
  assert.deepEqual(boardingInstant(c), { ms: T0 + 780_000, predicted: true });
});

// ---------------- the arithmetic ----------------

test('the ride time is the agency’s scheduled running time, never reshaped', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 600_000 + 1_500_000 });
  assert.equal(buildRidePlan(c, opts).rideSec, 1500);
});

test('a delayed boarding shifts the whole plan by the delay, keeping the running time', () => {
  const scheduled = candidate({ tripId: 'S', departureMs: T0 + 600_000, arrivalMs: T0 + 2_100_000 });
  const delayed = candidate({
    tripId: 'D', departureMs: T0 + 600_000, arrivalMs: T0 + 2_100_000,
    liveEtaMs: T0 + 900_000, // five minutes late
  });
  const a = buildRidePlan(scheduled, opts);
  const b = buildRidePlan(delayed, opts);
  assert.equal(b.rideSec, a.rideSec, 'the running time is untouched');
  assert.equal(b.doorMs - a.doorMs, 300_000, 'the whole plan slides by exactly the delay');
});

test('walk legs use the profile pace and the 1.25 route factor, not straight-line time', () => {
  const c = candidate({
    tripId: 'T', departureMs: T0 + 3_600_000, arrivalMs: T0 + 4_200_000,
    boardDistanceM: 400, alightDistanceM: 200,
  });
  const p = buildRidePlan(c, opts);
  // 400 m / 1.333 m/s * 1.25 = 375 s
  assert.equal(p.toStop.seconds, 375);
  assert.equal(p.fromStop.seconds, 188);
  assert.equal(p.toStop.distanceM, 400);
});

test('a slower pace makes the same trip longer, never shorter', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 3_600_000, arrivalMs: T0 + 4_200_000 });
  const fast = buildRidePlan(c, { nowMs: T0, paceMps: 6 / 3.6 });
  const slow = buildRidePlan(c, { nowMs: T0, paceMps: 3.6 / 3.6 });
  assert.ok(slow.toStop.seconds > fast.toStop.seconds);
  assert.ok(slow.doorMs > fast.doorMs);
  assert.ok(slow.leaveByMs < fast.leaveByMs, 'a slower rider has to leave earlier');
});

test('leave-by is the departure minus the walk, and the wait is never negative', () => {
  const c = candidate({
    tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000, boardDistanceM: 200,
  });
  const p = buildRidePlan(c, opts);
  assert.equal(p.leaveByMs, c.departureMs - p.toStop.seconds * 1000);
  assert.ok(p.waitSec > 0);

  // A departure the rider is already too late for reports zero wait, not a negative one.
  const late = candidate({ tripId: 'L', departureMs: T0 + 10_000, arrivalMs: T0 + 900_000, boardDistanceM: 900 });
  assert.equal(buildRidePlan(late, opts).waitSec, 0);
});

test('the door-to-door figure is TRAVEL time, not the wait until the next service day', () => {
  // Toronto's board can be empty until tomorrow morning. A 25-minute streetcar ride
  // that leaves in six hours is a 25-minute ride plus two walks — it is not a
  // six-hour journey, and reporting it as one would be true and useless.
  const c = candidate({
    tripId: 'TOMORROW',
    departureMs: T0 + 6 * 3_600_000,
    arrivalMs: T0 + 6 * 3_600_000 + 1_500_000, // 25 min of scheduled running time
    boardDistanceM: 200, alightDistanceM: 200,
  });
  const p = buildRidePlan(c, opts);
  const walks = p.toStop.seconds + p.fromStop.seconds;
  assert.equal(p.totalSec, walks + p.rideSec);
  assert.ok(p.totalSec < 3000, `expected a ~40 min journey, got ${Math.round(p.totalSec / 60)} min`);
  // The six-hour wait is not hidden — it is exactly what leave-by and the arrival say.
  assert.equal(p.leaveByMs, c.departureMs - p.toStop.seconds * 1000);
  assert.ok(p.doorMs - T0 > 6 * 3_600_000);
});

test('a broken feed row can never produce a negative ride', () => {
  const c = candidate({ tripId: 'X', departureMs: T0 + 600_000, arrivalMs: T0 + 300_000 });
  assert.equal(buildRidePlan(c, opts).rideSec, 0);
});

// ---------------- reachability ----------------

test('a ride the rider cannot walk to in time is unreachable', () => {
  // 2 km away, leaving in one minute.
  const c = candidate({
    tripId: 'T', departureMs: T0 + 60_000, arrivalMs: T0 + 900_000, boardDistanceM: 2000,
  });
  assert.equal(buildRidePlan(c, opts).reachable, false);
});

test('a walk that exactly consumes the remaining time still counts as reachable', () => {
  const c = candidate({ tripId: 'T', departureMs: T0, arrivalMs: T0 + 900_000, boardDistanceM: 0 });
  assert.equal(buildRidePlan(c, opts).reachable, true);
});

test('pickBestRide never returns a ride nobody can reach', () => {
  const unreachable = candidate({
    tripId: 'U', departureMs: T0 + 30_000, arrivalMs: T0 + 600_000, boardDistanceM: 3000,
  });
  assert.equal(pickBestRide([unreachable], opts), null);
});

test('pickBestRide returns null rather than a plan when nothing is catchable', () => {
  assert.equal(pickBestRide([], opts), null);
});

// ---------------- choosing between real options ----------------

test('pickBestRide optimises the door, not the departure', () => {
  // The earlier bus drops the rider a long walk from where they are going; the later
  // one arrives at the door first. The later one wins.
  const early = candidate({
    tripId: 'EARLY', departureMs: T0 + 600_000, arrivalMs: T0 + 1_500_000,
    boardDistanceM: 100, alightDistanceM: 1200,
  });
  const late = candidate({
    tripId: 'LATE', departureMs: T0 + 900_000, arrivalMs: T0 + 1_700_000,
    boardDistanceM: 100, alightDistanceM: 60,
  });
  assert.equal(pickBestRide([early, late], opts)?.candidate.tripId, 'LATE');
});

test('a dead heat at the door goes to the ride that lets the rider leave later', () => {
  const a = candidate({
    tripId: 'A', departureMs: T0 + 600_000, arrivalMs: T0 + 1_500_000,
    boardDistanceM: 400, alightDistanceM: 100,
  });
  const b = candidate({
    tripId: 'B', departureMs: T0 + 600_000, arrivalMs: T0 + 1_500_000,
    boardDistanceM: 100, alightDistanceM: 100,
  });
  // Same board time and same alight walk => same door. B is the shorter walk, so its
  // leave-by is later.
  const best = pickBestRide([a, b], opts);
  assert.equal(best?.candidate.tripId, 'B');
});

test('allRidePlans keeps every option and orders them by arrival at the door', () => {
  const c1 = candidate({ tripId: 'ONE', departureMs: T0 + 900_000, arrivalMs: T0 + 1_500_000 });
  const c2 = candidate({ tripId: 'TWO', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const plans = allRidePlans([c1, c2], opts);
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map((p) => p.candidate.tripId), ['ONE', 'TWO']);
});

// ---------------- the deep link ----------------

test('the maps deep link carries the destination and NOTHING about the rider', () => {
  const url = transitDirectionsUrl({ lat: 43.656862, lon: -79.453415 });
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1/);
  assert.match(url, /travelmode=transit/);
  assert.match(url, /destination=43\.656862%2C-79\.453415/);
  // The one thing that must never be in there.
  assert.ok(!url.includes('origin'), 'the rider position must not be in the URL');
  assert.ok(!url.includes('saddr'), 'the rider position must not be in the URL');
});

// ---------------- two rides and the walk between them ----------------

/** An itinerary whose legs are shaped the way /api/plan shapes them: the transfer end of
 *  each leg carries `distanceM: 0`, because a transfer stop belongs to no query point. */
function itinerary(o: {
  leg1Dep: number; leg1Arr: number; leg2Dep: number; leg2Arr: number;
  transferM?: number; sameStop?: boolean; crossAgency?: boolean; boardDistanceM?: number;
}): ItineraryDto {
  const { transferM = 130, sameStop = false, crossAgency = true, boardDistanceM = 200 } = o;
  const leg1 = candidate({
    tripId: 'LEG-1', departureMs: o.leg1Dep, arrivalMs: o.leg1Arr,
    boardDistanceM, alightDistanceM: 0,
  });
  const leg2 = candidate({
    tripId: 'LEG-2', departureMs: o.leg2Dep, arrivalMs: o.leg2Arr,
    boardDistanceM: 0, alightDistanceM: 150,
  });
  return {
    legs: [leg1, leg2],
    transfer: {
      from: { ...leg1.alight, stopId: 'X1', distanceM: 0 },
      to: { ...leg2.board, stopId: sameStop ? 'X1' : 'X2', distanceM: 0 },
      distanceM: sameStop ? 0 : transferM,
      sameStop,
    },
    transferWaitSec: Math.round((o.leg2Dep - o.leg1Arr) / 1000),
    // The wire carries every seam in `transfers` and the FIRST one again in `transfer`.
    // Fixtures build both from one source so they can never disagree with each other.
    transfers: [{
      from: { ...leg1.alight, stopId: 'X1', distanceM: 0 },
      to: { ...leg2.board, stopId: sameStop ? 'X1' : 'X2', distanceM: 0 },
      distanceM: sameStop ? 0 : transferM,
      sameStop,
      waitSec: Math.round((o.leg2Dep - o.leg1Arr) / 1000),
    }],
    crossAgency,
  };
}

test('a two-leg plan leaves on the FIRST leg and arrives on the SECOND', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,   // ride 10:00 -> 10:10
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000, // ride 10:20 -> 10:30
  });
  const p = buildItineraryPlan(it, opts);

  // Leave-by belongs to the walk to the FIRST stop; the door time to the LAST walk.
  assert.equal(p.leaveByMs, p.leg1.leaveByMs);
  assert.equal(p.doorMs, p.leg2.doorMs);
  assert.ok(p.doorMs > it.legs[1].arrivalMs, 'the walk from the last stop is counted');

  // The gap is 10 minutes, and it SPLITS into the walk and what is left to stand around
  // for. `transferWaitSec` is the post-walk remainder, NOT the whole gap — the server's
  // field of that name is the whole gap, and rendering it beside the walk row is exactly
  // how the legs came to over-sum the total by one transfer walk.
  assert.equal(p.transferGapSec, 600);
  assert.ok(p.transferWalkSec > 0, 'a 130 m transfer takes real time at a real pace');
  assert.equal(p.transferWaitSec, 600 - p.transferWalkSec);

  // Total is travel only, measured from leaving — the same definition the ride tier uses.
  assert.equal(p.totalSec, Math.round((p.doorMs - p.leaveByMs) / 1000));
});

test('the transfer end of each leg contributes NO walk — it is stated once, in the transfer', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const p = buildItineraryPlan(it, opts);
  assert.equal(p.leg1.fromStop.seconds, 0, 'leg 1 does not walk the rider off at the transfer');
  assert.equal(p.leg2.toStop.seconds, 0, 'leg 2 does not walk them on again');
  assert.ok(p.leg1.toStop.seconds > 0 && p.leg2.fromStop.seconds > 0, 'the real walks survive');
});

test('a same-stop transfer is a wait, not a walk', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_500_000, leg2Arr: T0 + 2_400_000, sameStop: true,
  });
  const p = buildItineraryPlan(it, opts);
  assert.equal(p.transferWalkSec, 0);
  assert.equal(p.transferWaitSec, 300);
});

test('an itinerary whose first leg cannot be walked to in time is never chosen', () => {
  // Departs in 60 s, and the boarding stop is a 3 km walk away.
  const unreachable = itinerary({
    leg1Dep: T0 + 60_000, leg1Arr: T0 + 600_000,
    leg2Dep: T0 + 1_200_000, leg2Arr: T0 + 1_800_000, boardDistanceM: 3000,
  });
  assert.equal(buildItineraryPlan(unreachable, opts).reachable, false);
  assert.equal(pickBestItinerary([unreachable], opts), null,
    'no reachable itinerary is null, never the least-bad one');
});

test('the best itinerary is the one that gets the rider there SOONEST', () => {
  const later = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 3_600_000,
  });
  const sooner = itinerary({
    leg1Dep: T0 + 900_000, leg1Arr: T0 + 1_500_000,
    leg2Dep: T0 + 2_100_000, leg2Arr: T0 + 3_000_000,
  });
  const best = pickBestItinerary([later, sooner], opts);
  assert.ok(best);
  assert.equal(best.doorMs, buildItineraryPlan(sooner, opts).doorMs,
    'the earlier ARRIVAL wins, even though it departs later');
});

test('a measured walk re-times the FIRST leg only — never a stop out in the network', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  // A routed walk measured to leg 2's boarding stop id must not be applied: that stop is
  // the transfer, and the map measured a path from under the RIDER's feet.
  const p = buildItineraryPlan(it, {
    ...opts,
    boardWalk: { kind: 'routed', stopId: it.legs[1].board.stopId, distanceM: 900, seconds: 700 },
  });
  assert.equal(p.leg2.toStop.seconds, 0, 'leg 2 keeps its zero-length transfer end');
});

// ---------------- the copy exists in every locale ----------------

test('every plan string the planner can render exists in all three locales', () => {
  // The two-leg tier added keys, and a missing one renders as its own dotted key path in
  // the middle of a trip plan. Structural rather than a list, so the next key added is
  // covered without anyone remembering to add it here.
  const dicts = { en, es, frCA } as Record<string, { plan: Record<string, unknown> }>;
  const names = Object.keys(dicts);
  const keysOf = (d: { plan: Record<string, unknown> }) => Object.keys(d.plan).sort();
  const reference = keysOf(dicts.en);
  for (const name of names.slice(1)) {
    assert.deepEqual(keysOf(dicts[name]), reference,
      `${name} and en disagree on which plan strings exist`);
  }
  // And the two-leg keys specifically are really there, in every one.
  for (const k of ['twoLegResultLabel', 'twoLegEyebrow', 'twoLegCrossAgency',
    'transferWalkTo', 'transferStayAt', 'transferWait', 'basisTransfer']) {
    for (const name of names) {
      assert.equal(typeof dicts[name].plan[k], 'string', `${name}.plan.${k} is missing`);
    }
  }
});

test('THE ROWS ADD UP: every leg the card renders sums to exactly totalSec', () => {
  // The bug this exists for: the server's `transferWaitSec` is the WHOLE gap and already
  // includes the walk, so rendering it beside the walk row printed the walk twice and the
  // legs over-summed the headline total by one transfer walk, in all three locales.
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000, transferM: 250,
  });
  const p = buildItineraryPlan(it, opts);
  const rendered = p.leg1.toStop.seconds      // "Walk … to <first stop>"
    + p.leg1.rideSec                          // first ride
    + p.transferWalkSec                       // "Walk … to <transfer stop>"
    + p.transferWaitSec                       // "Then wait …"
    + p.leg2.rideSec                          // second ride
    + p.leg2.fromStop.seconds;                // "Walk … to <destination>"
  assert.equal(rendered, p.totalSec, 'the rows the rider reads must be the total they are given');
  // And the two halves of the gap are exactly the gap — no third place for time to hide.
  assert.equal(p.transferWalkSec + p.transferWaitSec, p.transferGapSec);
});

test('a DELAYED first leg that eats the connection is refused, not printed', () => {
  // Scheduled, this connects with 10 minutes to spare. Leg 1 is then predicted 12 minutes
  // late while leg 2 — schedule-only, another agency — does not move. The rider is still
  // on the first vehicle when the second one leaves, and the card would otherwise print
  // leg 1 alighting AFTER leg 2 boards.
  const base = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000, transferM: 130,
  });
  assert.equal(buildItineraryPlan(base, opts).connectionHolds, true, 'on schedule it holds');

  const delayed: ItineraryDto = {
    ...base,
    legs: [
      { ...base.legs[0], honest: { estimateMs: base.legs[0].departureMs + 720_000, bandLowMs: null, bandHighMs: null, medianDelaySec: 720 } },
      base.legs[1],
    ],
  };
  const p = buildItineraryPlan(delayed, opts);
  assert.equal(p.leg1.boardIsPredicted, true, 'the plan really is built on the prediction');
  assert.ok(p.transferGapSec < p.transferWalkSec, 'the walk no longer fits in the gap');
  assert.equal(p.connectionHolds, false);
  assert.equal(p.reachable, false, 'a connection that cannot be made is not offered');
  assert.equal(pickBestItinerary([delayed], opts), null);
  // Never a negative wait on the way out.
  assert.ok(p.transferWaitSec >= 0);
});

test('a first leg predicted only slightly late still connects', () => {
  // The refusal must be about the ARITHMETIC, not about any prediction existing at all.
  const base = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000, transferM: 130,
  });
  const nudged: ItineraryDto = {
    ...base,
    legs: [
      { ...base.legs[0], honest: { estimateMs: base.legs[0].departureMs + 60_000, bandLowMs: null, bandHighMs: null, medianDelaySec: 60 } },
      base.legs[1],
    ],
  };
  const p = buildItineraryPlan(nudged, opts);
  assert.equal(p.connectionHolds, true);
  assert.equal(p.reachable, true);
  // And the wait shrank by exactly the delay — the gap is measured, not assumed.
  assert.equal(p.transferGapSec, buildItineraryPlan(base, opts).transferGapSec - 60);
});
