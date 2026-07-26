// These run against a real in-memory Postgres (PGlite), not a mock, same convention as
// aggregate.test.ts: no network, no fixture files, no wall-clock coupling beyond the
// backtest's own "is this day over yet" check (dates below are chosen safely in the past).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import {
  computeGhostForecastBacktest, computeEtaCalibration,
  BACKTEST_MIN_QUALIFYING_DAYS, BACKTEST_MIN_EVENTS_PER_DAY, CALIBRATION_MIN_OBS,
  type BacktestRunnable, type CalibrationRunnable,
} from './eval.ts';
import { torontoMidnightEpoch } from './tz.ts';
import { percentileCont } from './eta.ts';
import type { Db, Queryable, Result } from './db.ts';

async function freshDb(): Promise<Db> {
  const pg = new PGlite();
  await pg.waitReady;
  const norm = (r: { rows: unknown[]; affectedRows?: number }): Result => ({
    rows: r.rows as Record<string, unknown>[],
    rowCount: Math.max(r.affectedRows ?? 0, r.rows.length),
  });
  const db: Db = {
    driver: 'pglite',
    closed: false,
    async query(sql, params) { return norm(await pg.query(sql, params as unknown[])) as Result<never>; },
    async transaction(fn) {
      return await pg.transaction(async (tx) => fn({
        async query(sql, params) { return norm(await tx.query(sql, params as unknown[])) as Result<never>; },
      } as Queryable));
    },
    async close() { await pg.close(); },
  };
  await db.query(`CREATE TABLE ghosts (
    agency TEXT NOT NULL, trip_id TEXT NOT NULL, route_id TEXT,
    scheduled_start TIMESTAMPTZ NOT NULL, detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind TEXT NOT NULL, PRIMARY KEY (agency, trip_id, scheduled_start))`);
  await db.query(`CREATE TABLE trips (
    agency TEXT NOT NULL, trip_id TEXT NOT NULL, route_id TEXT, service_id TEXT,
    PRIMARY KEY (agency, trip_id))`);
  await db.query(`CREATE TABLE stop_times (
    agency TEXT NOT NULL, trip_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL,
    stop_id TEXT NOT NULL, arrival_s INTEGER, departure_s INTEGER,
    PRIMARY KEY (agency, trip_id, stop_sequence))`);
  await db.query(`CREATE TABLE calendar (
    agency TEXT NOT NULL, service_id TEXT NOT NULL, mon BOOLEAN NOT NULL, tue BOOLEAN NOT NULL,
    wed BOOLEAN NOT NULL, thu BOOLEAN NOT NULL, fri BOOLEAN NOT NULL, sat BOOLEAN NOT NULL,
    sun BOOLEAN NOT NULL, start_date INTEGER NOT NULL, end_date INTEGER NOT NULL,
    PRIMARY KEY (agency, service_id))`);
  await db.query(`CREATE TABLE calendar_dates (
    agency TEXT NOT NULL, service_id TEXT NOT NULL, date INTEGER NOT NULL,
    exception_type SMALLINT NOT NULL, PRIMARY KEY (agency, service_id, date))`);
  await db.query(`CREATE TABLE trip_delay_obs (
    agency TEXT NOT NULL, route_id TEXT, stop_id TEXT, trip_id TEXT, static_trip_id TEXT,
    stop_sequence INTEGER, hour_of_week SMALLINT, delay_s INTEGER, service_date INTEGER NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(), method TEXT, source TEXT, confidence TEXT,
    xwalk_conf DOUBLE PRECISION, sched_epoch_s BIGINT, event_epoch_s BIGINT)`);
  return db;
}

async function addGhost(db: Db, tripId: string, routeId: string, scheduledStartMs: number): Promise<void> {
  await db.query(
    `INSERT INTO ghosts (agency, trip_id, route_id, scheduled_start, kind) VALUES ('ttc',$1,$2,$3,'ghost')`,
    [tripId, routeId, new Date(scheduledStartMs).toISOString()]);
}

async function addWatchedHour(db: Db, epochMs: number, serviceDate: number): Promise<void> {
  await db.query(
    `INSERT INTO trip_delay_obs (agency, service_date, ts) VALUES ('ttc',$1,$2)`,
    [serviceDate, new Date(epochMs).toISOString()]);
}

// ---------------------------------------------------------------------------------------
// Section 1: Ghost Forecast backtest
// ---------------------------------------------------------------------------------------

test('backtest: zero ghosts ever recorded -> honest thin-data message, not a fabricated number', async () => {
  const db = await freshDb();
  try {
    const r = await computeGhostForecastBacktest(db);
    assert.equal(r.runnable, false);
    if (!r.runnable) {
      assert.equal(r.totalGhostEvents, 0);
      assert.equal(r.qualifyingDays, 0);
      assert.match(r.reason, /0 ghost events recorded across 0 service day\(s\) observed/);
    }
  } finally { await db.close(); }
});

