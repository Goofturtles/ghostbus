// api — the GhostBus HTTP API (Fastify). Toronto-only, agency 'ttc' internally.
//
// All endpoints return JSON typed in /shared/types.ts. The in-process poller supplies
// live vehicle state + feed health; Postgres supplies the schedule, stops, honest-ETA
// aggregates, and stats. Security: rate-limit + helmet on every route, CORS locked to
// same-origin (localhost dev origins allowed), input validation on every param, and no
// stack traces in error responses.

import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';
import type { PollerHandle } from './poller.ts';
import { parseBbox, pointInBbox } from './bbox.ts';
import { selectEvidence, type Agg } from './eta.ts';
import { WINDOW_DAYS } from './aggregate.ts';
import { activeServiceIds, type CalendarRow, type CalendarDateRow } from './gtfs.ts';
import { torontoDay, torontoMidnightEpoch, hourOfWeek, torontoParts } from './tz.ts';
import type {
  HealthResponse, VehiclesResponse, VehicleDto, StopsResponse, StopDto,
  ArrivalsResponse, DepartureDto, StatsResponse, FeedId,
  RouteShapeResponse, RouteStopDto,
  AlertsResponse, AlertDto, AlertInformedDto,
  GhostFeedResponse, GhostEventDto, GhostKind, GhostCounters,
  TrustGrade, GradeLetter, GhostRisk, EtaBucket,
} from '../../shared/types.ts';

const AGENCY = 'ttc';
const AGENCY_TZ = 'America/Toronto';
const __dirname = dirname(fileURLToPath(import.meta.url));
// Vite builds the SPA to <root>/dist (vite.config.ts `build.outDir: '../dist'` with
// `root: 'web'`). Serve exactly that. `web/dist` is also accepted so a future config
// change — or a `vite build` run from inside web/ — still finds the bundle.
const DIST_CANDIDATES = [
  join(__dirname, '..', '..', 'dist'),
  join(__dirname, '..', '..', 'web', 'dist'),
];

// A missing file must 404, never fall through to the SPA shell. Answering a hashed
// `.js` URL with `200 text/html` is how a dead map hid for a whole phase (DECISIONS §29),
// and the service worker would happily cache that HTML under the immutable asset URL
// forever. Anything that looks like a file gets a real 404; only navigations get the shell.
const ASSET_EXT_RE = /\.(js|mjs|cjs|css|map|json|webmanifest|wasm|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|txt|xml)$/i;

const NEARBY_DEFAULT_RADIUS_M = 600;
const NEARBY_MAX_RADIUS_M = 3000;
const NEARBY_MAX_RESULTS = 50;
const SEARCH_MAX_RESULTS = 25;
const Q_MAX_LEN = 64;
const ARRIVALS_DEFAULT_WINDOW_MIN = 90;
const ARRIVALS_MAX_WINDOW_MIN = 4320; // 3 days — lets the window reach the next service board
const ARRIVALS_MAX_DEPARTURES = 60;
const LIVE_ETA_MAX_SKEW_MS = 10 * 60_000; // only attach live ETAs to a near-"now" query
const AT_FLOOR_MS = Date.parse('2020-01-01T00:00:00Z'); // reject nonsense far-past `at`
const AT_MAX_FUTURE_MS = 30 * 86_400_000;               // reject `at` more than 30 days out
const ALERTS_DEFAULT_LIMIT = 50;
const ALERTS_MAX_LIMIT = 100;
const GHOSTS_DEFAULT_HOURS = 24;
const GHOSTS_MAX_HOURS = 168;    // one week — the counters already cover the week
const GHOSTS_MAX_EVENTS = 200;
const FORECAST_REFRESH_MS = 30 * 60_000; // the denominator query is heavy; twice an hour is plenty

interface RouteMeta { shortName: string | null; longName: string | null; routeType: number | null; color: string | null }

