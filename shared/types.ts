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

// ---------- /api/stats ----------

export interface StatsResponse {
  vehiclesTracked: number;
  obsCollected: number;
  ghostsThisWeek: number;
  cancelledThisWeek: number;
  avgDelayRecentSec: number | null;
  updatedAtMs: number;
}