test('backtest: ghosts exist but fewer than the required qualifying days -> thin data with real counts', async () => {
  const db = await freshDb();
  try {
    // Only ONE day ever clears the >=5-events bar; the spec's own bar is >=2 such days.
    const day = torontoMidnightEpoch(2026, 7, 1);
    for (let i = 0; i < 6; i++) await addGhost(db, `T${i}`, 'R1', day + 8 * 3_600_000);
    const r = await computeGhostForecastBacktest(db);
    assert.equal(r.runnable, false);
    if (!r.runnable) {
      assert.equal(r.totalGhostEvents, 6);
      assert.equal(r.qualifyingDays, 1, 'exactly one day clears the 5-event bar');
    }
  } finally { await db.close(); }
});

test('backtest: a second qualifying day exists in history but falls outside the training window -> thin data', async () => {
  const db = await freshDb();
  try {
    const holdout = torontoMidnightEpoch(2026, 7, 15);
    const longAgo = torontoMidnightEpoch(2026, 6, 1); // 44 days before holdout, outside the 14-day window
    for (let i = 0; i < 5; i++) await addGhost(db, `H${i}`, 'R1', holdout + 8 * 3_600_000);
    for (let i = 0; i < 5; i++) await addGhost(db, `L${i}`, 'R1', longAgo + 8 * 3_600_000);
    const r = await computeGhostForecastBacktest(db);
    assert.equal(r.runnable, false);
    if (!r.runnable) {
      assert.equal(r.qualifyingDays, 2, 'two qualifying days exist across all history');
      assert.match(r.reason, /training window/);
    }
  } finally { await db.close(); }
});

test('backtest: synthetic DB with known ghosts produces the exactly-expected numbers', async () => {
  const db = await freshDb();
  try {
    const trainYmd = 20260708; // Wednesday
    const holdoutYmd = 20260715; // Wednesday, 7 days later — same hour_of_week cell as trainYmd
    const trainMidnight = torontoMidnightEpoch(2026, 7, 8);
    const holdoutMidnight = torontoMidnightEpoch(2026, 7, 15);

    // Service 'WD' runs the 08:00 slot on both Wednesdays; service 'HOL' runs only on the
    // holdout day (e.g. a one-off extra), so its cell has no training history at all.
    await db.query(`INSERT INTO calendar_dates (agency, service_id, date, exception_type) VALUES
      ('ttc','WD',$1,1), ('ttc','WD',$2,1), ('ttc','HOL',$2,1)`, [trainYmd, holdoutYmd]);

    // Ten distinct static trips all sharing the same (route, service, start) slot — ten
    // vehicles scheduled at the same instant clears GHOST_RISK_MIN_N=8 on the denominator.
    for (let i = 1; i <= 10; i++) {
      await db.query(`INSERT INTO trips (agency, trip_id, route_id, service_id) VALUES ('ttc',$1,'R1','WD')`, [`T8_${i}`]);
      await db.query(`INSERT INTO stop_times (agency, trip_id, stop_sequence, stop_id, departure_s) VALUES ('ttc',$1,1,'S1',28800)`, [`T8_${i}`]);
    }
    await db.query(`INSERT INTO trips (agency, trip_id, route_id, service_id) VALUES ('ttc','T14','R1','HOL')`);
    await db.query(`INSERT INTO stop_times (agency, trip_id, stop_sequence, stop_id, departure_s) VALUES ('ttc','T14',1,'S1',50400)`);

    // Watched hours: the collector demonstrably ran during both 08:00 slots and the 14:00 slot.
    await addWatchedHour(db, trainMidnight + 8 * 3_600_000 + 900_000, trainYmd);
    await addWatchedHour(db, holdoutMidnight + 8 * 3_600_000 + 900_000, holdoutYmd);
    await addWatchedHour(db, holdoutMidnight + 14 * 3_600_000 + 900_000, holdoutYmd);

    // Training day: 5 of the 10 08:00 departures ghost -> rate 5/10 = 50% -> 'high' risk,
    // so the model learns to flag route R1's Wednesday-08:00 cell.
    for (let i = 1; i <= 5; i++) await addGhost(db, `T8_${i}`, 'R1', trainMidnight + 8 * 3_600_000);

    // Holdout day: 4 of the SAME 10-slot cell ghost (flagged cell -> hits + false alarms),
    // and the lone HOL-service trip also ghosts (unflagged cell, no training history -> miss).
    for (let i = 6; i <= 9; i++) await addGhost(db, `T8_${i}`, 'R1', holdoutMidnight + 8 * 3_600_000);
    await addGhost(db, 'T14', 'R1', holdoutMidnight + 14 * 3_600_000);

    const r = await computeGhostForecastBacktest(db);
    assert.equal(r.runnable, true);
    const b = r as BacktestRunnable;
    assert.equal(b.holdoutYmd, holdoutYmd);
    assert.equal(b.trainWindowDays, 14);
    assert.equal(b.truePositives, 4, 'flagged cell: 4 of 10 departures actually ghosted');
    assert.equal(b.falsePositives, 6, 'flagged cell: 6 of 10 departures did not ghost');
    assert.equal(b.falseNegatives, 1, 'unflagged HOL cell: its one ghost was missed');
    assert.equal(b.trueNegatives, 0, 'unflagged HOL cell had no non-ghosting departures');
    assert.equal(b.totalDue, 11);
    assert.equal(b.baseRate, 5 / 11);
    assert.equal(b.precision, 0.4, '4 of the 10 flagged departures actually ghosted');
    assert.equal(b.recall, 0.8, '4 of the 5 actual ghosts were flagged');
    assert.equal(b.inconsistentCells, 0);
  } finally { await db.close(); }
});

