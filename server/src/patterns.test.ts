import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  patternIdFor, medianHeadwayForSlots, foldTrip, emptyPatternIndex, median,
  type StaticTripSlot,
} from './patterns.ts';

function row(tripId: string, routeId: string, dirId: number | null, serviceId: string, seq: number, stopId: string, t: number) {
  return { trip_id: tripId, route_id: routeId, direction_id: dirId, service_id: serviceId, stop_sequence: seq, stop_id: stopId, arrival_s: t, departure_s: t };
}
function slot(tripId: string, serviceId: string, firstDepS: number): StaticTripSlot {
  return { tripId, serviceId, patternId: 'p', times: new Int32Array([firstDepS]), arrivals: new Int32Array([firstDepS]), firstDepS };
}

test('pattern id is stable under row re-ordering', () => {
  const rows = [row('t1', 'R', 0, 's1', 1, 'A', 0), row('t1', 'R', 0, 's1', 2, 'B', 60), row('t1', 'R', 0, 's1', 3, 'C', 120)];
  const a = emptyPatternIndex();
  const b = emptyPatternIndex();
  foldTrip(a, rows);
  foldTrip(b, [rows[2], rows[0], rows[1]]);
  assert.equal([...a.patterns.keys()][0], [...b.patterns.keys()][0]);
  assert.deepEqual([...a.patterns.values()][0].stops, ['A', 'B', 'C']);
  assert.deepEqual([...b.patterns.values()][0].stops, ['A', 'B', 'C']);
});

test('pattern id distinguishes direction_id even with an identical stop list', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [row('t1', 'R', 0, 's1', 1, 'A', 0), row('t1', 'R', 0, 's1', 2, 'B', 60)]);
  foldTrip(idx, [row('t2', 'R', 1, 's1', 1, 'A', 0), row('t2', 'R', 1, 's1', 2, 'B', 60)]);
  assert.equal(idx.patterns.size, 2, 'same stops, opposite direction = two patterns');
  assert.notEqual(patternIdFor('R', 0, ['A', 'B']), patternIdFor('R', 1, ['A', 'B']));
  // …and two routes with the same stop list are also distinct.
  assert.notEqual(patternIdFor('R', 0, ['A', 'B']), patternIdFor('S', 0, ['A', 'B']));
  // …but the same route+direction+stops is one pattern, however many trips run it.
  assert.equal(idx.slotsByPattern.get(patternIdFor('R', 0, ['A', 'B']))!.length, 1);
});

test('medianHeadwayForSlots on departures 0/600/1200/1800 is 600', () => {
  const slots = [slot('a', '1', 0), slot('b', '1', 600), slot('c', '1', 1200), slot('d', '1', 1800)];
  assert.equal(medianHeadwayForSlots(slots), 600);
  // Unsorted input gives the same answer.
  assert.equal(medianHeadwayForSlots([slots[3], slots[0], slots[2], slots[1]]), 600);
});

test('medianHeadwayForSlots uses the dominant service, not a mix of them', () => {
  // Service 1 runs every 600s; two stray service-9 trips must not pollute the gap list.
  const slots = [
    slot('a', '1', 0), slot('b', '1', 600), slot('c', '1', 1200), slot('d', '1', 1800),
    slot('x', '9', 30), slot('y', '9', 60),
  ];
  assert.equal(medianHeadwayForSlots(slots), 600);
});

test('medianHeadwayForSlots refuses to guess from fewer than 3 slots', () => {
  assert.equal(medianHeadwayForSlots([slot('a', '1', 0), slot('b', '1', 600)]), null);
  assert.equal(medianHeadwayForSlots([]), null);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('maxLenByRoute is the max over that route\'s patterns (it feeds the merge cap)', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [row('short', 'R', 0, 's1', 1, 'A', 0), row('short', 'R', 0, 's1', 2, 'B', 60)]);
  foldTrip(idx, [
    row('long', 'R', 0, 's1', 1, 'A', 0), row('long', 'R', 0, 's1', 2, 'B', 60),
    row('long', 'R', 0, 's1', 3, 'C', 120), row('long', 'R', 0, 's1', 4, 'D', 180),
  ]);
  foldTrip(idx, [row('other', 'S', 0, 's1', 1, 'Z', 0), row('other', 'S', 0, 's1', 2, 'Y', 60)]);
  assert.equal(idx.maxLenByRoute.get('R'), 4);
  assert.equal(idx.maxLenByRoute.get('S'), 2);
});

test('a trip with a hole in its stop_sequence is refused, not silently patched', () => {
  const idx = emptyPatternIndex();
  // sequences 1 and 3, no 2 — folding this would invent an empty stop at index 1.
  foldTrip(idx, [row('t', 'R', 0, 's1', 1, 'A', 0), row('t', 'R', 0, 's1', 3, 'C', 120)]);
  assert.equal(idx.patterns.size, 0);
  assert.equal(idx.tripIds.size, 0);
});

test('arrival and departure are kept separately and both fall back to the other', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [
    { trip_id: 't', route_id: 'R', direction_id: 0, service_id: 's1', stop_sequence: 1, stop_id: 'A', arrival_s: 100, departure_s: 130 },
    { trip_id: 't', route_id: 'R', direction_id: 0, service_id: 's1', stop_sequence: 2, stop_id: 'B', arrival_s: 200, departure_s: null },
  ]);
  const s = idx.slotsByTrip.get('t')!;
  assert.equal(s.arrivals[0], 100);
  assert.equal(s.times[0], 130);
  assert.equal(s.firstDepS, 130);
  assert.equal(s.arrivals[1], 200);
  assert.equal(s.times[1], 200, 'departure falls back to arrival');
});

test('a trip with no route_id contributes nothing', () => {
  const idx = emptyPatternIndex();
  foldTrip(idx, [{ trip_id: 't', route_id: null, direction_id: 0, service_id: 's1', stop_sequence: 1, stop_id: 'A', arrival_s: 0, departure_s: 0 }]);
  assert.equal(idx.patterns.size, 0);
});