/** Tasteful livery fallback when routes.color is blank, by GTFS route_type. */
function colorFor(meta: RouteMeta | undefined): string {
  const raw = meta?.color?.trim();
  if (raw && /^[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  switch (meta?.routeType) {
    case 0: return 'DA291C';  // streetcar — TTC red
    case 1: return '005DAA';  // subway — TTC blue
    case 2: return '00853F';  // rail — green
    default: return '3C4A5B'; // bus / other — slate
  }
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Douglas–Peucker on [lon, lat] points. epsilon in degrees (~1e-4 ≈ 11 m).
 *  Keeps the route line faithful to the streets while shrinking the payload. */
function simplify(pts: [number, number][], epsilon: number): [number, number][] {
  if (pts.length <= 2) return pts;
  let maxD = 0, idx = 0;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    // perpendicular distance of p from segment a→b (planar; fine at city scale)
    const t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    const cx = ax + Math.max(0, Math.min(1, t)) * dx;
    const cy = ay + Math.max(0, Math.min(1, t)) * dy;
    const d = Math.hypot(px - cx, py - cy);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= epsilon) return [pts[0], pts[pts.length - 1]];
  const left = simplify(pts.slice(0, idx + 1), epsilon);
  const right = simplify(pts.slice(idx), epsilon);
  return left.slice(0, -1).concat(right);
}

// =====================================================================================
// Trust grades — pure, exported, unit-tested (api.test.ts).
// =====================================================================================
//
// A grade answers "how much should I trust this ETA?", and it is derived from exactly
// the two things we actually measured:
//
//   n         — how many historical delay observations back the estimate
//   spreadMin — half the P25..P75 delay spread, in whole minutes (the "± X min" shown)
//
// A grade is the BEST tier whose BOTH thresholds are met, so a wide spread can never be
// bought with sample size and a large sample can never rescue a wide spread. The tiers
// slide from "many observations, tight band" (A) down to "we have evidence but it is
// thin or all over the place" (E):
//
//   A: n >= 40 and spread <=  4 min
//   B: n >= 25 and spread <=  6 min
//   C: n >= 15 and spread <=  9 min
//   D: n >=  8 and spread <= 14 min
//   E: has evidence, meets no tier
//
// n >= 8 is the same floor `selectEvidence` uses for its tightest bucket, so D is the
// weakest grade a stop-hour bucket can earn on sample size alone.
//
// A departure whose evidence bucket is 'none' gets NO grade object at all: the UI shows
// "untracked". We never invent a letter for a departure we have not watched.
export const GRADE_TIERS: ReadonlyArray<{ letter: GradeLetter; minN: number; maxSpreadMin: number }> = [
  { letter: 'A', minN: 40, maxSpreadMin: 4 },
  { letter: 'B', minN: 25, maxSpreadMin: 6 },
  { letter: 'C', minN: 15, maxSpreadMin: 9 },
  { letter: 'D', minN: 8, maxSpreadMin: 14 },
];

/** Half the P25..P75 spread in whole minutes, from percentile *seconds*. Never negative. */
export function spreadMinutes(p25Sec: number, p75Sec: number): number {
  return Math.max(0, Math.round((p75Sec - p25Sec) / 2 / 60));
}

/** The grade for a departure, or null when there is nothing to grade. */
export function gradeFor(bucket: EtaBucket, n: number, spreadMin: number): TrustGrade | null {
  if (bucket === 'none') return null;
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(spreadMin) || spreadMin < 0) return null;
  for (const tier of GRADE_TIERS) {
    if (n >= tier.minN && spreadMin <= tier.maxSpreadMin) return { letter: tier.letter, n, spreadMin };
  }
  return { letter: 'E', n, spreadMin };
}

// =====================================================================================
// Ghost Forecast — pure, exported, unit-tested (api.test.ts).
// =====================================================================================
//
// rate = ghosts / scheduled trips, for one (route_id, hour_of_week) cell over a trailing
// WINDOW_DAYS window. The denominator is the hard part and it is derived, never assumed:
//
//   * A *watched cell* is a wall-clock (calendar-date, hour-of-week) pair in which the
//     collector demonstrably ran — proven by at least one row in `trip_delay_obs` whose
//     `ts` falls in that hour. This is a true watched-window denominator, not the
//     "days with any observation" proxy: an hour the collector slept through is excluded.
//   * The denominator counts scheduled trips (from trips × stop_times × calendar) whose
//     scheduled start lands in a watched cell.
//   * The numerator counts ghosts whose scheduled start lands in the SAME watched cells.
//     Restricting both sides to the same cells is what makes the ratio meaningful — a
//     ghost in an unwatched hour would otherwise inflate the rate against a denominator
//     that never counted its scheduled siblings.
//   * An hour in which the collector ran but recorded zero observations is
//     indistinguishable from an hour it did not run, so it is treated as unwatched. That
//     drops matching ghosts too, so the ratio stays consistent rather than inflated.
//
// Thresholds (structural, chosen a priori — deliberately NOT tuned to any observed
// distribution):
//   n >= 8       a cell with fewer than eight scheduled trips is an anecdote, not a rate
//   rate > 0.08  'elevated' — roughly one run in twelve went missing
//   rate > 0.20  'high'     — more than one run in five went missing
// Below the elevated threshold there is no chip at all: the field is simply absent.
export const GHOST_RISK_MIN_N = 8;
export const GHOST_RISK_ELEVATED_RATE = 0.08;
export const GHOST_RISK_HIGH_RATE = 0.20;

export function ghostRiskFor(ghosts: number, scheduled: number, windowDays: number): GhostRisk | null {
  if (!Number.isFinite(ghosts) || !Number.isFinite(scheduled)) return null;
  if (ghosts <= 0 || scheduled < GHOST_RISK_MIN_N) return null;
  // A cell can never record more ghosts than it had scheduled trips; if it somehow does,
  // the two sides disagree about the window and we withhold rather than report > 100%.
  if (ghosts > scheduled) return null;
  const rate = ghosts / scheduled;
  if (rate <= GHOST_RISK_ELEVATED_RATE) return null;
  return {
    level: rate > GHOST_RISK_HIGH_RATE ? 'high' : 'elevated',
    rate, n: scheduled, ghosts, windowDays,
  };
}

/** One (route, scheduled-start-second) group of trips belonging to a single service_id. */
export interface TripStartBucket { routeId: string; startS: number; n: number }
export interface ForecastDay { ymd: number; midnightMs: number; serviceIds: readonly string[] }
export interface ForecastCell { ghosts: number; scheduled: number }

export interface ForecastInputs {
  /** wall-clock cells the collector demonstrably watched, keyed `${ymd}|${hourOfWeek}`. */
  watched: ReadonlySet<string>;
  /** the service days to walk, with their agency-local midnight + active service ids. */
  days: readonly ForecastDay[];
  /** service_id -> its trips grouped by (route, scheduled start second). */
  byService: ReadonlyMap<string, readonly TripStartBucket[]>;
  /** ghost rows in the window (kind 'ghost' only — a cancellation is not a no-show). */
  ghosts: readonly { routeId: string; scheduledStartMs: number }[];
  /** epoch ms -> the wall-clock cell it belongs to. Injected so this stays pure. */
  cellOf: (epochMs: number) => { ymd: number; how: number };
}

/** Build the (route_id, hour_of_week) -> {ghosts, scheduled} table. Key: `${routeId}|${how}`. */
export function buildForecast(input: ForecastInputs): Map<string, ForecastCell> {
  const out = new Map<string, ForecastCell>();
  const add = (routeId: string, how: number, field: keyof ForecastCell, delta: number) => {
    const key = `${routeId}|${how}`;
    let cell = out.get(key);
    if (!cell) { cell = { ghosts: 0, scheduled: 0 }; out.set(key, cell); }
    cell[field] += delta;
  };

  for (const day of input.days) {
    for (const serviceId of day.serviceIds) {
      const buckets = input.byService.get(serviceId);
      if (!buckets) continue;
      for (const b of buckets) {
        // The scheduled instant, resolved through agency-local midnight so GTFS times
        // past 24:00:00 land on the following wall-clock day, exactly as they run.
        const at = day.midnightMs + b.startS * 1000;
        const cell = input.cellOf(at);
        if (!input.watched.has(`${cell.ymd}|${cell.how}`)) continue;
        add(b.routeId, cell.how, 'scheduled', b.n);
      }
    }
  }

  for (const g of input.ghosts) {
    const cell = input.cellOf(g.scheduledStartMs);
    if (!input.watched.has(`${cell.ymd}|${cell.how}`)) continue;
    add(g.routeId, cell.how, 'ghosts', 1);
  }

  return out;
}

/** "YYYY-MM-DD HH:MM" in the agency's zone — the wire form of an agency-local time. */
export function agencyLocalStamp(epochMs: number): string {
  const p = torontoParts(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

export interface BuildApiOptions { db: Db; poller: PollerHandle }

export async function buildApi(opts: BuildApiOptions): Promise<FastifyInstance> {
  const { db, poller } = opts;

  // ----- static caches loaded once (small, read-only) -----
  const routeMeta = new Map<string, RouteMeta>();
  for (const r of (await db.query<{ route_id: string; short_name: string | null; long_name: string | null; route_type: number | null; color: string | null }>(
    'SELECT route_id, short_name, long_name, route_type, color FROM routes WHERE agency=$1', [AGENCY])).rows) {
    routeMeta.set(r.route_id, { shortName: r.short_name, longName: r.long_name, routeType: r.route_type == null ? null : Number(r.route_type), color: r.color });
  }

  const calendar: CalendarRow[] = (await db.query<{ service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; start_date: number; end_date: number }>(
    'SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency=$1', [AGENCY])).rows
    .map((r) => ({ service_id: r.service_id, days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun], start_date: Number(r.start_date), end_date: Number(r.end_date) }));
  const calendarDates: CalendarDateRow[] = (await db.query<{ service_id: string; date: number; exception_type: number }>(
    'SELECT service_id, date, exception_type FROM calendar_dates WHERE agency=$1', [AGENCY])).rows
    .map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));
  const activeSvcCache = new Map<number, string[]>();
  function activeServicesFor(ymd: number, dow: number): string[] {
    let s = activeSvcCache.get(ymd);
    if (!s) { s = [...activeServiceIds(calendar, calendarDates, [{ ymd, dow }])]; activeSvcCache.set(ymd, s); }
    return s;
  }
  function midnightFor(ymd: number): number {
    return torontoMidnightEpoch(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100), ymd % 100);
  }

  // ----- Ghost Forecast table, rebuilt in the background (see buildForecast above) -----
  // The denominator query walks every trip's first stop_time, so it is far too heavy for
  // a request path: it is computed off-thread of any request, cached, and refreshed on a
  // timer. Until the first build lands the map is empty, which means arrivals simply omit
  // `ghostRisk` — no data, no field, silently.
  let forecast: ReadonlyMap<string, ForecastCell> = new Map();
  const cellOf = (epochMs: number) => ({ ymd: torontoDay(epochMs).ymd, how: hourOfWeek(epochMs) });

  async function refreshForecast(): Promise<void> {
    const now = Date.now();
    const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();

    // 1. Watched cells: every whole hour with at least one delay observation. Toronto is
    //    a whole-hour offset from UTC, so a UTC hour bucket is also a Toronto hour bucket.
    const watched = new Set<string>();
    for (const r of (await db.query<{ hr: string | number }>(
      `SELECT DISTINCT FLOOR(EXTRACT(EPOCH FROM ts) / 3600)::bigint AS hr
       FROM trip_delay_obs WHERE agency=$1 AND ts >= $2`, [AGENCY, since])).rows) {
      const bucketMs = Number(r.hr) * 3_600_000;
      const cell = cellOf(bucketMs);
      watched.add(`${cell.ymd}|${cell.how}`);
    }

    // 2. Denominator source: every static trip's route + scheduled start second, grouped
    //    by the service_id that decides which days it runs.
    const byService = new Map<string, TripStartBucket[]>();
    for (const r of (await db.query<{ route_id: string; service_id: string; start_s: number | string; n: number }>(
      `SELECT route_id, service_id, start_s, COUNT(*)::int AS n FROM (
         SELECT DISTINCT ON (t.trip_id) t.trip_id, t.route_id, t.service_id,
                COALESCE(st.departure_s, st.arrival_s) AS start_s
         FROM trips t JOIN stop_times st ON st.agency = t.agency AND st.trip_id = t.trip_id
         WHERE t.agency = $1 ORDER BY t.trip_id, st.stop_sequence
       ) x
       WHERE route_id IS NOT NULL AND service_id IS NOT NULL AND start_s IS NOT NULL
       GROUP BY route_id, service_id, start_s`, [AGENCY])).rows) {
      const list = byService.get(r.service_id) ?? [];
      list.push({ routeId: r.route_id, startS: Number(r.start_s), n: Number(r.n) });
      byService.set(r.service_id, list);
    }

    // 3. The service days inside the window, with their active services.
    const days: ForecastDay[] = [];
    const seen = new Set<number>();
    for (let i = 0; i <= WINDOW_DAYS; i++) {
      const d = torontoDay(now - i * 86_400_000);
      if (seen.has(d.ymd)) continue;
      seen.add(d.ymd);
      days.push({ ymd: d.ymd, midnightMs: midnightFor(d.ymd), serviceIds: activeServicesFor(d.ymd, d.dow) });
    }

    // 4. Numerator: confirmed no-shows only. A cancellation is an announced absence, not
    //    a broken promise, so it never enters the ghost rate.
    const ghosts: { routeId: string; scheduledStartMs: number }[] = [];
    for (const r of (await db.query<{ route_id: string | null; scheduled_start: string | Date }>(
      `SELECT route_id, scheduled_start FROM ghosts
       WHERE agency=$1 AND kind='ghost' AND scheduled_start >= $2`, [AGENCY, since])).rows) {
      if (!r.route_id) continue;
      const ms = r.scheduled_start instanceof Date ? r.scheduled_start.getTime() : Date.parse(String(r.scheduled_start));
      if (!Number.isFinite(ms)) continue;
      ghosts.push({ routeId: r.route_id, scheduledStartMs: ms });
    }

    forecast = buildForecast({ watched, days, byService, ghosts, cellOf });
    console.log(`[forecast] ${forecast.size} route-hour cells from ${watched.size} watched hours, ${ghosts.length} ghosts, ${days.length} service days`);
  }

  const app = Fastify({ logger: false, trustProxy: true });

  // Build once at boot and refresh on a timer, both in the background and both non-fatal:
  // a forecast failure must never take the API down or block a departure board.
  const kickForecast = () => { void refreshForecast().catch((e) => console.error('[forecast] refresh failed:', e)); };
  kickForecast();
  const forecastTimer = setInterval(kickForecast, FORECAST_REFRESH_MS);
  forecastTimer.unref?.();
  app.addHook('onClose', async () => { clearInterval(forecastTimer); });

  await app.register(helmet, { contentSecurityPolicy: false }); // web app (Phase 3) sets its own CSP
  await app.register(cors, {
    origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/],
    methods: ['GET'],
  });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  // Uniform JSON errors — never leak a stack trace.
  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: status === 429 ? 'rate limit exceeded' : status < 500 ? err.message : 'internal error' });
  });

  const bad = (reply: import('fastify').FastifyReply, msg: string) => reply.code(400).send({ error: msg });

  // ---------- /api/health ----------
  app.get('/api/health', async (_req, reply) => {
    const h = poller.getFeedHealth();
    const feeds = {} as HealthResponse['feeds'];
    for (const key of Object.keys(h.feeds) as FeedId[]) {
      feeds[key] = { status: h.feeds[key].status, lastOkMs: h.feeds[key].lastOkMs, sinceMs: h.feeds[key].sinceMs };
    }
    const ok = Object.values(feeds).some((f) => f.status === 'ok');
    const body: HealthResponse = {
      ok, dbDriver: db.driver, lastPollAtMs: h.lastPollAtMs, collectorMode: 'in-process',
      feeds, boardCoverage: poller.getJoinStats().boardCoverage, serverNowMs: Date.now(),
    };
    return reply.send(body);
  });

  // ---------- /api/vehicles?bbox=minLon,minLat,maxLon,maxLat ----------
  app.get('/api/vehicles', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const parsed = parseBbox(q.bbox);
    if (!parsed.ok) return bad(reply, parsed.error);
    const b = parsed.value;
    const health = poller.getFeedHealth();
    const vehicles: VehicleDto[] = [];
    for (const v of poller.getVehicleStates()) {
      if (!pointInBbox(v.lat, v.lon, b)) continue;
      const meta = v.routeId ? routeMeta.get(v.routeId) : undefined;
      vehicles.push({
        id: v.id, routeId: v.routeId, shortName: meta?.shortName ?? null, routeType: meta?.routeType ?? null,
        color: colorFor(meta), lat: v.lat, lon: v.lon, heading: v.heading, speedMs: v.speedMs, isGhost: false, ts: v.ts,
      });
    }
    const body: VehiclesResponse = {
      vehicles, count: vehicles.length, lastPollAtMs: health.lastPollAtMs, serverNowMs: Date.now(),
      bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat],
    };
    return reply.send(body);
  });

  // ---------- /api/stops?q= ----------
  app.get('/api/stops', async (req, reply) => {
    const q = (req.query as Record<string, string | undefined>).q?.trim() ?? '';
    if (q.length === 0) return bad(reply, 'q is required');
    if (q.length > Q_MAX_LEN) return bad(reply, `q too long (max ${Q_MAX_LEN})`);
    const rows = (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
      `SELECT stop_id, name, lat, lon, wheelchair_boarding FROM stops
       WHERE agency=$1 AND (stop_id = $2 OR name ILIKE $3) ORDER BY (stop_id = $2) DESC, name LIMIT $4`,
      [AGENCY, q, `%${q}%`, SEARCH_MAX_RESULTS])).rows;
    const stops: StopDto[] = rows.map((r) => ({ stopId: r.stop_id, name: r.name, lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), wheelchairBoarding: r.wheelchair_boarding == null ? null : Number(r.wheelchair_boarding) }));
    const body: StopsResponse = { stops, count: stops.length };
    return reply.send(body);
  });

  // ---------- /api/stops/nearby?lat=&lon=&radius= ----------
  app.get('/api/stops/nearby', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const lat = Number(q.lat), lon = Number(q.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return bad(reply, 'lat must be a number in [-90, 90]');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return bad(reply, 'lon must be a number in [-180, 180]');
    let radius = q.radius == null ? NEARBY_DEFAULT_RADIUS_M : Number(q.radius);
    if (!Number.isFinite(radius) || radius <= 0) return bad(reply, 'radius must be a positive number (metres)');
    radius = Math.min(radius, NEARBY_MAX_RADIUS_M);

    const dLat = radius / 111_320;
    const dLon = radius / (111_320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    const rows = (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
      `SELECT stop_id, name, lat, lon, wheelchair_boarding FROM stops
       WHERE agency=$1 AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5`,
      [AGENCY, lat - dLat, lat + dLat, lon - dLon, lon + dLon])).rows;
    const stops: StopDto[] = [];
    for (const r of rows) {
      if (r.lat == null || r.lon == null) continue;
      const distanceM = haversineM(lat, lon, Number(r.lat), Number(r.lon));
      if (distanceM > radius) continue;
      stops.push({ stopId: r.stop_id, name: r.name, lat: Number(r.lat), lon: Number(r.lon), wheelchairBoarding: r.wheelchair_boarding == null ? null : Number(r.wheelchair_boarding), distanceM: Math.round(distanceM) });
    }
    stops.sort((a, b2) => (a.distanceM ?? 0) - (b2.distanceM ?? 0));
    const body: StopsResponse = { stops: stops.slice(0, NEARBY_MAX_RESULTS), count: Math.min(stops.length, NEARBY_MAX_RESULTS) };
    return reply.send(body);
  });

  // ---------- /api/stops/:id/arrivals?windowMin=&at= ----------
  app.get<{ Params: { id: string } }>('/api/stops/:id/arrivals', async (req, reply) => {
    const stopId = req.params.id;
    if (!stopId || stopId.length > Q_MAX_LEN) return bad(reply, 'invalid stop id');
    const q = req.query as Record<string, string | undefined>;

    const now = Date.now();
    let atMs = now;
    // Non-empty guard: Number('') === 0 would silently resolve `at` to 1970.
    if (q.at != null && q.at.trim() !== '') {
      const n = Number(q.at);
      atMs = Number.isFinite(n) ? n : Date.parse(q.at);
      if (!Number.isFinite(atMs)) return bad(reply, 'at must be epoch ms or an ISO datetime');
      // Sanity floor/ceiling: reject nonsense far-past or far-future timestamps.
      if (atMs < AT_FLOOR_MS || atMs > now + AT_MAX_FUTURE_MS) return bad(reply, 'at must be between 2020-01-01 and 30 days from now');
    }
    let windowMin = q.windowMin == null ? ARRIVALS_DEFAULT_WINDOW_MIN : Number(q.windowMin);
    if (!Number.isFinite(windowMin) || windowMin <= 0) return bad(reply, 'windowMin must be a positive number');
    windowMin = Math.min(windowMin, ARRIVALS_MAX_WINDOW_MIN);
    const windowMs = windowMin * 60_000;

    const stopRow = (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
      'SELECT stop_id, name, lat, lon, wheelchair_boarding FROM stops WHERE agency=$1 AND stop_id=$2', [AGENCY, stopId])).rows[0];
    if (!stopRow) return reply.code(404).send({ error: 'stop not found' });

    // Scan every service date whose window can overlap [at, at+window]. Sized to the
    // window (not a fixed 3 days) so a large windowMin never silently truncates: one day
    // before (for >24h GTFS times) through one day after the window's end.
    const dayList: Array<{ ymd: number; dow: number }> = [];
    const seenYmd = new Set<number>();
    for (let t = atMs - 86_400_000; t <= atMs + windowMs + 86_400_000; t += 86_400_000) {
      const d = torontoDay(t);
      if (!seenYmd.has(d.ymd)) { seenYmd.add(d.ymd); dayList.push(d); }
    }
    interface Raw { tripId: string; stopSequence: number; dep: number; routeId: string | null; headsign: string | null; directionId: number | null; scheduledMs: number }
    const raws: Raw[] = [];
    for (const day of dayList) {
      const svc = activeServicesFor(day.ymd, day.dow);
      if (svc.length === 0) continue;
      const midnight = midnightFor(day.ymd);
      const loSec = Math.floor((atMs - midnight) / 1000);
      const hiSec = Math.ceil((atMs + windowMs - midnight) / 1000);
      if (hiSec < 0) continue;
      const rows = (await db.query<{ trip_id: string; stop_sequence: number; dep: number | null; route_id: string | null; headsign: string | null; direction_id: number | null }>(
        `SELECT st.trip_id, st.stop_sequence, COALESCE(st.departure_s, st.arrival_s) AS dep,
                t.route_id, t.headsign, t.direction_id
         FROM stop_times st JOIN trips t ON t.agency=st.agency AND t.trip_id=st.trip_id
         WHERE st.agency=$1 AND st.stop_id=$2 AND t.service_id = ANY($3::text[])
           AND COALESCE(st.departure_s, st.arrival_s) BETWEEN $4 AND $5`,
        [AGENCY, stopId, svc, Math.max(0, loSec), hiSec])).rows;
      for (const r of rows) {
        if (r.dep == null) continue;
        const scheduledMs = midnight + Number(r.dep) * 1000;
        if (scheduledMs < atMs || scheduledMs > atMs + windowMs) continue;
        raws.push({ tripId: r.trip_id, stopSequence: Number(r.stop_sequence), dep: Number(r.dep), routeId: r.route_id, headsign: r.headsign, directionId: r.direction_id == null ? null : Number(r.direction_id), scheduledMs });
      }
    }
    raws.sort((a, b) => a.scheduledMs - b.scheduledMs);
    const trimmed = raws.slice(0, ARRIVALS_MAX_DEPARTURES);

    // Evidence: load this stop's agg_delay buckets and the route-hour rollup for the
    // routes involved, then select per departure by the hard n-thresholds.
    const stopAgg = new Map<string, Agg>(); // key `${route}|${how}`
    for (const r of (await db.query<{ route_id: string; hour_of_week: number; n: number; p25: number; p50: number; p75: number }>(
      'SELECT route_id, hour_of_week, n, p25, p50, p75 FROM agg_delay WHERE agency=$1 AND stop_id=$2', [AGENCY, stopId])).rows) {
      stopAgg.set(`${r.route_id}|${r.hour_of_week}`, { n: Number(r.n), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
    }
    const routesInvolved = [...new Set(trimmed.map((r) => r.routeId).filter((x): x is string => !!x))];
    const routeAgg = new Map<string, Agg>();
    if (routesInvolved.length > 0) {
      for (const r of (await db.query<{ route_id: string; hour_of_week: number; n: number; p25: number; p50: number; p75: number }>(
        'SELECT route_id, hour_of_week, n, p25, p50, p75 FROM agg_delay_route WHERE agency=$1 AND route_id = ANY($2::text[])', [AGENCY, routesInvolved])).rows) {
        routeAgg.set(`${r.route_id}|${r.hour_of_week}`, { n: Number(r.n), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
      }
    }

    const attachLive = Math.abs(atMs - now) < LIVE_ETA_MAX_SKEW_MS;
    const departures: DepartureDto[] = trimmed.map((r) => {
      const meta = r.routeId ? routeMeta.get(r.routeId) : undefined;
      const how = hourOfWeek(r.scheduledMs);
      const sAgg = r.routeId ? stopAgg.get(`${r.routeId}|${how}`) ?? null : null;
      const rAgg = r.routeId ? routeAgg.get(`${r.routeId}|${how}`) ?? null : null;
      const ev = selectEvidence(sAgg, rAgg);
      const hasEst = ev.bucket !== 'none' && ev.p50 != null;
      const liveEtaMs = attachLive ? poller.getLivePredictionMs(r.tripId, stopId) : null;

      // Evidence gates are structural: no grade without a sample, no risk chip without
      // a denominator. Both fields are omitted entirely rather than sent empty.
      const grade = hasEst
        ? gradeFor(ev.bucket, ev.n, spreadMinutes(ev.p25 as number, ev.p75 as number))
        : null;
      const cell = r.routeId ? forecast.get(`${r.routeId}|${how}`) : undefined;
      const ghostRisk = cell ? ghostRiskFor(cell.ghosts, cell.scheduled, WINDOW_DAYS) : null;

      const dep: DepartureDto = {
        routeId: r.routeId, shortName: meta?.shortName ?? null, longName: meta?.longName ?? null,
        routeType: meta?.routeType ?? null, color: colorFor(meta),
        headsign: r.headsign, directionId: r.directionId,
        directionLabel: r.headsign ?? (r.directionId == null ? 'Unknown' : `Direction ${r.directionId}`),
        tripId: r.tripId, stopSequence: r.stopSequence, scheduledMs: r.scheduledMs, liveEtaMs,
        honest: {
          estimateMs: hasEst ? r.scheduledMs + (ev.p50 as number) * 1000 : null,
          bandLowMs: hasEst ? r.scheduledMs + (ev.p25 as number) * 1000 : null,
          bandHighMs: hasEst ? r.scheduledMs + (ev.p75 as number) * 1000 : null,
          medianDelaySec: hasEst ? (ev.p50 as number) : null,
        },
        evidence: { n: ev.n, windowDays: WINDOW_DAYS, bucket: ev.bucket },
      };
      if (grade) dep.grade = grade;
      if (ghostRisk) dep.ghostRisk = ghostRisk;
      return dep;
    });

    const body: ArrivalsResponse = {
      stopId: stopRow.stop_id, stopName: stopRow.name,
      lat: stopRow.lat == null ? null : Number(stopRow.lat), lon: stopRow.lon == null ? null : Number(stopRow.lon),
      wheelchairBoarding: stopRow.wheelchair_boarding == null ? null : Number(stopRow.wheelchair_boarding),
      serverNowMs: now, atMs, windowMinutes: windowMin, departures,
    };
    return reply.send(body);
  });

  // ---------- /api/routes/:routeId/shape?dir= ----------
  // The route's most representative shape (the shape_id used by the most trips for
  // that route/direction) as a simplified polyline, plus the real ordered stops of a
  // representative trip on it. Powers the red active-route line + intermediate dots.
  app.get<{ Params: { routeId: string } }>('/api/routes/:routeId/shape', async (req, reply) => {
    const routeId = req.params.routeId;
    if (!routeId || routeId.length > Q_MAX_LEN) return bad(reply, 'invalid route id');
    const q = req.query as Record<string, string | undefined>;
    let dir: number | null = null;
    if (q.dir != null && q.dir.trim() !== '') {
      if (q.dir !== '0' && q.dir !== '1') return bad(reply, 'dir must be 0 or 1');
      dir = Number(q.dir);
    }

    // Most representative (shape_id, direction) for this route: parameterized, dir optional.
    const repParams: unknown[] = [AGENCY, routeId];
    let dirClause = '';
    if (dir != null) { dirClause = ' AND direction_id = $3'; repParams.push(dir); }
    const rep = (await db.query<{ shape_id: string; direction_id: number | null; n: number }>(
      `SELECT shape_id, direction_id, COUNT(*)::int AS n FROM trips
       WHERE agency=$1 AND route_id=$2 AND shape_id IS NOT NULL${dirClause}
       GROUP BY shape_id, direction_id ORDER BY n DESC LIMIT 1`, repParams)).rows[0];
    if (!rep) return reply.code(404).send({ error: 'no shape for route' });

    const shapeRow = (await db.query<{ points: unknown }>(
      'SELECT points FROM shapes WHERE agency=$1 AND shape_id=$2', [AGENCY, rep.shape_id])).rows[0];
    if (!shapeRow) return reply.code(404).send({ error: 'shape not found' });
    // points stored as [lat, lon][] (JSONB); pg returns it parsed, PGlite may return text.
    const raw = (typeof shapeRow.points === 'string' ? JSON.parse(shapeRow.points) : shapeRow.points) as [number, number][];
    const lonLat: [number, number][] = raw.map(([lat, lon]) => [lon, lat]);
    const coordinates = simplify(lonLat, 1.5e-5); // ~1.7 m — trims collinear runs, keeps every curve

    // A representative trip on that exact shape → its real ordered stops.
    const repDir = rep.direction_id;
    const tripRow = (await db.query<{ trip_id: string }>(
      `SELECT trip_id FROM trips WHERE agency=$1 AND route_id=$2 AND shape_id=$3
       ${repDir == null ? 'AND direction_id IS NULL' : 'AND direction_id=$4'} LIMIT 1`,
      repDir == null ? [AGENCY, routeId, rep.shape_id] : [AGENCY, routeId, rep.shape_id, repDir])).rows[0];
    const stops: RouteStopDto[] = [];
    if (tripRow) {
      for (const s of (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null }>(
        `SELECT s.stop_id, s.name, s.lat, s.lon FROM stop_times st
         JOIN stops s ON s.agency=st.agency AND s.stop_id=st.stop_id
         WHERE st.agency=$1 AND st.trip_id=$2 ORDER BY st.stop_sequence`, [AGENCY, tripRow.trip_id])).rows) {
        if (s.lat == null || s.lon == null) continue;
        stops.push({ stopId: s.stop_id, name: s.name, lat: Number(s.lat), lon: Number(s.lon) });
      }
    }

    const body: RouteShapeResponse = {
      routeId, directionId: rep.direction_id == null ? null : Number(rep.direction_id),
      shapeId: rep.shape_id, color: colorFor(routeMeta.get(routeId)), coordinates, stops,
    };
    return reply.send(body);
  });

  // ---------- /api/alerts?limit= ----------
  // The agency's own words, unedited. Effect and cause are reported exactly as the feed
  // publishes them (the TTC feed says UNKNOWN_EFFECT / UNKNOWN_CAUSE on every alert
  // today) — we never infer an effect from the wording of the header.
  app.get('/api/alerts', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    let limit = ALERTS_DEFAULT_LIMIT;
    if (q.limit != null && q.limit.trim() !== '') {
      const n = Number(q.limit);
      if (!Number.isFinite(n) || n <= 0) return bad(reply, 'limit must be a positive number');
      limit = Math.min(Math.floor(n), ALERTS_MAX_LIMIT);
    }
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // "Active" = not yet expired. An alert with no activePeriod is active by virtue of
    // being in the feed's current snapshot, which is what the poller upserts.
    // Recent-first where the feed gives us recency; `alert_id` is the deterministic
    // tie-break so a feed with no timestamps still returns a stable order.
    const rows = (await db.query<{
      alert_id: string; effect: string | null; cause: string | null; header: string | null;
      description: string | null; active_start: string | Date | null; active_end: string | Date | null;
      informed: unknown; is_accessibility: boolean | null;
    }>(
      `SELECT alert_id, effect, cause, header, description, active_start, active_end, informed, is_accessibility
       FROM service_alerts
       WHERE agency=$1 AND (active_end IS NULL OR active_end >= $2)
       ORDER BY active_start DESC NULLS LAST, alert_id
       LIMIT $3`, [AGENCY, nowIso, limit])).rows;

    const toMs = (v: string | Date | null): number | null => {
      if (v == null) return null;
      const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
      return Number.isFinite(ms) ? ms : null;
    };
    const blank = (s: string | null | undefined): string | null => {
      const v = s?.trim();
      return v ? v : null;
    };

    const alerts: AlertDto[] = rows.map((r) => {
      // JSONB: pg returns it parsed, PGlite can hand back the text form.
      const raw = typeof r.informed === 'string' ? JSON.parse(r.informed) : r.informed;
      const list: AlertInformedDto[] = Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>).map((e) => {
          const routeId = blank(e.routeId as string | null);
          return {
            routeId,
            routeShortName: routeId ? routeMeta.get(routeId)?.shortName ?? null : null,
            stopId: blank(e.stopId as string | null),
            tripId: blank(e.tripId as string | null),
          };
        })
        : [];
      return {
        alertId: r.alert_id,
        effect: blank(r.effect), cause: blank(r.cause),
        header: blank(r.header), description: blank(r.description),
        activeStartMs: toMs(r.active_start), activeEndMs: toMs(r.active_end),
        informed: list,
        isAccessibility: r.is_accessibility === true,
      };
    });

    const publishesActivePeriod = alerts.some((a) => a.activeStartMs != null || a.activeEndMs != null);
    const body: AlertsResponse = {
      alerts, count: alerts.length,
      feedUpdatedMs: poller.getFeedHealth().feeds.alerts.lastOkMs,
      serverNowMs: now,
      meta: { ordering: publishesActivePeriod ? 'active-start' : 'stable-id', publishesActivePeriod },
    };
    return reply.send(body);
  });

  // ---------- /api/ghosts/feed?hours= ----------
  // Every row here is a promise the schedule made and the service did not keep. A ghost
  // that was later retracted (the trip turned up inside its due window) is a DELETEd row
  // — see DECISIONS §18 — so it simply never appears in this feed; there is no
  // "retracted" state to render, which `meta.retractedAreDeleted` states on the wire.
  app.get('/api/ghosts/feed', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    let hours = GHOSTS_DEFAULT_HOURS;
    if (q.hours != null && q.hours.trim() !== '') {
      const n = Number(q.hours);
      if (!Number.isFinite(n) || n <= 0) return bad(reply, 'hours must be a positive number');
      hours = Math.min(n, GHOSTS_MAX_HOURS);
    }
    const now = Date.now();
    const sinceIso = new Date(now - hours * 3_600_000).toISOString();
    const today = torontoDay(now);
    const todaySinceMs = midnightFor(today.ymd);
    const weekSinceMs = now - 7 * 86_400_000;

    const [eventRows, counterRows] = await Promise.all([
      db.query<{
        trip_id: string; kind: string; route_id: string | null;
        scheduled_start: string | Date; detected_at: string | Date; headsign: string | null;
      }>(
        `SELECT g.trip_id, g.kind, g.route_id, g.scheduled_start, g.detected_at, t.headsign
         FROM ghosts g LEFT JOIN trips t ON t.agency = g.agency AND t.trip_id = g.trip_id
         WHERE g.agency=$1 AND g.detected_at >= $2
         ORDER BY g.detected_at DESC LIMIT $3`, [AGENCY, sinceIso, GHOSTS_MAX_EVENTS]),
      db.query<{ kind: string; today: number; week: number }>(
        `SELECT kind, COUNT(*) FILTER (WHERE detected_at >= $2)::int AS today, COUNT(*)::int AS week
         FROM ghosts WHERE agency=$1 AND detected_at >= $3 GROUP BY kind`,
        [AGENCY, new Date(todaySinceMs).toISOString(), new Date(weekSinceMs).toISOString()]),
    ]);

    const counters: GhostCounters = { todayGhosts: 0, todayCancelled: 0, weekGhosts: 0, weekCancelled: 0 };
    for (const r of counterRows.rows) {
      if (r.kind === 'ghost') { counters.todayGhosts = Number(r.today); counters.weekGhosts = Number(r.week); }
      else if (r.kind === 'cancelled') { counters.todayCancelled = Number(r.today); counters.weekCancelled = Number(r.week); }
    }

    const ms = (v: string | Date): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));
    const events: GhostEventDto[] = [];
    for (const r of eventRows.rows) {
      const scheduledStartMs = ms(r.scheduled_start);
      const detectedAtMs = ms(r.detected_at);
      if (!Number.isFinite(scheduledStartMs) || !Number.isFinite(detectedAtMs)) continue;
      const meta = r.route_id ? routeMeta.get(r.route_id) : undefined;
      events.push({
        tripId: r.trip_id,
        kind: (r.kind === 'cancelled' ? 'cancelled' : 'ghost') satisfies GhostKind,
        routeId: r.route_id, shortName: meta?.shortName ?? null, longName: meta?.longName ?? null,
        routeType: meta?.routeType ?? null, color: colorFor(meta),
        headsign: r.headsign,
        scheduledStartMs, scheduledStartLocal: agencyLocalStamp(scheduledStartMs), detectedAtMs,
      });
    }

    const body: GhostFeedResponse = {
      events, count: events.length, hours, counters, serverNowMs: now,
      meta: { retractedAreDeleted: true, timezone: AGENCY_TZ, todaySinceMs },
    };
    return reply.send(body);
  });

  // ---------- /api/stats ----------
  app.get('/api/stats', async (_req, reply) => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [obs, ghosts, avg] = await Promise.all([
      db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM trip_delay_obs WHERE agency=$1', [AGENCY]),
      db.query<{ kind: string; n: string }>('SELECT kind, COUNT(*)::text AS n FROM ghosts WHERE agency=$1 AND detected_at >= $2 GROUP BY kind', [AGENCY, weekAgo]),
      db.query<{ avg: number | null }>('SELECT AVG(delay_s)::double precision AS avg FROM trip_delay_obs WHERE agency=$1 AND ts >= $2', [AGENCY, new Date(Date.now() - 3 * 3_600_000).toISOString()]),
    ]);
    let ghostsThisWeek = 0, cancelledThisWeek = 0;
    for (const r of ghosts.rows) { if (r.kind === 'ghost') ghostsThisWeek = Number(r.n); else if (r.kind === 'cancelled') cancelledThisWeek = Number(r.n); }
    const body: StatsResponse = {
      vehiclesTracked: poller.getVehicleStates().length,
      obsCollected: Number(obs.rows[0].n),
      ghostsThisWeek, cancelledThisWeek,
      avgDelayRecentSec: avg.rows[0].avg == null ? null : Math.round(Number(avg.rows[0].avg)),
      updatedAtMs: Date.now(),
    };
    return reply.send(body);
  });

  // ---------- static SPA (production) + JSON 404 for API ----------
  // DECISIONS §26 deploy blocker: vite writes the bundle to <root>/dist but this served
  // <root>/web/dist, so `/` 404'd in production. Resolved by probing for the real bundle
  // (a directory that actually contains index.html) instead of assuming one path.
  const webDist = DIST_CANDIDATES.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
  if (webDist) {
    // `wildcard: true` (the default) resolves each request against the filesystem at
    // request time. The previous `wildcard: false` enumerated the bundle *once at
    // startup*, so every hashed asset written by a later `vite build` 404'd into the SPA
    // fallback and the page booted to a blank screen — the exact failure this endpoint
    // exists to prevent. A missing file still falls through to the not-found handler
    // below, which is what serves the SPA shell for client-side routes.
    await app.register(fastifyStatic, { root: webDist });
  }
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    if (!webDist) return reply.code(404).send({ error: 'not found' });

    const path = req.url.split(/[?#]/, 1)[0];
    // A missing asset is a missing asset, whatever the client claims to Accept —
    // this branch is checked first precisely so a browser navigating straight to a
    // dead bundle URL still sees the 404 instead of a reassuring HTML page.
    if (path.startsWith('/assets/') || ASSET_EXT_RE.test(path)) {
      return reply.code(404).send({ error: 'not found' });
    }
    // Genuine navigations only: no file extension, or an explicit HTML Accept.
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    const isNavigation = (req.method === 'GET' || req.method === 'HEAD') && (wantsHtml || !path.includes('.'));
    if (!isNavigation) return reply.code(404).send({ error: 'not found' });

    return reply.type('text/html').send(readFileSync(join(webDist, 'index.html'), 'utf8'));
  });

  return app;
}
