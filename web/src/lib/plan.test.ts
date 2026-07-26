// The single-ride planner's arithmetic, exercised end to end.
//
// These tests are about the CLAIMS, not the plumbing: that a plan is built on the
// instant a departure is actually expected, that the agency's running time is never
// quietly reshaped, that a ride nobody can walk to is not offered, and that the
// destination deep link cannot leak the rider's own position.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { RideCandidateDto } from '../../../shared/types.ts';
import {
  boardingInstant, buildRidePlan, pickBestRide, allRidePlans, transitDirectionsUrl,
} from './plan.ts';

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
