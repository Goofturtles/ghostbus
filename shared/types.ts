// Shared request/response contracts between the GhostBus API (server/src/api.ts)
// and the Phase-3 web client. One source of truth so the API and UI cannot drift.
//
// The wire format NAMES the agency on every row that carries an agency-scoped id.
//
// It used to say "Tier 0 is Toronto-only … the wire format never leaks the agency seam",
// which was true and is now false on purpose. With more than one agency seeded, a bare
// stop_id or route_id is ambiguous — see the note on StopDto.agency for the measured
// collision counts — so hiding the seam would mean shipping ids the client cannot resolve.

export type DbDriver = 'pg' | 'pglite';

/**
 * WHOSE FAULT A FAILURE WAS, on the wire.
 *
 * The client cannot tell these apart from an HTTP status alone, and it has to: rendering
 * our own throttling as "can't reach the live TTC feed" blamed the transit agency for our
 * rate limiter and is the defect DECISIONS §45 exists to close. So every error body names
 * its own kind, and the UI's copy is keyed off that rather than off prose or a status code.
 *
 *   rateLimited  · OUR limiter refused the request (429). Nothing is wrong with the feed.
 *   badRequest   · the request itself was invalid (4xx). A bug on our side, not an outage.
 *   serverError  · OUR server failed (5xx). Still not the agency.
 *
 * No member of this union ever means "the TTC feed is down". That claim has exactly one
 * honest source in the whole system: `HealthResponse.feeds`.
 */
export type ApiErrorKind = 'rateLimited' | 'badRequest' | 'serverError';

