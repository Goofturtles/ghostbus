// These run against a real in-memory Postgres (PGlite), not a mock, so the SQL filter
// under test is the SQL that ships. No network, no fixture files, no wall-clock coupling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { runAggregation } from './aggregate.ts';
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
    async query(sql, params) { return norm(await pg.query(sql, params as unknown[])) as Result<never>; },
    async transaction(fn) {
      return await pg.transaction(async (tx) => fn({
        async query(sql, params) { return norm(await tx.query(sql, params as unknown[])) as Result<never>; },
      } as Queryable));
    },
    async close() { await pg.close(); },
  };
  await db.query(`CREATE TABLE trip_delay_obs (
    agency TEXT NOT NULL, route_id TEXT, stop_id TEXT, trip_id TEXT, static_trip_id TEXT,
    stop_sequence INTEGER, hour_of_week SMALLINT, delay_s INTEGER, service_date INTEGER NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(), method TEXT, source TEXT, confidence TEXT,
    xwalk_conf DOUBLE PRECISION, sched_epoch_s BIGINT, event_epoch_s BIGINT)`);
  await db.query(`CREATE TABLE agg_delay (agency TEXT, route_id TEXT, stop_id TEXT,
    hour_of_week SMALLINT, n INTEGER, p25 INTEGER, p50 INTEGER, p75 INTEGER,
    updated TIMESTAMPTZ, n_trips INTEGER)`);
  await db.query(`CREATE TABLE agg_delay_route (agency TEXT, route_id TEXT,
    hour_of_week SMALLINT, n INTEGER, p25 INTEGER, p50 INTEGER, p75 INTEGER,
    updated TIMESTAMPTZ, n_trips INTEGER)`);
  return db;
}

interface ObsOpts {
  method?: string; confidence?: string; xwalkConf?: number;
  staticTripId?: string; routeId?: string; stopId?: string; how?: number;
}
async function insertObs(db: Db, delayS: number, o: ObsOpts = {}): Promise<void> {
  await db.query(
    `INSERT INTO trip_delay_obs
       (agency, route_id, stop_id, trip_id, static_trip_id, hour_of_week, delay_s, service_date,
        method, confidence, xwalk_conf)
     VALUES ('ttc',$1,$2,'rt',$3,$4,$5,20260803,$6,$7,$8)`,
    [o.routeId ?? 'R', o.stopId ?? 'S', o.staticTripId ?? 'T1', o.how ?? 9, delayS,
      o.method ?? 'sched_diff', o.confidence ?? 'high', o.xwalkConf ?? 0.9]);
}

test('THE ONE-LINE OMISSION: 1,000 legacy zero rows must not touch the percentiles', async () => {
  const db = await freshDb();
  try {
    // Exactly the situation that shipped: a table dominated by rows recording a protobuf
    // default as a measurement. Every one of them is 0.
    for (let i = 0; i < 1000; i++) await insertObs(db, 0, { method: 'legacy_feed_delay_zero', confidence: null as unknown as string });
    // …and a small number of genuine schedule-difference measurements, 60..300 s late.
    const real = [60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 255, 270, 285, 300, 90, 150, 210];
    for (let i = 0; i < real.length; i++) await insertObs(db, real[i], { staticTripId: `T${i % 5}` });

    const r = await runAggregation(db);
    assert.equal(r.obsConsidered, 20, 'only the real rows are even read');

    const agg = await db.query<{ n: number; p50: number; p25: number; p75: number; n_trips: number }>(
      'SELECT n, p25, p50, p75, n_trips FROM agg_delay');
    assert.equal(agg.rows.length, 1);
    const row = agg.rows[0];
    assert.equal(Number(row.n), 20);
    // Drawn only from the 20 — identical to the percentile of the real set computed
    // independently, and nowhere near 0.
    assert.equal(Number(row.p50), Math.round(percentileCont(real, 0.5) as number));
    assert.equal(Number(row.p25), Math.round(percentileCont(real, 0.25) as number));
    assert.equal(Number(row.p75), Math.round(percentileCont(real, 0.75) as number));
    assert.ok(Number(row.p25) > 0 && Number(row.p75) > 0, 'no percentile is dragged to zero');
    // With the filter omitted, n would be 1020 and p50 would be 0 — the app would look
    // confidently punctual. This assertion is the tripwire.
    assert.notEqual(Number(row.n), 1020);
    assert.notEqual(Number(row.p50), 0);
  } finally { await db.close(); }
});

