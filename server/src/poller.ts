// poller — the GTFS-realtime poll cycle + in-memory live state, extracted from the
// standalone collector so the API can run it in-process (one deployable service).
//
// What it does every POLL_MS:
//   - fetches the realtime feeds ITS OWN AGENCY publishes (conditional requests, timeout,
//     backoff) — which may be three, fewer, or none: see `feedIdsFor` in agencies.ts,
//   - keeps current vehicle positions in an in-memory map (never persisted),
//   - hands the decoded feeds to the delay engine (server/src/engine.ts), which learns
//     the RT->static stop crosswalk, binds realtime trips to static trips, and writes
//     genuine delay observations as (predicted_time - scheduled_time),
//   - decides which static trips are present from the engine's bindings, then detects
//     ghosts / cancelled among the calendar-active, due-but-absent trips, with a
//     mass-ghost sanity breaker,
//   - upserts the current service_alerts snapshot.
//
// WHAT USED TO BE HERE, AND WHY IT IS GONE. The old identity join reconstructed a
// scheduled time as (predicted - delay) and matched that against static stop_times. The
// TTC feed publishes no delay field at all (see pb.ts), so protobuf.js's proto2 default
// made that expression `predicted - 0 === predicted` — the join compared predictions
// against predictions, which is why its measured rate was 0%, and every one of the
// 300k+ delay observations it recorded was a decoder artifact. Both the join and that
// write are deleted rather than patched: no code path may reconstruct a scheduled time
// from the feed. Scheduled time comes only from our own seeded stop_times.
//
// `createPoller(db)` returns a handle with start/stop and getters the API reads from.
// All the Phase-1 honesty guards are intact: feedsFresh, retention, eviction, the
// mass-ghost breaker, and now the delay engine's own gates on top.
//
// ---------------------------------------------------------------------------------
// TWO CLOCKS AND ONE OPTIONAL SOURCE (Demo Mode)
//
// The poller has no idea Demo Mode exists. It has a `source`, which is `undefined` for
// the live TTC network fetch and supplied for a recorded replay, and it reads time from
// two clocks that are the same thing live and different things on a recording:
//
//   WALL CLOCK  (`Date.now()`)  — is our own poll loop alive? Backoff, feed staleness,
//                                 lastPollAtMs. Answers "did we get a snapshot just now".
//   DATA CLOCK  (`dataNow()`)   — what time is the DATA from? Service date, the ghost due
//                                 window, the engine's nowMs, retention. Answers "what
//                                 moment does this snapshot describe".
//
// Live, `dataNow() === Date.now()`. On a recording, `dataNow()` is the capture instant of
// the frame currently being replayed, so the whole pipeline sees the coherent past the
// bytes actually came from instead of judging 22:45-on-Saturday data against tonight's
// wall clock. That distinction is the difference between a demo that works and one that
// declares every bus in Toronto a ghost.
//
// The source also carries the AGENCY NAMESPACE every row this poller writes is tagged
// with ('ttc' live, 'ttc-demo' on a recording). Static schedule tables are read under the
// poller's OWN agency ('ttc', 'miway', …) in both modes — a schedule is not an observation,
// and a recording is a recording OF the same published board. See DECISIONS.md §44 / §48,
// and `getMode().staticAgency`, which is how a caller asks rather than assuming.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { Db } from './db.ts';
import { isDbClosed } from './db.ts';
import { activeServiceIds, boardSpan, type CalendarRow, type CalendarDateRow } from './gtfs.ts';
import { torontoDay, torontoMidnightEpoch, torontoYmd, serviceDay } from './tz.ts';
import { presentInt, presentStr, presentFloat } from './pb.ts';
import { decodeJsonFeed } from './rtjson.ts';
import { createDelayEngine, type DelayEngineStats, type EngineVehicle, type EngineTripUpdate, type EngineStopUpdate } from './engine.ts';
import { agency as agencyDescriptor, feedIdsFor, USER_AGENT, type AgencyDescriptor } from './agencies.ts';
import type { FeedId, FeedStatusKind } from '../../shared/types.ts';

const { transit_realtime } = GtfsRealtimeBindings;

/**
 * The published schedule's namespace for a DEFAULT poller. Still 'ttc' because that is the
 * agency a poller observes when nobody says otherwise, but it is no longer THE answer for
 * the process: a poller now carries its own descriptor, and `getMode().staticAgency` is
 * what any caller should read (DECISIONS §44, §48).
 *
 * A schedule is not an observation. Whatever a poller WRITES under (`ttc`, `ttc-demo`,
 * `miway`), it READS the published board under the agency's own id, because there is one
 * published board and a recording is a recording OF it.
 */
export const STATIC_AGENCY = 'ttc';

const POLL_MS = 45_000;
const REQUEST_TIMEOUT_MS = 10_000;
const STALE_AFTER_MS = 90_000;         // a feed is "stale" after 90s without a good poll
const GHOST_MIN_AGE_MS = 6 * 60_000;
const GHOST_MAX_AGE_MS = 30 * 60_000;
const RETENTION_DAYS = 14;
const RING_BUFFER = 6;
const EVICT_AFTER_CYCLES = 10;
const MASS_GHOST_FRACTION = 0.30;      // suppress a cycle emitting ghosts for >30% of due trips
const MASS_GHOST_ROUTE_MIN_DUE = 4;    // per-route breaker only applies once a route has >=4 due trips
const GHOST_CONFIRM_MISSES = 2;        // a trip must be absent this many consecutive cycles before it's a ghost
const STATIC_RELOAD_MS = 6 * 3_600_000; // reload calendar/trips/index every 6h (and on service-day rollover)

