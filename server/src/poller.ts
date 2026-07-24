// poller — the GTFS-realtime poll cycle + in-memory live state, extracted from the
// standalone collector so the API can run it in-process (one deployable service).
//
// What it does every POLL_MS:
//   - fetches the three TTC feeds (conditional requests, timeout, backoff),
//   - keeps current vehicle positions in an in-memory map (never persisted),
//   - writes honest delay observations to trip_delay_obs (feed-provided delays only),
//   - runs the Phase-2 identity join (route + reconstructed schedule time) to decide
//     which static trips are present, then detects ghosts / cancelled among the
//     calendar-active, due-but-absent trips, with a mass-ghost sanity breaker,
//   - upserts the current service_alerts snapshot.
//
// `createPoller(db)` returns a handle with start/stop and getters the API reads from.
// All the Phase-1 honesty guards are intact: feedsFresh, dedupe, retention, eviction,
// bogus-delay drop, and now a measured join rate + mass-ghost breaker instead of the
// trip_id match-rate gate (which was structurally impossible — see BLOCKERS.md).

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { Db } from './db.ts';
import { activeServiceIds, type CalendarRow, type CalendarDateRow } from './gtfs.ts';
import { torontoDay, torontoMidnightEpoch, hourOfWeek, torontoYmd } from './tz.ts';
import { buildRouteStopIndex, claimTrips, indexKey, type RouteStopIndex, type RtTripInput, type RtStopObs } from './join.ts';
import type { FeedId, FeedStatusKind } from '../../shared/types.ts';

const { transit_realtime } = GtfsRealtimeBindings;

const AGENCY = 'ttc';
const FEEDS: Record<FeedId, string> = {
  vehicles: 'https://bustime.ttc.ca/gtfsrt/vehicles',
  trips: 'https://bustime.ttc.ca/gtfsrt/trips',
  alerts: 'https://bustime.ttc.ca/gtfsrt/alerts',
};

const POLL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 90_000;         // a feed is "stale" after 90s without a good poll
const GHOST_MIN_AGE_MS = 6 * 60_000;
const GHOST_MAX_AGE_MS = 30 * 60_000;
const RETENTION_DAYS = 14;
const RING_BUFFER = 6;
const EVICT_AFTER_CYCLES = 10;
const MAX_SANE_DELAY_S = 24 * 3600;
const JOIN_TOL_SEC = 75;               // ± window for a reconstructed schedule second
const JOIN_MIN_VOTES = 2;              // need >=2 consistent stops to claim a static trip
const MASS_GHOST_FRACTION = 0.30;      // suppress a cycle emitting ghosts for >30% of due trips
const MASS_GHOST_ROUTE_MIN_DUE = 4;    // per-route breaker only applies once a route has >=4 due trips
const GHOST_CONFIRM_MISSES = 2;        // a trip must be absent this many consecutive cycles before it's a ghost
const STATIC_RELOAD_MS = 6 * 3_600_000; // reload calendar/trips/index every 6h (and on service-day rollover)

// ---------- protobuf numeric coercion ----------
function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && v !== null && typeof (v as { toNumber?: unknown }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(v as number);
  return Number.isNaN(n) ? null : n;
}
function enumName(enumObj: Record<string, number>, val: number | null | undefined): string | null {
  if (val == null) return null;
  for (const [k, v] of Object.entries(enumObj)) if (v === val) return k;
  return String(val);
}
function translated(ts: { translation?: Array<{ text?: string | null }> | null } | null | undefined): string | null {
  const t = ts?.translation?.[0]?.text;
  return t == null || t === '' ? null : t;
}

// ---------- public state types ----------
export interface VehicleState {
  id: string;
  tripId: string | null;   // RT-internal trip id
  routeId: string | null;
  seq: number | null;
  lat: number;
  lon: number;
  heading: number | null;
  speedMs: number | null;
  ts: number;              // epoch ms of the ping
  cycleSeen: number;
}

export interface FeedRuntime {
  status: FeedStatusKind;
  lastOkMs: number | null;
  sinceMs: number | null;
}

export interface JoinStats {
  indexReady: boolean;
  lastJoinRate: number | null;      // claims / RT trips considered, last cycle
  cumulativeClaimed: number;
  cumulativeRt: number;
  lastGhosts: number;
  lastCancelled: number;
  lastDueTrips: number;
  massGhostTrippedCycles: number;
  lastUnmatchedRt: number;
  lastUnmatchedVehicles: number;
  retractionsTotal: number;         // ghosts retracted after the trip was later claimed
  lastRetracted: number;
  lastCanceledSeen: number;         // CANCELED RT entities seen last cycle
  lastCanceledIdentified: number;   // ...that we could tie to a static trip
  lastCanceledUnidentified: number; // ...that we could not (anonymous — counted, never faked)
  boardCoverage: string;            // min..max calendar date of the loaded static board
}

export interface PollerHandle {
  start(): void;
  stop(): Promise<void>;
  runOnce(cycle: number): Promise<void>;
  getVehicleStates(): VehicleState[];
  getFeedHealth(): { feeds: Record<FeedId, FeedRuntime>; lastPollAtMs: number | null };
  getLivePredictionMs(staticTripId: string, stopId: string): number | null;
  getJoinStats(): JoinStats;
  isIndexReady(): boolean;
}

