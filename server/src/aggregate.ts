// aggregate â€” recompute the delay aggregates the Honest-ETA endpoint reads from.
//
//   agg_delay        : (agency, route_id, stop_id, hour_of_week) -> n, p25, p50, p75
//   agg_delay_route  : (agency, route_id, hour_of_week)          -> n, p25, p50, p75   (fallback rollup)
//
// Computed from trip_delay_obs over a trailing 14-day window. Percentiles are computed
// in JS (percentileCont, matching Postgres percentile_cont) so the numbers are byte-for-
// byte identical on the pg and PGlite drivers â€” see the driver verification logged at
// the top of a run. Each table is rebuilt atomically inside a transaction so a reader
// never sees a half-written aggregate.
//
// Runs on API boot and hourly in-process (server.ts), and standalone via `npm run aggregate`.

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { getDb, type Db, type Queryable } from './db.ts';
import { percentiles } from './eta.ts';

const AGENCY = 'ttc';
// The trailing window aggregates are computed over. Exported so the arrivals endpoint
// reports the SAME windowDays in every evidence object (metadata must not drift).
export const WINDOW_DAYS = 14;
// Group-key delimiter: U+001F (unit separator) never appears in a GTFS id, so composite
// keys can't collide and we never split an id back apart.
const SEP = String.fromCharCode(31);

export interface AggregateResult {
  stopHourRows: number;
  routeHourRows: number;
  obsConsidered: number;
  windowDays: number;
  percentileContSupported: boolean;
  elapsedMs: number;
}

/** Probe whether the driver supports percentile_cont (informational; we use JS math). */
async function percentileContSupported(db: Db): Promise<boolean> {
  try {
    const r = await db.query<{ p: number }>(
      'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY x)::double precision AS p FROM (VALUES (10),(20),(30),(40)) t(x)');
    return Number(r.rows[0]?.p) === 25;
  } catch {
    return false;
  }
}

async function insertAgg(tx: Queryable, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const row of slice) {
      const ph: string[] = [];
      for (let c = 0; c < columns.length; c++) { ph.push(`$${p++}`); values.push(row[c]); }
      tuples.push(`(${ph.join(',')})`);
    }
    await tx.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values);
  }
}

export async function runAggregation(db: Db): Promise<AggregateResult> {
  const t0 = Date.now();
  const supported = await percentileContSupported(db);

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  const obs = await db.query<{ route_id: string; stop_id: string; hour_of_week: number; delay_s: number }>(
    `SELECT route_id, stop_id, hour_of_week, delay_s FROM trip_delay_obs
     WHERE agency=$1 AND ts >= $2 AND delay_s IS NOT NULL AND route_id IS NOT NULL AND stop_id IS NOT NULL AND hour_of_week IS NOT NULL`,
    [AGENCY, cutoff]);

  // Group by composite key but carry the parsed components in the value, so we never
  // split the key back apart (a route_id/stop_id with an odd character can't misparse).
  interface StopGroup { routeId: string; stopId: string; how: number; delays: number[] }
  interface RouteGroup { routeId: string; how: number; delays: number[] }
  const stopHour = new Map<string, StopGroup>();
  const routeHour = new Map<string, RouteGroup>();
  for (const r of obs.rows) {
    const d = Number(r.delay_s);
    const how = Number(r.hour_of_week);
    const shKey = `${r.route_id}${SEP}${r.stop_id}${SEP}${how}`;
    let sh = stopHour.get(shKey);
    if (!sh) { sh = { routeId: r.route_id, stopId: r.stop_id, how, delays: [] }; stopHour.set(shKey, sh); }
    sh.delays.push(d);
    const rhKey = `${r.route_id}${SEP}${how}`;
    let rh = routeHour.get(rhKey);
    if (!rh) { rh = { routeId: r.route_id, how, delays: [] }; routeHour.set(rhKey, rh); }
    rh.delays.push(d);
  }

  const updatedAt = new Date().toISOString();
  const stopHourRows: unknown[][] = [];
  for (const g of stopHour.values()) {
    const pc = percentiles(g.delays);
    if (!pc) continue;
    stopHourRows.push([AGENCY, g.routeId, g.stopId, g.how, g.delays.length, Math.round(pc.p25), Math.round(pc.p50), Math.round(pc.p75), updatedAt]);
  }
  const routeHourRows: unknown[][] = [];
  for (const g of routeHour.values()) {
    const pc = percentiles(g.delays);
    if (!pc) continue;
    routeHourRows.push([AGENCY, g.routeId, g.how, g.delays.length, Math.round(pc.p25), Math.round(pc.p50), Math.round(pc.p75), updatedAt]);
  }

  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM agg_delay WHERE agency=$1', [AGENCY]);
    await insertAgg(tx, 'agg_delay', ['agency', 'route_id', 'stop_id', 'hour_of_week', 'n', 'p25', 'p50', 'p75', 'updated'], stopHourRows);
    await tx.query('DELETE FROM agg_delay_route WHERE agency=$1', [AGENCY]);
    await insertAgg(tx, 'agg_delay_route', ['agency', 'route_id', 'hour_of_week', 'n', 'p25', 'p50', 'p75', 'updated'], routeHourRows);
  });

  return {
    stopHourRows: stopHourRows.length,
    routeHourRows: routeHourRows.length,
    obsConsidered: obs.rows.length,
    windowDays: WINDOW_DAYS,
    percentileContSupported: supported,
    elapsedMs: Date.now() - t0,
  };
}

// ---------- standalone entry (`npm run aggregate`) ----------
async function main(): Promise<void> {
  const db = await getDb();
  console.log(`GhostBus aggregate â€” driver=${db.driver}, window=${WINDOW_DAYS} days`);
  const r = await runAggregation(db);
  console.log(`  percentile_cont supported on ${db.driver}: ${r.percentileContSupported} (aggregates computed in JS for cross-driver determinism)`);
  console.log(`  obs considered: ${r.obsConsidered}`);
  console.log(`  agg_delay rows        : ${r.stopHourRows}`);
  console.log(`  agg_delay_route rows  : ${r.routeHourRows}`);
  console.log(`  elapsed: ${(r.elapsedMs / 1000).toFixed(1)}s`);
  await db.close();
}

// Only run main when invoked directly (npm run aggregate), not when imported by the
// server. Normalize both paths so the check is robust on Windows.
const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error('aggregate FAILED:', e); process.exit(1); });