// ---------- protobuf field coercion ----------
// `toNum` used to live here. It coerced whatever a field read as, which on proto2 includes
// the materialised default of a field that was never sent. Its last two callers (the map's
// vehicle timestamp and an alert's active period) now go through pb.ts, which answers the
// presence question first; nothing should reintroduce a presence-blind numeric read.
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

export type { DelayEngineStats } from './engine.ts';

export interface JoinStats {
  indexReady: boolean;
  lastJoinRate: number | null;      // bound RT trips / RT trips considered, last cycle
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
  // Everything the delay engine measured this cycle, including the reason it is (or is
  // not) publishing. NOTE FOR THE api.ts OWNER: /api/health currently reads only
  // boardCoverage off this object; `delayEngine` is new and should be surfaced.
  delayEngine: DelayEngineStats;
}

/** Where this poller's bytes come from. Never inferred, never guessed, never blended. */
export type PollerMode = 'live' | 'demo';

/** Provenance of a recorded replay. Everything the UI needs under the amber DEMO badge. */
export interface DemoModeInfo {
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

/**
 * The honest answer to "what am I looking at". `mode` is decided once at boot and can
 * never change for the life of the process, so no response can ever be half live.
 */
export interface ModeInfo {
  mode: PollerMode;
  /** the namespace every row this poller writes is tagged with. */
  agency: string;
  /**
   * The namespace this poller READS the published schedule under — stops, routes, trips,
   * stop_times, shapes, calendar, calendar_dates.
   *
   * REQUIRED, and deliberately a separate field from `agency` rather than something a
   * caller can derive. DECISIONS §48 records both directions of getting this wrong shipping
   * in one file: hardcoding the static agency served live rows under the DEMO badge, and
   * then using the write agency everywhere made a demo instance read a namespace nothing is
   * written to and report "No TTC stops within 800 m" while standing at King & Spadina.
   * Two names, so neither can be typed where the other belongs.
   *
   * Equal to `agency` for a live poller; the underlying agency for a demo replay.
   */
  staticAgency: string;
  /** the DATA clock — what "now" means to this process. Live: the wall clock. */
  dataNowMs: number;
  /** the wall clock, always. Equal to dataNowMs when live. */
  wallNowMs: number;
  /** null unless mode === 'demo'. */
  demo: DemoModeInfo | null;
}

export type FeedMessage = ReturnType<typeof transit_realtime.FeedMessage.decode>;

/**
 * A replacement for the network fetch layer AND the clock, together, because they are the
 * same fact: bytes recorded at time T must be judged at time T. Supplying one is how Demo
 * Mode happens; nothing else in this file branches on the mode.
 */
export interface PollerSource {
  readonly mode: Exclude<PollerMode, 'live'>;
  /** namespace for every row written while this source is in use. */
  readonly agency: string;
  /** how often the poller should ask, so replay consumes every recorded frame exactly once. */
  readonly pollMs: number;
  /** the capture instant of the frame currently being replayed. */
  dataNow(): number;
  /** never throws; structurally identical to what the live fetch returns. */
  fetch(feed: FeedId): { status: 'ok'; msg: FeedMessage } | { status: 'error'; reason: string };
  describe(): DemoModeInfo;
}

export interface PollerHandle {
  start(): void;
  stop(): Promise<void>;
  runOnce(cycle: number): Promise<void>;
  getVehicleStates(): VehicleState[];
  getFeedHealth(): { feeds: Partial<Record<FeedId, FeedRuntime>>; lastPollAtMs: number | null; mode: PollerMode };
  getLivePredictionMs(staticTripId: string, stopId: string): number | null;
  getJoinStats(): JoinStats;
  isIndexReady(): boolean;
  /** The DATA clock. Anything that dates this poller's output must use it, not Date.now(). */
  now(): number;
  getMode(): ModeInfo;
}

interface FetchState { etag?: string; lastModified?: string; fails: number; nextAttemptAt: number; status: FeedStatusKind; lastOkMs: number | null; sinceMs: number | null }

export interface PollerOptions {
  pollMs?: number;
  maxCycles?: number;     // 0 = forever
  onExit?: () => void;    // called when maxCycles reached (standalone wrapper uses this)
  /** Recorded replay source. Absent = live network + wall clock. */
  source?: PollerSource;
  /**
   * Which agency this poller observes. Defaults to the TTC, so an existing caller that
   * passes nothing behaves exactly as before. The descriptor supplies the feed URLs, the
   * static namespace and — importantly — WHICH feeds exist at all.
   */
  agency?: AgencyDescriptor;
}

export function createPoller(db: Db, options: PollerOptions = {}): PollerHandle {
  const source = options.source ?? null;
  const mode: PollerMode = source ? source.mode : 'live';
  const descriptor = options.agency ?? agencyDescriptor(STATIC_AGENCY);
  /** The published board this poller reads. Never varies with mode. */
  const staticAgency = descriptor.id;
  // Every row this poller writes carries this. Static schedule reads always use
  // `staticAgency`, so a recording shares the board it is a recording OF and shares
  // nothing else.
  const agency = source ? source.agency : staticAgency;
  /**
   * ONLY the feeds this agency actually publishes. Iterating the three-member FeedId union
   * instead would invent feeds for an agency that has none: YRT publishes no alerts feed
   * (404) and Oakville publishes no realtime at all, and reporting those as `down` would
   * say "this feed is broken" when the truth is "this feed does not exist". Those are
   * opposite statements and gates.ts makes the same distinction for boardIntegrity.
   */
  const feeds: Partial<Record<FeedId, string>> = descriptor.rt;
  const feedIds: FeedId[] = feedIdsFor(descriptor);
  const pollMs = options.pollMs ?? source?.pollMs ?? POLL_MS;
  const maxCycles = options.maxCycles ?? 0;
  /** The DATA clock. See the two-clocks note at the top of this file. */
  const dataNow = (): number => (source ? source.dataNow() : Date.now());

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
  let boardCoverage = '?..?';
  let lastStaticLoadAt = 0;
  let lastStaticLoadYmd = 0;
  let staticReloading = false;

  // The delay engine owns the static pattern index, the learned stop crosswalk, trip
  // binding, and every delay row written. The poller feeds it decoded feeds and asks it
  // which static trips are present.
  // Static reads under this agency's own board, every learned/observed row under `agency`.
  // The descriptor's namespace claim rides along: 'identity' turns on the earned-and-
  // audited identity crosswalk and its gate, 'learned' (the TTC) changes nothing.
  const engine = createDelayEngine(db, staticAgency, agency, descriptor.rtNamespace);

  // Ghost confirmation/retraction state (keyed `${tripId}|${startEpoch}`):
  const ghostMissStreak = new Map<string, number>();   // consecutive cycles a due trip has been absent
  const ghostInserted = new Map<string, { tripId: string; startEpoch: number }>(); // ghost rows we wrote this run

  // Built from the agency's own feed list, so a feed this agency does not publish has no
  // entry at all — not an entry that reads `down` forever.
  const feedState: Partial<Record<FeedId, FetchState>> = {};
  for (const id of feedIds) {
    feedState[id] = { fails: 0, nextAttemptAt: 0, status: 'down', lastOkMs: null, sinceMs: null };
  }
  let lastPollAtMs: number | null = null;

  const totals = { obs: 0, ghosts: 0, cancelled: 0, alerts: 0 };
  const joinStats: JoinStats = {
    indexReady: false, lastJoinRate: null, cumulativeClaimed: 0, cumulativeRt: 0,
    lastGhosts: 0, lastCancelled: 0, lastDueTrips: 0, massGhostTrippedCycles: 0,
    lastUnmatchedRt: 0, lastUnmatchedVehicles: 0,
    retractionsTotal: 0, lastRetracted: 0, lastCanceledSeen: 0, lastCanceledIdentified: 0,
    lastCanceledUnidentified: 0, boardCoverage: '?..?',
    delayEngine: engine.getStats(),
  };
  let lastRetentionYmd = 0;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;

  // ---------- feed fetch ----------
  /**
   * The ONLY place the byte origin varies. Everything after it — health bookkeeping,
   * staleness, the engine, ghosts — is the same code on the same shapes in both modes.
   *
   * The health bookkeeping (`markOk`) lives on this side of the branch deliberately. An
   * earlier sketch of Demo Mode returned recorded frames *instead of* calling fetchFeed,
   * which meant `lastOkMs` was never set, `refreshStaleness` moved all three feeds to
   * `down`, and `/api/health` answered `ok:false` while the app was happily serving a
   * complete recorded snapshot. A demo whose first act is to report itself dead is worse
   * than no demo, so the recorded path goes through the same door as the live one.
   */
  async function fetchFeed(key: FeedId): Promise<{ status: 'ok'; msg: FeedMessage } | { status: 'notmodified' | 'skip' | 'error'; reason?: string }> {
    const st = feedState[key];
    const url = feeds[key];
    // This agency does not publish this feed. Not an error, not a backoff, not a `down`
    // status — there is simply nothing to ask for.
    if (!st || !url) return { status: 'skip', reason: `${descriptor.id} publishes no ${key} feed` };
    const now = Date.now();   // WALL clock: backoff and freshness are about our own loop
    if (now < st.nextAttemptAt) return { status: 'skip', reason: `backoff ${(st.nextAttemptAt - now) / 1000 | 0}s` };
    if (source) {
      const r = source.fetch(key);
      if (r.status === 'ok') { markOk(st, now); return r; }
      // A recorded failure is replayed once, exactly where the recorder hit it, and then
      // the recording moves on. No exponential backoff: the frames are already laid out in
      // time, and a 5-minute wall backoff would skip ~53 recorded minutes at 8x — turning
      // a faithfully reproduced 45-second hiccup into a hole the original never had.
      st.fails++;
      return { status: 'error', reason: r.reason };
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
      if (st.etag) headers['If-None-Match'] = st.etag;
      if (st.lastModified) headers['If-Modified-Since'] = st.lastModified;
      const res = await fetch(url, { signal: ctrl.signal, headers });
      if (res.status === 304) { markOk(st, now); return { status: 'notmodified' }; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // A descriptor-flagged JSON feed (Metrolinx/GO — see rtjson.ts for the casing and
      // presence traps) parses through fromObject; every other agency's binary decode is
      // byte-for-byte the line it always was.
      const msg = descriptor.rtFormat === 'json'
        ? decodeJsonFeed(buf)
        : transit_realtime.FeedMessage.decode(buf);
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
    for (const key of feedIds) {
      const st = feedState[key];
      if (!st) continue;
      const wanted: FeedStatusKind = st.lastOkMs == null ? 'down' : (now - st.lastOkMs > STALE_AFTER_MS ? 'stale' : 'ok');
      if (wanted !== st.status) { st.status = wanted; st.sinceMs = now; }
    }
  }

  // ---------- static context ----------
  // Builds fresh structures and swaps them in atomically, so a concurrent poll cycle
  // never sees a half-cleared calendar/trip map during a reload.
  async function loadStaticContext(): Promise<void> {
    const cal = await db.query<{ service_id: string; mon: boolean; tue: boolean; wed: boolean; thu: boolean; fri: boolean; sat: boolean; sun: boolean; start_date: number; end_date: number }>(
      'SELECT service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date FROM calendar WHERE agency=$1', [staticAgency]);
    const newCalendar: CalendarRow[] = cal.rows.map((r) => ({
      service_id: r.service_id, days: [r.mon, r.tue, r.wed, r.thu, r.fri, r.sat, r.sun],
      start_date: Number(r.start_date), end_date: Number(r.end_date),
    }));
    const cd = await db.query<{ service_id: string; date: number; exception_type: number }>(
      'SELECT service_id, date, exception_type FROM calendar_dates WHERE agency=$1', [staticAgency]);
    const newCalendarDates: CalendarDateRow[] = cd.rows.map((r) => ({ service_id: r.service_id, date: Number(r.date), exception_type: Number(r.exception_type) }));

    const starts = await db.query<{ trip_id: string; route_id: string | null; service_id: string | null; start_s: number | null }>(
      `SELECT DISTINCT ON (t.trip_id) t.trip_id, t.route_id, t.service_id, COALESCE(st.departure_s, st.arrival_s) AS start_s
       FROM trips t JOIN stop_times st ON st.agency = t.agency AND st.trip_id = t.trip_id
       WHERE t.agency = $1 ORDER BY t.trip_id, st.stop_sequence`, [staticAgency]);
    const newStarts = new Map<string, TripStart>();
    const newStaticIds = new Set<string>();
    for (const r of starts.rows) {
      newStarts.set(r.trip_id, { routeId: r.route_id, serviceId: r.service_id, startS: r.start_s == null ? null : Number(r.start_s) });
      newStaticIds.add(r.trip_id);
    }
    /**
     * THE BOARD TAG MUST CHANGE WHEN THE BOARD CHANGES, OR THE CROSSWALK GOES STALE SILENTLY.
     *
     * This used to read `calendar` alone. That is fine for a feed with a populated
     * calendar.txt and quietly broken for one without: MiWay and GO ship NO calendar.txt at
     * all and Brampton ships a header-only one, expressing service entirely through
     * calendar_dates.txt (valid GTFS — `activeServiceIds` already handles it). For those
     * agencies `minStart` stayed Infinity and the tag became the literal `'?..?'`.
     *
     * `boardCoverage` is not just a display string: it IS the `board_tag` scoping
     * `rt_stop_xwalk`, `rt_stop_xwalk_votes` and `rt_pattern` (migration 004), and
     * ARCHITECTURE.md §6 depends on it changing — "A board change wipes the crosswalk and
     * every binding… carrying the old crosswalk across would silently map realtime stops
     * onto a schedule they were never learned from." A constant `'?..?'` means a new board
     * reuses the previous board's learned stop identities. The `agency` column still keeps
     * agencies apart, so this was never a blending bug between agencies — it was a
     * stale-within-one-agency bug, which is exactly what §6 exists to prevent.
     *
     * So the span is taken over calendar ∪ calendar_dates — the same union `boardDays` in
     * the seeder already computes to decide which trips to load. A feed with neither is the
     * only remaining `'?..?'`, and that feed has no schedule at all.
     */
    const span = boardSpan(newCalendar, newCalendarDates);
    boardCoverage = span ? `${span.first}..${span.last}` : '?..?';

    // atomic swap
    calendar = newCalendar;
    calendarDates = newCalendarDates;
    tripStarts = newStarts;
    staticTripIds = newStaticIds;
    activeServiceCache.clear(); // active-service sets depend on the calendar we just replaced
    joinStats.boardCoverage = boardCoverage;
    console.log(`[poller:${staticAgency}] static context: ${calendar.length} calendar, ${calendarDates.length} calendar_dates, ${tripStarts.size} trips, board ${boardCoverage}`);
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
    console.log(`[poller:${staticAgency}] static reload triggered (${rollover ? 'service-day rollover' : '6h refresh'})`);
    void (async () => {
      try {
        await loadStaticContext();
        await buildIndex();
        lastStaticLoadAt = dataNow();
        lastStaticLoadYmd = torontoYmd(lastStaticLoadAt);
      } catch (e) {
        console.error('[poller] static reload failed (keeping previous context):', e);
      } finally {
        staticReloading = false;
      }
    })();
  }

  // Build the static PATTERN index the delay engine matches against. Measured at 109 s
  // and 71 MB of heap over Neon (2.15M stop_times, keyset-paged), so it is always built
  // in the background and never on a request path.
  async function buildIndex(): Promise<void> {
    await engine.reloadStatic(boardCoverage);
    joinStats.indexReady = engine.isReady();
  }

  /**
   * The service_ids active on one service day. `ReadonlySet` is load-bearing, not
   * decoration: this returns the CACHE ENTRY itself, so a caller that added to it would
   * corrupt the answer for every later caller and for the rest of the process. One
   * caller did exactly that — see the note at the engine cycle input, and DECISIONS §54.
   */
  function servicesForYmd(ymd: number, dow: number): ReadonlySet<string> {
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
  /**
   * The map's vehicle DTO. Every optional scalar goes through pb.ts for the same reason
   * the delay path does: GTFS-realtime is proto2, so `v.position.bearing` reads 0 and
   * `v.timestamp` reads 0 for a producer that never sent them, and a `!= null` test cannot
   * tell "reported" from "never reported". Reading a materialised default as a measurement
   * is the exact mistake that produced 314,742 information-free delay observations
   * (BLOCKERS 6); it costs a wrong sprite rotation here rather than a wrong statistic, but
   * the rule is the same everywhere or it is not a rule.
   *
   * An absent bearing therefore stays NULL rather than becoming 0 (due north): the map
   * already falls back to the bearing implied by the vehicle's own movement.
   */
  function processVehicles(msg: FeedMessage, vehicleTripIds: Set<string>, cycle: number): number {
    let n = 0;
    for (const e of msg.entity) {
      const v = e.vehicle;
      if (!v?.position) continue;
      n++;
      const vid = presentStr(v.vehicle, 'id') ?? e.id;
      const tripId = presentStr(v.trip, 'tripId');
      const seqOnWire = presentInt(v, 'currentStopSequence');
      const seq = seqOnWire != null && seqOnWire > 0 ? seqOnWire : null;
      const tsS = presentInt(v, 'timestamp');
      // Absent means "we do not know when this ping was taken", so the fallback is now —
      // reading the proto2 default made it 1970-01-01 and the fallback unreachable.
      const ts = (tsS ?? Math.floor(dataNow() / 1000)) * 1000;
      const heading = presentFloat(v.position, 'bearing');
      const speedMs = presentFloat(v.position, 'speed');
      positions.set(vid, { id: vid, tripId, routeId: presentStr(v.trip, 'routeId'), seq, lat: v.position.latitude, lon: v.position.longitude, heading, speedMs, ts, cycleSeen: cycle });
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
    /** upcoming predicted event times, keyed by RT stop id, for arrivals' liveEtaMs. */
    predictions: Array<{ rtStopId: string; timeMs: number }>;
    /** the same trip update, shaped for the delay engine. */
    engine: EngineTripUpdate;
  }

  /**
   * Decode trip updates. NOTHING is written to trip_delay_obs here any more, and no
   * scheduled time is reconstructed from the feed — the feed carries no delay to
   * reconstruct one from. Every optional scalar goes through pb.ts so an absent field
   * stays absent instead of decoding as a proto2 default.
   */
  function processTripUpdates(msg: FeedMessage): { count: number; parsed: TripUpdateParsed[] } {
    const CANCELED = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
    const parsed: TripUpdateParsed[] = [];
    let n = 0;
    for (const e of msg.entity) {
      const tu = e.tripUpdate;
      if (!tu) continue;
      n++;
      const rtTripId = presentStr(tu.trip, 'tripId');
      const routeId = presentStr(tu.trip, 'routeId');
      const sr = presentInt(tu.trip, 'scheduleRelationship');
      const canceled = sr === CANCELED;
      const predictions: Array<{ rtStopId: string; timeMs: number }> = [];
      const engineStops: EngineStopUpdate[] = [];

      for (const stu of tu.stopTimeUpdate ?? []) {
        const rtStopId = presentStr(stu, 'stopId');
        const stopSequence = presentInt(stu, 'stopSequence');
        // scheduleRelationship 2 is NO_DATA, not SKIPPED (verified: SKIPPED count is 0 and
        // NO_DATA is ~500 per snapshot). NO_DATA carries no time; imputing an on-time
        // arrival for it would be exactly the fabrication this engine exists to remove.
        const stuSr = presentInt(stu, 'scheduleRelationship');
        const noData = stuSr === 2;

        // Take time from ONE StopTimeEvent, never mixing the two. Measured: 22,391
        // arrival-only, 602 departure-only, 0 carrying both — so the event kind is
        // unambiguous per stop and determines whether we compare against the scheduled
        // arrival or the scheduled departure.
        const depTime = presentInt(stu.departure, 'time');
        const arrTime = presentInt(stu.arrival, 'time');
        const kind: 'arrival' | 'departure' = depTime != null ? 'departure' : 'arrival';
        const epochS = depTime ?? arrTime;

        if (rtStopId && epochS != null) predictions.push({ rtStopId, timeMs: epochS * 1000 });
        if (rtStopId) engineStops.push({ stopSequence, rtStopId, epochS, kind, noData });
      }

      if (rtTripId) {
        parsed.push({
          rtTripId, routeId, canceled, predictions,
          engine: { rtTripId, routeId, scheduleRelationship: sr, stops: engineStops },
        });
      }
    }
    return { count: n, parsed };
  }

  /** Decoded vehicles, shaped for the delay engine's geometric anchors. */
  function engineVehicles(msg: FeedMessage): EngineVehicle[] {
    const out: EngineVehicle[] = [];
    for (const e of msg.entity) {
      const v = e.vehicle;
      if (!v?.position) continue;
      out.push({
        vehicleId: presentStr(v.vehicle, 'id') ?? e.id,
        routeId: presentStr(v.trip, 'routeId'),
        rtTripId: presentStr(v.trip, 'tripId'),
        rtStopId: presentStr(v, 'stopId'),
        // MUST be presentInt: the proto2 default for currentStatus is IN_TRANSIT_TO (2),
        // so `v.currentStatus` reads 2 for the 565 of 1,413 vehicles that never sent it.
        currentStatus: presentInt(v, 'currentStatus'),
        lat: v.position.latitude,
        lon: v.position.longitude,
        tsS: presentInt(v, 'timestamp'),
      });
    }
    return out;
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
      rows.push([agency, tripId, info.routeId, new Date(startEpoch).toISOString(), 'cancelled']);
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
      // TimeRange.start/end are proto2 optional uint64: an open-ended period reads 0 and
      // would be published as a real window starting 1970-01-01. Absent stays null.
      const period = al.activePeriod?.[0];
      const startS = presentInt(period, 'start');
      const endS = presentInt(period, 'end');
      const activeStart = startS == null ? null : new Date(startS * 1000).toISOString();
      const activeEnd = endS == null ? null : new Date(endS * 1000).toISOString();
      const informed = (al.informedEntity ?? []).map((ie) => ({ routeId: presentStr(ie, 'routeId'), stopId: presentStr(ie, 'stopId'), tripId: presentStr(ie.trip, 'tripId'), agencyId: presentStr(ie, 'agencyId') }));
      const text = `${header ?? ''} ${description ?? ''}`;
      const isAccessibility = effect === 'ACCESSIBILITY_ISSUE' || /elevator|escalator|wheelchair|accessib/i.test(text);
      await db.query(
        `INSERT INTO service_alerts (agency, alert_id, effect, cause, header, description, active_start, active_end, informed, is_accessibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
         ON CONFLICT (agency, alert_id) DO UPDATE SET
           effect=EXCLUDED.effect, cause=EXCLUDED.cause, header=EXCLUDED.header, description=EXCLUDED.description,
           active_start=EXCLUDED.active_start, active_end=EXCLUDED.active_end, informed=EXCLUDED.informed, is_accessibility=EXCLUDED.is_accessibility`,
        [agency, e.id, effect, cause, header, description, activeStart, activeEnd, JSON.stringify(informed), isAccessibility]);
    }
    return n;
  }

  /**
   * WALL clock, deliberately, even in demo mode: the column this filters (`trip_delay_obs.ts`)
   * is stamped by the database's own `DEFAULT now()`, so its cutoff has to be on the same
   * clock. Mixing them would compare a wall-clock column against a capture-window instant.
   */
  async function retention(now: number): Promise<void> {
    const ymd = torontoYmd(now);
    if (ymd === lastRetentionYmd) return;
    const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
    // Agency-scoped on purpose: unscoped, a recorded-replay process would prune the
    // LIVE observation table, which is exactly the blend Demo Mode may never cause.
    const r = await db.query('DELETE FROM trip_delay_obs WHERE agency=$1 AND ts < $2', [agency, cutoff]);
    lastRetentionYmd = ymd; // only mark done after a successful prune, so a failure retries
    if (r.rowCount > 0) console.log(`[poller:${staticAgency}][retention] deleted ${r.rowCount} obs older than ${RETENTION_DAYS}d`);
  }

  function evictStaleVehicles(cycle: number): void {
    for (const [vid, st] of positions) if (cycle - st.cycleSeen > EVICT_AFTER_CYCLES) { positions.delete(vid); ring.delete(vid); }
  }

  async function poll(cycle: number): Promise<void> {
    // DATA clock: everything below dates the snapshot, not our own liveness.
    const now = dataNow();
    await retention(Date.now());
    maybeReloadStatic(now);

    const [vr, tr, ar] = await Promise.all([fetchFeed('vehicles'), fetchFeed('trips'), fetchFeed('alerts')]);
    /**
     * A feed this agency does not publish is not news. `fetchFeed` already returns `skip`
     * for it, but logging that every 45 s would fill a schedule-only agency's log with
     * three lines a cycle about feeds that do not exist. Absence is reported once, by
     * `/api/health` omitting the key — not repeatedly, as if something were wrong.
     */
    const publishes = (id: FeedId): boolean => feeds[id] != null;
    // WALL clock: staleness asks whether OUR poll loop is still getting snapshots, and
    // `markOk`/`getFeedHealth` both stamp it from Date.now(). Feeding it the data clock
    // would leave `sinceMs` carrying a capture-window instant or a wall-clock one
    // depending on which caller wrote it last — and `sinceMs` is API-visible.
    refreshStaleness(Date.now());

    const vehicleTripIds = new Set<string>();
    let vehicles = 0;
    if (vr.status === 'ok') vehicles = processVehicles(vr.msg, vehicleTripIds, cycle);
    else if (publishes('vehicles')) console.log(`[poller:${staticAgency}][cycle ${cycle}] vehicles ${vr.status}${'reason' in vr && vr.reason ? `: ${vr.reason}` : ''}`);
    evictStaleVehicles(cycle);

    let tripUpdates = 0;
    let parsed: TripUpdateParsed[] = [];
    if (tr.status === 'ok') { const r = processTripUpdates(tr.msg); tripUpdates = r.count; parsed = r.parsed; }
    else if (publishes('trips')) console.log(`[poller:${staticAgency}][cycle ${cycle}] trips ${tr.status}${'reason' in tr && tr.reason ? `: ${tr.reason}` : ''}`);

    // ----- the delay engine -----
    // NOTE: TTC sends no ETag/Last-Modified and never returns 304 (measured — see
    // BLOCKERS.md), so a fresh cycle is always a real 200. feedsFresh therefore gates the
    // ghost scan on actually having this cycle's vehicle+trip snapshots, never on reusing
    // a stale-but-unchanged one; the conditional-request headers are harmless no-ops.
    const feedsFresh = vr.status === 'ok' && tr.status === 'ok';
    let ghostsIns = 0, cancelledIns = 0, retracted = 0, joinRate: number | null = null;
    let dueCount = 0, unmatchedRt = 0, unmatchedVehicles = 0;
    let canceledSeen = 0, canceledIdentified = 0, canceledUnidentified = 0;
    let obsInserted = 0;

    if (engine.isReady()) {
      // ONE SERVICE DAY, ASKED WITH ITS OWN WEEKDAY. The engine measures every origin
      // residual against `serviceDate`'s midnight, so a slot belonging to any OTHER
      // service day is not a near-miss candidate — it is off by a whole day and can only
      // ever be noise in the candidate set.
      //
      // This used to union in the previous calendar day's services, to cover "a trip that
      // started before midnight is still running". It does not need covering: `serviceDay`
      // is already (now − 4 h), so at 01:30 the service date IS yesterday and yesterday's
      // services are exactly what this returns. The union only ever added a second,
      // complete service calendar — and on any day whose service_id differs from the
      // previous day's (every Saturday, every Sunday, every holiday) that doubled the
      // slots on every pattern with a near-duplicate schedule, so the origin lock's
      // runner-up sat inside MARGIN_MIN_S and `refused_ambiguous` swallowed the day.
      // Worse, `servicesForYmd` hands back its CACHED set, so the union mutated the cache
      // in place: the poison persisted for the life of the process and accumulated one
      // more service calendar per day. See DECISIONS §54.
      const svcDay = serviceDay(now);
      const serviceDate = svcDay.ymd;
      const activeServices = servicesForYmd(svcDay.ymd, svcDay.dow);

      if (feedsFresh && !staticReloading) {
        try {
          const res = await engine.runCycle({
            nowMs: now,
            serviceDate,
            vehicles: vr.status === 'ok' ? engineVehicles(vr.msg) : [],
            tripUpdates: parsed.map((p) => p.engine),
            activeServices,
          });
          obsInserted = res.rows;
          totals.obs += obsInserted;
        } catch (e) {
          console.error(`[poller:${staticAgency}][cycle ${cycle}] delay engine error:`, e);
        }
      }
      joinStats.delayEngine = engine.getStats();

      // "Present" now means the delay engine holds a live binding for the static trip.
      const present = engine.getPresentStaticTrips();
      const consideredRt = parsed.filter((p) => p.routeId).length;
      joinRate = consideredRt > 0 ? present.size / consideredRt : 0;
      unmatchedRt = consideredRt - present.size;
      joinStats.cumulativeClaimed += present.size;
      joinStats.cumulativeRt += consideredRt;

      // Live predictions for the arrivals endpoint, keyed by STATIC trip + STATIC stop, so
      // they are only published for trips we actually bound and stops we actually
      // crosswalked. An unbound trip contributes nothing rather than a guess.
      const bindingByRt = engine.getBindingsByRtTrip();
      const preds = new Map<string, Map<string, number>>();
      for (const p of parsed) {
        if (p.canceled) continue;
        const b = bindingByRt.get(p.rtTripId);
        if (!b) continue;
        const m = new Map<string, number>();
        for (const pr of p.predictions) {
          const staticStopId = engine.staticStopFor(pr.rtStopId);
          if (staticStopId) m.set(staticStopId, pr.timeMs);
        }
        if (m.size > 0) preds.set(b, m);
      }
      livePredictions = preds;

      // CANCELED entities: they ship no stop_time_update, so they can never be bound by the
      // origin lock. Identify them by a direct static trip_id match first, then by an
      // existing binding; anything left is genuinely anonymous — counted, never guessed. On
      // the live TTC feed CANCELED entities are ~0 (measured), so this path is honestly
      // dormant today.
      const canceledStatic = new Set<string>();
      for (const p of parsed) {
        if (!p.canceled) continue;
        canceledSeen++;
        const bound = bindingByRt.get(p.rtTripId);
        if (staticTripIds.has(p.rtTripId)) { canceledStatic.add(p.rtTripId); canceledIdentified++; }
        else if (bound) { canceledStatic.add(bound); canceledIdentified++; }
        else canceledUnidentified++;
      }

      // Vehicles with an RT trip id that never appeared in a bound trip update can't be
      // measured — count them honestly (they may leave a trip looking absent).
      for (const tid of vehicleTripIds) if (!bindingByRt.has(tid)) unmatchedVehicles++;

      // Skip the ghost scan mid-reload too: tripStarts may already be the new board while
      // the pattern index is still the old one, which would make new-board trips look absent.
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
          const r = await db.query("DELETE FROM ghosts WHERE agency=$1 AND trip_id=$2 AND scheduled_start=$3 AND kind='ghost'", [agency, d.tripId, new Date(d.startEpoch).toISOString()]);
          retracted += r.rowCount;
          ghostInserted.delete(d.key);
          ghostMissStreak.delete(d.key);
        }
        if (retracted > 0) { joinStats.retractionsTotal += retracted; console.log(`[poller:${staticAgency}][cycle ${cycle}] retracted ${retracted} ghost(s) — trip(s) later claimed or cancelled within the due window`); }

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
          console.log(`[poller:${staticAgency}][cycle ${cycle}] GLOBAL MASS-GHOST BREAKER: ${confirmed.length}/${dueCount} due (> ${MASS_GHOST_FRACTION * 100}%) — suppressing all (feed outage or our bug, not reality)`);
        } else {
          const suppressedRoutes: string[] = [];
          for (const [route, list] of confirmedByRoute) {
            const dueR = duePerRoute.get(route) ?? 0;
            if (dueR >= MASS_GHOST_ROUTE_MIN_DUE && list.length / dueR > MASS_GHOST_FRACTION) suppressedRoutes.push(`${route}:${list.length}/${dueR}`);
            else toInsert.push(...list);
          }
          if (suppressedRoutes.length > 0) { suppressed = true; console.log(`[poller:${staticAgency}][cycle ${cycle}] PER-ROUTE MASS-GHOST BREAKER suppressed ${suppressedRoutes.length} route(s): ${suppressedRoutes.join(' ')}`); }
        }
        if (suppressed) joinStats.massGhostTrippedCycles++;

        if (toInsert.length > 0) {
          const rows = toInsert.map((d) => [agency, d.tripId, d.routeId, new Date(d.startEpoch).toISOString(), 'ghost']);
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
        console.log(`[poller:${staticAgency}][cycle ${cycle}] ghost scan skipped (${!feedsFresh ? 'vehicles/trips feed not fresh' : 'static reload in progress'})`);
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
    else if (ar.status !== 'notmodified' && publishes('alerts')) console.log(`[poller:${staticAgency}][cycle ${cycle}] alerts ${ar.status}${'reason' in ar && ar.reason ? `: ${ar.reason}` : ''}`);

    const jr = joinRate == null ? 'n/a(index warming)' : `${(joinRate * 100).toFixed(1)}%`;
    const cancTag = canceledSeen > 0 ? ` canceled(seen=${canceledSeen} id=${canceledIdentified} anon=${canceledUnidentified})` : '';
    // A demo cycle is labelled in the log for the same reason it is labelled in the UI:
    // a line that looks like a live cycle and is not would be the worst artefact this
    // codebase could produce.
    if (source) {
      const p = source.describe();
      console.log(`[poller:${staticAgency}][cycle ${cycle}] DEMO replay t+${(p.positionMs / 1000).toFixed(0)}s of ` +
        `${((p.captureEndMs - p.captureStartMs) / 1000).toFixed(0)}s (loop ${p.loops}, ${p.speed}x) ` +
        `data clock ${new Date(now).toISOString()} — recorded, not live`);
    }
    console.log(
      `[poller:${staticAgency}][cycle ${cycle}] vehicles=${vehicles} tripUpdates=${tripUpdates} obs+=${obsInserted} ` +
      `join=${jr} due=${dueCount} ghosts+=${ghostsIns} retracted=${retracted} cancelled+=${cancelledIns}${cancTag} alerts=${alerts} ` +
      `| totals obs=${totals.obs} ghost=${totals.ghosts} cancelled=${totals.cancelled}`,
    );
    // The engine's own state, every cycle. The suppression reason in particular must be
    // visible in the log: a collector that quietly writes nothing looks identical to one
    // that is broken, and the whole point is that we can always say which.
    if (engine.isReady()) {
      const d = joinStats.delayEngine;
      console.log(
        `[engine:${staticAgency}][cycle ${cycle}] xwalk ${d.xwalk.confirmed}/${d.xwalk.rtStopsSeen} confirmed ` +
        `(${(d.xwalk.occurrenceCoverage * 100).toFixed(1)}% of occurrences, ${d.xwalk.conflicted} conflicted, ` +
        `agree=${d.xwalk.crossRouteAgreement == null ? 'n/a' : (d.xwalk.crossRouteAgreement * 100).toFixed(1) + '%'}) ` +
        `| patterns ${d.patterns.resolved}/${d.patterns.rtTotal} resolved (maxIter=${d.patterns.maxResolveIter}, ` +
        `amb=${d.patterns.ambiguous} noCand=${d.patterns.noCandidate} thin=${d.patterns.tooFewAnchors}) ` +
        `| bindings births=${d.bindings.births} pending=${d.bindings.pending} active=${d.bindings.active} ` +
        // Where THIS cycle's pending births stopped, then the cumulative refusal ledger.
        // `pending` climbing while `active` sits at zero is the engine's worst-looking and
        // least-explained state; these two groups are what turn it into a sentence.
        `| lock unres=${d.bindings.lockPath.patternUnresolved} noPat=${d.bindings.lockPath.noPattern} ` +
        `originUnconf=${d.bindings.lockPath.originUnconfirmed} scored=${d.bindings.lockPath.reached} ` +
        `locked=${d.bindings.lockPath.locked} ` +
        `| refused(cum) noSlot=${d.bindings.refusedNoSlot} amb=${d.bindings.refusedAmbiguous} ` +
        `hw=${d.bindings.refusedHeadwayBand} inactive=${d.bindings.refusedBoardInactive} ` +
        `midroute=${d.bindings.refusedMidroute} unres=${d.bindings.refusedUnresolved} ` +
        `| directTripIdMatch=${(d.directTripIdMatchRate * 100).toFixed(1)}% ` +
        // Only for feeds that publish no stop_sequence at all. Silent for every other one.
        (d.seqRecovery.needed > 0
          ? `| seqFromBoard=${d.seqRecovery.recovered}/${d.seqRecovery.needed} ` : '') +
        `| ${d.suppressionReason ? `SUPPRESSED (${d.suppressionGate}): ${d.suppressionReason}` : 'publishing'}`,
      );
    }
  }

  // ---------- lifecycle ----------
  let started = false;
  async function initStatic(): Promise<void> {
    await loadStaticContext();
    lastStaticLoadAt = dataNow();
    lastStaticLoadYmd = torontoYmd(lastStaticLoadAt);
    // Build the (heavy) join index in the background so start() returns fast.
    buildIndex().catch((e) => {
      // A shutdown mid-build is expected, not a failure: the index takes ~109 s and the
      // process can be stopped at any point inside it. Anything else is a real error.
      if (isDbClosed(e)) console.log('[poller] join index build aborted: shutting down');
      else console.error('[poller] join index build failed:', e);
    });
  }

  function scheduleNext(cycle: number): void {
    if (stopping) return;
    timer = setTimeout(() => { void loop(cycle + 1); }, pollMs);
  }
  async function loop(cycle: number): Promise<void> {
    if (stopping) return;
    try { await poll(cycle); } catch (e) { console.error(`[poller:${staticAgency}][cycle ${cycle}] error:`, e); }
    if (maxCycles > 0 && cycle >= maxCycles) { console.log(`[poller:${staticAgency}] reached ${maxCycles} cycles.`); options.onExit?.(); return; }
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
      // WALL clock: `status`/`lastOkMs` answer "is our poll loop getting snapshots", which
      // is a question about this process, not about the data's age. On a recording they
      // are honestly `ok` — a recorded frame did arrive, just now — and `mode` alongside
      // them is what stops that from reading as "live".
      const now = Date.now();
      refreshStaleness(now);
      // Named `out` rather than `feeds` so it cannot be confused with this poller's feed
      // URL map of the same name in the enclosing scope.
      const out: Partial<Record<FeedId, FeedRuntime>> = {};
      for (const key of feedIds) {
        const st = feedState[key];
        if (!st) continue;
        out[key] = { status: st.status, lastOkMs: st.lastOkMs, sinceMs: st.sinceMs };
      }
      return { feeds: out, lastPollAtMs, mode };
    },
    getLivePredictionMs(staticTripId, stopId) { return livePredictions.get(staticTripId)?.get(stopId) ?? null; },
    getJoinStats() { return { ...joinStats }; },
    isIndexReady() { return engine.isReady(); },
    now() { return dataNow(); },
    getMode() {
      return {
        mode,
        agency,
        staticAgency,
        dataNowMs: dataNow(),
        wallNowMs: Date.now(),
        demo: source ? source.describe() : null,
      };
    },
  };
}
