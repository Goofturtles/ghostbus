// seed:toronto — discover the TTC static GTFS feed at runtime via Toronto Open
// Data (CKAN), download + extract it, and load it into the database.
//
// GTFS times are stored as seconds-past-service-midnight INTEGERS so 25:30:00
// stays valid.
//
// ---------------------------------------------------------------------------
// WINDOW SEMANTICS — one window, and the board defines it
// ---------------------------------------------------------------------------
// `trips`, `stop_times` and `shapes` are loaded for every service the loaded
// calendar can activate. That set is derived from the board's OWN validity span
// — min(start_date)..max(end_date) across calendar.txt, widened by any
// calendar_dates exception date outside it — replayed day by day through the
// same `activeServiceIds` resolution the runtime uses. `routes`, `stops`,
// `calendar`, `calendar_dates` and `cities` are loaded in full, as before.
//
// This used to be a rolling N-day window measured from the SEED DATE
// (GHOSTBUS_SEED_WINDOW_DAYS, default 7) while calendar/calendar_dates were
// loaded whole: two different windows over one dataset, so the calendar could
// declare a service active on a date whose trips had never been loaded. On the
// 2026-07-26..2026-09-05 board that emptied 7 of 42 days — the six Saturdays
// (service `2`, 32,874 trips) and the 2026-08-03 civic holiday (service `4`,
// 31,295 trips, with the weekday service switched off by calendar_dates) — and
// those days rendered exactly like flawless service days. The env var is gone;
// deriving the filter from the board costs +27 s and +2.0M rows, once. See
// DECISIONS.md §43 / BLOCKERS.md entry 9.
//
// Escape hatches, both diagnostic:
//   GHOSTBUS_SEED_FULL=1          load every row unfiltered, including services
//                                 the calendar never activates (1,112 dead trips
//                                 in this feed: 6702/6703/6704).
//   GHOSTBUS_SEED_SKIP_DOWNLOAD=1 reuse the already-extracted feed in
//                                 .data/gtfs/extracted instead of re-downloading,
//                                 so a re-seed provably loads the same board a
//                                 running server is already observing.

import AdmZip from 'adm-zip';
import { parse } from 'csv-parse';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, type Db, type Queryable } from './db.ts';
import {
  parseGtfsTime,
  activeServiceIds,
  type CalendarRow,
  type CalendarDateRow,
  type WindowDay,
} from './gtfs.ts';
import { torontoMidnightEpoch, torontoDay } from './tz.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(ROOT, '.data', 'gtfs');
const EXTRACT_DIR = join(DATA_DIR, 'extracted');
const ZIP_PATH = join(DATA_DIR, 'opendata_ttc_schedules.zip');

const AGENCY = 'ttc';
const CKAN_URL =
  'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules';
const FULL = process.env.GHOSTBUS_SEED_FULL === '1';
const SKIP_DOWNLOAD = process.env.GHOSTBUS_SEED_SKIP_DOWNLOAD === '1';
const BATCH_SIZE = 1000; // rows per INSERT statement
const COMMIT_EVERY = 40_000; // rows per transaction

// ---------- small value coercers ----------
const intOrNull = (v: string | undefined): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};
const floatOrNull = (v: string | undefined): number | null => {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
};
const textOrNull = (v: string | undefined): string | null => {
  if (v == null) return null;
  const t = v.trim();
  return t === '' ? null : t;
};
const flag = (v: string | undefined): boolean => v === '1';

// Malformed rows are skipped and counted, never silently dropped or defaulted.
interface Skip { n: number; sample: string | null }
const newSkip = (): Skip => ({ n: 0, sample: null });
function record(skip: Skip, why: string): void {
  skip.n++;
  if (skip.sample === null) skip.sample = why;
}

// ---------- fetch with timeout ----------
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- CSV streaming ----------
async function* readCsv(path: string): AsyncGenerator<Record<string, string>> {
  const parser = createReadStream(path).pipe(
    parse({ columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true }),
  );
  for await (const rec of parser) yield rec as Record<string, string>;
}

