// Shared request/response contracts between the GhostBus API (server/src/api.ts)
// and the Phase-3 web client. One source of truth so the API and UI cannot drift.
//
// Tier 0 is Toronto-only; every payload is scoped to the TTC internally
// (agency = 'ttc') and the wire format never leaks the agency seam.

export type DbDriver = 'pg' | 'pglite';

/** A JSON error envelope. The API never returns a stack trace. */
export interface ApiError {
  error: string;
}

// ---------- /api/health ----------

export type FeedId = 'vehicles' | 'trips' | 'alerts';
export type FeedStatusKind = 'ok' | 'stale' | 'down';

export interface FeedStatus {
  status: FeedStatusKind;
  /** epoch ms of the last successful poll of this feed, or null if never. */
  lastOkMs: number | null;
  /** epoch ms since when the current status has held (transition time), or null. */
  sinceMs: number | null;
}

export interface HealthResponse {
  ok: boolean;
  dbDriver: DbDriver;
  /** epoch ms of the most recent successful upstream poll of any feed. */
  lastPollAtMs: number | null;
  collectorMode: 'in-process' | 'external';
  feeds: Record<FeedId, FeedStatus>;
  /** the loaded static GTFS board's calendar coverage, "YYYYMMDD..YYYYMMDD". */
  boardCoverage: string;
  serverNowMs: number;
}

// ---------- /api/vehicles ----------

export interface VehicleDto {
  id: string;
  routeId: string | null;
  shortName: string | null;
  routeType: number | null;
  /** hex, no leading '#'. Falls back to a tasteful neutral when the route has none. */
  color: string;
  lat: number;
  lon: number;
  /** degrees, 0 = north; null when the feed omits it. */
  heading: number | null;
  /** metres/second; null when the feed omits it. */
  speedMs: number | null;
  /** A live vehicle is present by definition, so this is always false today; the
   *  field exists so the map layer's contract is stable. */
  isGhost: boolean;
  /** epoch ms of the ping this position came from. */
  ts: number;
}

export interface VehiclesResponse {
  vehicles: VehicleDto[];
  count: number;
  lastPollAtMs: number | null;
  serverNowMs: number;
  /** the bbox actually applied: [minLon, minLat, maxLon, maxLat]. */
  bbox: [number, number, number, number];
}

// ---------- /api/stops + /api/stops/nearby ----------

export interface StopDto {
  stopId: string;
  name: string | null;
  lat: number | null;
  lon: number | null;
  wheelchairBoarding: number | null;
  /** metres from the query point; present only on /nearby. */
  distanceM?: number;
}

export interface StopsResponse {
  stops: StopDto[];
  count: number;
}

// ---------- /api/stops/:id/arrivals ----------

export type EtaBucket = 'stop-hour' | 'route-hour' | 'none';

/** Evidence behind an Honest ETA. Always present, even when bucket = 'none'. */
export interface EtaEvidence {
  /** number of historical observations behind the estimate (0 when none). */
  n: number;
  windowDays: number;
  bucket: EtaBucket;
}

/** The honest estimate = scheduled + median historical delay, band P25..P75.
 *  Every numeric field is null when there is no evidence (bucket = 'none'). */
export interface HonestEta {
  estimateMs: number | null;
  bandLowMs: number | null;
  bandHighMs: number | null;
  medianDelaySec: number | null;
}

export type GradeLetter = 'A' | 'B' | 'C' | 'D' | 'E';

/** How much a departure's honest ETA can be trusted, derived from sample size and
 *  the P25–P75 delay spread. **Never present when `evidence.bucket === 'none'`** —
 *  an untracked departure has no letter, and the UI must say "untracked" instead.
 *  The tier table + formula live in `server/src/api.ts` (`GRADE_TIERS` / `gradeFor`). */
export interface TrustGrade {
  letter: GradeLetter;
  /** observations behind the grade — identical to `evidence.n`. */
  n: number;
  /** half the P25–P75 spread in whole minutes: the "± X min" the UI shows. */
  spreadMin: number;
}

export type GhostRiskLevel = 'elevated' | 'high';

/** Ghost Forecast for a departure's (route, hour-of-week) cell. Present only when
 *  the cell clears the sample-size gate AND the rate is genuinely elevated; a quiet
 *  route simply has no field. Formula + thresholds: `ghostRiskFor` in
 *  `server/src/api.ts`. */
export interface GhostRisk {
  level: GhostRiskLevel;
  /** ghosts / scheduled trips, both counted over the same watched hour cells. 0..1 */
  rate: number;
  /** denominator — scheduled trips in that route×hour inside the watched window. */
  n: number;
  /** numerator — ghosts recorded in that route×hour inside the watched window. */
  ghosts: number;
  windowDays: number;
}

