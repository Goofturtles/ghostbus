// Search result shaping.
//
// The rules under test are the honesty rules: a distance is printed only when it was
// measured, a route row exists only when there is a real departure behind it, and the
// ordering puts the thing the rider actually typed at the top.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { DepartureDto, StopDto } from '../../../shared/types.ts';
import {
  haversineM, normalise, matches, shapeStopResults, matchRoutes,
  filterRecents, dedupeAgainst, pushRecent, type RecentPlace,
} from './search.ts';

const RIDER = { lat: 43.64354, lon: -79.39699 }; // King & Spadina

const stop = (o: Partial<StopDto> & { stopId: string }): StopDto => ({
  name: `Stop ${o.stopId}`, lat: null, lon: null, wheelchairBoarding: null, ...o,
});

// ---------------- primitives ----------------

test('haversineM measures a real Toronto distance to within a metre or so', () => {
  // King & Spadina -> King St West at Spadina Ave West Side, which /api/stops/nearby
  // independently reports as 225 m.
  const d = haversineM(RIDER, { lat: 43.64537, lon: -79.395811 });
  assert.ok(Math.abs(d - 225) < 2, `expected ~225 m, got ${d.toFixed(1)}`);
  assert.equal(Math.round(haversineM(RIDER, RIDER)), 0);
});

test('normalise folds case and accents so a French rider still finds a stop', () => {
  assert.equal(normalise('Préfecture'), 'prefecture');
  assert.equal(normalise('ÉGLINTON'), 'eglinton');
  assert.ok(matches('Église St-Denis', 'eglise'));
  assert.ok(matches('King St West', 'KING'));
  assert.equal(matches(null, 'king'), false);
  assert.equal(matches('King', 'queen'), false);
});

// ---------------- stop results ----------------

test('a stop distance is measured from the rider, and is ABSENT when there is no fix', () => {
  const stops = [stop({ stopId: '15647', name: 'King St West at Spadina Ave West Side', lat: 43.64537, lon: -79.395811 })];

  const withFix = shapeStopResults(stops, RIDER, 'king');
  assert.equal(withFix[0].distanceM, 225);

  // No position: the field is null, not an estimate measured from somewhere else.
  const withoutFix = shapeStopResults(stops, null, 'king');
  assert.equal(withoutFix[0].distanceM, null);
});

test('a stop with no published coordinates gets no distance either', () => {
  const rows = shapeStopResults([stop({ stopId: '99', name: 'Somewhere' })], RIDER, 'some');
  assert.equal(rows[0].distanceM, null);
});

test('typing a stop code puts that exact stop first, however far away it is', () => {
  const rows = shapeStopResults([
    stop({ stopId: '4197001', name: 'Nearby Ave', lat: 43.6436, lon: -79.397 }),
    stop({ stopId: '4197', name: 'Far Away Rd', lat: 43.75, lon: -79.5 }),
  ], RIDER, '4197');
  assert.equal(rows[0].stopId, '4197');
});

test('without an exact code, stops are ordered by real distance', () => {
  const rows = shapeStopResults([
    stop({ stopId: 'far', name: 'B', lat: 43.70, lon: -79.42 }),
    stop({ stopId: 'near', name: 'A', lat: 43.6454, lon: -79.3958 }),
  ], RIDER, 'x');
  assert.deepEqual(rows.map((r) => r.stopId), ['near', 'far']);
});

test('stops we can measure sort ahead of stops we cannot, then by name', () => {
  const rows = shapeStopResults([
    stop({ stopId: 'z', name: 'Zeta' }),
    stop({ stopId: 'a', name: 'Alpha' }),
    stop({ stopId: 'm', name: 'Measured', lat: 43.6454, lon: -79.3958 }),
  ], RIDER, 'x');
  assert.deepEqual(rows.map((r) => r.stopId), ['m', 'a', 'z']);
});

test('shapeStopResults falls back to the stop code when the agency published no name', () => {
  const rows = shapeStopResults([{ stopId: '7', name: null, lat: null, lon: null, wheelchairBoarding: null }], null, '7');
  assert.equal(rows[0].name, '7');
});

test('shapeStopResults respects its limit', () => {
  const many = Array.from({ length: 30 }, (_, i) => stop({ stopId: `s${i}` }));
  assert.equal(shapeStopResults(many, null, 's', 5).length, 5);
});

// ---------------- route results ----------------

const dep = (o: Partial<DepartureDto> & { tripId: string; scheduledMs: number }): DepartureDto => ({
  routeId: '504', shortName: '504', longName: 'King', routeType: 0, color: 'ED1C24',
  headsign: 'East - 504A King towards Distillery Loop', directionId: 0,
  directionLabel: 'East - 504A King towards Distillery Loop',
  stopSequence: 1, liveEtaMs: null,
  honest: { estimateMs: null, bandLowMs: null, bandHighMs: null, medianDelaySec: null },
  evidence: { n: 0, windowDays: 14, bucket: 'none' },
  ...o,
});

