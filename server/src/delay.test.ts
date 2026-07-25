import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleTrip, MAX_PLAUSIBLE_DELAY_S, type SettleInput, type TrackedStop } from './delay.ts';
import { serviceEpochSeconds, hourOfWeek } from './tz.ts';
import type { XwalkEntry } from './xwalk.ts';

const DATE = 20260803;
const DAY0 = serviceEpochSeconds(DATE, 0);

function xw(rtStopId: string, stopId: string, confidence = 0.9, state: XwalkEntry['state'] = 'confirmed'): [string, XwalkEntry] {
  return [rtStopId, { rtStopId, stopId, votes: 10, distinctPatterns: 2, geoResidM: 10, source: 'geo', state, confidence }];
}
function stop(seq: number, rtStopId: string, epochS: number, kind: 'arrival' | 'departure' = 'arrival', noData = false): TrackedStop {
  return { stopSequence: seq, rtStopId, epochS, kind, noData };
}

function input(over: Partial<SettleInput> = {}): SettleInput {
  const times = new Int32Array([9 * 3600, 9 * 3600 + 120, 9 * 3600 + 240]);
  const arrivals = new Int32Array([9 * 3600 - 10, 9 * 3600 + 110, 9 * 3600 + 230]);
  return {
    nowS: DAY0 + 9 * 3600 + 600,
    serviceDate: DATE,
    boardTag: '20260726..20260905',
    rtTripId: 'rt1',
    staticTripId: 'T1',
    routeId: 'R',
    confidence: 'high',
    matchMarginS: 200,
    headwayS: 900,
    prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600 + 60)]]),
    current: new Map(),
    times,
    arrivals,
    staticStops: ['s1', 's2', 's3'],
    xwalk: new Map([xw('a1', 's1'), xw('a2', 's2'), xw('a3', 's3')]),
    ...over,
  };
}

test('delay_s is exactly event_epoch_s - sched_epoch_s, recomputable from the row alone', () => {
  const r = settleTrip(input());
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.delayS, row.eventEpochS - row.schedEpochS);
  // arrival kind -> arrivals[0] = 9h-10s; predicted 9h+60s -> 70 s late.
  assert.equal(row.schedEpochS, DAY0 + 9 * 3600 - 10);
  assert.equal(row.delayS, 70);
  assert.equal(row.method, 'sched_diff');
  assert.equal(row.stopId, 's1', 'the STATIC stop id, never the realtime one');
  assert.equal(row.source, 'predicted');
});

test('hour_of_week comes from the SCHEDULED epoch, not the actual one', () => {
  // Scheduled at 09:50, running 50 minutes late so the event lands at 10:40. The row must
  // be bucketed at 09:00, or it would be compared against the wrong hour's baseline.
  const sched = 9 * 3600 + 50 * 60;
  const r = settleTrip(input({
    times: new Int32Array([sched]),
    arrivals: new Int32Array([sched]),
    staticStops: ['s1'],
    prev: new Map([[1, stop(1, 'a1', DAY0 + sched + 50 * 60)]]),
  }));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].delayS, 3000);
  assert.equal(r.rows[0].hourOfWeek, hourOfWeek((DAY0 + sched) * 1000));
  assert.notEqual(r.rows[0].hourOfWeek, hourOfWeek((DAY0 + sched + 50 * 60) * 1000));
});

test('arrival stops read arrivals[], departure stops read times[]', () => {
  const arrival = settleTrip(input({ prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600, 'arrival')]]) }));
  assert.equal(arrival.rows[0].schedEpochS, DAY0 + 9 * 3600 - 10);
  assert.equal(arrival.rows[0].delayS, 10);

  const departure = settleTrip(input({ prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600, 'departure')]]) }));
  assert.equal(departure.rows[0].schedEpochS, DAY0 + 9 * 3600);
  assert.equal(departure.rows[0].delayS, 0);
});

test('a future stop is never emitted; a dropped sequence is', () => {
  const future = DAY0 + 9 * 3600 + 5000;
  // Still listed and still in the future -> not settled.
  const notYet = settleTrip(input({
    prev: new Map([[1, stop(1, 'a1', future)]]),
    current: new Map([[1, stop(1, 'a1', future)]]),
  }));
  assert.equal(notYet.rows.length, 0);
  assert.equal(notYet.counters.droppedNotSettled, 1);

  // Same future time, but the sequence dropped out of the list -> the bus went past it.
  const dropped = settleTrip(input({ prev: new Map([[1, stop(1, 'a1', future)]]), current: new Map() }));
  assert.equal(dropped.rows.length, 1);

  // Trip gone from the feed entirely -> settle everything it still had.
  const gone = settleTrip(input({ prev: new Map([[1, stop(1, 'a1', future)]]), current: null }));
  assert.equal(gone.rows.length, 1);

  // Still listed but its predicted time is comfortably past -> settled in place.
  const past = settleTrip(input({
    prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600)]]),
    current: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600)]]),
    nowS: DAY0 + 9 * 3600 + 31,
  }));
  assert.equal(past.rows.length, 1);
});

test('NO_DATA is never emitted — imputing on-time for it is the fabrication being fixed', () => {
  const r = settleTrip(input({ prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600, 'arrival', true)]]) }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.counters.droppedNoData, 1);
  assert.equal(r.counters.written, 0);
});