export interface DepartureDto {
  routeId: string | null;
  shortName: string | null;
  longName: string | null;
  routeType: number | null;
  color: string;
  headsign: string | null;
  directionId: number | null;
  /** human label for the direction (headsign, else "Direction 0/1"). */
  directionLabel: string;
  tripId: string;
  stopSequence: number;
  /** scheduled departure, epoch ms (agency-local resolved, >24h times handled). */
  scheduledMs: number;
  /** live ETA when a TripUpdate references this trip via the identity join; else null. */
  liveEtaMs: number | null;
  honest: HonestEta;
  evidence: EtaEvidence;
  /** absent when there is no evidence (bucket 'none') — never a fabricated letter. */
  grade?: TrustGrade;
  /** absent unless the route×hour cell is both well-sampled and genuinely elevated. */
  ghostRisk?: GhostRisk;
}

export interface ArrivalsResponse {
  stopId: string;
  stopName: string | null;
  lat: number | null;
  lon: number | null;
  wheelchairBoarding: number | null;
  serverNowMs: number;
  /** the reference time the departures were computed against (epoch ms). */
  atMs: number;
  windowMinutes: number;
  departures: DepartureDto[];
}

// ---------- /api/routes/:routeId/shape ----------

/** One stop along the representative trip of a route/direction (real GTFS stops,
 *  never sampled points). Used for the intermediate stop dots on the route line. */
export interface RouteStopDto {
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
}

/** The simplified shape polyline for a route/direction, plus its real stops.
 *  Coordinates are GeoJSON order [lon, lat] so the client can drop them straight
 *  into a LineString. The most representative shape (most trips) is chosen. */
export interface RouteShapeResponse {
  routeId: string;
  directionId: number | null;
  shapeId: string;
  /** hex, no leading '#'. */
  color: string;
  /** [lon, lat] pairs, Douglas–Peucker simplified. */
  coordinates: [number, number][];
  stops: RouteStopDto[];
}

// ---------- /api/alerts ----------

/** One entity a service alert says it affects, straight from the feed's
 *  `informed_entity`. Empty strings in the feed are normalised to null. */
export interface AlertInformedDto {
  routeId: string | null;
  /** resolved from the static GTFS `routes` table; null when the id is unknown. */
  routeShortName: string | null;
  stopId: string | null;
  tripId: string | null;
}

export interface AlertDto {
  alertId: string;
  /** GTFS-realtime `Alert.Effect` enum name, e.g. 'NO_SERVICE'. The TTC feed
   *  publishes 'UNKNOWN_EFFECT' on every alert today — reported as-is, never guessed. */
  effect: string | null;
  /** GTFS-realtime `Alert.Cause` enum name, e.g. 'MEDICAL_EMERGENCY'. */
  cause: string | null;
  header: string | null;
  description: string | null;
  /** first active period, epoch ms; null when the feed omits it (TTC does). */
  activeStartMs: number | null;
  activeEndMs: number | null;
  informed: AlertInformedDto[];
  /** effect is ACCESSIBILITY_ISSUE, or the text names an elevator/escalator/etc. */
  isAccessibility: boolean;
}

export interface AlertsResponse {
  alerts: AlertDto[];
  count: number;
  /** epoch ms of the last successful poll of the alerts feed; null = never polled.
   *  This — not a per-row timestamp — is what "Updated X ago" must be based on. */
  feedUpdatedMs: number | null;
  serverNowMs: number;
  meta: {
    /** 'active-start' when the feed publishes activePeriod, else 'stable-id':
     *  with no timestamps to sort by, order degrades to a deterministic one. */
    ordering: 'active-start' | 'stable-id';
    /** false when NO returned alert carries an activePeriod (TTC today). */
    publishesActivePeriod: boolean;
  };
}

// ---------- /api/ghosts/feed ----------

export type GhostKind = 'ghost' | 'cancelled';

export interface GhostEventDto {
  tripId: string;
  /** 'ghost' = scheduled, due, and never showed up. 'cancelled' = the agency said so. */
  kind: GhostKind;
  routeId: string | null;
  shortName: string | null;
  longName: string | null;
  routeType: number | null;
  color: string;
  headsign: string | null;
  /** scheduled start, epoch ms. */
  scheduledStartMs: number;
  /** the same instant as agency-local wall clock, "YYYY-MM-DD HH:MM" (America/Toronto). */
  scheduledStartLocal: string;
  detectedAtMs: number;
}

export interface GhostCounters {
  todayGhosts: number;
  todayCancelled: number;
  weekGhosts: number;
  weekCancelled: number;
}

export interface GhostFeedResponse {
  events: GhostEventDto[];
  count: number;
  /** the trailing window actually applied, in hours. */
  hours: number;
  counters: GhostCounters;
  serverNowMs: number;
  meta: {
    /** A retracted ghost is a DELETEd row (see DECISIONS §18), so it simply never
     *  appears in this feed — there is no "retracted" state to render. */
    retractedAreDeleted: true;
    /** IANA zone `scheduledStartLocal` is rendered in. */
    timezone: string;
    /** 'today' counters are counted from agency-local midnight, this epoch ms. */
    todaySinceMs: number;
  };
}

// ---------- /api/stats ----------

export interface StatsResponse {
  vehiclesTracked: number;
  obsCollected: number;
  ghostsThisWeek: number;
  cancelledThisWeek: number;
  avgDelayRecentSec: number | null;
  updatedAtMs: number;
}