type FeedMessage = ReturnType<typeof transit_realtime.FeedMessage.decode>;
interface FetchState { etag?: string; lastModified?: string; fails: number; nextAttemptAt: number; status: FeedStatusKind; lastOkMs: number | null; sinceMs: number | null }

export interface PollerOptions {
  pollMs?: number;
  maxCycles?: number;     // 0 = forever
  onExit?: () => void;    // called when maxCycles reached (standalone wrapper uses this)
}

export function createPoller(db: Db, options: PollerOptions = {}): PollerHandle {
  const pollMs = options.pollMs ?? POLL_MS;
  const maxCycles = options.maxCycles ?? 0;

  // ----- in-memory live state -----
  const positions = new Map<string, VehicleState>();
  const ring = new Map<string, Array<{ lat: number; lon: number; ts: number }>>();
  // static trip id -> (stop id -> predicted epoch ms), for arrivals' liveEtaMs.
  let livePredictions = new Map<string, Map<string, number>>();

  // ----- static context (reloaded on service-day rollover and every 6h) -----
  interface TripStart { routeId: string | null; serviceId: string | null; startS: number | null }
  let tripStarts = new Map<string, TripStart>();
  let staticTripIds = new Set<string>();               // for direct CANCELED trip_id matching
  let calendar: CalendarRow[] = [];
  let calendarDates: CalendarDateRow[] = [];
  const activeServiceCache = new Map<number, Set<string>>();
  const midnightCache = new Map<number, number>();
  let routeStopIndex: RouteStopIndex = new Map();
  let indexReady = false;
  let boardCoverage = '?..?';
  let lastStaticLoadAt = 0;
  let lastStaticLoadYmd = 0;
  let staticReloading = false;

  const delayDedupe = new Map<string, number>();
  // Ghost confirmation/retraction state (keyed `${tripId}|${startEpoch}`):
  const ghostMissStreak = new Map<string, number>();   // consecutive cycles a due trip has been absent
  const ghostInserted = new Map<string, { tripId: string; startEpoch: number }>(); // ghost rows we wrote this run

  const feedState: Record<FeedId, FetchState> = {
    vehicles: { fails: 0, nextAttemptAt: 0, status: 'down', lastOkMs: null, sinceMs: null },
    trips: { fails: 0, nextAttemptAt: 0, status: 'down', lastOkMs: null, sinceMs: null },
    alerts: { fails: 0, nextAttemptAt: 0, status: 'down', lastOkMs: null, sinceMs: null },
  };
  let lastPollAtMs: number | null = null;

  const totals = { obs: 0, ghosts: 0, cancelled: 0, alerts: 0 };
  const joinStats: JoinStats = {
    indexReady: false, lastJoinRate: null, cumulativeClaimed: 0, cumulativeRt: 0,
    lastGhosts: 0, lastCancelled: 0, lastDueTrips: 0, massGhostTrippedCycles: 0,
    lastUnmatchedRt: 0, lastUnmatchedVehicles: 0,
    retractionsTotal: 0, lastRetracted: 0, lastCanceledSeen: 0, lastCanceledIdentified: 0,
    lastCanceledUnidentified: 0, boardCoverage: '?..?',
  };
  let lastRetentionYmd = 0;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;

  // ---------- feed fetch ----------
  async function fetchFeed(key: FeedId): Promise<{ status: 'ok'; msg: FeedMessage } | { status: 'notmodified' | 'skip' | 'error'; reason?: string }> {
    const st = feedState[key];
    const now = Date.now();
    if (now < st.nextAttemptAt) return { status: 'skip', reason: `backoff ${(st.nextAttemptAt - now) / 1000 | 0}s` };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      if (st.etag) headers['If-None-Match'] = st.etag;
      if (st.lastModified) headers['If-Modified-Since'] = st.lastModified;
      const res = await fetch(FEEDS[key], { signal: ctrl.signal, headers });
      if (res.status === 304) { markOk(st, now); return { status: 'notmodified' }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const msg = transit_realtime.FeedMessage.decode(buf);
      st.etag = res.headers.get('etag') ?? undefined;
      st.lastModified = res.headers.get('last-modified') ?? undefined;
      markOk(st, now);
      return { status: 'ok', msg };
    } catch (e) {
      st.fails++;
      const backoff = Math.min(5_000 * 2 ** (st.fails - 1), 5 * 60_000);
      st.nextAttemptAt = Date.now() + backoff;
      return { status: 'error', reason: `${e instanceof Error ? e.message : String(e)} (backoff ${backoff / 1000}s)` };
    } finally {
      clearTimeout(t);
    }
  }
  function markOk(st: FetchState, now: number): void {
    st.fails = 0; st.nextAttemptAt = 0; st.lastOkMs = now;
    if (st.status !== 'ok') { st.status = 'ok'; st.sinceMs = now; }
    lastPollAtMs = lastPollAtMs == null ? now : Math.max(lastPollAtMs, now);
  }
  function refreshStaleness(now: number): void {
    for (const key of Object.keys(feedState) as FeedId[]) {
      const st = feedState[key];
      const wanted: FeedStatusKind = st.lastOkMs == null ? 'down' : (now - st.lastOkMs > STALE_AFTER_MS ? 'stale' : 'ok');
      if (wanted !== st.status) { st.status = wanted; st.sinceMs = now; }
    }
  }

  // ---------- static context ----------
  // Builds fresh structures and swaps them in atomically, so a concurrent poll cycle
  // never sees a half-cleared calendar/trip map during a reload.
  async function loadStaticContext(): Promise<void> {
    const cal = await db.query<{ service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; start_date: number; end_date: number }>(
      'SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency=$1', [AGENCY]);
    const newCalendar: CalendarRow[] = cal.rows.map((r) => ({
      service_id: r.service_id, days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun],
      start_date: Number(r.start_date), end_date: Number(r.end_date),
    }));
    const cd = await db.query<{ service_id: string; date: number; exception_type: number }>(
      'SELECT service_id, date, exception_type FROM calendar_dates WHERE agency=$1', [AGENCY]);
    const newCalendarDates: CalendarDateRow[] = cd.rows.map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));

    const starts = await db.query<{ trip_id: string; route_id: string | null; service_id: string | null; start_s: number | null }>(
      `SELECT DISTINCT ON (t.trip_id) t.trip_id, t.route_id, t.service_id, COALESCE(st.departure_s, st.arrival_s) AS start_s
       FROM trips t JOIN stop_times st ON st.agency = t.agency AND st.trip_id = t.trip_id
       WHERE t.agency = $1 ORDER BY t.trip_id, st.stop_sequence`, [AGENCY]);
    const newStarts = new Map<string, TripStart>();
    const newStaticIds = new Set<string>();
    for (const r of starts.rows) {
      newStarts.set(r.trip_id, { routeId: r.route_id, serviceId: r.service_id, startS: r.start_s == null ? null : Number(r.start_s) });
      newStaticIds.add(r.trip_id);
    }
    let minStart = Infinity, maxEnd = 0;
    for (const c of newCalendar) { if (c.start_date < minStart) minStart = c.start_date; if (c.end_date > maxEnd) maxEnd = c.end_date; }
    boardCoverage = Number.isFinite(minStart) ? `${minStart}..${maxEnd}` : '?..?';

    // atomic swap
    calendar = newCalendar;
    calendarDates = newCalendarDates;
    tripStarts = newStarts;
    staticTripIds = newStaticIds;
    activeServiceCache.clear(); // active-service sets depend on the calendar we just replaced
    joinStats.boardCoverage = boardCoverage;
    console.log(`[poller] static context: ${calendar.length} calendar, ${calendarDates.length} calendar_dates, ${tripStarts.size} trips, board ${boardCoverage}`);
  }

  // Reload the static context (calendar/trips/index) on a service-day rollover or every
  // STATIC_RELOAD_MS, so a re-seed / board swap is picked up without a restart. Runs in
  // the background (rebuilding the index is heavy); one reload at a time.
  function maybeReloadStatic(now: number): void {
    if (staticReloading || lastStaticLoadAt === 0) return;
    const ymd = torontoYmd(now);
    const rollover = ymd !== lastStaticLoadYmd;
    const stale = now - lastStaticLoadAt > STATIC_RELOAD_MS;
    if (!rollover && !stale) return;
    staticReloading = true;
    console.log(`[poller] static reload triggered (${rollover ? 'service-day rollover' : '6h refresh'})`);
    void (async () => {
      try {
        await loadStaticContext();
        await buildIndex();
        lastStaticLoadAt = Date.now();
        lastStaticLoadYmd = torontoYmd(lastStaticLoadAt);
      } catch (e) {
        console.error('[poller] static reload failed (keeping previous context):', e);
      } finally {
        staticReloading = false;
      }
    })();
  }

  // Build the (route, stop) -> [{trip, depSec}] index over ALL loaded static trips.
  // Date-independent, so built once; the join votes against everything we have and
  // ghost detection then intersects claims with the calendar-active due set.
  async function buildIndex(): Promise<void> {
    const t0 = Date.now();
    const tripRoute = new Map<string, string>();
    const tr = await db.query<{ trip_id: string; route_id: string | null }>('SELECT trip_id, route_id FROM trips WHERE agency=$1', [AGENCY]);
    for (const r of tr.rows) if (r.route_id) tripRoute.set(r.trip_id, r.route_id);
    const rows: Array<{ routeId: string; stopId: string; depSec: number; tripId: string }> = [];
    const st = await db.query<{ trip_id: string; stop_id: string; dep: number | null }>(
      'SELECT trip_id, stop_id, COALESCE(departure_s, arrival_s) AS dep FROM stop_times WHERE agency=$1', [AGENCY]);
    for (const r of st.rows) {
      if (r.dep == null) continue;
      const routeId = tripRoute.get(r.trip_id);
      if (!routeId) continue;
      rows.push({ routeId, stopId: r.stop_id, depSec: Number(r.dep), tripId: r.trip_id });
    }
    routeStopIndex = buildRouteStopIndex(rows);
    indexReady = true;
    joinStats.indexReady = true;
    console.log(`[poller] join index ready: ${routeStopIndex.size} (route,stop) keys from ${rows.length} stop_times (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  function servicesForYmd(ymd: number, dow: number): Set<string> {
    let s = activeServiceCache.get(ymd);
    if (!s) { s = activeServiceIds(calendar, calendarDates, [{ ymd, dow }]); activeServiceCache.set(ymd, s); }
    return s;
  }
  function midnightForYmd(ymd: number): number {
    let m = midnightCache.get(ymd);
    if (m === undefined) {
      m = torontoMidnightEpoch(Math.floor(ymd / 10000), Math.floor((ymd % 10000) / 100), ymd % 100);
      midnightCache.set(ymd, m);
    }
    return m;
  }

  // ---------- batched insert ----------
  async function insertRows(table: string, columns: string[], rows: unknown[][], conflict: string): Promise<number> {
    if (rows.length === 0) return 0;
    let inserted = 0;
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
      const r = await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict}`, values);
      inserted += r.rowCount;
    }
    return inserted;
  }

  // ---------- per-poll processing ----------
  function processVehicles(msg: FeedMessage, vehicleTripIds: Set<string>, cycle: number): number {
    let n = 0;
    for (const e of msg.entity) {
      const v = e.vehicle;
      if (!v?.position) continue;
      n++;
      const vid = v.vehicle?.id ?? e.id;
      const tripId = v.trip?.tripId ?? null;
      const seq = v.currentStopSequence && v.currentStopSequence > 0 ? v.currentStopSequence : null;
      const ts = (toNum(v.timestamp) ?? Math.floor(Date.now() / 1000)) * 1000;
      const heading = v.position.bearing != null ? Number(v.position.bearing) : null;
      const speedMs = v.position.speed != null ? Number(v.position.speed) : null;
      positions.set(vid, { id: vid, tripId, routeId: v.trip?.routeId ?? null, seq, lat: v.position.latitude, lon: v.position.longitude, heading, speedMs, ts, cycleSeen: cycle });
      let buf = ring.get(vid);
      if (!buf) { buf = []; ring.set(vid, buf); }
      buf.push({ lat: v.position.latitude, lon: v.position.longitude, ts });
      if (buf.length > RING_BUFFER) buf.shift();
      if (tripId) vehicleTripIds.add(tripId);
    }
    return n;
  }

  interface TripUpdateParsed {
    rtTripId: string;
    routeId: string | null;
    canceled: boolean;
    reconstructed: RtStopObs[];               // stops usable for the identity join
    predictions: Array<{ stopId: string; timeMs: number }>; // upcoming predicted times
  }

  function processTripUpdates(
    msg: FeedMessage, now: number, vehicleSeqByTrip: Map<string, number>, obsRows: unknown[][], midToday: number,
  ): { count: number; parsed: TripUpdateParsed[] } {
    const CANCELED = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
    const parsed: TripUpdateParsed[] = [];
    let n = 0;
    for (const e of msg.entity) {
      const tu = e.tripUpdate;
      if (!tu) continue;
      n++;
      const rtTripId = tu.trip?.tripId ?? null;
      const routeId = tu.trip?.routeId ?? null;
      const startDate = tu.trip?.startDate ? Number(tu.trip.startDate) : null;
      const canceled = tu.trip?.scheduleRelationship === CANCELED;
      const reconstructed: RtStopObs[] = [];
      const predictions: Array<{ stopId: string; timeMs: number }> = [];
      const seqNow = rtTripId ? vehicleSeqByTrip.get(rtTripId) ?? null : null;

      for (const stu of tu.stopTimeUpdate ?? []) {
        const stopId = stu.stopId ?? null;
        if (!stopId) continue;
        const stopSeq = stu.stopSequence && stu.stopSequence > 0 ? stu.stopSequence : null;
        // Read time AND delay from the SAME StopTimeEvent (prefer departure when it has a
        // time, else arrival) — never mix a departure time with an arrival delay, or the
        // reconstructed schedule second would be garbage.
        const ev = stu.departure?.time != null ? stu.departure
          : stu.arrival?.time != null ? stu.arrival
          : (stu.departure ?? stu.arrival ?? null);
        const evTime = ev ? toNum(ev.time) : null;
        const delay = ev && ev.delay != null ? toNum(ev.delay) : null;

        // Live prediction for arrivals (future stops): keep the predicted event time.
        if (evTime != null) predictions.push({ stopId, timeMs: evTime * 1000 });

        // Identity-join reconstruction: scheduled = predicted - delay (delay is defined
        // relative to the static schedule). Only usable when both are present and the
        // stop is in a route/stop namespace we have.
        if (evTime != null && delay != null && Math.abs(delay) <= MAX_SANE_DELAY_S && routeId && routeStopIndex.has(indexKey(routeId, stopId))) {
          const schedSec = Math.round(((evTime - delay) * 1000 - midToday) / 1000);
          reconstructed.push({ stopId, schedSec });
        }

        // Honest delay observation (unchanged Phase-1 logic): only at passed stops with
        // an explicit delay; keyed for DB-enforced idempotency.
        const passedBySeq = seqNow != null && stopSeq != null && stopSeq < seqNow;
        const passedByTime = evTime != null && evTime * 1000 <= now;
        if (!passedBySeq && !passedByTime) continue;
        if (delay == null || Math.abs(delay) > MAX_SANE_DELAY_S) continue;
        const serviceDate = startDate ?? torontoYmd(now);
        const dkey = `${rtTripId}|${stopId}`;
        if (delayDedupe.get(dkey) === serviceDate) continue;
        delayDedupe.set(dkey, serviceDate);
        // Bucket by the SCHEDULED hour_of_week (scheduled = event - delay). Arrivals
        // reads the evidence bucket by the departure's scheduled time, so the write key
        // must be the scheduled hour too, not the actual event hour — otherwise a stop
        // near an hour boundary (or with a large delay) lands in an adjacent bucket.
        const scheduledEpoch = (evTime != null ? evTime * 1000 : now) - delay * 1000;
        obsRows.push([AGENCY, routeId, stopId, rtTripId, hourOfWeek(scheduledEpoch), delay, serviceDate]);
      }

      if (rtTripId) parsed.push({ rtTripId, routeId, canceled, reconstructed, predictions });
    }
    return { count: n, parsed };
  }

  // A calendar-active static trip whose scheduled start is inside the ghost scan window.
  interface DueTrip { tripId: string; routeId: string | null; startEpoch: number; key: string; present: boolean }

  // Active static trips currently due (scheduled start 6..30 min ago), annotated with
  // whether the identity join found them present this cycle.
  function computeDue(now: number, present: Set<string>): DueTrip[] {
    const days = [torontoDay(now), torontoDay(now - 86_400_000)];
    const out: DueTrip[] = [];
    const seen = new Set<string>();
    for (const day of days) {
      const svc = servicesForYmd(day.ymd, day.dow);
      if (svc.size === 0) continue;
      const midnight = midnightForYmd(day.ymd);
      for (const [tripId, info] of tripStarts) {
        if (info.startS == null || info.serviceId == null || !svc.has(info.serviceId)) continue;
        const startEpoch = midnight + info.startS * 1000;
        const age = now - startEpoch;
        if (age < GHOST_MIN_AGE_MS || age > GHOST_MAX_AGE_MS) continue;
        const key = `${tripId}|${startEpoch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tripId, routeId: info.routeId, startEpoch, key, present: present.has(tripId) });
      }
    }
    return out;
  }

  function cancelledRows(canceledStatic: Set<string>, now: number): unknown[][] {
    // Resolve the service day whose active set includes the trip (prefer today, then
    // yesterday for past-midnight >24h starts) so the scheduled_start matches the day
    // resolution in computeDueAndGhosts and dedupes against the equivalent ghost row.
    const days = [torontoDay(now), torontoDay(now - 86_400_000)];
    const rows: unknown[][] = [];
    const seen = new Set<string>();
    for (const tripId of canceledStatic) {
      const info = tripStarts.get(tripId);
      if (!info || info.startS == null || info.serviceId == null) continue;
      let startEpoch: number | null = null;
      for (const day of days) {
        if (servicesForYmd(day.ymd, day.dow).has(info.serviceId)) { startEpoch = midnightForYmd(day.ymd) + info.startS * 1000; break; }
      }
      if (startEpoch == null) continue;
      const dedupe = `${tripId}|${startEpoch}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      rows.push([AGENCY, tripId, info.routeId, new Date(startEpoch).toISOString(), 'cancelled']);
    }
    return rows;
  }

  async function processAlerts(msg: FeedMessage): Promise<number> {
    let n = 0;
    for (const e of msg.entity) {
      const al = e.alert;
      if (!al) continue;
      n++;
      const effect = enumName(transit_realtime.Alert.Effect as unknown as Record<string, number>, al.effect);
      const cause = enumName(transit_realtime.Alert.Cause as unknown as Record<string, number>, al.cause);
      const header = translated(al.headerText);
      const description = translated(al.descriptionText);
      const period = al.activePeriod?.[0];
      const activeStart = period?.start != null ? new Date((toNum(period.start) ?? 0) * 1000).toISOString() : null;
      const activeEnd = period?.end != null ? new Date((toNum(period.end) ?? 0) * 1000).toISOString() : null;
      const informed = (al.informedEntity ?? []).map((ie) => ({ routeId: ie.routeId ?? null, stopId: ie.stopId ?? null, tripId: ie.trip?.tripId ?? null, agencyId: ie.agencyId ?? null }));
      const text = `${header ?? ''} ${description ?? ''}`;
      const isAccessibility = effect === 'ACCESSIBILITY_ISSUE' || /elevator|escalator|wheelchair|accessib/i.test(text);
      await db.query(
        `INSERT INTO service_alerts (agency, alert_id, effect, cause, header, description, active_start, active_end, informed, is_accessibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT (agency, alert_id) DO UPDATE SET
           effect=EXCLUDED.effect, cause=EXCLUDED.cause, header=EXCLUDED.header, description=EXCLUDED.description,
           active_start=EXCLUDED.active_start, active_end=EXCLUDED.active_end, informed=EXCLUDED.informed, is_accessibility=EXCLUDED.is_accessibility`,
        [AGENCY, e.id, effect, cause, header, description, activeStart, activeEnd, JSON.stringify(informed), isAccessibility]);
    }
    return n;
  }

  async function retention(now: number): Promise<void> {
    const ymd = torontoYmd(now);
    if (ymd === lastRetentionYmd) return;
    const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
    const r = await db.query('DELETE FROM trip_delay_obs WHERE ts < $1', [cutoff]);
    lastRetentionYmd = ymd; // only mark done after a successful prune, so a failure retries
    if (r.rowCount > 0) console.log(`[poller][retention] deleted ${r.rowCount} obs older than ${RETENTION_DAYS}d`);
    let pruned = 0;
    for (const [k, sd] of delayDedupe) if (sd < ymd) { delayDedupe.delete(k); pruned++; }
    if (pruned > 0) console.log(`[poller][retention] pruned ${pruned} stale dedupe keys`);
  }

  function evictStaleVehicles(cycle: number): void {
    for (const [vid, st] of positions) if (cycle - st.cycleSeen > EVICT_AFTER_CYCLES) { positions.delete(vid); ring.delete(vid); }
  }

  async function poll(cycle: number): Promise<void> {
    const now = Date.now();
    await retention(now);
    maybeReloadStatic(now);
    const midToday = midnightForYmd(torontoDay(now).ymd);

    const [vr, tr, ar] = await Promise.all([fetchFeed('vehicles'), fetchFeed('trips'), fetchFeed('alerts')]);
    refreshStaleness(now);

    const vehicleTripIds = new Set<string>();
    const obsRows: unknown[][] = [];
    let vehicles = 0;
    if (vr.status === 'ok') vehicles = processVehicles(vr.msg, vehicleTripIds, cycle);
    else console.log(`[poller][cycle ${cycle}] vehicles ${vr.status}${'reason' in vr && vr.reason ? `: ${vr.reason}` : ''}`);
    evictStaleVehicles(cycle);

    // Vehicle current-stop-sequence keyed by RT trip id, for the passed-stop obs test.
    const vehicleSeqByTrip = new Map<string, number>();
    for (const v of positions.values()) if (v.tripId && v.seq != null) vehicleSeqByTrip.set(v.tripId, v.seq);

    let tripUpdates = 0;
    let parsed: TripUpdateParsed[] = [];
    if (tr.status === 'ok') { const r = processTripUpdates(tr.msg, now, vehicleSeqByTrip, obsRows, midToday); tripUpdates = r.count; parsed = r.parsed; }
    else console.log(`[poller][cycle ${cycle}] trips ${tr.status}${'reason' in tr && tr.reason ? `: ${tr.reason}` : ''}`);

    let obsInserted = 0;
    if (obsRows.length > 0) {
      obsInserted = await insertRows('trip_delay_obs', ['agency', 'route_id', 'stop_id', 'trip_id', 'hour_of_week', 'delay_s', 'service_date'], obsRows,
        'ON CONFLICT (agency, trip_id, stop_id, service_date) DO NOTHING');
      totals.obs += obsInserted;
    }

    // ----- Phase-2 identity join -----
    // NOTE: TTC sends no ETag/Last-Modified and never returns 304 (measured — see
    // BLOCKERS.md), so a fresh cycle is always a real 200. feedsFresh therefore gates the
    // ghost scan on actually having this cycle's vehicle+trip snapshots, never on reusing
    // a stale-but-unchanged one; the conditional-request headers are harmless no-ops.
    const feedsFresh = vr.status === 'ok' && tr.status === 'ok';
    let ghostsIns = 0, cancelledIns = 0, retracted = 0, joinRate: number | null = null;
    let dueCount = 0, unmatchedRt = 0, unmatchedVehicles = 0;
    let canceledSeen = 0, canceledIdentified = 0, canceledUnidentified = 0;
    if (indexReady) {
      const rtTrips: RtTripInput[] = parsed
        .filter((p) => p.routeId && p.reconstructed.length > 0)
        .map((p) => ({ rtTripId: p.rtTripId, routeId: p.routeId as string, stops: p.reconstructed }));
      const claim = claimTrips(rtTrips, routeStopIndex, { tolSec: JOIN_TOL_SEC, minVotes: JOIN_MIN_VOTES });
      const consideredRt = parsed.filter((p) => p.routeId).length;
      joinRate = consideredRt > 0 ? claim.claims.size / consideredRt : 0;
      unmatchedRt = consideredRt - claim.claims.size;
      joinStats.cumulativeClaimed += claim.claims.size;
      joinStats.cumulativeRt += consideredRt;
      const rtById = new Map(parsed.map((p) => [p.rtTripId, p]));

      // Rebuild the live-prediction store from this cycle's claimed (non-canceled) trips.
      const preds = new Map<string, Map<string, number>>();
      for (const [rtTripId, staticTripId] of claim.claims) {
        const p = rtById.get(rtTripId);
        if (!p || p.canceled) continue;
        const m = new Map<string, number>();
        for (const pr of p.predictions) m.set(pr.stopId, pr.timeMs);
        preds.set(staticTripId, m);
      }
      livePredictions = preds;

      // CANCELED entities (MAJOR 3): they ship no stop_time_update, so they cannot win the
      // >=2-stop join. Identify them by a direct static trip_id match first, then by any join
      // claim; anything left is genuinely anonymous — counted, never guessed. On the live TTC
      // feed CANCELED entities are ~0 (measured), so this path is honestly dormant today.
      const canceledStatic = new Set<string>();
      for (const p of parsed) {
        if (!p.canceled) continue;
        canceledSeen++;
        if (staticTripIds.has(p.rtTripId)) { canceledStatic.add(p.rtTripId); canceledIdentified++; }
        else if (claim.claims.has(p.rtTripId)) { canceledStatic.add(claim.claims.get(p.rtTripId)!); canceledIdentified++; }
        else canceledUnidentified++;
      }

      // Vehicles with an RT trip id that never appeared in a claimed trip update can't
      // be stop-matched — count them honestly (they may leave a trip looking absent).
      const claimedRt = new Set(claim.claims.keys());
      for (const tid of vehicleTripIds) if (!claimedRt.has(tid)) unmatchedVehicles++;

      const present = claim.claimedStatic;
      // Skip the ghost scan mid-reload too: tripStarts may already be the new board while
      // the join index is still the old one, which would make new-board trips look absent.
      if (feedsFresh && !staticReloading) {
        const dueList = computeDue(now, present);
        dueCount = dueList.length;
        const currentDueKeys = new Set<string>();

        // Confirmation + retraction. A ghost is only real after GHOST_CONFIRM_MISSES
        // consecutive absent cycles; a ghost we already wrote is RETRACTED (deleted) if the
        // trip is later claimed (or cancelled) while still inside the due window — a false
        // positive that is never reconciled would violate the product's core promise.
        const confirmed: DueTrip[] = [];
        const toRetract: DueTrip[] = [];
        for (const d of dueList) {
          currentDueKeys.add(d.key);
          if (canceledStatic.has(d.tripId)) {
            // An explicitly-cancelled trip is NOT a ghost — the cancelled path owns it.
            // Retract any ghost already written so the cancellation wins the ON CONFLICT,
            // and never let it enter the ghost `confirmed` set.
            ghostMissStreak.delete(d.key);
            if (ghostInserted.has(d.key)) toRetract.push(d);
            continue;
          }
          if (d.present) {
            ghostMissStreak.delete(d.key);
            if (ghostInserted.has(d.key)) toRetract.push(d);
          } else {
            const s = (ghostMissStreak.get(d.key) ?? 0) + 1;
            ghostMissStreak.set(d.key, s);
            if (s >= GHOST_CONFIRM_MISSES && !ghostInserted.has(d.key)) confirmed.push(d);
          }
        }
        for (const d of toRetract) {
          const r = await db.query("DELETE FROM ghosts WHERE agency=$1 AND trip_id=$2 AND scheduled_start=$3 AND kind='ghost'", [AGENCY, d.tripId, new Date(d.startEpoch).toISOString()]);
          retracted += r.rowCount;
          ghostInserted.delete(d.key);
          ghostMissStreak.delete(d.key);
        }
        if (retracted > 0) { joinStats.retractionsTotal += retracted; console.log(`[poller][cycle ${cycle}] retracted ${retracted} ghost(s) — trip(s) later claimed or cancelled within the due window`); }

        // Mass-ghost breakers on the confirmed set: GLOBAL (>30% of all due) plus PER-ROUTE
        // (>30% of a route's due, once it has >=4 due) — a board swap touching a few routes
        // would slip past a global-only breaker.
        const duePerRoute = new Map<string, number>();
        for (const d of dueList) { const k = d.routeId ?? '?'; duePerRoute.set(k, (duePerRoute.get(k) ?? 0) + 1); }
        const confirmedByRoute = new Map<string, DueTrip[]>();
        for (const d of confirmed) { const k = d.routeId ?? '?'; (confirmedByRoute.get(k) ?? confirmedByRoute.set(k, []).get(k)!).push(d); }

        const toInsert: DueTrip[] = [];
        let suppressed = false;
        if (dueCount > 0 && confirmed.length / dueCount > MASS_GHOST_FRACTION) {
          suppressed = true;
          console.log(`[poller][cycle ${cycle}] GLOBAL MASS-GHOST BREAKER: ${confirmed.length}/${dueCount} due (> ${MASS_GHOST_FRACTION * 100}%) — suppressing all (feed outage or our bug, not reality)`);
        } else {
          const suppressedRoutes: string[] = [];
          for (const [route, list] of confirmedByRoute) {
            const dueR = duePerRoute.get(route) ?? 0;
            if (dueR >= MASS_GHOST_ROUTE_MIN_DUE && list.length / dueR > MASS_GHOST_FRACTION) suppressedRoutes.push(`${route}:${list.length}/${dueR}`);
            else toInsert.push(...list);
          }
          if (suppressedRoutes.length > 0) { suppressed = true; console.log(`[poller][cycle ${cycle}] PER-ROUTE MASS-GHOST BREAKER suppressed ${suppressedRoutes.length} route(s): ${suppressedRoutes.join(' ')}`); }
        }
        if (suppressed) joinStats.massGhostTrippedCycles++;

        if (toInsert.length > 0) {
          const rows = toInsert.map((d) => [AGENCY, d.tripId, d.routeId, new Date(d.startEpoch).toISOString(), 'ghost']);
          ghostsIns = await insertRows('ghosts', ['agency', 'trip_id', 'route_id', 'scheduled_start', 'kind'], rows, 'ON CONFLICT (agency, trip_id, scheduled_start) DO NOTHING');
          for (const d of toInsert) ghostInserted.set(d.key, { tripId: d.tripId, startEpoch: d.startEpoch });
          totals.ghosts += ghostsIns;
        }

        const canc = cancelledRows(canceledStatic, now);
        if (canc.length > 0) { cancelledIns = await insertRows('ghosts', ['agency', 'trip_id', 'route_id', 'scheduled_start', 'kind'], canc, 'ON CONFLICT (agency, trip_id, scheduled_start) DO NOTHING'); totals.cancelled += cancelledIns; }

        // Prune confirmation/retraction bookkeeping for trips that have left the due window.
        for (const k of ghostMissStreak.keys()) if (!currentDueKeys.has(k)) ghostMissStreak.delete(k);
        for (const [k, v] of ghostInserted) if (now - v.startEpoch > GHOST_MAX_AGE_MS + 60_000) ghostInserted.delete(k);
      } else {
        console.log(`[poller][cycle ${cycle}] ghost scan skipped (${!feedsFresh ? 'vehicles/trips feed not fresh' : 'static reload in progress'})`);
      }
    }
    joinStats.lastJoinRate = joinRate;
    joinStats.lastGhosts = ghostsIns;
    joinStats.lastCancelled = cancelledIns;
    joinStats.lastRetracted = retracted;
    joinStats.lastDueTrips = dueCount;
    joinStats.lastUnmatchedRt = unmatchedRt;
    joinStats.lastUnmatchedVehicles = unmatchedVehicles;
    joinStats.lastCanceledSeen = canceledSeen;
    joinStats.lastCanceledIdentified = canceledIdentified;
    joinStats.lastCanceledUnidentified = canceledUnidentified;

    let alerts = 0;
    if (ar.status === 'ok') { alerts = await processAlerts(ar.msg); totals.alerts = alerts; }
    else if (ar.status !== 'notmodified') console.log(`[poller][cycle ${cycle}] alerts ${ar.status}${'reason' in ar && ar.reason ? `: ${ar.reason}` : ''}`);

    const jr = joinRate == null ? 'n/a(index warming)' : `${(joinRate * 100).toFixed(1)}%`;
    const cancTag = canceledSeen > 0 ? ` canceled(seen=${canceledSeen} id=${canceledIdentified} anon=${canceledUnidentified})` : '';
    console.log(
      `[poller][cycle ${cycle}] vehicles=${vehicles} tripUpdates=${tripUpdates} obs+=${obsInserted} ` +
      `join=${jr} due=${dueCount} ghosts+=${ghostsIns} retracted=${retracted} cancelled+=${cancelledIns}${cancTag} alerts=${alerts} ` +
      `| totals obs=${totals.obs} ghost=${totals.ghosts} cancelled=${totals.cancelled}`,
    );
  }

  // ---------- lifecycle ----------
  let started = false;
  async function initStatic(): Promise<void> {
    await loadStaticContext();
    lastStaticLoadAt = Date.now();
    lastStaticLoadYmd = torontoYmd(lastStaticLoadAt);
    // Build the (heavy) join index in the background so start() returns fast.
    buildIndex().catch((e) => console.error('[poller] join index build failed:', e));
  }

  function scheduleNext(cycle: number): void {
    if (stopping) return;
    timer = setTimeout(() => { void loop(cycle + 1); }, pollMs);
  }
  async function loop(cycle: number): Promise<void> {
    if (stopping) return;
    try { await poll(cycle); } catch (e) { console.error(`[poller][cycle ${cycle}] error:`, e); }
    if (maxCycles > 0 && cycle >= maxCycles) { console.log(`[poller] reached ${maxCycles} cycles.`); options.onExit?.(); return; }
    scheduleNext(cycle);
  }

  return {
    start() {
      if (started) return;
      started = true;
      void (async () => {
        await initStatic();
        void loop(1);
      })();
    },
    async stop() {
      stopping = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    async runOnce(cycle: number) { await poll(cycle); },
    getVehicleStates() { return [...positions.values()]; },
    getFeedHealth() {
      const now = Date.now();
      refreshStaleness(now);
      const feeds = {} as Record<FeedId, FeedRuntime>;
      for (const key of Object.keys(feedState) as FeedId[]) {
        const st = feedState[key];
        feeds[key] = { status: st.status, lastOkMs: st.lastOkMs, sinceMs: st.sinceMs };
      }
      return { feeds, lastPollAtMs };
    },
    getLivePredictionMs(staticTripId, stopId) { return livePredictions.get(staticTripId)?.get(stopId) ?? null; },
    getJoinStats() { return { ...joinStats }; },
    isIndexReady() { return indexReady; },
  };
}