const board = (departures: DepartureDto[]) => [{
  stopId: '15647', stopName: 'King St West at Spadina Ave West Side', departures,
}];

test('a route row carries the real stop it leaves from and the real time it leaves', () => {
  const rows = matchRoutes(board([dep({ tripId: 't1', scheduledMs: 1000 })]), 'king');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stopId, '15647');
  assert.equal(rows[0].stopName, 'King St West at Spadina Ave West Side');
  assert.equal(rows[0].departureMs, 1000);
  assert.equal(rows[0].destination, 'Distillery Loop');
});

test('a route matches on its number, its name, or its destination', () => {
  const b = board([dep({ tripId: 't1', scheduledMs: 1000 })]);
  for (const q of ['504', 'king', 'distillery', 'KING']) {
    assert.equal(matchRoutes(b, q).length, 1, `expected a hit for "${q}"`);
  }
  assert.equal(matchRoutes(b, 'spadina').length, 0);
});

test('one row per route AND direction, holding the earliest real departure', () => {
  const rows = matchRoutes(board([
    dep({ tripId: 'later', scheduledMs: 5000 }),
    dep({ tripId: 'earlier', scheduledMs: 2000 }),
    dep({ tripId: 'other-dir', scheduledMs: 3000, directionId: 1, directionLabel: 'West - 504A King towards Dundas West' }),
  ]), 'king');
  assert.equal(rows.length, 2);
  const east = rows.find((r) => r.directionLabel.startsWith('East'));
  assert.equal(east?.departureMs, 2000, 'the earliest departure of that direction');
});

test('an empty query produces no route rows at all', () => {
  assert.deepEqual(matchRoutes(board([dep({ tripId: 't', scheduledMs: 1 })]), '   '), []);
});

test('a departure with no route id can never become a route row', () => {
  const rows = matchRoutes(board([dep({ tripId: 't', scheduledMs: 1, routeId: null })]), 'king');
  assert.deepEqual(rows, []);
});

test('a route row reports live only when the feed actually predicted it', () => {
  const sched = matchRoutes(board([dep({ tripId: 't', scheduledMs: 1000 })]), '504');
  assert.equal(sched[0].isLive, false);
  const live = matchRoutes(board([dep({ tripId: 't', scheduledMs: 1000, liveEtaMs: 1200 })]), '504');
  assert.equal(live[0].isLive, true);
});

// ---------------- recents ----------------

const rec = (stopId: string, name: string, ts: number): RecentPlace =>
  ({ stopId, name, lat: 43.6, lon: -79.4, ts });

test('recents come back newest first, and filter on name or code', () => {
  const list = [rec('1', 'Union Station', 100), rec('2', 'Dundas West', 300), rec('3', 'Broadview', 200)];
  assert.deepEqual(filterRecents(list, '').map((r) => r.stopId), ['2', '3', '1']);
  assert.deepEqual(filterRecents(list, 'dundas').map((r) => r.stopId), ['2']);
  assert.deepEqual(filterRecents(list, '3').map((r) => r.stopId), ['3']);
  assert.deepEqual(filterRecents(list, 'zzz'), []);
});

test('a place already shown as a recent is not repeated in the stop results', () => {
  const rows = shapeStopResults([stop({ stopId: 'A' }), stop({ stopId: 'B' })], null, 'x');
  const out = dedupeAgainst(rows, [rec('A', 'A', 1)]);
  assert.deepEqual(out.map((r) => r.stopId), ['B']);
});

test('pushRecent promotes without duplicating, and honours the cap', () => {
  let list: RecentPlace[] = [];
  list = pushRecent(list, rec('1', 'One', 1));
  list = pushRecent(list, rec('2', 'Two', 2));
  list = pushRecent(list, rec('1', 'One again', 3));
  assert.deepEqual(list.map((r) => r.stopId), ['1', '2'], 'no duplicate, promoted to the front');
  assert.equal(list[0].name, 'One again', 'the newer record wins');

  let big: RecentPlace[] = [];
  for (let i = 0; i < 12; i++) big = pushRecent(big, rec(`s${i}`, `S${i}`, i), 8);
  assert.equal(big.length, 8);
  assert.equal(big[0].stopId, 's11');
});

test('pushRecent does not mutate the list it was given', () => {
  const list = [rec('1', 'One', 1)];
  const snapshot = JSON.parse(JSON.stringify(list));
  pushRecent(list, rec('2', 'Two', 2));
  assert.deepEqual(list, snapshot);
});