test('n_trips counts DISTINCT static trips, not observations', async () => {
  const db = await freshDb();
  try {
    // 10 observations, but all of them from a single very late bus.
    for (let i = 0; i < 10; i++) await insertObs(db, 600 + i, { staticTripId: 'ONE_BUS' });
    const r = await runAggregation(db);
    assert.equal(r.obsConsidered, 10);
    const agg = await db.query<{ n: number; n_trips: number }>('SELECT n, n_trips FROM agg_delay');
    assert.equal(Number(agg.rows[0].n), 10);
    assert.equal(Number(agg.rows[0].n_trips), 1, 'ten readings of one bus is one bus');
    const rt = await db.query<{ n_trips: number }>('SELECT n_trips FROM agg_delay_route');
    assert.equal(Number(rt.rows[0].n_trips), 1);
  } finally { await db.close(); }
});

test('low-confidence rows are excluded from the aggregates', async () => {
  const db = await freshDb();
  try {
    for (let i = 0; i < 10; i++) await insertObs(db, 1000, { confidence: 'low', staticTripId: `L${i}` });
    for (let i = 0; i < 4; i++) await insertObs(db, 100, { confidence: 'high', staticTripId: `H${i}` });
    const r = await runAggregation(db);
    assert.equal(r.obsConsidered, 4);
    const agg = await db.query<{ n: number; p50: number }>('SELECT n, p50 FROM agg_delay');
    assert.equal(Number(agg.rows[0].n), 4);
    assert.equal(Number(agg.rows[0].p50), 100, 'the low-confidence 1000s are nowhere in this number');
  } finally { await db.close(); }
});

test('rows whose stop crosswalk is not confident enough are excluded', async () => {
  const db = await freshDb();
  try {
    for (let i = 0; i < 8; i++) await insertObs(db, 900, { xwalkConf: 0.55, staticTripId: `W${i}` });
    for (let i = 0; i < 3; i++) await insertObs(db, 120, { xwalkConf: 0.60, staticTripId: `G${i}` });
    const r = await runAggregation(db);
    assert.equal(r.obsConsidered, 3, '0.60 is inclusive, 0.55 is not');
    const agg = await db.query<{ p50: number }>('SELECT p50 FROM agg_delay');
    assert.equal(Number(agg.rows[0].p50), 120);
  } finally { await db.close(); }
});

test('with no qualifying rows at all the aggregates are EMPTY, not zero', async () => {
  const db = await freshDb();
  try {
    // This is today's real state: legacy rows only, nothing the engine has measured.
    for (let i = 0; i < 50; i++) await insertObs(db, 0, { method: 'legacy_feed_delay_zero' });
    const r = await runAggregation(db);
    assert.equal(r.obsConsidered, 0);
    assert.equal(r.stopHourRows, 0);
    const agg = await db.query('SELECT * FROM agg_delay');
    assert.equal(agg.rows.length, 0, 'an empty table means the UI must say "no evidence", not "0 min"');
  } finally { await db.close(); }
});

test('negative delays survive aggregation — early buses are real measurements', async () => {
  const db = await freshDb();
  try {
    for (const d of [-120, -60, -30, 0, 30, 60, 120]) await insertObs(db, d, { staticTripId: `E${d}` });
    await runAggregation(db);
    const agg = await db.query<{ p25: number; p50: number }>('SELECT p25, p50 FROM agg_delay');
    assert.equal(Number(agg.rows[0].p50), 0);
    assert.ok(Number(agg.rows[0].p25) < 0, 'the distribution is not floored at zero');
  } finally { await db.close(); }
});
