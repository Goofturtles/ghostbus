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
import { type PollerHandle, type FeedRuntime } from './poller.ts';
import { enabledAgencies } from './agencies.ts';
import { parseBbox, pointInBbox } from './bbox.ts';
import { selectEvidence, type Agg } from './eta.ts';
import { WINDOW_DAYS } from './aggregate.ts';
import { activeServiceIds, type CalendarRow, type CalendarDateRow } from './gtfs.ts';
import { torontoDay, torontoMidnightEpoch, hourOfWeek, torontoParts } from './tz.ts';
import {
  stitchItineraries, stitchThreeLeg, withinTransferWalk, TRANSFER_MAX_WALK_M,
  breathe, startSearchBudget, PLAN_SEARCH_BUDGET_MS,
  type StitchStop,
} from './itinerary.ts';
import type {
  HealthResponse, VehiclesResponse, VehicleDto, StopsResponse, StopDto, StopRouteDto,
  ArrivalsResponse, DepartureDto, StatsResponse, FeedId,
  RouteShapeResponse, RouteStopDto,
  AlertsResponse, AlertDto, AlertInformedDto,
  GhostFeedResponse, GhostEventDto, GhostKind, GhostCounters,
  TrustGrade, GradeLetter, GhostRisk, EtaBucket,
  PlanResponse, PlanStopDto, RideCandidateDto, PlanOutcome, ItineraryDto,
  GeocodeResponse,
} from '../../shared/types.ts';
import { geocode, OSM_ATTRIBUTION } from './geocode.ts';

// The agency namespace is NOT a module constant: it is read off the poller inside
// `buildApi` (see the note there), because the poller is what decides which namespace
// the rows it writes are tagged with — and in Demo Mode that is not 'ttc'.
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
// `.js` URL with `200 text/html` is how a dead map hid for a whole phase (DECISIONS §28),
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
const PLAN_DEFAULT_RADIUS_M = 500;
const PLAN_MAX_RADIUS_M = 1500;
/** Endpoint stops considered per side. More than this and the self-join below starts
 *  scanning trips that stop nowhere near either end of the journey. */
const PLAN_MAX_ENDPOINT_STOPS = 12;
const PLAN_DEFAULT_WINDOW_MIN = 90;
/** Same ceiling as arrivals: three days is enough to reach the next service board. */
const PLAN_MAX_WINDOW_MIN = 4320;
/** Raw (board, alight) pairs the SQL may return before ranking trims them. */
const PLAN_SQL_ROW_LIMIT = 400;
/**
 * TWO-LEG TIER. These probes run ONLY where the direct search already found nothing, so
 * they are never on the hot path — but they are unconstrained at one end by construction
 * (every stop a leg-1 trip reaches is a transfer candidate), so each needs its own cap.
 * Ordered by departure time, so a cap that bites can only drop the LATEST options.
 */
const TWO_LEG_SQL_ROW_LIMIT = 3000;
/**
 * How far past the requested window leg 2 is allowed to depart. Leg 2 leaves after leg 1
 * ARRIVES, so searching only the rider's window would find first legs with nothing to
 * connect to. Sized as a long ride plus the transfer wait cap in itinerary.ts.
 */
const TWO_LEG_HORIZON_MS = 120 * 60_000;
/** Itineraries returned. A menu, like the ride tier's — not a verdict. */
const PLAN_MAX_ITINERARIES = 5;
/**
 * Three-leg itineraries returned — deliberately fewer than two-leg ones.
 *
 * Not a performance number. A third leg compounds a second schedule assumption, so the
 * honest thing is to show the few journeys that clearly work rather than a long menu that
 * invites the rider to pick the marginal one.
 */
const PLAN_MAX_THREE_LEG = 3;
/**
 * The widest stop set a three-leg search will consider as transfer ground. Bounds the one
 * unbounded thing in the tier: a middle leg touches no query point, so its candidate stops
 * come from a bounding box rather than a radius around the rider.
 */
const THREE_LEG_STOP_LIMIT = 4000;
/**
 * The pace the SERVER times a transfer walk at, to decide whether a connection can be
 * made at all — the SLOW end of the client's three settings (3.6 km/h), not the average.
 *
 * The rider's real pace is a preference that never leaves their device, which is the
 * whole reason /api/plan returns a menu instead of a verdict. So the one walk the server
 * cannot avoid judging is judged conservatively: timing the transfer at the slowest pace
 * offers only connections a slow walker could also make, and never dangles one that
 * needs the rider to hurry. The client re-times everything it draws at the rider's own
 * pace; this constant only decides what is on the menu.
 */
const TRANSFER_PACE_MPS = 3.6 / 3.6;
const ALERTS_DEFAULT_LIMIT = 50;
const ALERTS_MAX_LIMIT = 100;
const GHOSTS_DEFAULT_HOURS = 24;
const GHOSTS_MAX_HOURS = 168;    // one week — the counters already cover the week
const GHOSTS_MAX_EVENTS = 200;
const FORECAST_REFRESH_MS = 30 * 60_000; // the denominator query is heavy; twice an hour is plenty

/**
 * How the stitching search ended. Three outcomes, and the caller must be able to tell
 * them apart — see the note on `findItineraries`.
 *
 *   'found'      real itineraries, two legs or three.
 *   'exhausted'  the search ran to the end of its depth and found none. It had material
 *                to work with: rides depart near the rider and arrive near the
 *                destination, they simply do not chain within three legs.
 *   'budget'     the wall clock stopped it. Proves nothing either way.
 *   'noRides'    there was nothing to search: no ride leaves the rider's stops, or none
 *                reaches the destination's, inside the window. Not a depth finding.
 */
type PlanSearchResult =
  | { kind: 'found'; outcome: 'twoLeg' | 'threeLeg'; itineraries: ItineraryDto[] }
  | { kind: 'exhausted' }
  | { kind: 'budget' }
  | { kind: 'noRides' };

interface RouteMeta { shortName: string | null; longName: string | null; routeType: number | null; color: string | null }

/** Tasteful livery fallback when routes.color is blank, by GTFS route_type. */
/**
 * Composite cache key for anything scoped to (agency, id). U+001F never appears in a GTFS
 * id, so two different pairs can never collide by concatenation — the same reasoning as
 * `dedupeByKey` in engine.ts.
 */
function metaKey(agencyId: string, id: string): string {
  return `${agencyId}${String.fromCharCode(31)}${id}`;
}

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

/**
 * ROUTE BADGE ORDER — "7, 29, 29A, 300, Line 2", not "29A, 29, 300, 7".
 *
 * Route short names are strings that riders read as numbers, and a plain
 * `localeCompare` puts 300 before 7 on every board in the city. Leading digits are
 * compared numerically, the suffix breaks the tie ("29" before "29A"), and anything with
 * no leading digit at all ("Line 2", "BLUE") sorts after the numbered routes rather than
 * being interleaved with them by accident of ASCII.
 */
