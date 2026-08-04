// The two ends of a trip.
//
// These tests are about what the plan surface is ALLOWED to do with an end it cannot
// resolve: never invent a coordinate for it, never confuse one end for another across a
// refresh, and never write a point with no identity into the persisted recents list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planPointCoords, planPointKey, needsFix, swapEnds, HERE, type PlanPoint } from './planpoint.ts';
import type { RecentPlace } from './search.ts';

const RIDER = { lat: 43.6453, lon: -79.3958 };

const place = (o: Partial<RecentPlace> = {}): RecentPlace => ({
  agency: 'ttc', stopId: '1425', name: 'King St West at Spadina Ave',
  lat: 43.6454, lon: -79.3959, ts: 0, ...o,
});

const stop = (o: Partial<RecentPlace> = {}): PlanPoint => ({ kind: 'stop', place: place(o) });

// ------------------------------------------------------------------ resolving

test('here borrows the live fix rather than carrying one of its own', () => {
  assert.deepEqual(planPointCoords(HERE, RIDER), RIDER);
  // The rider moved. The same point resolves somewhere else, which is the whole reason
  // `here` is a kind and not a coordinate captured when they typed.
  const moved = { lat: 43.7, lon: -79.4 };
  assert.deepEqual(planPointCoords(HERE, moved), moved);
});

test('here with no fix yet resolves to nothing — never to a guess', () => {
  assert.equal(planPointCoords(HERE, null), null);
});

test('a stop the agency published without coordinates is unresolvable, not approximate', () => {
  assert.equal(planPointCoords(stop({ lat: null, lon: null }), RIDER), null);
  // Half a coordinate is not a coordinate.
  assert.equal(planPointCoords(stop({ lat: 43.6, lon: null }), RIDER), null);
  assert.equal(planPointCoords(stop({ lat: null, lon: -79.4 }), RIDER), null);
});

test('a stop resolves to its own coordinates, not the rider\'s', () => {
  assert.deepEqual(planPointCoords(stop(), RIDER), { lat: 43.6454, lon: -79.3959 });
});

test('a map pin resolves to the point that was picked, with or without a fix', () => {
  const pin: PlanPoint = { kind: 'pin', lat: 43.7, lon: -79.5, label: 'Dropped pin' };
  assert.deepEqual(planPointCoords(pin, RIDER), { lat: 43.7, lon: -79.5 });
  assert.deepEqual(planPointCoords(pin, null), { lat: 43.7, lon: -79.5 });
});

test('no end at all resolves to nothing', () => {
  assert.equal(planPointCoords(null, RIDER), null);
});

// ------------------------------------------------------------------ the fix dependency

test('only here depends on the rider\'s fix', () => {
  assert.equal(needsFix(HERE), true);
  assert.equal(needsFix(stop()), false);
  assert.equal(needsFix({ kind: 'pin', lat: 1, lon: 2, label: 'x' }), false);
  assert.equal(needsFix(null), false);
});

// ------------------------------------------------------------------ question identity

test('the rider moving IS a new question', () => {
  const a = planPointKey(HERE, RIDER);
  const b = planPointKey(HERE, { lat: 43.7, lon: -79.4 });
  assert.notEqual(a, b, 'a held answer would describe a walk from where they no longer are');
});

test('GPS jitter is NOT a new question — the key is quantized', () => {
  // ~1 cm of sixth-decimal noise from a stationary phone. If this changed the key, the
  // answer on screen would drop to a skeleton and refetch on every sample.
  const jittered = { lat: RIDER.lat + 0.0000009, lon: RIDER.lon - 0.0000004 };
  assert.equal(planPointKey(HERE, RIDER), planPointKey(HERE, jittered));
  // ~100 m of real movement still is.
  assert.notEqual(planPointKey(HERE, RIDER), planPointKey(HERE, { lat: RIDER.lat + 0.001, lon: RIDER.lon }));
});

test('a stop keeps ONE identity across a refresh, however the rider moves', () => {
  assert.equal(planPointKey(stop(), RIDER), planPointKey(stop(), { lat: 1, lon: 2 }));
});

test('the three kinds cannot collide with each other', () => {
  const keys = new Set([
    planPointKey(HERE, RIDER),
    planPointKey(stop(), RIDER),
    planPointKey({ kind: 'pin', lat: RIDER.lat, lon: RIDER.lon, label: 'x' }, RIDER),
    planPointKey(null, RIDER),
  ]);
  assert.equal(keys.size, 4);
});

test('two agencies numbering a stop the same are two different ends', () => {
  assert.notEqual(
    planPointKey(stop({ agency: 'ttc', stopId: '2334' }), RIDER),
    planPointKey(stop({ agency: 'yrt', stopId: '2334' }), RIDER),
  );
});

test("an id containing the obvious separators cannot forge another end's key", () => {
  // GTFS ids are agency-controlled free text. A '/' or '>' delimiter would let
  // agency 'a', stop 'b/c' collide with agency 'a/b', stop 'c'.
  assert.notEqual(
    planPointKey(stop({ agency: 'a', stopId: 'b/c' }), RIDER),
    planPointKey(stop({ agency: 'a/b', stopId: 'c' }), RIDER),
  );
});

// ------------------------------------------------------------------ swapping

test('swapping reverses both ends, including from-here-to-there', () => {
  const office = stop({ stopId: '999', name: 'Office' });
  const s = swapEnds(HERE, office);
  assert.deepEqual(s.origin, office);
  assert.deepEqual(s.target, HERE);
  // And back again, unchanged — a swap is its own inverse.
  const back = swapEnds(s.origin, s.target);
  assert.deepEqual(back.origin, HERE);
  assert.deepEqual(back.target, office);
});

test('swapping with no destination chosen changes nothing', () => {
  const s = swapEnds(HERE, null);
  assert.deepEqual(s.origin, HERE);
  assert.equal(s.target, null);
});

test('a swapped pair is still resolvable — the reversed trip is a real question', () => {
  const office = stop({ stopId: '999', name: 'Office' });
  const s = swapEnds(HERE, office);
  assert.deepEqual(planPointCoords(s.origin, RIDER), { lat: 43.6454, lon: -79.3959 });
  assert.deepEqual(planPointCoords(s.target, RIDER), RIDER);
});