// ---------- INSERT builder ----------
function buildInsert(
  table: string,
  columns: string[],
  rows: unknown[][],
  casts?: Record<number, string>,
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const tuples: string[] = [];
  let p = 1;
  for (const row of rows) {
    const placeholders: string[] = [];
    for (let c = 0; c < columns.length; c++) {
      let ph = `$${p++}`;
      if (casts && casts[c]) ph += casts[c];
      placeholders.push(ph);
      values.push(row[c]);
    }
    tuples.push(`(${placeholders.join(',')})`);
  }
  return { text: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')}`, values };
}

// ---------- truncate + chunked, batched load ----------
async function chunkedLoad(
  db: Db,
  table: string,
  columns: string[],
  source: AsyncIterable<unknown[]>,
  opts: { casts?: Record<number, string>; label: string },
): Promise<number> {
  await db.query(`TRUNCATE ${table}`);
  const it = source[Symbol.asyncIterator]();
  const t0 = Date.now();
  let total = 0;
  let done = false;
  while (!done) {
    const chunk: unknown[][] = [];
    while (chunk.length < COMMIT_EVERY) {
      const n = await it.next();
      if (n.done) { done = true; break; }
      chunk.push(n.value);
    }
    if (chunk.length === 0) break;
    await db.transaction(async (tx: Queryable) => {
      for (let i = 0; i < chunk.length; i += BATCH_SIZE) {
        const slice = chunk.slice(i, i + BATCH_SIZE);
        const { text, values } = buildInsert(table, columns, slice, opts.casts);
        await tx.query(text, values);
      }
    });
    total += chunk.length;
    console.log(`  [${opts.label}] ${total.toLocaleString()} rows (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  return total;
}

async function* fromArray(rows: unknown[][]): AsyncGenerator<unknown[]> {
  for (const r of rows) yield r;
}

// ---------- window: derived from the loaded board, never from the clock ----------

// A GTFS board is weeks long. This only exists so a malformed date in calendar.txt
// cannot turn the enumeration below into a hang.
const MAX_BOARD_DAYS = 800;

/**
 * Every calendar date the loaded board can speak about: min(start_date)..max(end_date)
 * across `calendar`, widened by any `calendar_dates` exception date outside that span
 * (a feed may add or remove a service on a date no calendar row covers).
 *
 * Days are sampled at Toronto local noon so a DST transition can never shift one onto
 * its neighbour. Pure: the result depends on the feed alone, never on the seed date —
 * that independence is the whole point, and `seed_toronto.test.ts` asserts it.
 */
export function boardDays(calendar: CalendarRow[], calendarDates: CalendarDateRow[]): WindowDay[] {
  let first = Infinity;
  let last = -Infinity;
  const see = (ymd: number): void => {
    // A blank date column parses as 0, not NaN. Ignore anything outside a plausible
    // GTFS date rather than letting one empty cell drag the span back to 1899.
    if (!Number.isFinite(ymd) || ymd < 19700101 || ymd > 21001231) return;
    if (ymd < first) first = ymd;
    if (ymd > last) last = ymd;
  };
  for (const c of calendar) { see(c.start_date); see(c.end_date); }
  for (const d of calendarDates) see(d.date);
  if (first === Infinity) {
    throw new Error('GTFS calendar/calendar_dates carry no usable dates — cannot derive the board span.');
  }

  const midnight = torontoMidnightEpoch(Math.floor(first / 10000), Math.floor(first / 100) % 100, first % 100);
  const out: WindowDay[] = [];
  for (let i = 0; ; i++) {
    const day = torontoDay(midnight + i * 86_400_000 + 12 * 3_600_000);
    if (day.ymd > last) break;
    out.push(day);
    if (out.length > MAX_BOARD_DAYS) {
      throw new Error(`GTFS board span ${first}..${last} exceeds ${MAX_BOARD_DAYS} days — refusing to enumerate it; the feed's calendar dates look wrong.`);
    }
  }
  // Empty means `first` was a well-formed number but not a real date (e.g. 20260231,
  // which rolls forward past `last` on the first step). Say so here rather than let a
  // caller trip over days[0].
  if (out.length === 0) {
    throw new Error(`GTFS board span ${first}..${last} enumerates to zero days — the feed's calendar dates are not real dates.`);
  }
  return out;
}

// ---------- discovery + download ----------
async function discoverZipUrl(): Promise<string> {
  const res = await fetchWithTimeout(CKAN_URL, 30_000);
  if (!res.ok) throw new Error(`CKAN package_show HTTP ${res.status}`);
  const data = (await res.json()) as { result?: { resources?: Array<{ format?: string; url?: string; name?: string }> } };
  const resources = data.result?.resources ?? [];
  const zip = resources.find((r) => String(r.format).toUpperCase() === 'ZIP' && r.url);
  if (!zip?.url) throw new Error('CKAN package has no ZIP resource with a URL');
  return zip.url;
}

async function downloadAndExtract(zipUrl: string): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const res = await fetchWithTimeout(zipUrl, 180_000);
  if (!res.ok) throw new Error(`GTFS zip download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error(`GTFS zip suspiciously small (${buf.length} bytes)`);
  await writeFile(ZIP_PATH, buf);
  console.log(`  downloaded ${(buf.length / 1_048_576).toFixed(1)} MB -> ${ZIP_PATH}`);
  if (existsSync(EXTRACT_DIR)) await rm(EXTRACT_DIR, { recursive: true, force: true });
  await mkdir(EXTRACT_DIR, { recursive: true });
  new AdmZip(ZIP_PATH).extractAllTo(EXTRACT_DIR, true);
  console.log(`  extracted GTFS text files -> ${EXTRACT_DIR}`);
}

function entry(name: string): string {
  return join(EXTRACT_DIR, name);
}

// Fail loudly with a clean message if the feed is missing a file we must have.
function assertRequiredEntries(): void {
  const required = ['calendar.txt', 'routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt'];
  const missing = required.filter((f) => !existsSync(entry(f)));
  if (missing.length > 0) {
    throw new Error(`GTFS feed is missing required file(s): ${missing.join(', ')} — the TTC zip layout may have changed.`);
  }
}

// ---------- table loaders ----------
async function loadCalendar(): Promise<CalendarRow[]> {
  const rows: CalendarRow[] = [];
  if (!existsSync(entry('calendar.txt'))) return rows;
  for await (const r of readCsv(entry('calendar.txt'))) {
    rows.push({
      service_id: r.service_id,
      days: [flag(r.monday), flag(r.tuesday), flag(r.wednesday), flag(r.thursday), flag(r.friday), flag(r.saturday), flag(r.sunday)],
      start_date: Number(r.start_date),
      end_date: Number(r.end_date),
    });
  }
  return rows;
}

async function loadCalendarDates(): Promise<CalendarDateRow[]> {
  const rows: CalendarDateRow[] = [];
  if (!existsSync(entry('calendar_dates.txt'))) return rows;
  for await (const r of readCsv(entry('calendar_dates.txt'))) {
    rows.push({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) });
  }
  return rows;
}

async function* routeRows(skip: Skip): AsyncGenerator<unknown[]> {
  for await (const r of readCsv(entry('routes.txt'))) {
    if (!r.route_id) { record(skip, 'missing route_id'); continue; }
    yield [AGENCY, r.route_id, textOrNull(r.route_short_name), textOrNull(r.route_long_name), intOrNull(r.route_type), textOrNull(r.route_color)];
  }
}

interface Bbox { minLat: number; minLon: number; maxLat: number; maxLon: number }
async function* stopRows(bbox: Bbox, skip: Skip): AsyncGenerator<unknown[]> {
  for await (const r of readCsv(entry('stops.txt'))) {
    if (!r.stop_id) { record(skip, 'missing stop_id'); continue; }
    const lat = floatOrNull(r.stop_lat);
    const lon = floatOrNull(r.stop_lon);
    if (lat !== null && lon !== null) {
      if (lat < bbox.minLat) bbox.minLat = lat;
      if (lat > bbox.maxLat) bbox.maxLat = lat;
      if (lon < bbox.minLon) bbox.minLon = lon;
      if (lon > bbox.maxLon) bbox.maxLon = lon;
    }
    yield [AGENCY, r.stop_id, textOrNull(r.stop_name), lat, lon, intOrNull(r.wheelchair_boarding)];
  }
}

async function* tripRows(active: Set<string>, outTrips: Set<string>, outShapes: Set<string>, skip: Skip): AsyncGenerator<unknown[]> {
  for await (const r of readCsv(entry('trips.txt'))) {
    if (!FULL && !active.has(r.service_id)) continue; // filtered by window, not malformed
    if (!r.trip_id) { record(skip, 'missing trip_id'); continue; }
    outTrips.add(r.trip_id);
    if (r.shape_id) outShapes.add(r.shape_id);
    yield [AGENCY, r.trip_id, textOrNull(r.route_id), textOrNull(r.service_id), textOrNull(r.trip_headsign), intOrNull(r.direction_id), textOrNull(r.shape_id), intOrNull(r.wheelchair_accessible)];
  }
}

async function* stopTimeRows(activeTrips: Set<string>, skip: Skip): AsyncGenerator<unknown[]> {
  for await (const r of readCsv(entry('stop_times.txt'))) {
    if (!FULL && !activeTrips.has(r.trip_id)) continue; // filtered by window, not malformed
    const seq = intOrNull(r.stop_sequence);
    if (!r.trip_id || !r.stop_id || seq === null) {
      record(skip, `bad stop_time (trip=${r.trip_id ?? ''} stop=${r.stop_id ?? ''} seq=${r.stop_sequence ?? ''})`);
      continue;
    }
    yield [AGENCY, r.trip_id, seq, r.stop_id, parseGtfsTime(r.arrival_time), parseGtfsTime(r.departure_time)];
  }
}

async function collectShapes(activeShapes: Set<string>): Promise<Map<string, [number, number][]>> {
  const acc = new Map<string, { seq: number; lat: number; lon: number }[]>();
  if (!existsSync(entry('shapes.txt'))) return new Map();
  for await (const r of readCsv(entry('shapes.txt'))) {
    if (!FULL && !activeShapes.has(r.shape_id)) continue;
    let arr = acc.get(r.shape_id);
    if (!arr) { arr = []; acc.set(r.shape_id, arr); }
    arr.push({ seq: Number(r.shape_pt_sequence), lat: Number(r.shape_pt_lat), lon: Number(r.shape_pt_lon) });
  }
  const out = new Map<string, [number, number][]>();
  for (const [id, pts] of acc) {
    pts.sort((a, b) => a.seq - b.seq);
    out.set(id, pts.map((p) => [p.lat, p.lon]));
  }
  return out;
}

async function count(db: Db, table: string): Promise<number> {
  const r = await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`);
  return Number(r.rows[0].n);
}