// ---------------------------------------------------------------------------------------
// Section 2: Honest-ETA within-sample calibration
// ---------------------------------------------------------------------------------------

interface ObsOpts { routeId?: string; how?: number }
async function insertCalObs(db: Db, delayS: number, tripId: string, o: ObsOpts = {}): Promise<void> {
  await db.query(
    `INSERT INTO trip_delay_obs
       (agency, route_id, stop_id, trip_id, hour_of_week, delay_s, service_date, method, confidence, xwalk_conf)
     VALUES ('ttc',$1,'S',$2,$3,$4,20260715,'sched_diff','high',0.9)`,
    [o.routeId ?? 'R1', tripId, o.how ?? 8, delayS]);
}

test('calibration: fewer than 500 qualifying observations -> thin data with the real count', async () => {
  const db = await freshDb();
  try {
    for (let i = 0; i < 10; i++) await insertCalObs(db, 100, `T${i}`);
    const r = await computeEtaCalibration(db);
    assert.equal(r.runnable, false);
    if (!r.runnable) assert.equal(r.totalObs, 10);
  } finally { await db.close(); }
});

test('calibration: exact coverage math on a hand-computed fixture', async () => {
  const db = await freshDb();
  try {
    // Bucket A ('RA', hour 5): 480 observations, all delay=100 -> P25=P50=P75=100 by
    // construction, so every single one falls inside its own band. Covered = 480.
    for (let i = 0; i < 480; i++) await insertCalObs(db, 100, `A${i}`, { routeId: 'RA', how: 5 });

    // Bucket B ('RB', hour 6): 20 observations, an arithmetic sequence 0..380 step 20.
    const bDelays = Array.from({ length: 20 }, (_, i) => i * 20);
    for (let i = 0; i < bDelays.length; i++) await insertCalObs(db, bDelays[i], `B${i}`, { routeId: 'RB', how: 6 });
    // Independently derived expectation, using the SAME percentileCont the estimator ships
    // (unit-tested elsewhere) — this is the "hand computation" the fixture is checked against.
    const p25 = percentileCont(bDelays, 0.25) as number;
    const p75 = percentileCont(bDelays, 0.75) as number;
    assert.equal(p25, 95);
    assert.equal(p75, 285);
    const expectedCoveredB = bDelays.filter((d) => d >= p25 && d <= p75).length;
    assert.equal(expectedCoveredB, 10);

    // Bucket C ('RC', hour 7): only 5 observations — below ROUTE_HOUR_MIN_N (20), so it
    // must be excluded from the coverage stat entirely even though it pads totalObs.
    for (let i = 0; i < 5; i++) await insertCalObs(db, 999, `C${i}`, { routeId: 'RC', how: 7 });

    const r = await computeEtaCalibration(db);
    assert.equal(r.runnable, true);
    const c = r as CalibrationRunnable;
    assert.equal(c.totalObs, 505, 'all qualifying rows, including the sub-threshold bucket');
    assert.equal(c.bucketsConsidered, 2, 'bucket C (n=5) does not clear ROUTE_HOUR_MIN_N');
    assert.equal(c.obsInBuckets, 500, '480 + 20, bucket C excluded');
    assert.equal(c.covered, 480 + expectedCoveredB);
    assert.equal(c.coverage, (480 + expectedCoveredB) / 500);
    assert.equal(c.windowDays, 14);
  } finally { await db.close(); }
});

test('calibration: CALIBRATION_MIN_OBS / BACKTEST thresholds are the ones documented in the output', () => {
  // Pins the constants the report text quotes, so a change to either silently breaks the
  // printed "meaningful"/"thin data" thresholds without a test noticing.
  assert.equal(CALIBRATION_MIN_OBS, 500);
  assert.equal(BACKTEST_MIN_QUALIFYING_DAYS, 2);
  assert.equal(BACKTEST_MIN_EVENTS_PER_DAY, 5);
});