export function compareRouteShortName(a: string, b: string): number {
  const ma = /^(\d+)/.exec(a);
  const mb = /^(\d+)/.exec(b);
  if (ma && mb) {
    const d = Number(ma[1]) - Number(mb[1]);
    if (d !== 0) return d;
    return a.localeCompare(b);
  }
  if (ma) return -1;
  if (mb) return 1;
  return a.localeCompare(b);
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Douglas–Peucker tolerance for the route polyline, in degrees.
//
// The stored shape is the agency's own shapes.txt, loaded losslessly by
// seed_toronto.ts (median 226 points/shape; the 504's is 177 points over 10.3 km,
// spaced ~50 m). That feed is the ceiling on how well the line can trace a street,
// and we never invent geometry to beat it.
//
// This tolerance is what we are allowed to throw away on the way out. 1e-6° is
// 0.08 m of longitude / 0.11 m of latitude at Toronto's latitude, so the drawn line
// stays within ~0.11 m of the agency's centreline. The map opens at zoom 16.6 and
// allows 18, where a pixel is 1.14 m and 0.43 m respectively, so the worst-case
// error is a quarter of a pixel at the deepest zoom the app can reach — invisible.
// It still collapses the long dead-straight runs the TTC grid is full of.
//
// The previous 1.5e-5 (~1.4 m) was ~1.2 px off the street at the default zoom and
// ~3.9 px at zoom 18 — about a line-width adrift, which is exactly the "the route
// doesn't follow the road" artefact. Cost of the change: the 504 polyline goes from
// 46 to 141 points (1.0 KB → 3.1 KB of coordinates); the largest shape we hold tops
// out at 1,141 points (~27 KB). Nothing is stored differently — the DB is unchanged.
const SHAPE_SIMPLIFY_EPS_DEG = 1e-6;

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

// =====================================================================================
// Single-ride plan ranking — pure, exported, unit-tested (api.test.ts).
// =====================================================================================
//
// The SQL below returns every (boarding stop, alighting stop) pair a trip makes
// available, which for a rider ringed by twelve stops is up to 144 rows for ONE trip.
// They are all true, and almost all of them are noise: a rider does not want the same
// streetcar listed 144 times.
//
// This trims the list WITHOUT deciding the journey. Which option is actually best
// depends on how fast the rider walks, and that preference never leaves their device
// (see PlanStopDto) — so the server hands back a small, honest menu ordered soonest
// first and the client picks from it at the rider's own pace.
//
// The trim is: soonest departure first, nearest stops first as the tie-break; keep at
// most PER_TRIP pairs of any one trip; stop once maxTrips distinct trips are in.
// Deterministic, and it can only ever remove rows — never invent or reorder a fact.
export const PLAN_PAIRS_PER_TRIP = 3;
export const PLAN_MAX_TRIPS = 10;

export interface RankableRide {
  tripId: string;
  departureS: number;
  boardDistanceM: number;
  alightDistanceM: number;
  /** Breaks the tie a loop route creates: the SAME stop can be called twice on one
   *  trip, so two rows can agree on departure AND on both distances while describing
   *  a short ride and the long way around. Lower sequence = the shorter ride. */
  alightStopSequence: number;
}

export function rankRideCandidates<T extends RankableRide>(
  rows: readonly T[],
  perTrip = PLAN_PAIRS_PER_TRIP,
  maxTrips = PLAN_MAX_TRIPS,
): T[] {
  const sorted = rows.slice().sort((a, b) =>
    a.departureS - b.departureS ||
    (a.boardDistanceM + a.alightDistanceM) - (b.boardDistanceM + b.alightDistanceM) ||
    a.alightStopSequence - b.alightStopSequence ||
    // Total order, so the same input can never produce two different menus.
    (a.tripId < b.tripId ? -1 : a.tripId > b.tripId ? 1 : 0));

  const perTripCount = new Map<string, number>();
  const out: T[] = [];
  for (const r of sorted) {
    const seen = perTripCount.get(r.tripId) ?? 0;
    // A trip we have not admitted yet only gets in while there is room for a new one.
    if (seen === 0 && perTripCount.size >= maxTrips) continue;
    if (seen >= perTrip) continue;
    perTripCount.set(r.tripId, seen + 1);
    out.push(r);
  }
  return out;
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

export interface BuildApiOptions {
  db: Db;
  poller: PollerHandle;
  /**
   * The wall budget one /api/plan search may spend, in ms. Defaults to
   * `PLAN_SEARCH_BUDGET_MS`; injectable ONLY so a test can drive the expiry path without
   * spending eight real seconds to reach it. Nothing in production passes it.
   */
  planBudgetMs?: number;
}

export async function buildApi(opts: BuildApiOptions): Promise<FastifyInstance> {
  const { db, poller, planBudgetMs = PLAN_SEARCH_BUDGET_MS } = opts;

  /**
   * TWO NAMESPACES, BECAUSE THERE ARE TWO KINDS OF ROW — and collapsing them into one was
   * a bug in each direction. `poller.ts` has drawn this exact distinction since Demo Mode
   * landed (STATIC_AGENCY vs `agency`); this file now matches it.
   *
   * `staticAgency` — the published schedule: stops, routes, trips, stop_times, shapes,
   * calendar, calendar_dates. Read from `poller.getMode().staticAgency`, so it is whichever
   * agency this poller observes ('ttc', 'miway', …) — it is NO LONGER always `'ttc'`, and
   * `seed_toronto.ts` no longer writes only under `'ttc'` either: it takes `--agency` and
   * writes each agency's board under that agency's own id. What has not changed is the
   * rule: a schedule is not an observation, there is one published board per agency, and a
   * recording is a recording *of* that board rather than a different one (DECISIONS §44,
   * demo.ts rule 5). Demo Mode is exactly where the two names diverge.
   *
   * `modeAgency` — everything this process OBSERVED or DERIVED: trip_delay_obs, ghosts,
   * agg_delay, agg_delay_route, service_alerts. `'ttc-demo'` in demo mode, so replayed
   * observations can never be confused with live history. Enforced by the primary keys.
   *
   * BOTH DIRECTIONS OF THE MISTAKE ARE REAL BUGS, and this file has now shipped each one:
   *
   *   Hardcoding `'ttc'` everywhere (the original) meant a demo instance sharing a
   *   database with live rows served LIVE observations under the amber DEMO badge — a
   *   badge attached to data it does not describe.
   *
   *   Using the mode agency everywhere (the fix that overshot, caught by testers) meant a
   *   demo instance read the static tables under `'ttc-demo'`, where nothing is ever
   *   seeded, so EVERY static query returned zero rows. The visible result was a demo
   *   instance telling a rider standing at King & Spadina "No TTC stops within 800 m of
   *   you", with search and the planner both dead. That is the same dishonesty this
   *   attribution work exists to prevent, produced by a namespace bug instead of a copy
   *   bug — and it is why `staticAgency` and `modeAgency` are now separate names that
   *   cannot be typo'd into each other.
   */
  // Read off the poller rather than a module constant, so the two names stay the two facts
  // §48 established: which board is published, and whose observations these are. A second
  // agency changes the first of those, and a demo replay changes the second.
  const staticAgency = poller.getMode().staticAgency;
  const modeAgency = poller.getMode().agency;

  /**
   * THE AGENCY NAME THAT GOES ON THE WIRE for rows this poller itself produced.
   *
   * Always the STATIC agency, never `modeAgency`. In Demo Mode observations are stored
   * under 'ttc-demo', but that suffix is a storage namespace, not a transit system — a
   * rider looking at a replayed TTC alert is looking at a TTC alert. Sending 'ttc-demo'
   * would leak our bookkeeping into the UI and, worse, would not match the `agency` on the
   * stops and routes beside it, so the client could not join them. DECISIONS §44: a
   * recording is a recording OF the published board.
   *
   * Rows read from the STATIC tables carry their own `agency` column instead — see
   * `seeded` below — because those come from every agency, not just this poller's.
   */
  const wireAgency = staticAgency;

  /**
   * EVERY AGENCY THIS DEPLOYMENT SERVES, in configured order.
   *
   * The static read queries bind this whole list (`agency = ANY($1)`), not one name. The
   * poller still supplies `staticAgency` for the things genuinely about THIS poller — live
   * vehicle positions, the mode badge — but the published board a rider searches is the
   * union of everything seeded. Serving less than that union while polling all of it is the
   * silent half-coverage the Phase 0 boot refusal stood in for; this list is what replaced
   * that refusal.
   */
  const seededDescriptors = enabledAgencies();
  const seeded: string[] = seededDescriptors.map((a) => a.id);
  /** Sent on /api/health so the UI can state its coverage instead of hardcoding it. */
  const seededForWire = seededDescriptors.map((a) => ({ id: a.id, name: a.name }));

  /**
   * WHICH AGENCY AN ID-BEARING REQUEST IS ABOUT.
   *
   * `/api/stops/:id/arrivals` and `/api/routes/:id/shape` name an id that is unique only
   * within an agency, so once more than one is seeded the request is ambiguous without
   * `?agency=`. Rather than guess — the guess would silently serve a different city's stop
   * under the rider's stop id — the rules are:
   *
   *   - `?agency=` given: it must be a seeded agency, or 400. Never a silent fallback.
   *   - omitted, one agency seeded: that agency. The single-agency URL keeps working
   *     unchanged, which is what keeps every existing client and test honest.
   *   - omitted, several seeded: 400 naming the agencies, because there is no right answer
   *     and picking one would be a confident lie.
   */
  function resolveAgency(raw: string | undefined): { ok: true; agency: string } | { ok: false; error: string } {
    const a = raw?.trim();
    if (a != null && a !== '') {
      if (!seeded.includes(a)) {
        return { ok: false, error: `unknown agency '${a}' — this deployment serves: ${seeded.join(', ')}` };
      }
      return { ok: true, agency: a };
    }
    if (seeded.length === 1) return { ok: true, agency: seeded[0] };
    return {
      ok: false,
      error: `agency is required when more than one is served (${seeded.join(', ')}) — a stop id alone is ambiguous`,
    };
  }

  /**
   * The DATA clock. Live it is the wall clock; on a recording it is the capture instant of
   * the frame being replayed. Anything that DATES this API's output has to use it, so a
   * replayed board is judged against the moment its bytes came from rather than tonight.
   *
   * NOT used for the `trip_delay_obs.ts` / `ghosts.detected_at` cutoffs further down: those
   * columns are stamped by the database's own `DEFAULT now()`, so their cutoffs have to be
   * on the same wall clock. Mixing the two would compare a wall-clock column against a
   * capture-window instant. Those calls stay `Date.now()` and say so at each site.
   */
  const dataNow = (): number => poller.now();

  // ----- static caches loaded once (small, read-only) -----

  /**
   * KEYED BY (agency, route_id), NOT BY route_id.
   *
   * A bare `route_id` key is unique only WITHIN an agency, and measurement says the
   * collisions are not hypothetical: across the GTA feeds, Brampton shares 45 route_ids
   * with the TTC, MiWay 56, YRT 56. Keyed on the bare id, a Brampton bus would be rendered
   * with a TTC route's short name and brand colour — a confident, wrong label, which is
   * exactly the class of output this project exists not to produce.
   *
   * The composite key is built through `metaKey` so the delimiter is stated once. U+001F
   * never appears in a GTFS id, matching `dedupeByKey` in engine.ts and the SEP in
   * aggregate.ts.
   */
  const routeMeta = new Map<string, RouteMeta>();
  for (const r of (await db.query<{ agency: string; route_id: string; short_name: string | null; long_name: string | null; route_type: number | null; color: string | null }>(
    'SELECT agency, route_id, short_name, long_name, route_type, color FROM routes WHERE agency = ANY($1::text[])', [seeded])).rows) {
    routeMeta.set(metaKey(r.agency, r.route_id), { shortName: r.short_name, longName: r.long_name, routeType: r.route_type == null ? null : Number(r.route_type), color: r.color });
  }
  /** Route metadata for an id belonging to a named agency. */
  const routeMetaFor = (agencyId: string, routeId: string | null | undefined): RouteMeta | undefined =>
    routeId == null ? undefined : routeMeta.get(metaKey(agencyId, routeId));

  /**
   * WHICH ROUTES CALL AT A SET OF STOPS, from the published schedule.
   *
   * A BOUNDED QUERY, NOT A BOOT-TIME INDEX, and the choice is the whole point. The
   * obvious shape — precompute every stop's routes once at startup — is a `DISTINCT`
   * over all 2.15M `stop_times` rows, which is the exact scan migration 005 exists to
   * stop paying: on Render's free tier every wake is a fresh boot, so that cost recurs
   * forever and it is what exhausted the Neon transfer quota once already.
   *
   * This asks only about the handful of stops actually on screen. `idx_stop_times_stop_dep`
   * is `(agency, stop_id, departure_s)`, so `agency = $1 AND stop_id = ANY($2)` is an
   * index scan over one stop's worth of rows per id, joined to `trips` by its primary
   * key. A search page's 25 stops cost a few thousand index-scanned rows and return a
   * few dozen — small enough to run per request, on any agency, with no cache to go stale.
   *
   * EVERY STOP ASKED ABOUT GETS AN ANSWER, including `[]`. "We looked and found nothing"
   * and "we never looked" are different claims, and the caller can only keep them apart
   * if the empty case is present rather than missing.
   */
  const routesForStops = async (
    agencyId: string, stopIds: readonly string[],
  ): Promise<Map<string, StopRouteDto[]>> => {
    const out = new Map<string, StopRouteDto[]>();
    if (stopIds.length === 0) return out;
    const ids = [...new Set(stopIds)];
    for (const id of ids) out.set(id, []);
    const rows = (await db.query<{ stop_id: string; route_id: string }>(
      `SELECT DISTINCT st.stop_id, t.route_id
         FROM stop_times st
         JOIN trips t ON t.agency = st.agency AND t.trip_id = st.trip_id
        WHERE st.agency = $1 AND st.stop_id = ANY($2::text[]) AND t.route_id IS NOT NULL`,
      [agencyId, ids])).rows;
    for (const r of rows) {
      const meta = routeMetaFor(agencyId, r.route_id);
      out.get(r.stop_id)?.push({
        routeId: r.route_id,
        // The agency's own short name where it published one. Falling back to the id is
        // not cosmetic: a badge with no text is a coloured smudge a rider cannot act on.
        shortName: meta?.shortName?.trim() || r.route_id,
        color: colorFor(meta),
        routeType: meta?.routeType ?? null,
      });
    }
    for (const list of out.values()) list.sort((a, b) => compareRouteShortName(a.shortName, b.shortName));
    return out;
  };

  /** Fill `routes` on a set of stop DTOs, one query per agency involved. */
  const attachStopRoutes = async (stops: StopDto[]): Promise<void> => {
    const byAgency = new Map<string, StopDto[]>();
    for (const s of stops) {
      let a = byAgency.get(s.agency);
      if (!a) { a = []; byAgency.set(s.agency, a); }
      a.push(s);
    }
    await Promise.all([...byAgency].map(async ([agencyId, group]) => {
      // Agency-scoped, because a stop_id is unique only within an agency — 2,824 of them
      // are shared between the TTC and YRT alone, and a blended lookup would badge a TTC
      // stop with York Region routes.
      const found = await routesForStops(agencyId, group.map((s) => s.stopId));
      for (const s of group) s.routes = found.get(s.stopId) ?? [];
    }));
  };

  /**
   * Per-agency calendars. A `Map` rather than two bare arrays for the reason spelled out
   * over `activeServicesFor` below: one blended calendar is a silently-wrong board.
   */
  interface AgencyCalendar { calendar: CalendarRow[]; calendarDates: CalendarDateRow[] }
  const calendars = new Map<string, AgencyCalendar>();
  for (const agencyId of seeded) {
    const calendar: CalendarRow[] = (await db.query<{ service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; start_date: number; end_date: number }>(
      'SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency=$1', [agencyId])).rows
      .map((r) => ({ service_id: r.service_id, days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun] as CalendarRow['days'], start_date: Number(r.start_date), end_date: Number(r.end_date) }));
    const calendarDates: CalendarDateRow[] = (await db.query<{ service_id: string; date: number; exception_type: number }>(
      'SELECT service_id, date, exception_type FROM calendar_dates WHERE agency=$1', [agencyId])).rows
      .map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));
    calendars.set(agencyId, { calendar, calendarDates });
  }
  const EMPTY_CALENDAR: AgencyCalendar = { calendar: [], calendarDates: [] };
  const calendarFor = (agencyId: string): AgencyCalendar => calendars.get(agencyId) ?? EMPTY_CALENDAR;
  /**
   * SERVICE IDS ARE ONLY UNIQUE WITHIN AN AGENCY, SO THIS CACHE IS KEYED BY BOTH.
   *
   * The result of this function is bound straight into the arrivals query as
   * `t.service_id = ANY($3)` alongside `st.agency=$1`. If the calendar it resolves against
   * ever held more than one agency's rows, `$3` would be a blended set — and the agency
   * filter on `$1` does NOT protect against that, because it constrains which table rows
   * are considered, not which service ids are plausible. A service id active for agency B
   * on a Saturday would then activate agency A's identically-named service, and agency A's
   * board would render a full, confident arrivals list for a day those trips do not run.
   *
   * Measured across all ten GTA/GTHA feeds on 2026-07-26, service_id collision is currently
   * ZERO in every pair — the feeds use distinctive namespaces (TTC `1`,`2`,`501`; MiWay
   * `26AU03-CPBlock-Weekday-11`; DRT `Weekday`; GO `20260722`). So this is not a live bug.
   * It is also not something we control: ten independent organisations republish these on
   * their own schedules, and DRT's `Weekday` is exactly the kind of id another agency could
   * mint tomorrow. Taking the agency as an argument makes the blended call impossible to
   * write rather than merely unlikely, and costs nothing.
   */
  const activeSvcCache = new Map<string, string[]>();
  function activeServicesFor(agencyId: string, ymd: number, dow: number): string[] {
    const key = metaKey(agencyId, String(ymd));
    let s = activeSvcCache.get(key);
    if (!s) {
      const cal = calendarFor(agencyId);
      s = [...activeServiceIds(cal.calendar, cal.calendarDates, [{ ymd, dow }])];
      activeSvcCache.set(key, s);
    }
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
    // WALL clock: the trailing window below filters `trip_delay_obs.ts`, a `DEFAULT now()`
    // column, and this runs on a background timer rather than in a request.
    const now = Date.now();
    const since = new Date(now - WINDOW_DAYS * 86_400_000).toISOString();

    // 1. Watched cells: every whole hour with at least one delay observation. Toronto is
    //    a whole-hour offset from UTC, so a UTC hour bucket is also a Toronto hour bucket.
    const watched = new Set<string>();
    for (const r of (await db.query<{ hr: string | number }>(
      `SELECT DISTINCT FLOOR(EXTRACT(EPOCH FROM ts) / 3600)::bigint AS hr
       FROM trip_delay_obs WHERE agency=$1 AND ts >= $2`, [modeAgency, since])).rows) {
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
       GROUP BY route_id, service_id, start_s`, [staticAgency])).rows) {
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
      days.push({ ymd: d.ymd, midnightMs: midnightFor(d.ymd), serviceIds: activeServicesFor(staticAgency, d.ymd, d.dow) });
    }

    // 4. Numerator: confirmed no-shows only. A cancellation is an announced absence, not
    //    a broken promise, so it never enters the ghost rate.
    const ghosts: { routeId: string; scheduledStartMs: number }[] = [];
    for (const r of (await db.query<{ route_id: string | null; scheduled_start: string | Date }>(
      `SELECT route_id, scheduled_start FROM ghosts
       WHERE agency=$1 AND kind='ghost' AND scheduled_start >= $2`, [modeAgency, since])).rows) {
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
  /**
   * RATE LIMIT — RESCOPED, AND THIS FIXED A REPORTED USER-FACING BUG.
   *
   * The old budget was `max: 120` per minute per IP. That number came from spec-era
   * caution — it was never measured against what this app's own client actually costs —
   * and it is the direct cause of a rider's bug report: "when I allow it to use my
   * location it kept saying can't reach the live TTC feed right now".
   *
   * WHAT ONE HONEST SESSION COSTS, measured on the shipped client:
   *
   *   vehicles  /api/vehicles      12 req/min   (MapCard polls every 5s while visible)
   *   health    /api/health         3 req/min   (20s)
   *   arrivals  /api/stops/:id/…    2 req/min   (30s)
   *   alerts    /api/alerts         1 req/min   (60s)
   *   ghosts    /api/ghosts/feed    1 req/min   (60s)
   *                                --------
   *   steady state per open tab    ~19 req/min
   *
   * A cold load adds ~10-15 one-shot requests (nearby, route shape, stats, the
   * next-service probe walk, a search burst). So 120/min is only SIX open tabs' worth of
   * idle polling — and far fewer in practice, because every reload, every granted
   * location fix (which refetches nearby + arrivals + shape at the new coordinates),
   * every search keystroke burst and every ⌘K peek spends out of the same bucket.
   *
   * WHY THAT PRODUCED THE BUG RATHER THAN A GRACEFUL DEGRADE. Everything on one machine
   * shares one 127.0.0.1 bucket: the rider's tabs, a second window left open, and — on
   * the day of the report — automated verification suites hammering the same port. The
   * rider's own requests got the 429s. And a 429 from OUR server was rendered as "can't
   * reach the live TTC feed", i.e. we blamed the transit agency for our own throttling.
   * For an app whose entire thesis is honest attribution that is a first-class defect,
   * worse than the throttling itself. The client half of that fix is in web/src/lib/api.ts
   * (typed failure kinds + backoff) and DECISIONS §45; this half is making the ceiling
   * one a human cannot reach by using the app normally.
   *
   * THE NEW NUMBER, and why it is not simply "large". 600/min is ~31 tabs of steady-state
   * polling, or the same handful of tabs with generous headroom for reloads, location
   * grants, search bursts and a verification agent sharing the machine. It is still a
   * real ceiling: this is a read-only public JSON API over a local Postgres, the expensive
   * endpoints have their own tighter budgets below, and a genuine abuser sending hundreds
   * of requests a second is still stopped an order of magnitude short of hurting the box.
   * Chosen from the measurement above, not from caution.
   */
  const GLOBAL_MAX_PER_MIN = 600;
  /**
   * The two endpoints that are NOT cheap, kept on their own tighter budgets so raising the
   * global ceiling cannot turn into a way to make the database work hard.
   *
   *   /api/plan   runs the windowed board self-join (PLAN_SQL_ROW_LIMIT rows, two
   *               endpoint stop sets) — the heaviest query in the file.
   *   /api/stops  is a leading-wildcard ILIKE over the whole stops table, and the search
   *               sheet is the one place a human generates requests as fast as they type.
   *
   * Both are far above what the client can generate on its own: the search sheet debounces
   * to ~1 request per typing burst, and the planner issues at most two per destination. A
   * rider cannot reach these; a script pointed at them will.
   */
  const PLAN_MAX_PER_MIN = 60;
  const SEARCH_MAX_PER_MIN = 120;
  // Lower than the stop search on purpose: every miss here costs a stranger's free
  // endpoint a request, and the client already debounces past Nominatim's rate. This is
  // the backstop for a client that does not.
  const GEOCODE_MAX_PER_MIN = 20;

  /**
   * THE LIMITER COVERS /api/ ONLY. THE APP SHELL IS NEVER RATE-LIMITED.
   *
   * Registered at root scope it also guarded the static bundle, so a rider who reloaded
   * during a throttle was served raw 429 JSON instead of GhostBus — the app could not even
   * paint the honest "GhostBus is catching up" screen that the whole attribution fix exists
   * to show them. A reload is the first thing anyone does when an app looks stuck, and it
   * was the one action guaranteed to make things worse.
   *
   * `index.html` and the hashed assets are a handful of cacheable static files; they are
   * not what a budget is protecting. The budget protects the database behind /api/, and
   * that is now exactly what it is scoped to. The shell always loads, so the app can always
   * explain itself — and the API underneath it still says 429 honestly.
   */
  await app.register(rateLimit, {
    max: GLOBAL_MAX_PER_MIN,
    timeWindow: '1 minute',
    /**
     * Exempt everything that is not the API. `allowList` is the plugin's own hook for this
     * and returning true means "do not count, do not refuse".
     *
     * Deliberately NOT done by registering the limiter inside an encapsulated `/api` scope:
     * the routes below are registered on `app` itself, so a scoped plugin would apply the
     * limiter to nothing at all — a silent removal of the budget dressed up as a fix.
     *
     * GATED ON THE ROUTED PATH, NEVER ON `req.url` — that difference is a real bypass, not
     * a nicety. `req.url` is the RAW request target, while the router decodes before
     * matching: `GET /%61pi/plan` reads as "not /api" here but dispatches to `/api/plan`,
     * so a single curl loop would skip both the global and the per-route budgets entirely.
     * Absolute-form targets (`GET http://host/api/vehicles`) do the same. `routeOptions.url`
     * is the matched route PATTERN, decided before onRequest hooks run, so it cannot be
     * spelled around.
     *
     * UNMATCHED REQUESTS ARE NOT LIMITED, by either of two paths — measured, see §50.
     * With a bundle present, GET/HEAD misses match @fastify/static's `/*` wildcard, so this
     * hook DOES run and exempts them on that pattern; every other method, and everything
     * when no bundle is built, matches no route at all and never reaches this hook. That is
     * accepted deliberately: limiting the not-found handler would 429 the SPA shell during
     * an exhausted budget, and its branches are cheap 404s (§49 §2-§3).
     */
    allowList: (req) => {
      const routed = (req as { routeOptions?: { url?: string }; routerPath?: string }).routeOptions?.url
        ?? (req as { routerPath?: string }).routerPath;
      if (typeof routed === 'string') return !routed.startsWith('/api');
      // UNREACHABLE in both shipped configurations (§50): a request with no matched route
      // never reaches this hook. Kept as a guard in case a future route registers without a
      // pattern — it must fail closed, so an /api path is limited rather than exempted.
      let raw = req.url.split('?')[0];
      try { raw = decodeURIComponent(raw); } catch { return false; }
      return !raw.startsWith('/api');
    },
  });

  /** Per-route budget for the expensive endpoints. Fastify merges this with the global. */
  const routeLimit = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

  /**
   * Uniform JSON errors — never a stack trace, and always with the CULPRIT named.
   *
   * `kind` is the machine-readable fact the client keys its error copy off. It cannot do
   * that from an HTTP status alone, and when it had to guess it guessed "can't reach the
   * live TTC feed" — blaming the transit agency for our own rate limiter. A 4xx or 5xx
   * here is OUR server; it is never the agency's feed. That claim has exactly one honest
   * source in the whole system, `/api/health.feeds`, and nothing else may imply it.
   *
   * The 429 body is built HERE rather than in the limiter's `errorResponseBuilder`,
   * because @fastify/rate-limit raises its refusal as an error that lands in this handler
   * anyway — so a builder would have been a second code path whose richer fields this one
   * then discarded (measured: it did exactly that). The plugin's own response headers are
   * already set by the time we get here, so `retry-after` and `x-ratelimit-limit` are read
   * straight off the reply: one code path, and the numbers are the limiter's own rather
   * than a second guess at them.
   */
  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status === 429) {
      const headerNum = (name: string): number | undefined => {
        const raw = reply.getHeader(name);
        const n = Number(Array.isArray(raw) ? raw[0] : raw);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      return reply.code(429).send({
        statusCode: 429,
        kind: 'rateLimited',
        error: 'Too many requests to the GhostBus API from this address.',
        // Seconds until the window resets — what a backoff should actually wait.
        retryAfterSec: headerNum('retry-after') ?? 60,
        limit: headerNum('x-ratelimit-limit'),
      });
    }
    return reply.code(status).send({
      statusCode: status,
      kind: status < 500 ? 'badRequest' : 'serverError',
      error: status < 500 ? err.message : 'internal error',
    });
  });

  const bad = (reply: import('fastify').FastifyReply, msg: string) =>
    reply.code(400).send({ statusCode: 400, kind: 'badRequest', error: msg });

  // ---------- /api/health ----------
  app.get('/api/health', async (_req, reply) => {
    const h = poller.getFeedHealth();
    // Only the feeds this agency publishes appear, so an agency without (say) an alerts
    // feed reports no alerts key rather than a permanently-`down` one.
    const feeds: HealthResponse['feeds'] = {};
    for (const [key, st] of Object.entries(h.feeds) as Array<[FeedId, FeedRuntime | undefined]>) {
      if (!st) continue;
      feeds[key] = { status: st.status, lastOkMs: st.lastOkMs, sinceMs: st.sinceMs };
    }
    /**
     * `ok` means "the realtime we depend on is arriving". For an agency that publishes NO
     * realtime (Oakville), there is nothing to arrive and nothing is wrong — so an empty
     * feed set is `ok: true`, not a permanent red. The client keys "the agency's feed is
     * down" off this flag, and reporting an outage for a feed that never existed is the
     * §45 attribution bug one level up from the one CatchView already fixed.
     */
    const feedIds = Object.keys(feeds) as FeedId[];
    const ok = feedIds.length === 0 || feedIds.some((k) => feeds[k]?.status === 'ok');
    // The one response that has to state what it IS as well as what it says. `mode` and
    // `demo` are the client's only honest source for the amber DEMO badge; without them
    // a recording and a live feed are indistinguishable on the wire, which is exactly
    // the confusion Demo Mode exists to prevent (DECISIONS §44).
    const m = poller.getMode();
    const js = poller.getJoinStats();
    const body: HealthResponse = {
      ok, dbDriver: db.driver, lastPollAtMs: h.lastPollAtMs, collectorMode: 'in-process',
      feeds, boardCoverage: js.boardCoverage, agencies: seededForWire, serverNowMs: dataNow(),
      mode: m.mode, demo: m.demo,
      // `suppressionReason` is the engine's own sentence, passed through verbatim rather
      // than re-worded here: the log line and this field must never drift into two
      // different accounts of why the same gate refused.
      delayEngine: {
        suppressed: js.delayEngine.suppressionReason != null,
        reason: js.delayEngine.suppressionReason,
        gate: js.delayEngine.suppressionGate,
      },
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
      const meta = routeMetaFor(staticAgency, v.routeId);
      vehicles.push({
        agency: wireAgency,
        id: v.id, routeId: v.routeId, shortName: meta?.shortName ?? null, routeType: meta?.routeType ?? null,
        color: colorFor(meta), lat: v.lat, lon: v.lon, heading: v.heading, speedMs: v.speedMs, isGhost: false, ts: v.ts,
      });
    }
    const body: VehiclesResponse = {
      // DATA clock: these positions came out of a snapshot, and `serverNowMs` is what the
      // client ages them against. `lastPollAtMs` stays on the wall clock (it answers "is
      // our poll loop alive", which the poller stamps itself).
      vehicles, count: vehicles.length, lastPollAtMs: health.lastPollAtMs, serverNowMs: dataNow(),
      bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat],
    };
    return reply.send(body);
  });

  // ---------- /api/stops?q= ----------
  app.get('/api/stops', { config: routeLimit(SEARCH_MAX_PER_MIN) }, async (req, reply) => {
    const q = (req.query as Record<string, string | undefined>).q?.trim() ?? '';
    if (q.length === 0) return bad(reply, 'q is required');
    if (q.length > Q_MAX_LEN) return bad(reply, `q too long (max ${Q_MAX_LEN})`);
    const rows = (await db.query<{ agency: string; stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
      `SELECT agency, stop_id, name, lat, lon, wheelchair_boarding FROM stops
       WHERE agency = ANY($1::text[]) AND (stop_id = $2 OR name ILIKE $3) ORDER BY (stop_id = $2) DESC, name LIMIT $4`,
      [seeded, q, `%${q}%`, SEARCH_MAX_RESULTS])).rows;
    const stops: StopDto[] = rows.map((r) => ({ agency: r.agency, stopId: r.stop_id, name: r.name, lat: r.lat == null ? null : Number(r.lat), lon: r.lon == null ? null : Number(r.lon), wheelchairBoarding: r.wheelchair_boarding == null ? null : Number(r.wheelchair_boarding) }));
    // What SERVES this stop, so the row can say "504, 508 · 240 m" instead of showing a
    // rider our internal stop id.
    await attachStopRoutes(stops);
    const body: StopsResponse = { stops, count: stops.length };
    return reply.send(body);
  });

  // ---------- /api/geocode?q= ----------
  // Addresses, proxied to Nominatim. See geocode.ts for why this cannot be a client-side
  // call: the usage policy needs a User-Agent a browser is forbidden to set, and a rate
  // limit that only a single shared point can honour.
  //
  // A geocoder that does not know an address returns an EMPTY list and HTTP 200 — that is
  // an answer, not a failure, and the sheet says "nothing matches" rather than blaming the
  // network. Only a genuine upstream failure is a 502, which the client renders with its
  // ordinary degraded copy.
  app.get('/api/geocode', { config: routeLimit(GEOCODE_MAX_PER_MIN) }, async (req, reply) => {
    const q = (req.query as Record<string, string | undefined>).q?.trim() ?? '';
    if (q.length === 0) return bad(reply, 'q is required');
    if (q.length > Q_MAX_LEN) return bad(reply, `q too long (max ${Q_MAX_LEN})`);
    try {
      const results = await geocode(q);
      const body: GeocodeResponse = { results, q, attribution: OSM_ATTRIBUTION };
      return reply.send(body);
    } catch {
      // Upstream refused, timed out, or throttled US. Never the rider's fault and never
      // presented as an empty result, which would read as "this address does not exist".
      return reply.code(502).send({ statusCode: 502, kind: 'serverError', error: 'geocoder unavailable' });
    }
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
    const rows = (await db.query<{ agency: string; stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
      `SELECT agency, stop_id, name, lat, lon, wheelchair_boarding FROM stops
       WHERE agency = ANY($1::text[]) AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5`,
      [seeded, lat - dLat, lat + dLat, lon - dLon, lon + dLon])).rows;
    const stops: StopDto[] = [];
    for (const r of rows) {
      if (r.lat == null || r.lon == null) continue;
      const distanceM = haversineM(lat, lon, Number(r.lat), Number(r.lon));
      if (distanceM > radius) continue;
      stops.push({ agency: r.agency, stopId: r.stop_id, name: r.name, lat: Number(r.lat), lon: Number(r.lon), wheelchairBoarding: r.wheelchair_boarding == null ? null : Number(r.wheelchair_boarding), distanceM: Math.round(distanceM) });
    }
    stops.sort((a, b2) => (a.distanceM ?? 0) - (b2.distanceM ?? 0));

    /**
     * NOTHING IN RANGE IS A FACT THE RIDER NEEDS, AND IT NEEDS A NUMBER ATTACHED.
     *
     * This closes a reported bug in which a rider standing outside TTC coverage (spoofed
     * to Mississauga — MiWay territory) granted location, got an empty list, and the
     * client silently kept showing the DEFAULT downtown stop as though it were theirs.
     * "Here is your stop" about a stop 25 km away is the same class of lie as blaming the
     * agency for our own throttling: the UI asserting something that is not true.
     *
     * So when the radius comes back empty we answer the obvious next question — how far
     * away IS the nearest one — with the agency's own coordinates and our own haversine.
     * `nearest` is the honest bridge between "no coverage here" and a usable action, and
     * it is a MEASUREMENT, never a suggestion: the client is what decides whether 25 km
     * is worth offering, and it must relabel the view as a default location when it does.
     *
     * COST. One extra query, and only on the empty path — the case where we did no work.
     * It is ordered by squared planar degrees rather than a true great-circle distance so
     * it stays a plain index-friendly sort; the winner is then re-measured with the same
     * haversine as every other distance in this response, so the number we PRINT is never
     * the approximation we sorted by. Over a metro-sized stop table the difference between
     * the two orderings is nil, and a tie picked wrongly would still be a real stop with a
     * real, correctly-measured distance.
     */
    let nearest: StopDto | null = null;
    if (stops.length === 0) {
      const nr = (await db.query<{ agency: string; stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
        `SELECT agency, stop_id, name, lat, lon, wheelchair_boarding FROM stops
         WHERE agency = ANY($1::text[]) AND lat IS NOT NULL AND lon IS NOT NULL
         ORDER BY ((lat - $2) * (lat - $2) + (lon - $3) * (lon - $3) * $4) ASC
         LIMIT 1`,
        // Longitude degrees are shorter than latitude degrees by cos(lat); squaring that
        // ratio makes the planar sort isotropic instead of biased east-west.
        [seeded, lat, lon, Math.cos(lat * Math.PI / 180) ** 2])).rows[0];
      if (nr?.lat != null && nr.lon != null) {
        nearest = {
          agency: nr.agency,
          stopId: nr.stop_id, name: nr.name, lat: Number(nr.lat), lon: Number(nr.lon),
          wheelchairBoarding: nr.wheelchair_boarding == null ? null : Number(nr.wheelchair_boarding),
          distanceM: Math.round(haversineM(lat, lon, Number(nr.lat), Number(nr.lon))),
        };
      }
    }

    const body: StopsResponse = {
      stops: stops.slice(0, NEARBY_MAX_RESULTS),
      count: Math.min(stops.length, NEARBY_MAX_RESULTS),
      searchedRadiusM: Math.round(radius),
      ...(nearest ? { nearest } : {}),
    };
    return reply.send(body);
  });

  // ---------- /api/stops/:id/arrivals?windowMin=&at= ----------
  app.get<{ Params: { id: string } }>('/api/stops/:id/arrivals', async (req, reply) => {
    const stopId = req.params.id;
    if (!stopId || stopId.length > Q_MAX_LEN) return bad(reply, 'invalid stop id');
    const q = req.query as Record<string, string | undefined>;

    // DATA clock: "now" here means the moment the BOARD describes — the service day it
    // resolves, the window it scans, and whether a live ETA is close enough to "now" to
    // attach. On a recording all three have to be the capture instant, or a replayed
    // board is judged against tonight and comes back empty.
    const now = dataNow();
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

    const resolved = resolveAgency((req.query as Record<string, string | undefined>).agency);
    if (!resolved.ok) return bad(reply, resolved.error);
    const stopAgency = resolved.agency;
    const stopRow = (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
      'SELECT stop_id, name, lat, lon, wheelchair_boarding FROM stops WHERE agency=$1 AND stop_id=$2', [stopAgency, stopId])).rows[0];
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
      const svc = activeServicesFor(stopAgency, day.ymd, day.dow);
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
        [stopAgency, stopId, svc, Math.max(0, loSec), hiSec])).rows;
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
      'SELECT route_id, hour_of_week, n, p25, p50, p75 FROM agg_delay WHERE agency=$1 AND stop_id=$2', [modeAgency, stopId])).rows) {
      stopAgg.set(`${r.route_id}|${r.hour_of_week}`, { n: Number(r.n), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
    }
    const routesInvolved = [...new Set(trimmed.map((r) => r.routeId).filter((x): x is string => !!x))];
    const routeAgg = new Map<string, Agg>();
    if (routesInvolved.length > 0) {
      for (const r of (await db.query<{ route_id: string; hour_of_week: number; n: number; p25: number; p50: number; p75: number }>(
        'SELECT route_id, hour_of_week, n, p25, p50, p75 FROM agg_delay_route WHERE agency=$1 AND route_id = ANY($2::text[])', [modeAgency, routesInvolved])).rows) {
        routeAgg.set(`${r.route_id}|${r.hour_of_week}`, { n: Number(r.n), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
      }
    }

    const attachLive = Math.abs(atMs - now) < LIVE_ETA_MAX_SKEW_MS;
    const departures: DepartureDto[] = trimmed.map((r) => {
      const meta = routeMetaFor(stopAgency, r.routeId);
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
        agency: stopAgency,
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
      agency: stopAgency,
      stopId: stopRow.stop_id, stopName: stopRow.name,
      lat: stopRow.lat == null ? null : Number(stopRow.lat), lon: stopRow.lon == null ? null : Number(stopRow.lon),
      wheelchairBoarding: stopRow.wheelchair_boarding == null ? null : Number(stopRow.wheelchair_boarding),
      serverNowMs: now, atMs, windowMinutes: windowMin, departures,
      // The SCHEDULE's answer, not this window's. A board with nothing due for two hours
      // still serves the routes it serves, and the header says so.
      routes: (await routesForStops(stopAgency, [stopRow.stop_id])).get(stopRow.stop_id) ?? [],
    };
    return reply.send(body);
  });

  // ---------- /api/plan?fromLat=&fromLon=&toLat=&toLon=&at=&windowMin=&radius= ----------
  //
  // THE RIDE TIER IS SINGLE-RIDE ONLY, AND THAT IS THE POINT. A `ride` candidate exists
  // only when one real `trip_id` calls at a stop near the rider and LATER (strictly
  // greater stop_sequence) at a stop near the destination. A journey needing a transfer
  // produces no candidate here at all; it falls through to the stitching tiers below,
  // and if those find nothing either the answer names WHICH kind of nothing it is —
  // `beyondSearchDepth`, `searchBudgetExhausted`, `noService` or `transfer`. No tier ever
  // stitches two rides together and calls the result a single trip.
  //
  // The response is a small MENU, not a verdict: which option is best depends on how
  // fast the rider walks, and that preference stays on their device.
  app.get('/api/plan', { config: routeLimit(PLAN_MAX_PER_MIN) }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const num = (v: string | undefined) => (v == null || v.trim() === '' ? NaN : Number(v));
    const fromLat = num(q.fromLat), fromLon = num(q.fromLon);
    const toLat = num(q.toLat), toLon = num(q.toLon);
    const latOk = (n: number) => Number.isFinite(n) && n >= -90 && n <= 90;
    const lonOk = (n: number) => Number.isFinite(n) && n >= -180 && n <= 180;
    if (!latOk(fromLat)) return bad(reply, 'fromLat must be a number in [-90, 90]');
    if (!lonOk(fromLon)) return bad(reply, 'fromLon must be a number in [-180, 180]');
    if (!latOk(toLat)) return bad(reply, 'toLat must be a number in [-90, 90]');
    if (!lonOk(toLon)) return bad(reply, 'toLon must be a number in [-180, 180]');

    let radius = q.radius == null || q.radius.trim() === '' ? PLAN_DEFAULT_RADIUS_M : Number(q.radius);
    if (!Number.isFinite(radius) || radius <= 0) return bad(reply, 'radius must be a positive number (metres)');
    radius = Math.min(radius, PLAN_MAX_RADIUS_M);

    // DATA clock, for the same reason as the arrivals board: a plan is a statement about
    // departures on a service day, and on a recording that day is the capture window's.
    const now = dataNow();
    let atMs = now;
    if (q.at != null && q.at.trim() !== '') {
      const n = Number(q.at);
      atMs = Number.isFinite(n) ? n : Date.parse(q.at);
      if (!Number.isFinite(atMs)) return bad(reply, 'at must be epoch ms or an ISO datetime');
      if (atMs < AT_FLOOR_MS || atMs > now + AT_MAX_FUTURE_MS) return bad(reply, 'at must be between 2020-01-01 and 30 days from now');
    }
    let windowMin = q.windowMin == null || q.windowMin.trim() === '' ? PLAN_DEFAULT_WINDOW_MIN : Number(q.windowMin);
    if (!Number.isFinite(windowMin) || windowMin <= 0) return bad(reply, 'windowMin must be a positive number');
    windowMin = Math.min(windowMin, PLAN_MAX_WINDOW_MIN);
    const windowMs = windowMin * 60_000;

    const head = {
      from: { lat: fromLat, lon: fromLon }, to: { lat: toLat, lon: toLon },
      serverNowMs: now, atMs, windowMinutes: windowMin, radiusM: radius,
    };
    const answer = (
      outcome: PlanOutcome,
      candidates: RideCandidateDto[] = [],
      itineraries: ItineraryDto[] = [],
    ) => reply.send({ ...head, outcome, candidates, itineraries } satisfies PlanResponse);

    /** The real stops within `radius` of a point, nearest first. Same bounding-box +
     *  haversine method `/api/stops/nearby` uses, so the two can never disagree. */
    async function endpointStops(lat: number, lon: number): Promise<PlanStopDto[]> {
      const dLat = radius / 111_320;
      const dLon = radius / (111_320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
      const rows = (await db.query<{ agency: string; stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
        `SELECT agency, stop_id, name, lat, lon, wheelchair_boarding FROM stops
         WHERE agency = ANY($1::text[]) AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5`,
        [seeded, lat - dLat, lat + dLat, lon - dLon, lon + dLon])).rows;
      const out: PlanStopDto[] = [];
      for (const r of rows) {
        if (r.lat == null || r.lon == null) continue;
        const distanceM = haversineM(lat, lon, Number(r.lat), Number(r.lon));
        if (distanceM > radius) continue;
        out.push({
          agency: r.agency,
          stopId: r.stop_id, name: r.name, lat: Number(r.lat), lon: Number(r.lon),
          wheelchairBoarding: r.wheelchair_boarding == null ? null : Number(r.wheelchair_boarding),
          distanceM: Math.round(distanceM),
        });
      }
      out.sort((a, b) => a.distanceM - b.distanceM);
      return out.slice(0, PLAN_MAX_ENDPOINT_STOPS);
    }

    const [boardStops, alightStops] = await Promise.all([
      endpointStops(fromLat, fromLon),
      endpointStops(toLat, toLon),
    ]);
    // Short-circuit before any join: an empty id array would otherwise buy a scan that
    // can only ever return nothing.
    if (boardStops.length === 0) return answer('noStopsNearYou');
    if (alightStops.length === 0) return answer('noStopsNearDestination');

    // Keyed by (agency, stopId): the two ends can hold identically-numbered stops from
    // different agencies, and a bare-id map would silently pair a MiWay board with a TTC
    // alight and call it one ride.
    const boardById = new Map(boardStops.map((s) => [metaKey(s.agency, s.stopId), s]));
    const alightById = new Map(alightStops.map((s) => [metaKey(s.agency, s.stopId), s]));
    /**
     * A SINGLE-VEHICLE RIDE CANNOT CROSS AGENCIES, so the join runs once per agency that
     * has candidate stops at BOTH ends — never once across a blended id list. Blending
     * them would let `b.stop_id = ANY(...)` match a MiWay stop id against a TTC trip that
     * happens to serve the same number, inventing a ride nobody can take.
     */
    const idsFor = (stops: PlanStopDto[], a: string) => stops.filter((s) => s.agency === a).map((s) => s.stopId);
    const planAgencies = seeded.filter((a) => idsFor(boardStops, a).length > 0 && idsFor(alightStops, a).length > 0);

    // Every service date whose window can overlap [at, at+window] — sized to the window,
    // exactly as arrivals does, so a GTFS time past 24:00:00 lands on the day it runs
    // and a wide window never silently truncates at a service-day boundary.
    const dayList: Array<{ ymd: number; dow: number }> = [];
    const seenYmd = new Set<number>();
    for (let t = atMs - 86_400_000; t <= atMs + windowMs + 86_400_000; t += 86_400_000) {
      const d = torontoDay(t);
      if (!seenYmd.has(d.ymd)) { seenYmd.add(d.ymd); dayList.push(d); }
    }

    interface RawRide {
      /** Which agency's board this ride came off — the two ends are always the same one. */
      agency: string;
      tripId: string; routeId: string | null; headsign: string | null; directionId: number | null;
      boardStopId: string; boardStopSequence: number; departureMs: number;
      alightStopId: string; alightStopSequence: number; arrivalMs: number;
      boardDistanceM: number; alightDistanceM: number;
      /** seconds since the service day's midnight — what ranking orders on. */
      departureS: number;
    }
    const raw: RawRide[] = [];

    for (const planAgency of planAgencies) {
    const boardIds = idsFor(boardStops, planAgency);
    const alightIds = idsFor(alightStops, planAgency);
    for (const day of dayList) {
      const svc = activeServicesFor(planAgency, day.ymd, day.dow);
      if (svc.length === 0) continue;
      const midnight = midnightFor(day.ymd);
      const loSec = Math.floor((atMs - midnight) / 1000);
      const hiSec = Math.ceil((atMs + windowMs - midnight) / 1000);
      if (hiSec < 0) continue;

      // The whole planner, in one join: b and a are the SAME trip, a strictly later in
      // the sequence. Ordered by boarding time first, so if the row cap ever bites it
      // can only ever drop the LATEST options — never the soonest ones a rider wants.
      const rows = (await db.query<{
        trip_id: string; route_id: string | null; headsign: string | null; direction_id: number | null;
        board_stop: string; board_seq: number; board_s: number | null;
        alight_stop: string; alight_seq: number; alight_s: number | null;
      }>(
        `SELECT b.trip_id, t.route_id, t.headsign, t.direction_id,
                b.stop_id AS board_stop, b.stop_sequence AS board_seq,
                COALESCE(b.departure_s, b.arrival_s) AS board_s,
                a.stop_id AS alight_stop, a.stop_sequence AS alight_seq,
                COALESCE(a.arrival_s, a.departure_s) AS alight_s
         FROM stop_times b
         JOIN stop_times a ON a.agency = b.agency AND a.trip_id = b.trip_id
                          AND a.stop_sequence > b.stop_sequence
         JOIN trips t ON t.agency = b.agency AND t.trip_id = b.trip_id
         WHERE b.agency = $1
           AND b.stop_id = ANY($2::text[])
           AND a.stop_id = ANY($3::text[])
           AND t.service_id = ANY($4::text[])
           AND COALESCE(b.departure_s, b.arrival_s) BETWEEN $5 AND $6
         ORDER BY COALESCE(b.departure_s, b.arrival_s), b.trip_id, a.stop_sequence
         LIMIT $7`,
        [planAgency, boardIds, alightIds, svc, Math.max(0, loSec), hiSec, PLAN_SQL_ROW_LIMIT])).rows;

      for (const r of rows) {
        if (r.board_s == null || r.alight_s == null) continue;
        const departureMs = midnight + Number(r.board_s) * 1000;
        const arrivalMs = midnight + Number(r.alight_s) * 1000;
        // Re-filter against the REAL window: the per-day second range is a superset at
        // the edges, and a service day is not the same thing as a wall-clock day.
        if (departureMs < atMs || departureMs > atMs + windowMs) continue;
        // A ride that arrives before it departs is a broken feed row, not a journey.
        if (arrivalMs <= departureMs) continue;
        const board = boardById.get(metaKey(planAgency, r.board_stop));
        const alight = alightById.get(metaKey(planAgency, r.alight_stop));
        if (!board || !alight) continue;
        raw.push({
          agency: planAgency,
          tripId: r.trip_id, routeId: r.route_id, headsign: r.headsign,
          directionId: r.direction_id == null ? null : Number(r.direction_id),
          boardStopId: r.board_stop, boardStopSequence: Number(r.board_seq), departureMs,
          alightStopId: r.alight_stop, alightStopSequence: Number(r.alight_seq), arrivalMs,
          boardDistanceM: board.distanceM, alightDistanceM: alight.distanceM,
          departureS: Math.round(departureMs / 1000),
        });
      }
      // One breath per (agency, day) statement. The board is in-process and single
      // threaded, so without this the whole sweep is one unbroken tick and every other
      // rider's request waits behind all of it (rule 5, itinerary.ts).
      await breathe();
    }
    }

    /**
     * THE WALL, AND IT STARTS HERE — not at the top of the handler. See rule 5 in
     * itinerary.ts for what it is for; this is about where its clock begins.
     *
     * The rate limit above bounds how MANY plans one IP may ask for; it cannot bound what
     * one of them costs, and the cost is what froze the board for the city. This does. It
     * is checked at tier and per-day boundaries rather than mid-query, because the database
     * call already running is not something this process can cancel.
     *
     * IT DELIBERATELY DOES NOT COVER THE SINGLE-RIDE TIER ABOVE, and starting the clock at
     * the top of the handler amounted to the same thing by the back door — MEASURED on the
     * live board, not reasoned about: the ride tier plus the exists-ever probe spend eight
     * to ten seconds on a wide cross-region query, so a wall started at request entry was
     * already spent before the first stitching statement, and four journeys the planner
     * used to answer (Steeles/Etobicoke Creek to Union, Harmony to SMARTVMC, VMC to
     * Scarborough) came back as refusals instead of the two- and three-leg itineraries
     * they really have. A budget that refuses answers the search can find is not a budget,
     * it is an outage with better manners.
     *
     * So the wall bounds the STITCHING SWEEP, which is the part that is actually unbounded
     * in shape and where being cut short has an honest name to report itself under. The
     * ride tier stays outside it for its own reason: it is capped by PLAN_SQL_ROW_LIMIT,
     * and truncating it would quietly shorten a MENU — dropping real rides the rider was
     * entitled to see, with nothing on the wire to say some were dropped.
     */
    const budget = startSearchBudget(planBudgetMs);

    if (raw.length === 0) {
      // Nothing departs in the window. Two very different facts hide behind that, and
      // the rider deserves to know which. This probe is used ONLY as a NEGATIVE signal:
      // no row means no trip in the entire published schedule links these two stop sets,
      // so the journey genuinely needs a transfer. A row coming back proves only that
      // some trip does it on some service day — never that one is running tonight —
      // which is exactly what 'noService' claims and no more.
      // Asked per agency, for the same reason the main join is: one agency's board must
      // never be searched with another agency's stop ids.
      let anyDirect = false;
      for (const planAgency of planAgencies) {
        const hit = (await db.query<{ ok: number }>(
          `SELECT 1 AS ok FROM stop_times b
           JOIN stop_times a ON a.agency = b.agency AND a.trip_id = b.trip_id
                            AND a.stop_sequence > b.stop_sequence
           WHERE b.agency = $1 AND b.stop_id = ANY($2::text[]) AND a.stop_id = ANY($3::text[])
           LIMIT 1`, [planAgency, idsFor(boardStops, planAgency), idsFor(alightStops, planAgency)])).rows.length > 0;
        if (hit) { anyDirect = true; break; }
        await breathe();
      }
      // TIERS 2 AND 3. No single vehicle does it — but two joined by a walk often do,
      // and across the region's agency boundaries sometimes only three do. This
      // is the only place that question gets asked. Strictly additive: it runs only on a
      // journey the planner was already about to refuse, so the ride tier above cannot
      // be affected by anything below. An empty result falls through to the refusal that
      // shipped before this tier existed, word for word.
      const stitched = await findItineraries();
      if (stitched.kind === 'found') return answer(stitched.outcome, [], stitched.itineraries);
      /**
       * FOUR REFUSALS, AND THEY ARE NOT INTERCHANGEABLE. Ordered by how much each one has
       * actually PROVED, most-proved first.
       *
       * 'noService' leads because it is the only one of the four that is a proven fact
       * about the schedule rather than a statement about our search. Both halves of it
       * were established by statements that ran to completion — the windowed join and the
       * exists-ever probe are outside the budget — so an unfinished stitching sweep cannot
       * make it any less true. It is also the most useful thing we can say, and the copy
       * claims nothing about transfers, so nothing is smuggled in with it.
       *
       * 'searchBudgetExhausted' comes next and outranks both findings below it, because a
       * search that was cut short is not evidence of anything. Reporting it as a finding
       * would be claiming to have looked where we stopped looking.
       *
       * 'beyondSearchDepth' is a real finding, bounded by its own words: one, two and
       * three rides were all searched and none of them connects.
       *
       * 'transfer' survives for exactly one case: nothing at all runs from the rider's
       * stops (or to the destination's) inside the window, so the stitching tiers had no
       * material to work with. Saying "this needs a fourth ride" there would be inventing
       * a conclusion out of an empty board — the same class of lie in the other direction.
       */
      if (anyDirect) return answer('noService');
      if (stitched.kind === 'budget') return answer('searchBudgetExhausted');
      return answer(stitched.kind === 'exhausted' ? 'beyondSearchDepth' : 'transfer');
    }

    await breathe();
    const ranked = rankRideCandidates(raw);
    return answer('ride', await buildCandidates(ranked, staticAgency,
      (r) => boardById.get(metaKey(r.agency, r.boardStopId)),
      (r) => alightById.get(metaKey(r.agency, r.alightStopId))));

    /**
     * Turn ranked rides into full candidates — evidence, grade, ghost risk and all.
     *
     * EXTRACTED SO BOTH TIERS SHARE ONE PIPELINE. A two-leg itinerary's legs are
     * `RideCandidateDto`s like any other, and building them anywhere else would mean a
     * second implementation of the honest-ETA precedence that could drift from this one
     * — the exact failure `boardingInstant` exists to prevent one layer up.
     *
     * The two callers differ only in where a ride's endpoints are LOOKED UP: the direct
     * tier resolves both against the rider's and destination's own stop sets, while a
     * two-leg leg has one endpoint at a transfer stop that is in neither.
     *
     * `metaAgency` is passed rather than read off the ride ON PURPOSE. The direct tier
     * has always resolved route metadata against `staticAgency` — this poller's own
     * board — and changing that would alter what the single-ride path returns for a
     * non-TTC agency, which is not this change's business to do quietly. (It does look
     * wrong: a MiWay ride asked for TTC's route table gets no name and a default colour.
     * Left exactly as found, and reported rather than fixed in passing.) The two-leg
     * tier, which has no such history, passes each leg's OWN agency.
     */
    async function buildCandidates(
      rides: readonly RawRide[],
      metaAgency: string | ((r: RawRide) => string),
      boardFor: (r: RawRide) => PlanStopDto | undefined,
      alightFor: (r: RawRide) => PlanStopDto | undefined,
    ): Promise<RideCandidateDto[]> {
    // Evidence for the BOARDING departure, on exactly the terms a departure board uses:
    // this stop's own history where there is enough of it, the route-hour rollup where
    // there is not, and no estimate at all where there is neither.
    /**
     * KEYED BY AGENCY, AND ASKED PER AGENCY.
     *
     * These maps used to be keyed `${stop}|${route}|${how}` with the rows fetched for
     * `modeAgency` alone — safe while a plan could only ever be one agency's, and wrong
     * the moment the two-leg tier spans several. Two distinct failures, both silent:
     * a MiWay route `26` would read TTC's route-26 history and print TTC's grade beside
     * a MiWay bus, and MiWay's own history could never be reached at all because it was
     * never queried. Same bug class as the `routeMetaFor` collision noted below, and the
     * reason this one is worth spelling out: the FIX for that one was to pass the
     * agency, and these maps quietly did not.
     *
     * Demo Mode is why the lookup agency is `obsAgencyFor` rather than the ride's own id:
     * observations are written under `modeAgency` for whichever agency this poller
     * observes, and under the ride's own agency for every other one.
     */
    const obsAgencyFor = (agencyId: string) => (agencyId === staticAgency ? modeAgency : agencyId);
    const byAgg = new Map<string, { stops: Set<string>; routes: Set<string> }>();
    for (const r of rides) {
      if (!r.routeId) continue;
      const key = obsAgencyFor(r.agency);
      let e = byAgg.get(key);
      if (!e) { e = { stops: new Set(), routes: new Set() }; byAgg.set(key, e); }
      e.stops.add(r.boardStopId);
      e.routes.add(r.routeId);
    }
    const stopAgg = new Map<string, Agg>(); // `${agency}|${stop}|${route}|${how}`
    const routeAgg = new Map<string, Agg>(); // `${agency}|${route}|${how}`
    await Promise.all([...byAgg].map(async ([aggAgency, { stops, routes }]) => {
      const stopsInvolved = [...stops];
      const routesInvolved = [...routes];
      const [sRows, rRows] = await Promise.all([
        db.query<{ stop_id: string; route_id: string; hour_of_week: number; n: number; p25: number; p50: number; p75: number }>(
          `SELECT stop_id, route_id, hour_of_week, n, p25, p50, p75 FROM agg_delay
           WHERE agency=$1 AND stop_id = ANY($2::text[]) AND route_id = ANY($3::text[])`,
          [aggAgency, stopsInvolved, routesInvolved]),
        db.query<{ route_id: string; hour_of_week: number; n: number; p25: number; p50: number; p75: number }>(
          `SELECT route_id, hour_of_week, n, p25, p50, p75 FROM agg_delay_route
           WHERE agency=$1 AND route_id = ANY($2::text[])`, [aggAgency, routesInvolved]),
      ]);
      for (const r of sRows.rows) {
        stopAgg.set(`${aggAgency}|${r.stop_id}|${r.route_id}|${r.hour_of_week}`, { n: Number(r.n), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
      }
      for (const r of rRows.rows) {
        routeAgg.set(`${aggAgency}|${r.route_id}|${r.hour_of_week}`, { n: Number(r.n), p25: Number(r.p25), p50: Number(r.p50), p75: Number(r.p75) });
      }
    }));

    await breathe();
    const candidates: RideCandidateDto[] = [];
    for (const r of rides) {
      // A ride whose endpoints cannot both be resolved is dropped rather than shipped
      // with a hole. The direct tier could assert here — its rides came FROM these maps —
      // but the two-leg tier resolves one end against transfer stops, and a missing one
      // there must not become an `undefined` board on the wire.
      const board = boardFor(r);
      const alight = alightFor(r);
      if (!board || !alight) continue;
      const meta = routeMetaFor(typeof metaAgency === 'string' ? metaAgency : metaAgency(r), r.routeId);
      const how = hourOfWeek(r.departureMs);
      const aggAgency = obsAgencyFor(r.agency);
      const sAgg = r.routeId ? stopAgg.get(`${aggAgency}|${r.boardStopId}|${r.routeId}|${how}`) ?? null : null;
      const rAgg = r.routeId ? routeAgg.get(`${aggAgency}|${r.routeId}|${how}`) ?? null : null;
      const ev = selectEvidence(sAgg, rAgg);
      const hasEst = ev.bucket !== 'none' && ev.p50 != null;
      const liveEtaMs = Math.abs(r.departureMs - now) < LIVE_ETA_MAX_SKEW_MS
        ? poller.getLivePredictionMs(r.tripId, r.boardStopId)
        : null;
      const grade = hasEst ? gradeFor(ev.bucket, ev.n, spreadMinutes(ev.p25 as number, ev.p75 as number)) : null;
      // The ghost forecast is built for THIS poller's agency only (see `kickForecast`),
      // and its cells are keyed by bare route id — so applying it to another agency's leg
      // would hand a MiWay route its TTC namesake's ghost history. No forecast for an
      // agency this process does not observe is the honest answer, and it is also the
      // true one: nothing has been observed to forecast from.
      const cell = r.routeId && aggAgency === modeAgency ? forecast.get(`${r.routeId}|${how}`) : undefined;
      const ghostRisk = cell ? ghostRiskFor(cell.ghosts, cell.scheduled, WINDOW_DAYS) : null;

      const c: RideCandidateDto = {
        tripId: r.tripId, routeId: r.routeId,
        shortName: meta?.shortName ?? null, longName: meta?.longName ?? null,
        routeType: meta?.routeType ?? null, color: colorFor(meta),
        headsign: r.headsign, directionId: r.directionId,
        directionLabel: r.headsign ?? (r.directionId == null ? 'Unknown' : `Direction ${r.directionId}`),
        board,
        alight,
        boardStopSequence: r.boardStopSequence, alightStopSequence: r.alightStopSequence,
        stopsRidden: r.alightStopSequence - r.boardStopSequence,
        departureMs: r.departureMs, arrivalMs: r.arrivalMs, liveEtaMs,
        honest: {
          estimateMs: hasEst ? r.departureMs + (ev.p50 as number) * 1000 : null,
          bandLowMs: hasEst ? r.departureMs + (ev.p25 as number) * 1000 : null,
          bandHighMs: hasEst ? r.departureMs + (ev.p75 as number) * 1000 : null,
          medianDelaySec: hasEst ? (ev.p50 as number) : null,
        },
        evidence: { n: ev.n, windowDays: WINDOW_DAYS, bucket: ev.bucket },
      };
      if (grade) c.grade = grade;
      if (ghostRisk) c.ghostRisk = ghostRisk;
      candidates.push(c);
    }
    return candidates;
    }

    /**
     * One half of the two-leg search: every ride from a fixed set of stops to ANYWHERE
     * downstream (`end: 'board'`), or from ANYWHERE upstream to a fixed set of stops
     * (`end: 'alight'`).
     *
     * This is the direct tier's own self-join with ONE end unconstrained, which is what
     * makes it a transfer search: the unconstrained end enumerates transfer candidates.
     * Both directions stay well-indexed — `idx_stop_times_stop_dep` serves the fixed end
     * and the `(agency, trip_id, …)` primary key serves the join to the other.
     */
    async function legRides(
      agencyId: string, fixedStopIds: string[], end: 'board' | 'alight', horizonMs: number,
    ): Promise<RawRide[]> {
      if (fixedStopIds.length === 0) return [];
      const out: RawRide[] = [];
      const fixedSide = end === 'board' ? 'b' : 'a';
      // A marker, not decoration: this statement is the direct join with one end
      // unconstrained, so without it the two are indistinguishable in a query log — and
      // in the tests, which match statements by substring. `end` is a literal union, so
      // there is nothing interpolable here from a request.
      const tag = end === 'board' ? 'two-leg:from-rider' : 'two-leg:to-destination';
      let issued = 0;
      for (const day of dayList) {
        /**
         * THE WALL TRIMS THE SWEEP; IT NEVER CANCELS THE SEARCH.
         *
         * `break`, never `return []`: a truncated day list is still real board rows, and a
         * genuine two-leg journey found among them beats refusing over the days we did not
         * reach. And `issued > 0` so at least ONE service day is always fetched — a wall
         * that fires before any statement leaves an empty set behind, which can only ever
         * refuse, which would make an expired budget an off switch rather than a bound.
         */
        if (issued > 0 && budget.expired()) break;
        const svc = activeServicesFor(agencyId, day.ymd, day.dow);
        if (svc.length === 0) continue;
        const midnight = midnightFor(day.ymd);
        const loSec = Math.floor((atMs - midnight) / 1000);
        const hiSec = Math.ceil((atMs + horizonMs - midnight) / 1000);
        if (hiSec < 0) continue;
        const rows = (await db.query<{
          trip_id: string; route_id: string | null; headsign: string | null; direction_id: number | null;
          board_stop: string; board_seq: number; board_s: number | null;
          alight_stop: string; alight_seq: number; alight_s: number | null;
        }>(
          `SELECT /* ${tag} */ b.trip_id, t.route_id, t.headsign, t.direction_id,
                  b.stop_id AS board_stop, b.stop_sequence AS board_seq,
                  COALESCE(b.departure_s, b.arrival_s) AS board_s,
                  a.stop_id AS alight_stop, a.stop_sequence AS alight_seq,
                  COALESCE(a.arrival_s, a.departure_s) AS alight_s
           FROM stop_times b
           JOIN stop_times a ON a.agency = b.agency AND a.trip_id = b.trip_id
                            AND a.stop_sequence > b.stop_sequence
           JOIN trips t ON t.agency = b.agency AND t.trip_id = b.trip_id
           WHERE b.agency = $1
             AND ${fixedSide}.stop_id = ANY($2::text[])
             AND t.service_id = ANY($3::text[])
             AND COALESCE(b.departure_s, b.arrival_s) BETWEEN $4 AND $5
           ORDER BY COALESCE(b.departure_s, b.arrival_s), b.trip_id, a.stop_sequence
           LIMIT $6`,
          [agencyId, fixedStopIds, svc, Math.max(0, loSec), hiSec, TWO_LEG_SQL_ROW_LIMIT])).rows;
        issued++;
        for (const r of rows) {
          if (r.board_s == null || r.alight_s == null) continue;
          const departureMs = midnight + Number(r.board_s) * 1000;
          const arrivalMs = midnight + Number(r.alight_s) * 1000;
          if (departureMs < atMs || departureMs > atMs + horizonMs) continue;
          if (arrivalMs <= departureMs) continue;
          out.push({
            agency: agencyId,
            tripId: r.trip_id, routeId: r.route_id, headsign: r.headsign,
            directionId: r.direction_id == null ? null : Number(r.direction_id),
            boardStopId: r.board_stop, boardStopSequence: Number(r.board_seq), departureMs,
            alightStopId: r.alight_stop, alightStopSequence: Number(r.alight_seq), arrivalMs,
            // The FIXED end carries its real walk to the rider or the destination; the
            // free end is a transfer stop, whose walk is not this leg's to state — it is
            // the itinerary's, and it travels in `transfer.distanceM`.
            boardDistanceM: end === 'board' ? (boardById.get(metaKey(agencyId, r.board_stop))?.distanceM ?? 0) : 0,
            alightDistanceM: end === 'alight' ? (alightById.get(metaKey(agencyId, r.alight_stop))?.distanceM ?? 0) : 0,
            departureS: Math.round(departureMs / 1000),
          });
        }
        await breathe();
      }
      return out;
    }

    /**
     * Two rides joined by a walkable transfer — or three joined by two — or nothing.
     *
     * The stitching rules — the slack floor, the walk cap, the wait ceiling, the total-time
     * budget, ranking by arrival — all live in `itinerary.ts`, pure and tested. This
     * function's whole job is to feed it real board rows and turn what comes back into
     * wire DTOs.
     *
     * TWO IS TRIED FIRST AND THREE ONLY IF TWO FAILS, which is not an optimisation but the
     * honesty rule: a journey that can be done with one transfer is never shown with two.
     *
     * WHAT IT RETURNS IS NOT A BOOLEAN. It used to be an itinerary set or `null`, and the
     * caller turned `null` into "needs a transfer" — which was true when the only way to
     * get here was an exhausted search, and became a lie the moment a search could also be
     * stopped by a clock. So the three ways this can end are three distinct answers, and
     * `budget` is the one that must never be collapsed into either of the others.
     */
    async function findItineraries(): Promise<PlanSearchResult> {
      // Deliberately NOT `planAgencies`: that set is agencies with stops at BOTH ends,
      // which is exactly the wrong filter here. The journey this tier exists for is
      // MiWay to the edge of Toronto and TTC onwards, and neither agency has stops at
      // both ends of it.
      const fromAgencies = seeded.filter((a) => idsFor(boardStops, a).length > 0);
      const toAgencies = seeded.filter((a) => idsFor(alightStops, a).length > 0);
      // Both halves, every agency, in parallel. These probes are the widest statements
      // the planner issues and they run on EVERY journey the ride tier refuses, which on
      // a multi-agency deployment is most cross-boundary ones — serialising ten of them
      // made the refusal path the slowest thing in the app. They are independent reads.
      const [leg1Sets, legLastSets] = await Promise.all([
        Promise.all(fromAgencies.map((a) => legRides(a, idsFor(boardStops, a), 'board', windowMs))),
        Promise.all(toAgencies.map((a) => legRides(a, idsFor(alightStops, a), 'alight', windowMs + TWO_LEG_HORIZON_MS))),
      ]);
      const leg1 = leg1Sets.flat();
      const legLast = legLastSets.flat();
      // THE BUDGET IS ASKED BEFORE THE EMPTINESS IS INTERPRETED, and the order matters:
      // an expired budget can itself be the reason a set came back empty (legRides breaks
      // out of its day loop at the wall), so reading "no rides at all" off a truncated
      // fetch would report a fact about the board that is really a fact about the clock.
      if (budget.expired() && (leg1.length === 0 || legLast.length === 0)) return { kind: 'budget' };
      if (leg1.length === 0 || legLast.length === 0) return { kind: 'noRides' };

      /**
       * The search found nothing. WHICH truth that is depends on one question only: did it
       * get to the end, or did it stop? Every dead end below routes through here rather
       * than deciding for itself, so no path can ever grow a claim of exhaustion that the
       * clock has not earned.
       */
      const nothing = (): PlanSearchResult => (budget.expired() ? { kind: 'budget' } : { kind: 'exhausted' });

      // Coordinates for every stop a transfer could happen at. Keyed by (agency, stop)
      // because two agencies routinely number different stops the same.
      const transferById = new Map<string, PlanStopDto>();
      const stitchStops: StitchStop[] = [];
      const stitchByKey = new Map<string, StitchStop>();
      /**
       * Resolve (agency, stop) ids into transfer ground, skipping anything already known.
       * Additive on purpose: every stop learned here stays available to every later stitch
       * in this request, so the three-leg search never re-reads the two-leg search's stops.
       */
      async function learnStops(wanted: Iterable<{ agency: string; stopId: string }>): Promise<StitchStop[]> {
        const byAgency = new Map<string, string[]>();
        for (const w of wanted) {
          if (transferById.has(metaKey(w.agency, w.stopId))) continue;
          const list = byAgency.get(w.agency);
          if (list) list.push(w.stopId); else byAgency.set(w.agency, [w.stopId]);
        }
        const learned: StitchStop[] = [];
        for (const [agencyId, ids] of byAgency) {
          await breathe();
          for (const r of (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null; wheelchair_boarding: number | null }>(
            `SELECT stop_id, name, lat, lon, wheelchair_boarding FROM stops
             WHERE agency = $1 AND stop_id = ANY($2::text[])`, [agencyId, ids])).rows) {
            if (r.lat == null || r.lon == null) continue;
            const k = metaKey(agencyId, r.stop_id);
            if (transferById.has(k)) continue;
            transferById.set(k, {
              agency: agencyId, stopId: r.stop_id, name: r.name,
              lat: Number(r.lat), lon: Number(r.lon),
              wheelchairBoarding: r.wheelchair_boarding == null ? null : Number(r.wheelchair_boarding),
              // ZERO ON PURPOSE: `distanceM` means "from the query point this stop belongs
              // to", and a transfer stop belongs to no query point. The walk that matters
              // here is between two transfer stops, and it is stated once PER SEAM in
              // `transfers[i].distanceM` rather than half-implied twice.
              distanceM: 0,
            });
            const st = { agency: agencyId, stopId: r.stop_id, lat: Number(r.lat), lon: Number(r.lon) };
            stitchStops.push(st);
            stitchByKey.set(k, st);
            learned.push(st);
          }
        }
        return learned;
      }

      const seam = new Map<string, { agency: string; stopId: string }>();
      for (const r of leg1) seam.set(metaKey(r.agency, r.alightStopId), { agency: r.agency, stopId: r.alightStopId });
      for (const r of legLast) seam.set(metaKey(r.agency, r.boardStopId), { agency: r.agency, stopId: r.boardStopId });
      await learnStops(seam.values());

      const two = await stitchItineraries(leg1, legLast, stitchStops, {
        paceMps: TRANSFER_PACE_MPS, limit: PLAN_MAX_ITINERARIES, breathe,
      });
      if (two.length > 0) {
        const itineraries = await toItineraryDtos(two);
        // A FOUND ANSWER IS RETURNED WHATEVER THE CLOCK SAYS. The budget exists to stop
        // searching, never to throw away a journey the search already has in its hands.
        if (itineraries.length > 0) return { kind: 'found', outcome: 'twoLeg', itineraries };
      }

      // THE TIER BOUNDARY, and the one place the wall is worth the coverage it costs. The
      // third tier is the widest thing the planner does — a middle leg touching neither
      // query point — and it is where the 25 s searches were measured. Starting it with
      // the budget already spent buys nothing but a longer freeze.
      if (budget.expired()) return { kind: 'budget' };

      // TIER 3. No single vehicle, and no single transfer either. A middle leg touches
      // NEITHER query point, so its candidate stops cannot come from a radius around the
      // rider — they come from the transfer ground the outer legs already reach, expanded
      // by exactly one walk cap and no further. That expansion is the only thing keeping
      // this from being a region-wide graph search, so the bounding box below is narrowed
      // to the REAL cap by `withinTransferWalk` before a single ride is asked for.
      const anchorsIn: StitchStop[] = [];
      for (const r of leg1) { const st = stitchByKey.get(metaKey(r.agency, r.alightStopId)); if (st) anchorsIn.push(st); }
      const anchorsOut: StitchStop[] = [];
      for (const r of legLast) { const st = stitchByKey.get(metaKey(r.agency, r.boardStopId)); if (st) anchorsOut.push(st); }
      if (anchorsIn.length === 0 || anchorsOut.length === 0) return nothing();

      /** Every stop within one transfer walk of these anchors, learned and returned. */
      async function walkableFrom(anchors: readonly StitchStop[]): Promise<StitchStop[]> {
        const lats = anchors.map((a) => a.lat);
        const lons = anchors.map((a) => a.lon);
        const dLat = TRANSFER_MAX_WALK_M / 111_320;
        const dLon = TRANSFER_MAX_WALK_M / (111_320 * Math.max(0.01, Math.cos(lats[0] * Math.PI / 180)));
        const rows = (await db.query<{ agency: string; stop_id: string; lat: number | null; lon: number | null }>(
          `SELECT /* three-leg:transfer-ground */ agency, stop_id, lat, lon FROM stops
           WHERE agency = ANY($1::text[]) AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5
           LIMIT $6`,
          [seeded, Math.min(...lats) - dLat, Math.max(...lats) + dLat,
            Math.min(...lons) - dLon, Math.max(...lons) + dLon, THREE_LEG_STOP_LIMIT])).rows;
        const cands: StitchStop[] = [];
        for (const r of rows) {
          if (r.lat == null || r.lon == null) continue;
          cands.push({ agency: r.agency, stopId: r.stop_id, lat: Number(r.lat), lon: Number(r.lon) });
        }
        // The bounding box is a superset of the cap — this is the line that makes it the
        // cap, and on a THREE_LEG_STOP_LIMIT-wide box it is also the longest unbroken
        // stretch of arithmetic in the request. Breathe before it, not after.
        await breathe();
        const near = withinTransferWalk(anchors, cands);
        await learnStops(near.map((s) => ({ agency: s.agency, stopId: s.stopId })));
        return near;
      }

      const [midBoardStops, midAlightStops] = await Promise.all([
        walkableFrom(anchorsIn), walkableFrom(anchorsOut),
      ]);
      if (midBoardStops.length === 0 || midAlightStops.length === 0) return nothing();

      // A middle leg is ONE vehicle, so like every other leg it cannot cross agencies:
      // only an agency present at both ends of the middle can supply one.
      const midAgencies = seeded.filter((a) =>
        midBoardStops.some((s) => s.agency === a) && midAlightStops.some((s) => s.agency === a));
      const midSets = await Promise.all(midAgencies.map((a) => midRides(
        a,
        midBoardStops.filter((s) => s.agency === a).map((s) => s.stopId),
        midAlightStops.filter((s) => s.agency === a).map((s) => s.stopId),
      )));
      const mid = midSets.flat();
      if (mid.length === 0) return nothing();

      const three = await stitchThreeLeg(leg1, mid, legLast, stitchStops, {
        paceMps: TRANSFER_PACE_MPS, limit: PLAN_MAX_THREE_LEG, breathe,
      });
      if (three.length === 0) return nothing();
      const itineraries = await toItineraryDtos(three);
      // Same rule as the two-leg tier: what the search HAS is returned, clock or no clock.
      return itineraries.length > 0 ? { kind: 'found', outcome: 'threeLeg', itineraries } : nothing();

      /**
       * Stitched chains into wire DTOs, whatever their length.
       *
       * Every leg goes through the SAME enrichment the ride tier uses, so a leg's evidence
       * line means exactly what it means on a departure board. Which stop set a leg's ends
       * resolve against depends only on the leg's POSITION: the first boards at the rider's
       * own stop, the last alights at the destination's, and everything between touches
       * transfer ground on both sides.
       */
      async function toItineraryDtos(
        stitched: ReadonlyArray<{
          legs: RawRide[];
          transfers: Array<{ from: StitchStop; to: StitchStop; walkM: number; walkSec: number; waitSec: number }>;
          crossAgency: boolean;
        }>,
      ): Promise<ItineraryDto[]> {
        if (stitched.length === 0) return [];
        const lastIdx = stitched[0].legs.length - 1;
        const perPosition: RideCandidateDto[][] = [];
        for (let i = 0; i <= lastIdx; i++) {
          perPosition.push(await buildCandidates(
            stitched.map((s) => s.legs[i]), (r) => r.agency,
            (r) => (i === 0 ? boardById : transferById).get(metaKey(r.agency, r.boardStopId)),
            (r) => (i === lastIdx ? alightById : transferById).get(metaKey(r.agency, r.alightStopId)),
          ));
        }
        const cand = (list: RideCandidateDto[], r: RawRide) =>
          list.find((c) => c.tripId === r.tripId && c.boardStopSequence === r.boardStopSequence);

        const out: ItineraryDto[] = [];
        for (const s of stitched) {
          const legs: RideCandidateDto[] = [];
          for (let i = 0; i <= lastIdx; i++) {
            const c = cand(perPosition[i], s.legs[i]);
            if (c) legs.push(c);
          }
          const transfers: Array<{ from: PlanStopDto; to: PlanStopDto; distanceM: number; sameStop: boolean; waitSec: number } | null> =
            s.transfers.map((t) => {
              const from = transferById.get(metaKey(t.from.agency, t.from.stopId));
              const to = transferById.get(metaKey(t.to.agency, t.to.stopId));
              return from && to ? {
                from, to, distanceM: t.walkM,
                sameStop: t.from.agency === t.to.agency && t.from.stopId === t.to.stopId,
                waitSec: t.waitSec,
              } : null;
            });
          // Any leg or any seam that could not be resolved drops the itinerary WHOLE. Half
          // an itinerary is not a lesser answer, it is a wrong one.
          if (legs.length !== lastIdx + 1) continue;
          if (transfers.some((t) => t == null)) continue;
          const resolved = transfers.filter((t): t is NonNullable<typeof t> => t != null);
          out.push({
            legs,
            transfers: resolved,
            // The first seam, stated twice, for the readers written before three legs
            // existed. Identical data — see the note on ItineraryDto.transfer.
            transfer: {
              from: resolved[0].from, to: resolved[0].to,
              distanceM: resolved[0].distanceM, sameStop: resolved[0].sameStop,
            },
            transferWaitSec: resolved[0].waitSec,
            crossAgency: s.crossAgency,
          });
        }
        return out;
      }
    }

    /**
     * The middle leg of a three-leg journey: BOTH ends constrained, because neither of
     * them is at a query point.
     *
     * The two-leg halves leave one end free — that is exactly what enumerates transfer
     * candidates. A middle leg has no free end at all: it must start where a first leg can
     * be walked from and finish where a last leg can be walked to, and both of those sets
     * were narrowed to one walk cap before this ran. Without that narrowing this statement
     * is a self-join over every trip in the region, which is why it is not optional.
     */
    async function midRides(
      agencyId: string, boardIds: string[], alightIds: string[],
    ): Promise<RawRide[]> {
      if (boardIds.length === 0 || alightIds.length === 0) return [];
      const out: RawRide[] = [];
      const horizonMs = windowMs + TWO_LEG_HORIZON_MS;
      let issued = 0;
      for (const day of dayList) {
        // The wall, and the same reasoning as legRides: one service day is always
        // fetched, and past that the wall stops the sweep without discarding it.
        if (issued > 0 && budget.expired()) break;
        const svc = activeServicesFor(agencyId, day.ymd, day.dow);
        if (svc.length === 0) continue;
        const midnight = midnightFor(day.ymd);
        const loSec = Math.floor((atMs - midnight) / 1000);
        const hiSec = Math.ceil((atMs + horizonMs - midnight) / 1000);
        if (hiSec < 0) continue;
        const rows = (await db.query<{
          trip_id: string; route_id: string | null; headsign: string | null; direction_id: number | null;
          board_stop: string; board_seq: number; board_s: number | null;
          alight_stop: string; alight_seq: number; alight_s: number | null;
        }>(
          `SELECT /* three-leg:middle */ b.trip_id, t.route_id, t.headsign, t.direction_id,
                  b.stop_id AS board_stop, b.stop_sequence AS board_seq,
                  COALESCE(b.departure_s, b.arrival_s) AS board_s,
                  a.stop_id AS alight_stop, a.stop_sequence AS alight_seq,
                  COALESCE(a.arrival_s, a.departure_s) AS alight_s
           FROM stop_times b
           JOIN stop_times a ON a.agency = b.agency AND a.trip_id = b.trip_id
                            AND a.stop_sequence > b.stop_sequence
           JOIN trips t ON t.agency = b.agency AND t.trip_id = b.trip_id
           WHERE b.agency = $1
             AND b.stop_id = ANY($2::text[])
             AND a.stop_id = ANY($3::text[])
             AND t.service_id = ANY($4::text[])
             AND COALESCE(b.departure_s, b.arrival_s) BETWEEN $5 AND $6
           ORDER BY COALESCE(b.departure_s, b.arrival_s), b.trip_id, a.stop_sequence
           LIMIT $7`,
          [agencyId, boardIds, alightIds, svc, Math.max(0, loSec), hiSec, TWO_LEG_SQL_ROW_LIMIT])).rows;
        issued++;
        for (const r of rows) {
          if (r.board_s == null || r.alight_s == null) continue;
          const departureMs = midnight + Number(r.board_s) * 1000;
          const arrivalMs = midnight + Number(r.alight_s) * 1000;
          if (departureMs < atMs || departureMs > atMs + horizonMs) continue;
          if (arrivalMs <= departureMs) continue;
          out.push({
            agency: agencyId,
            tripId: r.trip_id, routeId: r.route_id, headsign: r.headsign,
            directionId: r.direction_id == null ? null : Number(r.direction_id),
            boardStopId: r.board_stop, boardStopSequence: Number(r.board_seq), departureMs,
            alightStopId: r.alight_stop, alightStopSequence: Number(r.alight_seq), arrivalMs,
            // BOTH ends are transfer ground on a middle leg, so neither carries a walk to
            // a query point — the seams state those, once each.
            boardDistanceM: 0, alightDistanceM: 0,
            departureS: Math.round(departureMs / 1000),
          });
        }
        await breathe();
      }
      return out;
    }
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
    const resolvedShape = resolveAgency((req.query as Record<string, string | undefined>).agency);
    if (!resolvedShape.ok) return bad(reply, resolvedShape.error);
    const routeAgency = resolvedShape.agency;
    const repParams: unknown[] = [routeAgency, routeId];
    let dirClause = '';
    if (dir != null) { dirClause = ' AND direction_id = $3'; repParams.push(dir); }
    const rep = (await db.query<{ shape_id: string; direction_id: number | null; n: number }>(
      `SELECT shape_id, direction_id, COUNT(*)::int AS n FROM trips
       WHERE agency=$1 AND route_id=$2 AND shape_id IS NOT NULL${dirClause}
       GROUP BY shape_id, direction_id ORDER BY n DESC LIMIT 1`, repParams)).rows[0];
    if (!rep) return reply.code(404).send({ error: 'no shape for route' });

    const shapeRow = (await db.query<{ points: unknown }>(
      'SELECT points FROM shapes WHERE agency=$1 AND shape_id=$2', [routeAgency, rep.shape_id])).rows[0];
    if (!shapeRow) return reply.code(404).send({ error: 'shape not found' });
    // points stored as [lat, lon][] (JSONB); pg returns it parsed, PGlite may return text.
    const raw = (typeof shapeRow.points === 'string' ? JSON.parse(shapeRow.points) : shapeRow.points) as [number, number][];
    const lonLat: [number, number][] = raw.map(([lat, lon]) => [lon, lat]);
    const coordinates = simplify(lonLat, SHAPE_SIMPLIFY_EPS_DEG); // ~0.11 m — trims only truly collinear runs

    // A representative trip on that exact shape → its real ordered stops.
    const repDir = rep.direction_id;
    const tripRow = (await db.query<{ trip_id: string }>(
      `SELECT trip_id FROM trips WHERE agency=$1 AND route_id=$2 AND shape_id=$3
       ${repDir == null ? 'AND direction_id IS NULL' : 'AND direction_id=$4'} LIMIT 1`,
      repDir == null ? [routeAgency, routeId, rep.shape_id] : [routeAgency, routeId, rep.shape_id, repDir])).rows[0];
    const stops: RouteStopDto[] = [];
    if (tripRow) {
      for (const s of (await db.query<{ stop_id: string; name: string | null; lat: number | null; lon: number | null }>(
        `SELECT s.stop_id, s.name, s.lat, s.lon FROM stop_times st
         JOIN stops s ON s.agency=st.agency AND s.stop_id=st.stop_id
         WHERE st.agency=$1 AND st.trip_id=$2 ORDER BY st.stop_sequence`, [routeAgency, tripRow.trip_id])).rows) {
        if (s.lat == null || s.lon == null) continue;
        stops.push({ stopId: s.stop_id, name: s.name, lat: Number(s.lat), lon: Number(s.lon) });
      }
    }

    const body: RouteShapeResponse = {
      routeId, directionId: rep.direction_id == null ? null : Number(rep.direction_id),
      shapeId: rep.shape_id, color: colorFor(routeMetaFor(routeAgency, routeId)), coordinates, stops,
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
    // DATA clock. `service_alerts.active_end` is the transit agency's own activePeriod off the
    // feed, not a column our database stamps, so "has this alert expired" has to be asked
    // at the moment the snapshot describes. Asking it at tonight's wall clock would expire
    // every alert in a recording and report an empty board as good news.
    const now = dataNow();
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
       LIMIT $3`, [modeAgency, nowIso, limit])).rows;

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
      // `wireAgency`, not `modeAgency`: a replayed TTC alert is still a TTC alert.
      // JSONB: pg returns it parsed, PGlite can hand back the text form.
      const raw = typeof r.informed === 'string' ? JSON.parse(r.informed) : r.informed;
      const list: AlertInformedDto[] = Array.isArray(raw)
        ? (raw as Array<Record<string, unknown>>).map((e) => {
          const routeId = blank(e.routeId as string | null);
          return {
            routeId,
            routeShortName: routeMetaFor(staticAgency, routeId)?.shortName ?? null,
            stopId: blank(e.stopId as string | null),
            tripId: blank(e.tripId as string | null),
          };
        })
        : [];
      return {
        agency: wireAgency,
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
      // `?? null` because an agency may publish NO alerts feed at all (YRT), in which case
      // there is no such thing as "when the alerts feed last updated". This used to
      // dereference `.alerts` unconditionally and would have thrown for such an agency.
      feedUpdatedMs: poller.getFeedHealth().feeds.alerts?.lastOkMs ?? null,
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
    // WALL clock, deliberately, and this whole handler stays on it. Every timestamp it
    // filters or reports — `ghosts.detected_at` and both counter windows — is stamped by
    // the database's own `DEFAULT now()` when OUR engine detects a ghost. A ghost feed
    // answers "what has this process caught lately", which is a question about our own
    // clock. Handing it the data clock would compare a wall-clock column against a
    // capture-window instant and silently return nothing.
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
        /**
         * THE ONE QUERY THAT CROSSES THE SEAM, so it names both sides explicitly.
         *
         * `ghosts` is an observation (modeAgency); `trips` is the published schedule
         * (staticAgency). Joining `t.agency = g.agency` silently bound the static side to
         * the observation namespace, so in demo mode the join matched nothing and EVERY
         * ghost lost its headsign — a row reading "trip 12345" instead of "504 to Dundas
         * West". The seam test cannot catch this by inspecting $1 alone, which is exactly
         * why the two agencies are separate bound parameters here.
         */
        `SELECT g.trip_id, g.kind, g.route_id, g.scheduled_start, g.detected_at, t.headsign
         FROM ghosts g LEFT JOIN trips t ON t.agency = $2 AND t.trip_id = g.trip_id
         WHERE g.agency=$1 AND g.detected_at >= $3
         ORDER BY g.detected_at DESC LIMIT $4`, [modeAgency, staticAgency, sinceIso, GHOSTS_MAX_EVENTS]),
      db.query<{ kind: string; today: number; week: number }>(
        `SELECT kind, COUNT(*) FILTER (WHERE detected_at >= $2)::int AS today, COUNT(*)::int AS week
         FROM ghosts WHERE agency=$1 AND detected_at >= $3 GROUP BY kind`,
        [modeAgency, new Date(todaySinceMs).toISOString(), new Date(weekSinceMs).toISOString()]),
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
      const meta = routeMetaFor(staticAgency, r.route_id);
      events.push({
        agency: wireAgency,
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
  // WALL clock throughout, and for the same reason as the ghost feed: every window below
  // filters `trip_delay_obs.ts` or `ghosts.detected_at`, both of which the database stamps
  // itself with `DEFAULT now()`. These counters describe what this process has collected,
  // not what moment the data depicts, so `updatedAtMs` is a wall-clock stamp too.
  app.get('/api/stats', async (_req, reply) => {
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const [obs, ghosts, avg] = await Promise.all([
      db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM trip_delay_obs WHERE agency=$1', [modeAgency]),
      db.query<{ kind: string; n: string }>('SELECT kind, COUNT(*)::text AS n FROM ghosts WHERE agency=$1 AND detected_at >= $2 GROUP BY kind', [modeAgency, weekAgo]),
      db.query<{ avg: number | null }>('SELECT AVG(delay_s)::double precision AS avg FROM trip_delay_obs WHERE agency=$1 AND ts >= $2', [modeAgency, new Date(Date.now() - 3 * 3_600_000).toISOString()]),
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
    const path = req.url.split(/[?#]/, 1)[0];
    // `/api` bare, not just `/api/…`: it has no extension, so without this it would
    // have fallen through and answered an API client with the SPA shell at 200.
    if (path === '/api' || path.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    if (!webDist) return reply.code(404).send({ error: 'not found' });

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
