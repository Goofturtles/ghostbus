// The two-leg planner's rules, each pinned by the failure it exists to prevent. The
// fixture is a small deliberate network rather than a recorded one, because what is
// being tested is the JOIN — which connections are offered and which are refused — and
// a real board would bury that in noise.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stitchItineraries, TRANSFER_MAX_WALK_M, TRANSFER_MIN_SLACK_S, TRANSFER_MAX_WAIT_S,
  type StitchRide, type StitchStop,
} from './itinerary.ts';

const T0 = Date.UTC(2026, 7, 3, 12, 0, 0);
const min = (n: number) => n * 60_000;

/** Stops on one east-west line, spaced so the walk cap can be crossed deliberately. */
const STOPS: StitchStop[] = [
  { agency: 'miway', stopId: 'HOME', lat: 43.6000, lon: -79.6000 },
  // HUB_A and HUB_B are ~180 m apart: a real cross-agency transfer, inside the cap.
  { agency: 'miway', stopId: 'HUB_A', lat: 43.6300, lon: -79.5500 },
  { agency: 'ttc', stopId: 'HUB_B', lat: 43.6300, lon: -79.5478 },
  // FAR is ~1.6 km from HUB_A: past the cap, and must never be offered.
  { agency: 'ttc', stopId: 'FAR', lat: 43.6300, lon: -79.5300 },
  { agency: 'ttc', stopId: 'WORK', lat: 43.6500, lon: -79.5000 },
];

const ride = (o: Partial<StitchRide> & Pick<StitchRide, 'agency' | 'tripId' | 'boardStopId' | 'alightStopId' | 'departureMs' | 'arrivalMs'>): StitchRide =>
  ({ routeId: o.routeId ?? 'R', ...o });

const opts = { paceMps: 1.3, limit: 10 };

test('a known two-leg journey is found: MiWay to the hub, walk, TTC onward', () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(22), arrivalMs: T0 + min(40) })];

  const [it] = stitchItineraries(leg1, leg2, STOPS, opts);
  assert.ok(it, 'the connection exists and must be offered');
  assert.equal(it.leg1.tripId, 'M1');
  assert.equal(it.leg2.tripId, 'T1');
  assert.equal(it.crossAgency, true, 'MiWay -> TTC is exactly the case this tier adds');
  assert.equal(it.arrivalMs, T0 + min(40));
  assert.equal(it.transferWaitSec, 7 * 60, 'the wait is stated, not folded into a total');
  assert.ok(it.transferWalkM > 0 && it.transferWalkM <= TRANSFER_MAX_WALK_M);
});

test('RULE 1: a connection that cannot physically be made is refused', () => {
  // Leg 2 leaves 30 s after leg 1 lands — the timetable permits it and a rider cannot.
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(15) + 30_000, arrivalMs: T0 + min(40) })];

  assert.deepEqual(stitchItineraries(leg1, leg2, STOPS, opts), [],
    'a sprint the schedule allows is still not a plan');
});

test('RULE 1: the slack floor is real — one second under it is still refused', () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  // MEASURED, not guessed: the walk is whatever the module says it is for these two
  // stops at this pace, and the point of the test is the boundary around it.
  const walkSec = stitchItineraries(
    leg1,
    [ride({ agency: 'ttc', tripId: 'T0', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(30), arrivalMs: T0 + min(40) })],
    STOPS, opts,
  )[0].transferWalkSec;
  const at = (extraS: number) => [ride({
    agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK',
    departureMs: T0 + min(15) + extraS * 1000, arrivalMs: T0 + min(40),
  })];

  assert.equal(stitchItineraries(leg1, at(walkSec + TRANSFER_MIN_SLACK_S - 1), STOPS, opts).length, 0);
  assert.equal(stitchItineraries(leg1, at(walkSec + TRANSFER_MIN_SLACK_S + 5), STOPS, opts).length, 1);
});

test('RULE 2: a transfer past the walk cap is not a transfer', () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  // Plenty of time; the only problem is that FAR is 1.6 km away.
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'FAR', alightStopId: 'WORK', departureMs: T0 + min(40), arrivalMs: T0 + min(55) })];

  assert.deepEqual(stitchItineraries(leg1, leg2, STOPS, opts), [],
    'past the cap this is a second journey, and the app must say it cannot plan it');
});

