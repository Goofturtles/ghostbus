// The alternatives beside the transit list.
//
// Two properties matter more than the arithmetic: the walk is an ESTIMATE and says so by
// carrying the route factor, and the Uber link does not carry the rider's own position
// unless the rider themselves put a named place at that end.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  walkAlternative, uberUrl, haversineM, WALK_ALTERNATIVE_MAX_M,
} from './modes.ts';
import { haversineM as searchHaversine } from './search.ts';
import { walkLegSeconds } from './walk.ts';

const KING_SPADINA = { lat: 43.6453, lon: -79.3958 };
const DUNDAS_WEST = { lat: 43.6569, lon: -79.4534 };
const PACE = 4.8 / 3.6; // the app's default, m/s

// ------------------------------------------------------------------ the walk

test('a short hop is offered as a walk', () => {
  const near = { lat: 43.6470, lon: -79.3958 }; // ~190 m north
  const w = walkAlternative(KING_SPADINA, near, PACE);
  assert.ok(w);
  assert.ok(w.distanceM > 150 && w.distanceM < 300, `got ${w.distanceM}`);
  assert.ok(w.seconds > 0);
});

test('the TIME carries the route factor and the DISTANCE stays the straight line', () => {
  const straight = haversineM(KING_SPADINA, DUNDAS_WEST);
  const w = walkAlternative(KING_SPADINA, DUNDAS_WEST, PACE);
  assert.ok(w);
  // THE REGRESSION THIS PINS: padding the distance too made the same pair of points read
  // 4.7 km in a journey step and 5.9 km here — one app quoting itself two numbers.
  assert.equal(w.distanceM, Math.round(straight), 'the distance must be the crow flight');
  // And the seconds are the app's own call, not a second implementation of it.
  assert.equal(w.seconds, walkLegSeconds('direct', w.distanceM, PACE));
  assert.ok(w.seconds > straight / PACE, 'the time must still carry the 1.25 factor');
});

test('a walk nobody would take is not offered at all', () => {
  // ~40 km out. "Walk 50 km" is not an alternative, it is noise.
  const far = { lat: 44.0, lon: -79.4 };
  assert.equal(walkAlternative(KING_SPADINA, far, PACE), null);
});

test('the cutoff is applied to the straight line between the ends', () => {
  const straightUnder = WALK_ALTERNATIVE_MAX_M - 50;
  const dLat = straightUnder / 111_320;
  const w = walkAlternative(KING_SPADINA, { lat: KING_SPADINA.lat + dLat, lon: KING_SPADINA.lon }, PACE);
  assert.ok(w, 'a 4.95 km straight line is still a walk');
  assert.ok(w.distanceM <= WALK_ALTERNATIVE_MAX_M);
});

test('an unresolvable end, or a nonsense pace, produces no walk rather than NaN', () => {
  assert.equal(walkAlternative(null, DUNDAS_WEST, PACE), null);
  assert.equal(walkAlternative(KING_SPADINA, null, PACE), null);
  assert.equal(walkAlternative(KING_SPADINA, DUNDAS_WEST, 0), null);
  assert.equal(walkAlternative(KING_SPADINA, DUNDAS_WEST, Number.NaN), null);
  assert.equal(walkAlternative(KING_SPADINA, DUNDAS_WEST, -1), null);
});

// ------------------------------------------------------------------ the deep link

test("the rider's own position is NEVER put in a URL we build — pickup end", () => {
  const url = uberUrl(KING_SPADINA, DUNDAS_WEST, { originIsRider: true });
  assert.match(url, /pickup=my_location/);
  assert.ok(!url.includes('43.6453'), "the rider's latitude leaked into the link");
  assert.ok(!url.includes('79.3958'), "the rider's longitude leaked into the link");
});

test("the rider's own position is NEVER put in a URL we build — DROPOFF end", () => {
  // "From the office to here" is a real trip: `swapPlanEnds` exists to make it. The
  // destination is then the live fix, and it must not be serialised either. There is no
  // `my_location` keyword for a dropoff, so the parameter is omitted entirely.
  const url = uberUrl(DUNDAS_WEST, KING_SPADINA, { originIsRider: false, destIsRider: true });
  assert.ok(!url.includes('43.6453'), "the rider's latitude leaked into the dropoff");
  assert.ok(!url.includes('79.3958'), "the rider's longitude leaked into the dropoff");
  assert.ok(!url.includes('dropoff'), 'no dropoff parameter may be sent at all');
  // The origin they chose still travels, so the car comes to the right place.
  assert.match(url, /43\.656900/);
});

test('a rider-chosen named origin IS sent, because sending a car to the wrong end is worse', () => {
  const url = uberUrl(KING_SPADINA, DUNDAS_WEST, { originIsRider: false });
  assert.ok(!url.includes('my_location'));
  assert.match(url, /43\.645300/);
});

test('a named origin that will not resolve is OMITTED, never defaulted to the device', () => {
  // A stop the agency published without coordinates. Falling back to `my_location` would
  // summon a car to wherever the rider is standing — the outcome the design calls worse.
  const url = uberUrl(null, DUNDAS_WEST, { originIsRider: false });
  assert.ok(!url.includes('my_location'), 'must not silently become the device position');
  assert.ok(!url.includes('pickup'), 'the pickup is left for Uber to ask');
  assert.match(url, /dropoff/);
});

test('brackets stay literal and spaces are %20, not +', () => {
  const url = uberUrl(null, DUNDAS_WEST, { originIsRider: true, dropoffName: 'Dundas West Station' });
  assert.ok(url.includes('dropoff[latitude]='), 'brackets must not be percent-encoded');
  assert.ok(!url.includes('%5B'), 'no encoded brackets');
  assert.ok(url.includes('Dundas%20West%20Station'), 'a space must be %20');
  assert.ok(!url.includes('Dundas+West'), "a '+' would render as a literal plus");
});

test('the destination travels, and the nickname only when there is one', () => {
  const bare = uberUrl(null, DUNDAS_WEST, { originIsRider: true });
  assert.match(bare, /43\.656900/);
  assert.match(bare, /-79\.453400/);
  assert.ok(!bare.includes('nickname'));
});

test('NO PRICE, ever — the link quotes nothing this app cannot back', () => {
  const url = uberUrl(KING_SPADINA, DUNDAS_WEST, { originIsRider: true, dropoffName: 'X' });
  for (const forbidden of ['fare', 'price', 'estimate', 'cost', '$']) {
    assert.ok(!url.toLowerCase().includes(forbidden), `the link must not carry ${forbidden}`);
  }
});

test('there is ONE haversine in the app, not two that can drift', () => {
  // Re-exported from lib/search rather than re-derived, so this is identity by
  // construction — and if somebody replaces the import with a local copy, this fails.
  assert.equal(haversineM, searchHaversine);
  const d = haversineM(KING_SPADINA, DUNDAS_WEST);
  assert.ok(d > 4600 && d < 4900, `got ${d}`);
  assert.equal(Math.round(d), Math.round(haversineM(DUNDAS_WEST, KING_SPADINA)));
  assert.equal(haversineM(KING_SPADINA, KING_SPADINA), 0);
});
