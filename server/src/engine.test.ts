// engine — the DB-facing half. These tests drive the real `createDelayEngine` against a
// stub Db that serves one tiny synthetic board, so the boot path, the crosswalk merge
// rules and the persisted rows are all exercised for real rather than approximated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDelayEngine } from './engine.ts';
import type { Db, Params, Result } from './db.ts';
import type { EngineCycleInput, EngineVehicle, EngineTripUpdate } from './engine.ts';
import { serviceEpochSeconds } from './tz.ts';

// ---------- a synthetic board ----------
//
// Route R1 with two static patterns that share a three-stop prefix, which is what real
// routes look like and what the crosswalk's "two independent patterns agree" promotion
// rule needs:
//   T1 / PA: st1 st2 st3 st4 st6      realtime  a b c d f
//   T2 / PB: st1 st2 st3 st5          realtime  a b c x
//
// So a, b and c are corroborated by both patterns while d, f and x sit on one each. The
// geometric anchors in these tests are placed on c, d and x only, which leaves a and b
// PROPAGATED-ONLY — the class the promotion and confidence rules are actually about.

const BOARD = '20260726..20260905';
const SERVICE_DATE = 20260726;
/** Scheduled departure of the first run of pattern PA, seconds past service midnight. */
const FIRST_DEP_S = 36_000;
const HEADWAY_S = 600;
const LAT0 = 43.70, LON0 = -79.40;
const at = (metresNorth: number): number => LAT0 + metresNorth / 111_320;
const STOP_LAT: Record<string, number> = {
  st1: at(0), st2: at(100), st3: at(200), st4: at(300), st5: at(800), st6: at(1500),
};

/** A vehicle dwelling exactly on a static stop, reporting it under a realtime id. */
const dwellingAt = (vehicleId: string, rtStopId: string, metresNorth: number): EngineVehicle => ({
  vehicleId, routeId: 'R1', rtTripId: null, rtStopId,
  currentStatus: 1, lat: at(metresNorth), lon: LON0, tsS: 1_800_000_000,
});
/** Anchors on c, d and x — enough for both patterns to resolve, and on neither a nor b. */
const ANCHORS: EngineVehicle[] = [
  dwellingAt('VC', 'c', 200), dwellingAt('VD', 'd', 300), dwellingAt('VX', 'x', 800),
];

interface XwRow {
  rt_stop_id: string; stop_id: string; votes: number; distinct_patterns: number;
  geo_resid_m: number | null; source: string; state: string; confidence: number;
}

interface Captured { sql: string; params: unknown[] }

