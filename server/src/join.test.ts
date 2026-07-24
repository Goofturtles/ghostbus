// Unit tests for the identity join (route+scheduled-time claim logic).
// Fixtures here are test inputs, not app-presented "live" data — the
// anti-fabrication rules govern what the app shows, not what tests feed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteStopIndex, claimTrips, type RtTripInput } from './join.ts';

// Static world: two trips on route R with distinct timetables, one on route R2.
const index = buildRouteStopIndex([
  { routeId: 'R', stopId: 's1', depSec: 100, tripId: 'A' },
  { routeId: 'R', stopId: 's2', depSec: 200, tripId: 'A' },
  { routeId: 'R', stopId: 's3', depSec: 300, tripId: 'A' },
  { routeId: 'R', stopId: 's1', depSec: 1000, tripId: 'B' },
  { routeId: 'R', stopId: 's2', depSec: 1100, tripId: 'B' },
  { routeId: 'R2', stopId: 's1', depSec: 100, tripId: 'C' },
]);
const OPTS = { tolSec: 75, minVotes: 2 };

test('exact match claims the right static trip', () => {
  const rt: RtTripInput[] = [{ rtTripId: 'rtA', routeId: 'R', stops: [{ stopId: 's1', schedSec: 100 }, { stopId: 's2', schedSec: 200 }] }];
  const r = claimTrips(rt, index, OPTS);
  assert.equal(r.claims.get('rtA'), 'A');
  assert.equal(r.votes.get('rtA'), 2);
  assert.ok(r.claimedStatic.has('A'));
});

test('within tolerance still matches; outside tolerance does not', () => {
  const near: RtTripInput[] = [{ rtTripId: 'rtA', routeId: 'R', stops: [{ stopId: 's1', schedSec: 140 }, { stopId: 's2', schedSec: 240 }] }];
  assert.equal(claimTrips(near, index, OPTS).claims.get('rtA'), 'A'); // 40s off, tol 75

  const far = claimTrips(near, index, { tolSec: 30, minVotes: 2 });
  assert.equal(far.claims.size, 0);
  assert.equal(far.unmatched, 1);
});

test('a static trip is claimed at most once; the higher-vote RT wins', () => {
  const rt: RtTripInput[] = [
    { rtTripId: 'rtStrong', routeId: 'R', stops: [{ stopId: 's1', schedSec: 100 }, { stopId: 's2', schedSec: 200 }, { stopId: 's3', schedSec: 300 }] }, // 3 votes for A
    { rtTripId: 'rtWeak', routeId: 'R', stops: [{ stopId: 's1', schedSec: 105 }, { stopId: 's2', schedSec: 205 }] }, // 2 votes for A only
  ];
  const r = claimTrips(rt, index, OPTS);
  assert.equal(r.claims.get('rtStrong'), 'A');
  assert.equal(r.claims.has('rtWeak'), false); // A already taken, no fallback candidate
  assert.equal(r.claimedStatic.size, 1);
  assert.ok(r.unmatched >= 1);
});

test('loser falls back to its next-best unclaimed candidate', () => {
  // rt1 strongly matches A (3) and weakly B (via a stop that also fits B's schedule).
  // rt2 matches only B (2). rt1 should take A, rt2 should take B.
  const idx = buildRouteStopIndex([
    { routeId: 'R', stopId: 'x1', depSec: 100, tripId: 'A' },
    { routeId: 'R', stopId: 'x2', depSec: 200, tripId: 'A' },
    { routeId: 'R', stopId: 'x3', depSec: 300, tripId: 'A' },
    { routeId: 'R', stopId: 'y1', depSec: 500, tripId: 'B' },
    { routeId: 'R', stopId: 'y2', depSec: 600, tripId: 'B' },
  ]);
  const rt: RtTripInput[] = [
    { rtTripId: 'rt1', routeId: 'R', stops: [{ stopId: 'x1', schedSec: 100 }, { stopId: 'x2', schedSec: 200 }, { stopId: 'x3', schedSec: 300 }] },
    { rtTripId: 'rt2', routeId: 'R', stops: [{ stopId: 'y1', schedSec: 500 }, { stopId: 'y2', schedSec: 600 }] },
  ];
  const r = claimTrips(rt, idx, OPTS);
  assert.equal(r.claims.get('rt1'), 'A');
  assert.equal(r.claims.get('rt2'), 'B');
  assert.equal(r.claimedStatic.size, 2);
});

test('no candidate within tolerance is left unmatched', () => {
  const rt: RtTripInput[] = [{ rtTripId: 'rtNope', routeId: 'R', stops: [{ stopId: 's1', schedSec: 5000 }] }];
  const r = claimTrips(rt, index, OPTS);
  assert.equal(r.claims.size, 0);
  assert.equal(r.unmatched, 1);
});

test('service-midnight wrap (>24h) still matches', () => {
  const rt: RtTripInput[] = [{ rtTripId: 'rtWrap', routeId: 'R', stops: [
    { stopId: 's1', schedSec: 86400 + 100 }, { stopId: 's2', schedSec: 86400 + 200 },
  ] }];
  const r = claimTrips(rt, index, OPTS);
  assert.equal(r.claims.get('rtWrap'), 'A');
});

test('an unbroken top-vote tie is reported ambiguous, not guessed', () => {
  const idx = buildRouteStopIndex([
    { routeId: 'R', stopId: 's1', depSec: 100, tripId: 'A' },
    { routeId: 'R', stopId: 's2', depSec: 200, tripId: 'A' },
    { routeId: 'R', stopId: 's1', depSec: 100, tripId: 'B' }, // B shares A's exact schedule
    { routeId: 'R', stopId: 's2', depSec: 200, tripId: 'B' },
  ]);
  const rt: RtTripInput[] = [{ rtTripId: 'rtTie', routeId: 'R', stops: [{ stopId: 's1', schedSec: 100 }, { stopId: 's2', schedSec: 200 }] }];
  const r = claimTrips(rt, idx, OPTS);
  assert.equal(r.claims.size, 0);
  assert.equal(r.ambiguous, 1);
});