/** A JSON error envelope. The API never returns a stack trace. */
export interface ApiError {
  error: string;
  statusCode?: number;
  kind?: ApiErrorKind;
  /** seconds until the rate-limit window resets. `kind: 'rateLimited'` only. */
  retryAfterSec?: number;
  /** the ceiling that was hit. `kind: 'rateLimited'` only. */
  limit?: number;
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

/**
 * Provenance of a recorded replay — everything the UI needs to put under the amber DEMO
 * badge. Structurally the server's own `DemoModeInfo` (server/src/poller.ts), restated here
 * because this file is the wire contract and `shared/` must not import from `server/`.
 */
export interface DemoProvenance {
  fixturePath: string | null;
  /** "RECORDING of live TTC data captured … through …. This is replayed history…" */
  recordedNotice: string;
  attribution: string;
  captureStartMs: number;
  captureEndMs: number;
  captureStartToronto: string;
  captureEndToronto: string;
  /** the cadence the recording was captured at, ms */
  cadenceMs: number;
  /** replay speed multiplier (8 = eight recorded minutes per wall minute) */
  speed: number;
  loop: boolean;
  /** how far into the recording replay currently is, in recording-time ms */
  positionMs: number;
  /** how many times replay has wrapped */
  loops: number;
}

export interface HealthResponse {
  ok: boolean;
  dbDriver: DbDriver;
  /** epoch ms of the most recent successful upstream poll of any feed. */
  lastPollAtMs: number | null;
  collectorMode: 'in-process' | 'external';
  /**
   * Only the feeds this deployment's agency actually publishes. A MISSING KEY MEANS THE
   * AGENCY PUBLISHES NO SUCH FEED — YRT has no alerts feed, Oakville has no realtime at
   * all — which is a different statement from `status: 'down'`, and the two must not
   * render alike. For the TTC all three are present, as before.
   */
  feeds: Partial<Record<FeedId, FeedStatus>>;
  /** the loaded static GTFS board's calendar coverage, "YYYYMMDD..YYYYMMDD". */
  boardCoverage: string;
  /**
   * Whether the accountability engine is currently WRITING observations, and if not,
   * which honesty gate is holding them back and why.
   *
   * Added after a production stall in which the engine computed observations and
   * dropped every one of them for five days: the gate was doing its job and saying so
   * only into the process log, so the outage was invisible to anything short of
   * `journalctl` on the box. The suppression is not a fault in itself — refusing to
   * publish unverified measurements is the whole design — but a suppression that lasts
   * days is, and it now shows up in the same place everything else about this
   * deployment's health does.
   *
   * Scoped to the poller this endpoint already reports feeds for; the process log
   * carries the same line, per agency, tagged with the agency id.
   */
  delayEngine: {
    suppressed: boolean;
    /** the operator-readable sentence — null exactly when `suppressed` is false. */
    reason: string | null;
    /** which gate refused, e.g. 'xwalkOccurrenceCoverage'. Null when publishing. */
    gate: string | null;
  };
  /**
   * EVERY AGENCY THIS DEPLOYMENT SERVES, in configured order.
   *
   * The client renders its coverage claim from this list rather than from a hardcoded
   * sentence. "GhostBus only covers the TTC, in Toronto" was a claim maintained by hand,
   * and the first time an agency was added it would have become false with nobody
   * editing it — the app asserting something untrue about itself, which is the failure
   * DECISIONS §45 exists to prevent. A generated claim cannot drift from what is seeded.
   */
  agencies: Array<{ id: string; name: string }>;
  /**
   * The server's DATA clock — what "now" means to the process that produced this response.
   * Live it is the wall clock; on a recording it is the capture instant of the frame being
   * replayed, so the client's countdowns stay correct against replayed departures.
   */
  serverNowMs: number;
  /**
   * WHAT THE RIDER IS LOOKING AT. Decided once at server boot and immutable for the life of
   * the process, so no response can ever be half live. This is the ONLY honest source for
   * the DEMO badge — without it a recording and a live feed are identical on the wire.
   */
  mode: 'live' | 'demo';
  /** null unless `mode === 'demo'`. */
  demo: DemoProvenance | null;
}

// ---------- /api/vehicles ----------

export interface VehicleDto {
  /** The agency operating this vehicle. Vehicle ids collide across fleets too. */
  agency: string;
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
  /**
   * WHICH AGENCY THIS ROW BELONGS TO. Required, because every id beside it — stop_id,
   * route_id, trip_id — is unique only WITHIN an agency, and the collisions are measured
   * rather than theoretical: across the GTA static feeds, 2,824 stop_ids are shared between
   * the TTC and YRT, 1,496 between MiWay and the TTC, and Brampton shares 45 route_ids with
   * the TTC. `stop_id 2334` is "Eglinton Ave West at Caledonia Rd" on the TTC and "Finch GO
   * Bus Terminal Platform 15" on YRT — two real stops, ten kilometres apart, one number.
   *
   * Deliberately a SEPARATE FIELD rather than a prefix baked into the id ("ttc:2334").
   * A composite string type-checks everywhere and silently does the wrong thing wherever an
   * id is compared, de-duplicated or persisted; DECISIONS §48's lesson was two names so
   * neither can be typed where the other belongs.
   */
  agency: string;
  stopId: string;
  name: string | null;
  lat: number | null;
  lon: number | null;
  wheelchairBoarding: number | null;
  /** metres from the query point; present only on /nearby. */
  distanceM?: number;
  /**
   * WHICH ROUTES CALL HERE, from the published schedule — the fact a rider actually
   * wants on a stop row, in place of our internal stop id.
   *
   * Read out of static `stop_times ⋈ trips ⋈ routes` for THIS stop only (the
   * `(agency, stop_id, …)` index makes it a bounded lookup rather than a table scan),
   * so it is the agency's own answer to "what serves this stop", not an inference from
   * whatever happened to be departing in the last poll. A stop whose routes we have not
   * looked up carries `undefined`; a stop we looked up and found nothing for carries
   * `[]`. The two are different claims and the UI must not render them the same way.
   */
  routes?: StopRouteDto[];
}

/**
 * One route serving a stop — the minimum a badge needs, and nothing else.
 *
 * `color` is already resolved server-side through the same `colorFor` every other
 * route-coloured surface uses, so a badge on a search row and the same route's badge on
 * a departure board can never be two different colours. Six uppercase hex digits, no `#`.
 */
export interface StopRouteDto {
  routeId: string;
  /** the agency's own `route_short_name`, falling back to the id when it published none. */
  shortName: string;
  color: string;
  routeType: number | null;
}

export interface StopsResponse {
  stops: StopDto[];
  count: number;
  /** the radius actually applied, after clamping. /nearby only. */
  searchedRadiusM?: number;
  /**
   * The single closest stop AT ANY DISTANCE, present on /nearby ONLY when `stops` came
   * back empty. It exists so "no stops near you" can carry a number instead of leaving
   * the client to either say nothing or quietly show somebody else's stop.
   *
   * It is a measurement, not a recommendation: it may be tens of kilometres away and the
   * client is what decides whether that is worth offering. `distanceM` is measured with
   * the same haversine as every other distance in this response.
   */
  nearest?: StopDto;
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
  /** The agency running this departure. See the note on StopDto.agency. */
  agency: string;
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
  /** Which agency's stop this board belongs to. */
  agency: string;
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
  /**
   * Every route the SCHEDULE says calls here — deliberately not "every route with a
   * departure in this window". A board opened at 03:00 has an empty `departures` and
   * still serves the 504; deriving the header's badges from the departures would erase
   * the route exactly when the rider most needs to know what this stop is.
   */
  routes?: StopRouteDto[];
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

// ---------- /api/plan ----------

/** One end of a planned ride — a real GTFS stop, with its straight-line distance
 *  from the rider (`board`) or to the destination (`alight`).
 *
 *  Distance only. The walk TIME is computed on the device from the rider's own pace
 *  profile (`lib/walk.ts`), which is exactly where that preference already lives and
 *  the one place it is allowed to stay: the server is never told how fast anyone walks. */
export interface PlanStopDto {
  /** Which agency's stop this is. A single-vehicle ride never crosses agencies, but the
   *  two ends of a plan are matched against a stop table that now holds several. */
  agency: string;
  stopId: string;
  name: string | null;
  lat: number;
  lon: number;
  wheelchairBoarding: number | null;
  /** metres, straight line, from the query point this stop belongs to. */
  distanceM: number;
}

/**
 * One real single-ride option: board this trip at this stop, stay on it, get off there.
 *
 * Every field is read straight out of the agency's published schedule. A candidate
 * exists ONLY when one `trip_id` genuinely calls at the boarding stop and later
 * (strictly greater `stop_sequence`) at the alighting stop. Multi-leg journeys are out
 * of scope by design — a trip that needs a transfer produces no candidate at all
 * rather than a stitched-together one.
 */
export interface RideCandidateDto {
  tripId: string;
  routeId: string | null;
  shortName: string | null;
  longName: string | null;
  routeType: number | null;
  /** hex, no leading '#'. */
  color: string;
  headsign: string | null;
  directionId: number | null;
  /** human label for the direction (headsign, else "Direction 0/1"). */
  directionLabel: string;
  board: PlanStopDto;
  alight: PlanStopDto;
  boardStopSequence: number;
  alightStopSequence: number;
  /** stops ridden between boarding and alighting (alightSeq − boardSeq). */
  stopsRidden: number;
  /** scheduled departure at the boarding stop, epoch ms. */
  departureMs: number;
  /** scheduled arrival at the alighting stop, epoch ms. */
  arrivalMs: number;
  /** live ETA at the BOARDING stop when a TripUpdate references this trip; else null. */
  liveEtaMs: number | null;
  /** honest ETA for the boarding departure — same evidence rules as a departure board. */
  honest: HonestEta;
  evidence: EtaEvidence;
  /** absent when there is no evidence (bucket 'none') — never a fabricated letter. */
  grade?: TrustGrade;
  /** absent unless the route×hour cell is both well-sampled and genuinely elevated. */
  ghostRisk?: GhostRisk;
}

/**
 * Why the planner answered the way it did. Each value is a different *fact*, and the
 * UI must say which one it is rather than collapsing them into one "no route" shrug:
 *
 *   'ride'                      at least one real single-ride option was found.
 *   'transfer'                  no trip in the whole schedule calls at a stop near the
 *                               rider and later at a stop near the destination. The
 *                               journey needs a transfer, which this tier does not plan.
 *   'noService'                 a direct connection DOES exist in the schedule, but none
 *                               departs inside the searched window (e.g. overnight).
 *   'noStopsNearYou'            no stop at all within `radiusM` of the rider.
 *   'noStopsNearDestination'    no stop at all within `radiusM` of the destination.
 */
export type PlanOutcome =
  | 'ride' | 'transfer' | 'noService' | 'noStopsNearYou' | 'noStopsNearDestination'
  /** No single ride does it, but TWO rides joined by a walk do — `itineraries`. */
  | 'twoLeg'
  /** Not even two — but three rides and two walks do. Same `itineraries` array. */
  | 'threeLeg';

/**
 * The walk between the two rides of a two-leg itinerary.
 *
 * A straight-line estimate, and labelled as one everywhere it is shown: this walk
 * happens somewhere out in the network, not under the rider's feet, so the device has
 * no reason to hold the tiles that would let it be routed the way the first walk is.
 */
export interface TransferWalkDto {
  from: PlanStopDto;
  to: PlanStopDto;
  distanceM: number;
  /** true when both rides call at the SAME stop — no walking, just a wait. */
  sameStop: boolean;
}

/**
 * Two or three rides and the walks between them.
 *
 * Each leg is a full `RideCandidateDto`, carrying its OWN evidence — live, honest ETA,
 * grade, ghost risk — because the two legs are routinely not equally knowable: leg 1 may
 * be a live-tracked TTC bus and leg 2 a schedule-only Milton coach. Averaging that into
 * one confidence for the itinerary would hide exactly the thing a rider needs to know
 * before committing to a connection.
 */
export interface ItineraryTransferDto extends TransferWalkDto {
  /**
   * Seconds between the previous leg's scheduled arrival and the next leg's scheduled
   * departure. Always at least the walk, because a connection that cannot be made is not
   * offered — see TRANSFER_MIN_SLACK_S. Stated out loud in the UI rather than folded into
   * a total, and stated PER SEAM so a rider can see which connection is the tight one.
   */
  waitSec: number;
}

export interface ItineraryDto {
  /** two legs, or three. `transfers[i]` is the seam between `legs[i]` and `legs[i+1]`. */
  legs: RideCandidateDto[];
  /** always `legs.length - 1`, in journey order. */
  transfers: ItineraryTransferDto[];
  /**
   * The FIRST seam, kept because the two-leg wire shipped with it and every existing
   * reader is written against it. Identical to `transfers[0]` — new readers should use
   * `transfers`, the only field that describes a three-leg journey completely.
   */
  transfer: TransferWalkDto;
  /** @see transfer — the first seam's wait. Identical to `transfers[0].waitSec`. */
  transferWaitSec: number;
  /** true when the legs are not all the same agency (e.g. MiWay -> GO -> Durham). */
  crossAgency: boolean;
}

export interface PlanResponse {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  serverNowMs: number;
  /** the reference time the plan was computed against (epoch ms). */
  atMs: number;
  windowMinutes: number;
  radiusM: number;
  outcome: PlanOutcome;
  /** soonest departure first; empty unless `outcome === 'ride'`. */
  candidates: RideCandidateDto[];
  /** soonest arrival first; empty unless `outcome` is `'twoLeg'` or `'threeLeg'`. */
  itineraries: ItineraryDto[];
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
  /** Which agency published this alert. */
  agency: string;
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
  /** Which agency's trip failed to appear. */
  agency: string;
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

// ---------- /api/geocode?q= ----------

/**
 * An address, as OpenStreetMap knows it. NOT a stop, and deliberately not shaped like one:
 * it has no agency, no stop id, and nothing about it is a claim that transit serves it.
 * It is a point a rider named, which is exactly what the map-pick pin already is.
 */
export interface GeocodeResultDto {
  /** The full display address, as the geocoder wrote it. Shown verbatim. */
  label: string;
  /** The leading part — house number and street — for the row's title line. */
  title: string;
  /** The rest, for the row's second line. Empty when the label has no remainder. */
  context: string;
  lat: number;
  lon: number;
}

export interface GeocodeResponse {
  results: GeocodeResultDto[];
  /** The query these answer, echoed so a late response can be matched to its request. */
  q: string;
  /**
   * The attribution the ODbL requires wherever these results are shown. Carried in the
   * response rather than hardcoded in the client so the credit can never drift from the
   * service that actually answered.
   */
  attribution: string;
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