test('an impossible journey still refuses — no connection is ever fabricated', () => {
  // Nothing leg-2 touches anything leg-1 reaches.
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'WORK', alightStopId: 'FAR', departureMs: T0 + min(30), arrivalMs: T0 + min(45) })];
  assert.deepEqual(stitchItineraries(leg1, leg2, STOPS, opts), []);

  // And the degenerate inputs, which must be silence rather than a throw.
  assert.deepEqual(stitchItineraries([], leg2, STOPS, opts), []);
  assert.deepEqual(stitchItineraries(leg1, [], STOPS, opts), []);
  assert.deepEqual(stitchItineraries(leg1, leg2, [], opts), []);
});

test('a service gap is not a connection', () => {
  const leg1 = [ride({ agency: 'miway', tripId: 'M1', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const tooLate = Math.ceil(TRANSFER_MAX_WAIT_S / 60) + 16;
  const leg2 = [ride({ agency: 'ttc', tripId: 'T1', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(tooLate), arrivalMs: T0 + min(tooLate + 15) })];
  assert.deepEqual(stitchItineraries(leg1, leg2, STOPS, opts), [],
    'waiting out an hour-long gap is not something to call a transfer');
});

test('RULE 4: ranked by ARRIVAL, and the earliest catchable leg 2 is the one offered', () => {
  const leg1 = [
    ride({ agency: 'miway', tripId: 'EARLY', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) }),
    ride({ agency: 'miway', tripId: 'LATER', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0 + min(10), arrivalMs: T0 + min(25) }),
  ];
  const leg2 = [
    ride({ agency: 'ttc', tripId: 'SLOW', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(20), arrivalMs: T0 + min(60) }),
    ride({ agency: 'ttc', tripId: 'FAST', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(30), arrivalMs: T0 + min(45) }),
  ];

  const out = stitchItineraries(leg1, leg2, STOPS, opts);
  assert.equal(out[0].arrivalMs, T0 + min(45), 'the soonest ARRIVAL leads, not the soonest departure');
  assert.equal(out[0].leg1.tripId, 'LATER',
    'and among equal arrivals the rider waits at home, not at the transfer stop');
  // EARLY can catch SLOW (20 min mark) — the earliest catchable, so SLOW is what EARLY
  // is paired with, never the later FAST as well.
  assert.ok(out.every((i) => !(i.leg1.tripId === 'EARLY' && i.leg2.tripId === 'FAST')),
    'one itinerary per first leg: the earliest leg 2 it can actually catch');
});

test('the same vehicle is never both legs of its own transfer', () => {
  const leg1 = [ride({ agency: 'ttc', tripId: 'SAME', boardStopId: 'HOME', alightStopId: 'HUB_A', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'SAME', boardStopId: 'HUB_A', alightStopId: 'WORK', departureMs: T0 + min(20), arrivalMs: T0 + min(35) })];
  const stops: StitchStop[] = [...STOPS, { agency: 'ttc', stopId: 'HUB_A', lat: 43.6300, lon: -79.5500 }];
  assert.deepEqual(stitchItineraries(leg1, leg2, stops, opts), [],
    'staying on the bus is a one-leg ride the first tier already answers');
});

test('a same-stop transfer needs no walk, only a wait', () => {
  const leg1 = [ride({ agency: 'ttc', tripId: 'A', boardStopId: 'HOME', alightStopId: 'HUB_B', departureMs: T0, arrivalMs: T0 + min(15) })];
  const leg2 = [ride({ agency: 'ttc', tripId: 'B', boardStopId: 'HUB_B', alightStopId: 'WORK', departureMs: T0 + min(20), arrivalMs: T0 + min(35) })];
  const stops: StitchStop[] = [...STOPS, { agency: 'ttc', stopId: 'HOME', lat: 43.6000, lon: -79.6000 }];

  const [it] = stitchItineraries(leg1, leg2, stops, opts);
  assert.ok(it);
  assert.equal(it.transferWalkM, 0);
  assert.equal(it.crossAgency, false);
});