async function main(): Promise<void> {
  const started = Date.now();
  const db = await getDb();
  console.log(`GhostBus seed:toronto — driver=${db.driver}, filter=${FULL ? 'FULL feed' : 'board span'}`);

  if (SKIP_DOWNLOAD) {
    if (!existsSync(entry('calendar.txt'))) {
      throw new Error(`GHOSTBUS_SEED_SKIP_DOWNLOAD=1 but there is no extracted feed at ${EXTRACT_DIR} — run the seed once without it first.`);
    }
    console.log('1/8 GHOSTBUS_SEED_SKIP_DOWNLOAD=1 — reusing the extracted feed already on disk…');
    console.log(`  source: ${EXTRACT_DIR}`);
  } else {
    console.log('1/8 discovering GTFS feed via CKAN…');
    const zipUrl = await discoverZipUrl();
    console.log(`  resource: ${zipUrl}`);
    await downloadAndExtract(zipUrl);
  }
  assertRequiredEntries();

  console.log('2/8 calendar + calendar_dates…');
  const calendar = await loadCalendar();
  const calendarDates = await loadCalendarDates();
  // The window comes from the board we just read, so the calendar we load and the
  // trips we load are the same window by construction.
  const days = boardDays(calendar, calendarDates);
  const active = activeServiceIds(calendar, calendarDates, days);
  console.log(`  board span: ${days[0].ymd}..${days[days.length - 1].ymd} (${days.length} days)`);
  console.log(`  ${calendar.length} calendar rows, ${calendarDates.length} calendar_dates rows, ${active.size} active service_ids`);
  const nCalendar = await chunkedLoad(
    db, 'calendar',
    ['agency', 'service_id', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'start_date', 'end_date'],
    fromArray(calendar.map((c) => [AGENCY, c.service_id, ...c.days, c.start_date, c.end_date])),
    { label: 'calendar' },
  );
  const nCalendarDates = await chunkedLoad(
    db, 'calendar_dates',
    ['agency', 'service_id', 'date', 'exception_type'],
    fromArray(calendarDates.map((c) => [AGENCY, c.service_id, c.date, c.exception_type])),
    { label: 'calendar_dates' },
  );

  const skips = { routes: newSkip(), stops: newSkip(), trips: newSkip(), stopTimes: newSkip() };
  const logSkips = (label: string, s: Skip): void => {
    if (s.n > 0) console.log(`  [${label}] skipped ${s.n} malformed row(s); first: ${s.sample}`);
  };

  console.log('3/8 routes…');
  const nRoutes = await chunkedLoad(db, 'routes', ['agency', 'route_id', 'short_name', 'long_name', 'route_type', 'color'], routeRows(skips.routes), { label: 'routes' });
  logSkips('routes', skips.routes);

  console.log('4/8 stops…');
  const bbox: Bbox = { minLat: Infinity, minLon: Infinity, maxLat: -Infinity, maxLon: -Infinity };
  const nStops = await chunkedLoad(db, 'stops', ['agency', 'stop_id', 'name', 'lat', 'lon', 'wheelchair_boarding'], stopRows(bbox, skips.stops), { label: 'stops' });
  logSkips('stops', skips.stops);

  console.log('5/8 trips…');
  const activeTrips = new Set<string>();
  const activeShapes = new Set<string>();
  const nTrips = await chunkedLoad(db, 'trips', ['agency', 'trip_id', 'route_id', 'service_id', 'headsign', 'direction_id', 'shape_id', 'wheelchair_accessible'], tripRows(active, activeTrips, activeShapes, skips.trips), { label: 'trips' });
  logSkips('trips', skips.trips);
  console.log(`  ${activeTrips.size} trip_ids / ${activeShapes.size} shape_ids in scope`);

  // The check this seeder did not have, and the reason 7 of 42 days used to load empty:
  // every service the calendar can activate must own at least one trip. A miss here is a
  // hole in the board, so name it — never let it pass as a quiet zero.
  const perService = await db.query<{ service_id: string; n: string }>(
    `SELECT service_id, COUNT(*)::text AS n FROM trips WHERE agency=$1 GROUP BY service_id`,
    [AGENCY],
  );
  const loadedServices = new Set(perService.rows.map((r) => r.service_id));
  const emptyActive = [...active].filter((s) => !loadedServices.has(s)).sort();
  if (emptyActive.length > 0) {
    const blankDays = days.filter((d) => {
      const on = activeServiceIds(calendar, calendarDates, [d]);
      return on.size > 0 && [...on].every((s) => !loadedServices.has(s));
    });
    console.log(`  !! WARNING: service_id(s) ${emptyActive.join(', ')} are calendar-active on this board but have ZERO trips.`);
    console.log(`  !! ${blankDays.length} board day(s) would hold no schedule at all${blankDays.length ? `: ${blankDays.map((d) => d.ymd).join(', ')}` : ''}`);
    console.log('  !! The feed itself is short of trips for those services — the engine will gate those dates (boardIntegrity).');
  } else {
    console.log(`  integrity: all ${active.size} calendar-active service_id(s) have trips loaded`);
  }

  console.log('6/8 stop_times…');
  const nStopTimes = await chunkedLoad(db, 'stop_times', ['agency', 'trip_id', 'stop_sequence', 'stop_id', 'arrival_s', 'departure_s'], stopTimeRows(activeTrips, skips.stopTimes), { label: 'stop_times' });
  logSkips('stop_times', skips.stopTimes);

  console.log('7/8 shapes…');
  const shapeMap = await collectShapes(activeShapes);
  const shapeArrayRows: unknown[][] = [];
  for (const [id, pts] of shapeMap) shapeArrayRows.push([AGENCY, id, JSON.stringify(pts)]);
  const nShapes = await chunkedLoad(db, 'shapes', ['agency', 'shape_id', 'points'], fromArray(shapeArrayRows), { casts: { 2: '::jsonb' }, label: 'shapes' });

  console.log('8/8 city bounding box…');
  if (Number.isFinite(bbox.minLat)) {
    await db.query(
      `UPDATE cities SET min_lat=$1, min_lon=$2, max_lat=$3, max_lon=$4 WHERE agency=$5`,
      [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon, AGENCY],
    );
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log('\n================ SEED COMPLETE ================');
  console.log(`driver           : ${db.driver}`);
  console.log(`elapsed          : ${secs}s`);
  console.log(`window           : ${FULL ? 'FULL feed (filter disabled)' : `board span ${days[0].ymd}..${days[days.length - 1].ymd} (${days.length} days)`}`);
  console.log('--- row counts (from DB) ---');
  console.log(`cities           : ${await count(db, 'cities')}`);
  console.log(`routes           : ${nRoutes}`);
  console.log(`stops            : ${nStops}`);
  console.log(`trips            : ${nTrips}`);
  console.log(`stop_times       : ${nStopTimes}`);
  console.log(`shapes           : ${nShapes}`);
  console.log(`calendar         : ${nCalendar}`);
  console.log(`calendar_dates   : ${nCalendarDates}`);
  console.log(`bbox             : [${bbox.minLat.toFixed(4)}, ${bbox.minLon.toFixed(4)}] .. [${bbox.maxLat.toFixed(4)}, ${bbox.maxLon.toFixed(4)}]`);
  console.log('===============================================');

  await db.close();
}

// Seed only when run directly (`npm run seed:toronto`), so `seed_toronto.test.ts` can
// import the window derivation without touching a database. Path comparison, not URL
// comparison, matching aggregate.ts and record_demo.ts: it is not tripped up by Windows
// drive-letter casing.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error('seed:toronto FAILED:', e);
    process.exit(1);
  });
}