test('an implausible delay is DROPPED AND COUNTED, never clamped', () => {
  const r = settleTrip(input({
    prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600 + 6000)]]),
  }));
  assert.deepEqual(r.rows, [], 'the emitted array is empty');
  assert.equal(r.counters.droppedImplausible, 1);
  // Specifically NOT clamped to the limit: a censored distribution is a dishonest one.
  assert.equal(r.rows.find((x) => x.delayS === MAX_PLAUSIBLE_DELAY_S), undefined);

  // Just inside the limit still counts, in both directions.
  const late = settleTrip(input({ prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600 - 10 + 5400)]]) }));
  assert.equal(late.rows[0].delayS, 5400);
  const early = settleTrip(input({
    nowS: DAY0 + 20 * 3600,
    prev: new Map([[1, stop(1, 'a1', DAY0 + 9 * 3600 - 10 - 5400)]]),
  }));
  assert.equal(early.rows[0].delayS, -5400, 'genuinely early buses are measured, not floored at zero');
});

test('a stop without a usable crosswalk entry is skipped and counted', () => {
  const unknown = settleTrip(input({ prev: new Map([[1, stop(1, 'NEVER_SEEN', DAY0 + 9 * 3600)]]) }));
  assert.equal(unknown.rows.length, 0);
  assert.equal(unknown.counters.droppedNoXwalk, 1);

  const weak = settleTrip(input({ xwalk: new Map([xw('a1', 's1', 0.4)]) }));
  assert.equal(weak.counters.droppedNoXwalk, 1);

  const unconfirmed = settleTrip(input({ xwalk: new Map([xw('a1', 's1', 0.99, 'candidate')]) }));
  assert.equal(unconfirmed.counters.droppedNoXwalk, 1);

  const conflicted = settleTrip(input({ xwalk: new Map([xw('a1', 's1', 0.99, 'conflicted')]) }));
  assert.equal(conflicted.counters.droppedNoXwalk, 1);
});

test('CONSISTENCY GATE: crosswalk contradicting the binding abandons the whole trip', () => {
  // The bound static trip has s2 at sequence 2, but the crosswalk says the RT stop there
  // is s3. One of the two is wrong, so neither may be published — including the stop that
  // looked fine.
  const r = settleTrip(input({
    prev: new Map([
      [1, stop(1, 'a1', DAY0 + 9 * 3600)],
      [2, stop(2, 'a3', DAY0 + 9 * 3600 + 120)],
    ]),
  }));
  assert.deepEqual(r.rows, [], 'not even the consistent stop is emitted');
  assert.ok(r.inconsistent);
  assert.equal(r.inconsistent.stopSequence, 2);
  assert.equal(r.inconsistent.expected, 's2');
  assert.equal(r.inconsistent.got, 's3');
});

test('a LOOP ROUTE visiting one stop twice produces TWO rows', () => {
  // The same physical stop at sequences 1 and 3. The old (trip_id, stop_id) uniqueness
  // key could only express one of them; the key is on stop_sequence for exactly this case.
  const r = settleTrip(input({
    staticStops: ['sLOOP', 's2', 'sLOOP'],
    xwalk: new Map([xw('a1', 'sLOOP'), xw('a3', 'sLOOP')]),
    prev: new Map([
      [1, stop(1, 'a1', DAY0 + 9 * 3600)],
      [3, stop(3, 'a3', DAY0 + 9 * 3600 + 300)],
    ]),
  }));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].stopId, 'sLOOP');
  assert.equal(r.rows[1].stopId, 'sLOOP');
  assert.deepEqual(r.rows.map((x) => x.stopSequence), [1, 3]);
  assert.notEqual(r.rows[0].delayS, r.rows[1].delayS);
});

test('a VehiclePosition STOPPED_AT upgrades the row from predicted to observed', () => {
  const r = settleTrip(input({
    observed: new Map([[1, DAY0 + 9 * 3600 + 25]]),
  }));
  assert.equal(r.rows[0].source, 'observed');
  assert.equal(r.rows[0].eventEpochS, DAY0 + 9 * 3600 + 25, 'the actual arrival, not the prediction');
  assert.equal(r.rows[0].delayS, 35);
  assert.equal(r.counters.observed, 1);
  assert.equal(r.counters.predicted, 0);
});

test('a stop with no scheduled time in the bound trip is skipped, not treated as zero', () => {
  const r = settleTrip(input({
    arrivals: new Int32Array([-1, -1, -1]),
    times: new Int32Array([-1, -1, -1]),
  }));
  assert.equal(r.rows.length, 0);
  assert.equal(r.counters.droppedNoSchedule, 1);
});

test('rows carry the provenance a published number needs', () => {
  const row = settleTrip(input()).rows[0];
  assert.equal(row.confidence, 'high');
  assert.equal(row.xwalkConf, 0.9);
  assert.equal(row.matchMarginS, 200);
  assert.equal(row.headwayS, 900);
  assert.equal(row.boardTag, '20260726..20260905');
  assert.equal(row.staticTripId, 'T1');
  assert.equal(row.rtTripId, 'rt1');
});
