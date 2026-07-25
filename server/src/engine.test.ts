// engine — the DB-facing half. These tests drive the real `createDelayEngine` against a
// stub Db that serves one tiny synthetic board, so the boot path, the crosswalk merge
// rules and the persisted rows are all exercised for real rather than approximated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDelayEngine } from './engine.ts';
import type { Db, Params, Result } from './db.ts';
import type { EngineCycleInput, EngineVehicle, EngineTripUpdate } from './engine.ts';

// ---------- a synthetic board ----------
//
// Route R1 with two static patterns that share a prefix, which is what real routes look
// like and what the crosswalk's "two independent patterns agree" promotion rule needs:
//   T1 / PA: st1 st2 st3 st4
//   T2 / PB: st1 st2 st5
// Realtime names those stops a b c d and a b x. Stops sit 100 m apart along a meridian.

const BOARD = '20260726..20260905';
const LAT0 = 43.70, LON0 = -79.40;
const at = (metresNorth: number): number => LAT0 + metresNorth / 111_320;
const STOP_LAT: Record<string, number> = {
  st1: at(0), st2: at(100), st3: at(200), st4: at(300), st5: at(800),
};

interface XwRow {
  rt_stop_id: string; stop_id: string; votes: number; distinct_patterns: number;
  geo_resid_m: number | null; source: string; state: string; confidence: number;
}

interface Captured { sql: string; params: unknown[] }

/** A Db that serves the synthetic board and records every write. */
function stubDb(xwalkRows: XwRow[]): Db & { writes: Captured[] } {
  const writes: Captured[] = [];
  const tripStops = (tripId: string, stops: string[]) => stops.map((stopId, i) => ({
    trip_id: tripId, route_id: 'R1', direction_id: 0, service_id: 'S1',
    stop_sequence: i + 1, stop_id: stopId,
    arrival_s: 36_000 + i * 300, departure_s: 36_000 + i * 300,
  }));
  const stopTimeRows = [
    ...tripStops('T1', ['st1', 'st2', 'st3', 'st4']),
    ...tripStops('T2', ['st1', 'st2', 'st5']),
  ];
  const geometryRows = Object.entries(STOP_LAT).map(([stop_id, lat]) => ({ route_id: 'R1', stop_id, lat, lon: LON0 }));

  const db = {
    driver: 'pglite' as const,
    closed: false,
    async query<T>(sql: string, params?: Params): Promise<Result<T>> {
      const rows = (r: unknown[]): Result<T> => ({ rows: r as T[], rowCount: r.length });
      // buildPatternIndex is keyset-paged on trip_id; the cursor is $2 and starts at ''.
      if (/FROM stop_times st JOIN trips/.test(sql)) return rows(params?.[1] === '' ? stopTimeRows : []);
      if (/JOIN stops s/.test(sql)) return rows(geometryRows);
      if (/FROM rt_stop_xwalk/.test(sql)) return rows(xwalkRows);
      writes.push({ sql, params: (params ?? []) as unknown[] });
      return rows([]);
    },
    async transaction<T>(fn: (tx: { query: Db['query'] }) => Promise<T>): Promise<T> { return fn(db); },
    async close(): Promise<void> { /* nothing to close */ },
    writes,
  };
  return db as unknown as Db & { writes: Captured[] };
}

const xw = (rtStopId: string, stopId: string, over: Partial<XwRow> = {}): XwRow => ({
  rt_stop_id: rtStopId, stop_id: stopId, votes: 12, distinct_patterns: 2,
  geo_resid_m: null, source: 'propagated', state: 'confirmed', confidence: 0.85, ...over,
});

/** The crosswalk this deployment would have persisted before a restart. */
const LEARNED = (over: Partial<XwRow> = {}): XwRow[] => [
  xw('a', 'st1', over), xw('b', 'st2', over), xw('c', 'st3', over),
  xw('d', 'st4', over), xw('x', 'st5', over),
];

function tripUpdate(rtTripId: string, rtStops: string[]): EngineTripUpdate {
  return {
    rtTripId, routeId: 'R1', scheduleRelationship: null,
    stops: rtStops.map((rtStopId, i) => ({
      stopSequence: i + 1, rtStopId, epochS: 1_800_000_000 + i * 300,
      kind: 'departure' as const, noData: false,
    })),
  };
}

function cycle(over: Partial<EngineCycleInput> = {}): EngineCycleInput {
  return {
    nowMs: 1_800_000_000_000,
    serviceDate: 20260726,
    vehicles: [],
    tripUpdates: [tripUpdate('RT1', ['a', 'b', 'c', 'd']), tripUpdate('RT2', ['a', 'b', 'x'])],
    activeServices: new Set<string>(),   // board inactive: coverage is still measured
    ...over,
  };
}