/** A Db that serves the synthetic board and records every write. */
function stubDb(xwalkRows: XwRow[]): Db & { writes: Captured[] } {
  const writes: Captured[] = [];
  const tripStops = (tripId: string, stops: string[], baseS = FIRST_DEP_S) => stops.map((stopId, i) => ({
    trip_id: tripId, route_id: 'R1', direction_id: 0, service_id: 'S1',
    stop_sequence: i + 1, stop_id: stopId,
    arrival_s: baseS + i * 300, departure_s: baseS + i * 300,
  }));
  const stopTimeRows = [
    ...tripStops('T1', ['st1', 'st2', 'st3', 'st4', 'st6']),
    ...tripStops('T2', ['st1', 'st2', 'st3', 'st5']),
    // Two more runs of pattern PA, ten minutes apart. Three slots is the minimum
    // `medianHeadwayForSlots` will compute a headway from, and without a headway
    // `originLock` refuses the whole pattern (`refused_headway_band`) — so without these
    // the binding half of this engine cannot be exercised by a test at all.
    ...tripStops('T1b', ['st1', 'st2', 'st3', 'st4', 'st6'], FIRST_DEP_S + HEADWAY_S),
    ...tripStops('T1c', ['st1', 'st2', 'st3', 'st4', 'st6'], FIRST_DEP_S + 2 * HEADWAY_S),
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
  xw('d', 'st4', over), xw('f', 'st6', over), xw('x', 'st5', over),
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
    serviceDate: SERVICE_DATE,
    vehicles: [],
    tripUpdates: [tripUpdate('RT1', ['a', 'b', 'c', 'd', 'f']), tripUpdate('RT2', ['a', 'b', 'c', 'x'])],
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
  assert.equal(warm.getStats().xwalk.rtStopsSeen, 6);
  // 6 of the 9 realtime stop occurrences this cycle (a, b and c, on both trips) are covered.
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

// ---------- BLOCKERS 10: what the coverage plateau was actually made of ----------

test('REGRESSION (BLOCKERS 10): corroboration once observed is not forgotten', async () => {
  // `distinctPatterns` was recounted every cycle from the patterns resolved in THAT cycle,
  // so a stop confirmed by two agreeing patterns fell back to `candidate` as soon as one
  // of them stopped running — 03:00 unlearns what 08:00 established. The live run shows
  // the oscillation directly (confirmed 3,043 -> 3,031 -> 3,019 -> 3,025 -> 3,042 across
  // five consecutive cycles) and occurrence coverage drifting DOWN while still learning.
  const db = stubDb([]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);

  // Enough cycles with BOTH patterns present for the vote count to clear the floor.
  for (let i = 0; i < 8; i++) await e.runCycle(cycle({ vehicles: ANCHORS }));
  assert.equal(e.staticStopFor('a'), 'st1', 'two agreeing patterns confirm it');
  assert.equal(e.staticStopFor('b'), 'st2');

  // Now only one of the two patterns is in the feed. The second pattern's agreement
  // happened; it does not stop having happened.
  await e.runCycle(cycle({ vehicles: ANCHORS, tripUpdates: [tripUpdate('RT1', ['a', 'b', 'c', 'd', 'f'])] }));
  assert.equal(e.staticStopFor('a'), 'st1', 'the other pattern being off shift is not counter-evidence');
  assert.equal(e.staticStopFor('b'), 'st2');
});

test('REGRESSION (BLOCKERS 10): a distant geometric anchor cannot demote an agreeing entry', async () => {
  // The vehicle sits 40 m from st2 — a clean identification (the runner-up is 20 m further,
  // well past the 15 m ambiguity floor), but 40 m is past the point where `1 - resid/60`
  // falls under the 0.60 usability floor. Geometry AGREES with propagation about which stop
  // this is, so the entry must not become unusable for having been measured.
  const db = stubDb([]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  for (let i = 0; i < 8; i++) await e.runCycle(cycle({ vehicles: ANCHORS }));
  assert.equal(e.staticStopFor('b'), 'st2', 'usable on propagation alone');

  const near: EngineVehicle = {
    vehicleId: 'V1', routeId: 'R1', rtTripId: 'RT1', rtStopId: 'b',
    currentStatus: 1, lat: at(60), lon: LON0, tsS: 1_800_000_000,   // 40 m short of st2
  };
  await e.runCycle(cycle({ vehicles: [...ANCHORS, near] }));
  assert.equal(e.getStats().xwalk.conflicted, 0, 'the two sources agree, so there is no conflict');
  assert.equal(e.staticStopFor('b'), 'st2', 'and agreement must not cost it its usability');
});

test('a restored conflicted entry stays unusable and out of the propagation seed', async () => {
  const db = stubDb([xw('a', 'st1', { state: 'conflicted', confidence: 0 }), xw('b', 'st2')]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  await e.runCycle(cycle());
  assert.equal(e.staticStopFor('a'), null);
  assert.equal(e.getStats().xwalk.conflicted, 1);
});

// ---------- DECISIONS §46: a restored row may not outlive its evidence ----------

test('a row confirmed by BINDING VALIDATION comes back as a candidate, not confirmed', async () => {
  // The second promotion path rests on bindings that survived on the implying pattern.
  // Bindings belong to a service day and are not persisted, so a row that was confirmed
  // that way has no evidence behind it after a restart. It must re-earn the promotion.
  // Such a row is recognisable: one pattern, and not a self-confirming geometric anchor.
  const db = stubDb([xw('a', 'st1', { distinct_patterns: 1, state: 'confirmed', confidence: 0.85 })]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  assert.equal(e.staticStopFor('a'), null, 'restored as candidate, so it cannot back a delay row yet');
});

test('DEFECT 3: a validation-confirmed entry is demoted IN-PROCESS when its evidence is withdrawn', async () => {
  // The third promotion path confirms a one-pattern identity on the strength of bindings
  // that survived on the implying pattern. That evidence is retractable — and the promotion
  // loop only rewrites entries the CURRENT cycle re-proposed, while a stop stops being
  // proposed the moment its RT pattern is quarantined. So without `demoteUnvalidated()` an
  // entry keeps backing delay rows on evidence that no longer exists anywhere: exactly the
  // "evidence outliving its retraction" class this work was about, left open inside one
  // process even after the warm-start guard closed it across a restart.
  //
  // 'd' is the stop under test: it sits on pattern PA only, so it has one agreeing pattern
  // and can never reach `confirmed` by the two-pattern path. Everything else is seeded at
  // two patterns so it is confirmed and usable, which is what lets a binding form at all.
  const db = stubDb([
    xw('a', 'st1'), xw('b', 'st2'), xw('c', 'st3'), xw('f', 'st6'), xw('x', 'st5'),
    xw('d', 'st4', { distinct_patterns: 1 }),
  ]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);

  const dayStart = serviceEpochSeconds(SERVICE_DATE, 0);
  const bound = (over: Partial<EngineCycleInput> = {}): EngineCycleInput => ({
    nowMs: (dayStart + FIRST_DEP_S - 240) * 1000,   // before every predicted departure
    serviceDate: SERVICE_DATE,
    vehicles: [],                                    // no geo anchors: 'd' must not self-confirm
    tripUpdates: [],
    activeServices: new Set(['S1']),
    ...over,
  });
  /** A newborn trip whose first prediction sits 60 s after `schedS` — inside the origin band. */
  const newborn = (rtTripId: string, schedS: number, stops: string[]): EngineTripUpdate => ({
    rtTripId, routeId: 'R1', scheduleRelationship: null,
    stops: stops.map((rtStopId, i) => ({
      stopSequence: i + 1, rtStopId,
      epochS: dayStart + schedS + 60 + i * 300, kind: 'departure' as const, noData: false,
    })),
  });
  const PA_STOPS = ['a', 'b', 'c', 'd', 'f'];

  // Cycle 1: RT1 is born and locks onto T1. One binding, one cycle — not enough.
  await e.runCycle(bound({ tripUpdates: [newborn('RT1', FIRST_DEP_S, PA_STOPS)] }));
  assert.equal(e.getStats().bindings.locked, 1, 'the fixture must actually bind, or this test proves nothing');
  assert.equal(e.staticStopFor('d'), null, 'one binding in one cycle must not confirm');

  // Cycle 2: RT3 locks onto T1b. Now two distinct bindings across two distinct cycles.
  await e.runCycle(bound({
    tripUpdates: [newborn('RT1', FIRST_DEP_S, PA_STOPS), newborn('RT3', FIRST_DEP_S + HEADWAY_S, PA_STOPS)],
  }));
  assert.equal(e.getStats().bindings.locked, 2);

  // Cycle 3: promotion reads the credit accumulated in cycles 1-2 and confirms 'd'.
  await e.runCycle(bound({ tripUpdates: [newborn('RT1', FIRST_DEP_S, PA_STOPS)] }));
  assert.equal(e.staticStopFor('d'), 'st4', 'the third promotion path should have confirmed it by now');

  // Cycle 4: RT1 now reports 'x' at sequence 4. The crosswalk says 'x' is st5; the bound
  // trip's pattern has st4 there. That contradiction is what the per-trip consistency gate
  // exists to catch — it quarantines the RT pattern and distrusts the static one.
  await e.runCycle(bound({ tripUpdates: [newborn('RT1', FIRST_DEP_S, ['a', 'b', 'c', 'x'])] }));

  // Cycle 5: time has moved past those predictions and RT1 has left the feed, so its stops
  // settle and the gate fires.
  await e.runCycle(bound({ nowMs: (dayStart + FIRST_DEP_S + 3600) * 1000 }));

  // Cycle 6: 'd' is no longer proposed by anything — its pattern is quarantined, and it has
  // no geometric anchor — so only the sweep can still take its confirmation away.
  await e.runCycle(bound({ nowMs: (dayStart + FIRST_DEP_S + 3600) * 1000 }));
  // Pin the mechanism, not just the outcome: `staticStopFor` would also read null if the
  // drift breaker had retracted the credit instead. It cannot fire here (|resid| 60 s is well
  // inside half the 600 s headway), and this asserts the consistency gate is what ran.
  assert.equal(e.getStats().patterns.quarantined, 1, 'the consistency gate must be what withdrew it');
  assert.equal(e.staticStopFor('d'), null,
    'validation was withdrawn, so the entry must stop backing delay rows');
});

test('the two evidence-carrying promotion paths still survive a restart intact', async () => {
  // Whatever the guard above does, it must not cost a warm start the promotions whose
  // evidence IS persisted: distinct_patterns >= 2, and a geometric self-confirmation.
  const db = stubDb([
    xw('a', 'st1', { distinct_patterns: 2 }),
    xw('b', 'st2', { distinct_patterns: 1, source: 'geo', geo_resid_m: 20 }),
    // …and a geometric anchor too far away to self-confirm is NOT evidence.
    xw('c', 'st3', { distinct_patterns: 1, source: 'geo', geo_resid_m: 75 }),
  ]);
  const e = createDelayEngine(db, 'ttc');
  await e.reloadStatic(BOARD);
  assert.equal(e.staticStopFor('a'), 'st1');
  assert.equal(e.staticStopFor('b'), 'st2');
  assert.equal(e.staticStopFor('c'), null);
});
