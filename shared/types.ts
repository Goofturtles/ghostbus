// Shared TypeScript contracts between the Fastify server and the web client.
// One source of truth so the API and UI can never drift.

/** GTFS route_type → the three voxel model families we render. */
export type ModeKind = 'bus' | 'tram' | 'metro' | 'rail' | 'ferry' | 'cable' | 'other';

/** Freshness of any data point the UI shows. Drives the status pill + row labels. */
export type Freshness = 'live' | 'stale' | 'scheduled' | 'offline' | 'demo';

/** How a scheduled trip failed its promise. */
export type GhostKind = 'ghost' | 'cancelled';

/** Evidence grade for an Honest ETA (A best … E thin … null = untracked). */
export type TrustGrade = 'A' | 'B' | 'C' | 'D' | 'E' | null;

export interface FeedDef {
  cityId: string;
  name: string;
  /** [west, south, east, north] */
  bbox: [number, number, number, number];
  timezone: string;
  staticGtfsUrl: string;
  rtVehiclesUrl: string;
  rtTripUpdatesUrl: string;
  rtAlertsUrl?: string;
  license: string;
  attribution: string;
  /** Tier 1 = full live pipeline, 2 = dynamic activation, 3 = schedule-only. */
  tier: 1 | 2 | 3;
}

export interface CitySummary {
  cityId: string;
  name: string;
  tier: 1 | 2 | 3;
  attribution: string;
  center: [number, number];
  /** Whether this city is currently polled and live. */
  active: boolean;
}

export interface Vehicle {
  id: string;
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string; // hex, no leading '#'
  mode: ModeKind;
  tripId: string;
  headsign: string;
  /** Scene / geo position. In demo scene mode these are local metres. */
  lat: number;
  lon: number;
  bearing: number; // degrees, 0 = north
  speed: number; // m/s
  /** Fraction along the trip shape [0..1], used for dead-reckoning + trains. */
  shapeT?: number;
  isGhost: boolean;
  occupancy?: 'empty' | 'many_seats' | 'few_seats' | 'standing' | 'crushed' | 'full';
  wheelchairAccessible?: boolean | null;
  /** epoch ms of the ping this position came from. */
  ts: number;
}

export interface Departure {
  routeId: string;
  routeShortName: string; // may carry a branch, e.g. "504A"
  routeLongName: string;
  routeColor: string;
  mode: ModeKind;
  tripId: string;
  headsign: string;
  directionLabel: string; // "Eastbound"
  stopId: string;
  /** Scheduled departure, epoch ms (agency-local resolved). */
  scheduledMs: number;
  /** Best honest estimate, epoch ms. Equals scheduledMs when no evidence. */
  estimateMs: number;
  /** Minutes until the honest estimate (client re-derives too). */
  etaMin: number;
  freshness: Freshness;
  /** Evidence for the estimate. */
  evidence: EtaEvidence;
  /** Ghost forecast for this run, if history supports it. */
  forecast?: GhostForecast;
  wheelchairAccessible?: boolean | null;
  occupancy?: Vehicle['occupancy'];
  vehicleId?: string;
}

export interface EtaEvidence {
  grade: TrustGrade;
  /** Number of observations behind the estimate. */
  n: number;
  /** ± minutes (P25–P75 half-spread) shown to the rider. */
  spreadMin: number;
  /** Human window, localized on the client. */
  windowDays: number;
  /** True once we have enough samples to trust the median. */
  hasEvidence: boolean;
}

export interface GhostForecast {
  /** 0..1 probability this run vanishes, from route×hour (or per-trip) history. */
  risk: number;
  level: 'low' | 'medium' | 'high';
  vanished: number;
  of: number;
  granularity: 'trip' | 'route-hour';
  saferBet?: string; // headsign/time of a safer departure
}

export interface StopArrivals {
  stopId: string;
  stopName: string;
  stopCode: string;
  directionLabel: string;
  crossStreet?: string;
  distanceM: number;
  walkMinRange: [number, number];
  wheelchairBoarding?: 0 | 1 | 2 | null;
  lat: number;
  lon: number;
  departures: Departure[];
  alerts: ServiceAlert[];
}

export interface ServiceAlert {
  id: string;
  effect: string;
  cause?: string;
  header: string;
  description?: string;
  /** epoch ms */
  activeStart?: number;
  activeEnd?: number;
  routeIds: string[];
  stopIds: string[];
  isAccessibility: boolean;
  timestampMs: number;
}

export interface GhostEvent {
  cityId: string;
  tripId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string;
  stopId: string;
  stopName: string;
  scheduledMs: number;
  detectedMs: number;
  kind: GhostKind;
  isAccessibility: boolean;
  headsign: string;
}

export interface RouteReport {
  routeId: string;
  routeShortName: string;
  routeLongName: string;
  routeColor: string;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  onTimePct: number;
  p50DelaySec: number;
  p75DelaySec: number;
  ghostCount7d: number;
  /** 7 days × 24 hours average delay seconds, row-major [day][hour]. */
  heatmap: number[][];
  /** Delay distribution buckets in minutes. */
  distribution: { bucket: string; count: number }[];
  observations: number;
  windowLabel: string;
  formula: string;
}

export interface CityStats {
  cityId: string;
  vehiclesTracked: number;
  observations: number;
  ghosts7d: number;
  avgDelaySec: number;
  hoursLostToGhosts7d: number;
  accessibleKeptPct: number;
  overallKeptPct: number;
  window: string;
  source: Freshness;
}

export interface AnomalyBanner {
  routeShortName: string;
  routeColor: string;
  vanishedRecent: number;
  typical: number;
  windowMin: number;
}

/** Envelope for /vehicles so the client can render honest freshness. */
export interface VehiclesResponse {
  cityId: string;
  source: Freshness;
  /** epoch ms of the last successful upstream poll. */
  lastPollMs: number;
  serverNowMs: number;
  vehicles: Vehicle[];
  anomalies: AnomalyBanner[];
}