/** The rows persistCrosswalk wrote to rt_stop_xwalk, keyed by rt stop id. */
function persistedXwalk(writes: Captured[]): Map<string, { votes: number; state: string; confidence: number; stopId: string }> {
  const COLS = 10;   // agency, rt_stop_id, board_tag, stop_id, votes, distinct, resid, source, state, confidence
  const out = new Map<string, { votes: number; state: string; confidence: number; stopId: string }>();
  for (const w of writes) {
    if (!/INSERT INTO rt_stop_xwalk /.test(w.sql)) continue;
    for (let i = 0; i + COLS <= w.params.length; i += COLS) {
      out.set(String(w.params[i + 1]), {
        stopId: String(w.params[i + 3]),
        votes: Number(w.params[i + 4]),
        state: String(w.params[i + 8]),
        confidence: Number(w.params[i + 9]),
      });
    }
  }
  return out;
}

// ---------- BLOCKERS 11: the learned crosswalk is written and never read back ----------

test('REGRESSION (BLOCKERS 11): a cold boot restores the crosswalk instead of relearning', async () => {
  // BEFORE: rt_stop_xwalk was INSERTed every cycle and SELECTed by nothing, so every
  // restart began from an empty crosswalk. With no anchors nothing resolves, nothing is
  // implied, and occurrence coverage reads 0.0% — for the ~8 cycles a propagated entry
  // needs to climb back over the 0.60 usability floor. That is longer than the uptime of
  // a host that sleeps when idle.
  const cold = createDelayEngine(stubDb([]), 'ttc');
  await cold.reloadStatic(BOARD);
  await cold.runCycle(cycle());
  assert.equal(cold.getStats().xwalk.occurrenceCoverage, 0,
    'with nothing restored, cycle 1 can back none of the feed');
  assert.equal(cold.staticStopFor('a'), null);

  // AFTER: the same first cycle, with the crosswalk this deployment already learned.
  // a and b sit on both resolved patterns, so they clear promotion immediately; c, d and
  // x are each on one pattern only, which is BLOCKERS 10's ceiling, not this fix's.
  const warm = createDelayEngine(stubDb(LEARNED()), 'ttc');
  await warm.reloadStatic(BOARD);
  await warm.runCycle(cycle());
  assert.equal(warm.staticStopFor('a'), 'st1', 'a restored identity backs a delay row on cycle 1');
  assert.equal(warm.staticStopFor('b'), 'st2');
  assert.equal(warm.getStats().xwalk.rtStopsSeen, 5);
  // 4 of the 7 realtime stop occurrences this cycle (a and b, on both trips) are covered.
  assert.ok(warm.getStats().xwalk.occurrenceCoverage > 0.5,
    `cycle-1 coverage ${warm.getStats().xwalk.occurrenceCoverage} must beat the cold start's 0`);
});

test('a restored entry is not credited a vote for having been read', async () => {
  // Loading a row is not an observation. If it were, an entry could climb the confidence
  // ladder by restarting the process rather than by being corroborated.
  const db = stubDb(LEARNED({ votes: 5 }));
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  await e.runCycle(cycle());
  const after = persistedXwalk(db.writes);
  assert.equal(after.get('a')?.votes, 6,
    'one cycle of genuine re-derivation is worth exactly one vote — not a reset, not a jump');
  assert.equal(after.get('x')?.votes, 6);
});

test('REGRESSION (BLOCKERS 11): new evidence can still overturn a restored mapping', async () => {
  // The restored entry says rt stop "a" is st1. A vehicle now sits STOPPED_AT "a" on top
  // of st2. Two different static stops for one realtime stop is a conflict whether the
  // first came from this process or from the database — if the loaded id were not seeded
  // into the proposal set, the contradiction would silently overwrite instead, which is
  // the one outcome the conflict machinery exists to prevent.
  const db = stubDb(LEARNED());
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  assert.equal(e.staticStopFor('a'), 'st1', 'restored, before any contradiction');

  const atSt2: EngineVehicle = {
    vehicleId: 'V1', routeId: 'R1', rtTripId: 'RT1', rtStopId: 'a',
    currentStatus: 1, lat: STOP_LAT.st2, lon: LON0, tsS: 1_800_000_000,
  };
  await e.runCycle(cycle({ vehicles: [atSt2] }));

  assert.equal(e.staticStopFor('a'), null, 'a contested identity may not back a delay row');
  assert.equal(e.getStats().xwalk.conflicted, 1);
  const persisted = persistedXwalk(db.writes);
  assert.equal(persisted.get('a')?.state, 'conflicted');
  assert.equal(persisted.get('a')?.confidence, 0);
  assert.equal(e.staticStopFor('b'), 'st2', 'the stops nobody contradicted are untouched');
});

test('a restored conflicted entry stays unusable and out of the propagation seed', async () => {
  const db = stubDb([xw('a', 'st1', { state: 'conflicted', confidence: 0 }), xw('b', 'st2')]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  await e.runCycle(cycle());
  assert.equal(e.staticStopFor('a'), null);
  assert.equal(e.getStats().xwalk.conflicted, 1);
});
