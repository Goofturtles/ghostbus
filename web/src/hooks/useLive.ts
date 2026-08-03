// Live data flow against the real API. Everything personal (location) stays on
// the device; only anonymous lat/lon queries leave it.
//
// ONE POLLING DRIVER, NOT FOUR. This used to be four independent `setInterval`s
// (health 20s, arrivals 30s, alerts 60s, ghosts 60s) plus ad-hoc refetches on
// visibility and online events. Two problems, both measured in the network log:
// identical requests went out twice within milliseconds because different components
// asked independently, and NOTHING backed off — a throttled or restarting server was
// hammered at exactly the same rate as a healthy one, so a session that fell into
// 429s stayed there. Both fed the bug this file's `apiFailure` exists to report
// honestly rather than blame on the transit agency (DECISIONS §45).
//
// Now: one heartbeat, each task with its own due-time, a shared exponential backoff
// with jitter on failure, and a clean resume the moment a request succeeds again.
// Server clock skew is still tracked so freshness labels stay honest.
import { create } from 'zustand';
import { api, ApiFailure, failureKind, type ApiFailureKind } from '@/lib/api';
import type {
  HealthResponse, ArrivalsResponse, StopDto, AlertsResponse, GhostFeedResponse,
} from '@shared/types';
import { useStore } from '@/store';
import { haversineM } from '@/lib/search';
import { startCompass } from '@/hooks/useCompassHeading';

/**
 * Fallback when geolocation is denied/unavailable: KING ST W AT SPADINA AVE — the
 * intersection the design reference shows — standing on Wellington St W in the block
 * south-west of it.
 *
 * WHY A POINT A FEW MINUTES FROM ITS STOP. An earlier default (43.6455, -79.3954)
 * sat ~30 m from its nearest stop, so the rider and the stop were effectively the
 * same pixel: the walk was "1 min", the beaded walk path had no length to draw, and
 * the map's collision avoidance correctly suppressed the stop marker as a duplicate
 * of the You beacon. The default view therefore showed neither the walk nor the
 * stop card, which is the least informative possible first impression of a
 * "how far am I from my stop" app.
 *
 * WHY THIS EXACT POINT. King & Spadina is ringed by four stops, so almost every
 * standing point near it is one or two minutes from one of them. A 13 m grid over
 * ±450 m, keeping only points whose NEAREST stop is one of those four, has exactly
 * one member that reaches a four-minute walk — this one:
 *
 *   43.64354, -79.39699
 *     nearest      stop 15647  `King St West at Spadina Ave West Side`   225 m
 *     walkSeconds(225, 1.333 m/s, routeFactor 1.25) = 211 s  ->  4 min
 *     runner-up    stop 15649  `King St West at Portland St East Side`   227 m
 *                  which also computes to 4 min, so the label holds either way
 *
 * The walk time is never written down anywhere — it is `walkSeconds()` applied to
 * the distance `/api/stops/nearby` returns for the real stop, exactly as it would be
 * on a real geolocation fix. Move this point 2 m closer and the app will say 3 min,
 * and 3 min is what would ship.
 *
 * WHAT THIS INTERSECTION CANNOT GIVE — and it must not be faked. The reference shows
 * the red route making a hard dogleg at the stop. Measured against the polyline the
 * app actually draws (`/api/routes/:id/shape`, the agency's published geometry),
 * the largest accumulated heading change within 320 m of King & Spadina is:
 *
 *     504 King   dir 0 / dir 1   1 deg      304 King (night)   1 deg
 *     510 Spadina dir 0 / dir 1  3 deg      310 Spadina        3 deg
 *
 * King Street and Spadina Avenue are both dead straight through this intersection
 * and neither route turns off the other. The mockup's dogleg is an illustration; the
 * data has no turn here. Bending, smoothing or splicing the line to produce one
 * would be fabricating map data in an app whose entire argument is that it does not
 * (DESIGN-TARGET §H). So the line runs straight, and that is reported rather than
 * disguised.
 *
 * (For the record, a genuine right-angle turn IS reachable — 43.6618, -79.35456 puts
 * the 505's real turn from Dundas onto Broadview 80 m from the frame centre with the
 * same honest 4-minute walk — but that is a different intersection from the one the
 * reference shows, and the reference wins.)
 *
 * This is a starting viewpoint, shown only until the rider grants location, and the
 * UI says so on its face: "Using a default location — tap to use yours".
 */
export const DEFAULT_LOCATION = { lat: 43.64354, lon: -79.39699 };
export const NEARBY_RADIUS_M = 800;
const HEALTH_INTERVAL_MS = 20_000;
const ARRIVALS_INTERVAL_MS = 30_000;
/** Alerts and ghosts change on the scale of minutes, not seconds. */
const ALERTS_INTERVAL_MS = 60_000;
const GHOSTS_INTERVAL_MS = 60_000;
const GHOST_FEED_HOURS = 24;

/**
 * The heartbeat the four polling tasks hang off. It is a divisor of every cadence above,
 * so a task fires within one tick of when it is due and no task needs a timer of its own.
 *
 * 5s also matches the map's own vehicle cadence, which means a visible tab settles into a
 * predictable ~19 requests/minute — the number the server's rate-limit budget was sized
 * against (see the comment on GLOBAL_MAX_PER_MIN in server/src/api.ts).
 */
const POLL_TICK_MS = 5_000;

/**
 * BACKOFF, and why it is shared across all four tasks rather than per-task.
 *
 * Every one of these failure kinds is a statement about the SERVER, not about one
 * endpoint: a 429 means our whole budget is spent, a 5xx or a dead socket means the
 * process is unhealthy or restarting. Backing off per-task would keep three other tasks
 * hammering a server that just told us to stop, which is how a brief restart turned into
 * a sustained outage in the log.
 *
 * 2s, doubling, capped at 60s, with jitter in [0.5, 1.0) of the computed delay so a
 * reload storm across several tabs does not resynchronise into a thundering herd. A 429
 * that carries `retryAfterSec` overrides the curve entirely — the server's own number is
 * better than our guess. One success clears everything.
 */
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
/** When "now" has no departures, walk forward day-by-day from tomorrow (up to 8
 *  days) and surface the FIRST day that actually has scheduled service, so the
 *  section header's date is the genuine next service day. See DECISIONS §15. */
const NEXT_SERVICE_MAX_DAYS = 8;
const NEXT_SERVICE_WINDOW_MIN = 24 * 60;

export type GeoStatus = 'pending' | 'granted' | 'default';

interface LiveState {
  health: HealthResponse | null;
  /**
   * WHY WE HAVE NO FRESH SERVER DATA — typed, so the UI can name the right culprit.
   *
   * This replaced a bare `healthError: boolean`. A boolean could only say "something went
   * wrong", and the copy chosen for it was "can't reach the live TTC feed" — which blamed
   * the transit agency for our own rate limiter. Every value this can hold is OUR side of
   * the wire: `throttled`, `serverDown`, `unreachable`. None of them is ever allowed to
   * become a claim about the agency's feed; that claim's only honest source is
   * `health.feeds`, which is a different field with a different meaning.
   */
  apiFailure: ApiFailureKind | null;
  /** Consecutive failed polls. Drives the backoff and lets the UI say "still trying". */
  apiFailures: number;
  /** epoch ms the poll loop is allowed to resume at. 0 when not backed off. */
  retryAtMs: number;

  geo: { lat: number; lon: number } | null;
  geoStatus: GeoStatus;

  nearby: StopDto[];
  nearbyLoading: boolean;
  /**
   * THE RIDER IS SOMEWHERE WE DO NOT COVER, and we know how far the nearest stop is.
   *
   * Set when `/api/stops/nearby` returns an empty list for a fix the rider actually
   * granted. This closes a reported bug: spoofed to Mississauga (MiWay territory), the
   * "using a default location" banner disappeared — so the rider believed their location
   * had taken effect — and the app carried on showing a downtown Toronto stop as though
   * it were theirs. Silently substituting a location the rider did not choose is the same
   * dishonesty as blaming the agency for our own throttling: the UI asserting something
   * untrue.
   *
   * `nearest` is the closest stop at ANY distance, straight from the API, so the message
   * can carry a real number instead of a shrug. Cleared the moment a fix finds coverage.
   */
  outOfCoverage: { nearest: StopDto | null; radiusM: number } | null;
  /**
   * A stop opened from search that is NOT in the nearby list.
   *
   * Without this, opening a stop across town leaves the header with no distance at
   * all: `nearby` only covers NEARBY_RADIUS_M around the rider. Its `distanceM` is
   * measured the same way the API measures the nearby ones — great-circle from the
   * rider's own fix — so nothing here is a different kind of number, and it is only
   * ever set when we genuinely know where the rider is.
   */
  pickedStop: StopDto | null;

  /** Departures for the selected stop at "now". */
  arrivals: ArrivalsResponse | null;
  arrivalsLoading: boolean;
  arrivalsError: boolean;
  /** When "now" is empty, the next real scheduled service (probe query). */
  nextService: ArrivalsResponse | null;

  /** Active service alerts straight from the agency's feed. */
  alerts: AlertsResponse | null;
  alertsError: boolean;
  /** Ghost + cancellation events, trailing 24h, with today/week counters. */
  ghosts: GhostFeedResponse | null;
  ghostsError: boolean;
  /** Set when a ghost event lands that we had not seen before — announced politely
   *  once, then cleared. Null on the first load (nothing "new" about a first render). */
  ghostAnnouncement: { count: number; seq: number } | null;

  /** serverNow - clientNow, so countdowns/freshness are honest despite clock skew. */
  skewMs: number;

  /** navigator.onLine, kept in state so React re-renders when it flips. It is only
   *  ever used to *explain* an absence of data — never to suppress data we have,
   *  because it lies on captive portals. Where the two disagree, the app's own
   *  fetch outcome (apiFailure / arrivalsError) is what the UI trusts. */
  online: boolean;

  start: () => () => void;
  /** Open a stop the rider chose from search, remembering it so the board's header
   *  can still show a real distance when the stop is outside the nearby radius. */
  openStop: (stop: { agency: string; stopId: string; name: string | null; lat: number | null; lon: number | null; wheelchairBoarding?: number | null }) => void;
  requestLocation: () => void;
  /** Abandon the rider's out-of-coverage fix and go back to the DEFAULT view — which
   *  relabels itself as a default location, because that is what it is. Only ever called
   *  from the explicit button in the out-of-coverage card; nothing does this silently. */
  useDefaultLocation: () => void;
  refetchArrivals: () => void;
  refetchHealth: () => void;
  refetchAlerts: () => void;
  refetchGhosts: () => void;
}

/**
 * THE THREE ATTRIBUTION STATES, derived in one place so no component can invent a fourth.
 *
 *   'demo'       · the server is replaying a recording. Amber DEMO badge + provenance.
 *   'ourFault'   · WE cannot be reached, or we throttled ourselves. "GhostBus is catching
 *                  up — retrying." Never mentions the agency.
 *   'feedDown'   · our server is fine AND ITS OWN health says an agency feed is down or
 *                  stale. This is the only state permitted to name the TTC.
 *   'ok'         · everything is current.
 *
 * Order matters: demo first (a recording's feeds are honestly `ok`, and the badge is what
 * stops that reading as live), then our own failures, and only then the agency's. A
 * failure of ours must never be reported as a failure of theirs, which is the whole point.
 */
export type LiveAttribution = 'ok' | 'demo' | 'ourFault' | 'feedDown';

export function attributionOf(s: Pick<LiveState, 'health' | 'apiFailure'>): LiveAttribution {
  if (s.health?.mode === 'demo') return 'demo';
  if (s.apiFailure != null) return 'ourFault';
  if (s.health != null && !s.health.ok) return 'feedDown';
  return 'ok';
}

function stopFor(id: string, list: StopDto[]): StopDto | undefined {
  return list.find((s) => s.stopId === id);
}

// Monotonic request id: a slow arrivals/probe response for a stop the rider has
// since switched away from must never overwrite the current board.
let arrivalsSeq = 0;
// Monotonic so a repeat of the same count still re-announces in the live region.
let ghostAnnounceSeq = 0;

export const useLive = create<LiveState>((set, get) => ({
  health: null,
  apiFailure: null,
  apiFailures: 0,
  retryAtMs: 0,
  geo: null,
  geoStatus: 'pending',
  nearby: [],
  nearbyLoading: false,
  outOfCoverage: null,
  pickedStop: null,
  arrivals: null,
  arrivalsLoading: false,
  arrivalsError: false,
  nextService: null,
  alerts: null,
  alertsError: false,
  ghosts: null,
  ghostsError: false,
  ghostAnnouncement: null,
  skewMs: 0,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,

  start: () => {
    get().requestLocation();
    // The first pass is immediate; everything after it is due-time driven below.
    void pollDue(true);

    /**
     * ONE HEARTBEAT for all four tasks. Each keeps its own `dueAt`, so cadences are
     * unchanged from the four-timer version — but there is exactly one place that decides
     * whether a request may go out, which is what makes a shared backoff possible at all.
     */
    const tick = setInterval(() => { if (!document.hidden) void pollDue(false); }, POLL_TICK_MS);

    /**
     * Returning to a hidden tab, or regaining the network, is new information: the reason
     * we backed off may be gone. So both clear the backoff and poll immediately rather
     * than serving a stale error until the next scheduled attempt. This is the "resume
     * cleanly" half of the backoff — without it a rider who fixed their wifi still stared
     * at an error for up to a minute.
     */
    const resume = () => { clearBackoff(); void pollDue(true); };
    const onVis = () => { if (!document.hidden) resume(); };
    const onOnline = () => { set({ online: true }); resume(); };
    const onOffline = () => set({ online: false });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },

  openStop: (stop) => {
    const geo = get().geo;
    // Distance ONLY when we know where the rider is. A search result opened before
    // the first fix simply has no distance, rather than one measured from a
    // placeholder and printed as if it were theirs.
    const distanceM = geo != null && stop.lat != null && stop.lon != null
      ? Math.round(haversineM(geo, { lat: stop.lat, lon: stop.lon }))
      : undefined;
    set({
      pickedStop: {
        // Carried through, not re-derived: with several agencies seeded, a stopId alone
        // no longer identifies a stop.
        agency: stop.agency, stopId: stop.stopId, name: stop.name, lat: stop.lat, lon: stop.lon,
        wheelchairBoarding: stop.wheelchairBoarding ?? null,
        ...(distanceM == null ? {} : { distanceM }),
      },
    });
    // Changing the selection triggers the subscribe below, which refetches the board.
    useStore.getState().selectStop(stop.stopId);
  },

  requestLocation: () => {
    // Piggy-backed on this tap ON PURPOSE: iOS only grants the compass from inside a
    // user gesture, and "use my location" is the one gesture where a rider has already
    // said they want the app oriented around them. Nothing auto-prompts, and a refusal
    // costs only the facing wedge — the dot renders exactly as it did before.
    void startCompass();
    const apply = (lat: number, lon: number, status: GeoStatus) => {
      set({ geo: { lat, lon }, geoStatus: status });
      void loadNearby(lat, lon, status, set, get);
    };
    if (!('geolocation' in navigator)) {
      apply(DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon, 'default');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => apply(pos.coords.latitude, pos.coords.longitude, 'granted'),
      () => apply(DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon, 'default'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 },
    );
  },

  useDefaultLocation: () => {
    // An EXPLICIT fallback, and it relabels the view honestly: `geoStatus: 'default'`
    // brings back the "Using a default location — tap to use yours" banner, so the rider
    // is never left believing a downtown board describes where they are standing.
    set({ geo: DEFAULT_LOCATION, geoStatus: 'default', outOfCoverage: null });
    void loadNearby(DEFAULT_LOCATION.lat, DEFAULT_LOCATION.lon, 'default', set, get);
  },

  refetchHealth: () => {
    api.health()
      .then((health) => { noteOk(); set({ health, skewMs: health.serverNowMs - Date.now() }); })
      .catch(noteFailure);
  },

  refetchArrivals: () => {
    const stopId = useStore.getState().selectedStopId;
    if (!stopId) return;
    const seq = ++arrivalsSeq;
    const current = () => seq === arrivalsSeq && useStore.getState().selectedStopId === stopId;
    set({ arrivalsLoading: get().arrivals == null });
    // The selected stop's own agency, carried from the row that selected it (nearby list
    // or a search pick) — with several agencies seeded a bare stop id is ambiguous and
    // the server refuses to guess. Undefined only when neither source knows the stop,
    // which a single-agency deployment still answers.
    const agency = selectedNearbyStop()?.agency;
    api.arrivals(stopId, { agency })
      .then((arrivals) => {
        noteOk();
        if (!current()) return;
        set({ arrivals, arrivalsError: false, arrivalsLoading: false, skewMs: arrivals.serverNowMs - Date.now() });
        // No live departures right now → surface the next real scheduled service.
        if (arrivals.departures.length === 0) {
          void probeNextService(stopId, agency, current, set);
        } else {
          set({ nextService: null });
        }
      })
      .catch((e: unknown) => {
        noteFailure(e);
        if (failureKind(e) === 'aborted') return;
        if (current()) set({ arrivalsError: true, arrivalsLoading: false });
      });
  },

  refetchAlerts: () => {
    api.alerts()
      .then((alerts) => { noteOk(); set({ alerts, alertsError: false }); })
      .catch((e: unknown) => { noteFailure(e); set({ alertsError: true }); });
  },

  refetchGhosts: () => {
    api.ghostFeed(GHOST_FEED_HOURS)
      .then((ghosts) => {
        noteOk();
        // Announce only genuinely new detections, and only after a first load has
        // established a baseline — a fresh page is not "N new ghosts".
        const prev = get().ghosts;
        const seenBefore = prev != null;
        const newest = prev ? prev.events.reduce((m, e) => Math.max(m, e.detectedAtMs), 0) : 0;
        const fresh = seenBefore ? ghosts.events.filter((e) => e.detectedAtMs > newest).length : 0;
        set({
          ghosts, ghostsError: false,
          ghostAnnouncement: fresh > 0 ? { count: fresh, seq: ++ghostAnnounceSeq } : get().ghostAnnouncement,
        });
      })
      .catch((e: unknown) => { noteFailure(e); set({ ghostsError: true }); });
  },
}));

/** Walk forward day-by-day from tomorrow and set `nextService` to the first day
 *  with real scheduled departures (each probe is a 24h window). Sequential so the
 *  first hit wins; aborts if the rider switches stops mid-walk. */
async function probeNextService(
  stopId: string,
  agency: string | undefined,
  current: () => boolean,
  set: (p: Partial<LiveState>) => void,
): Promise<void> {
  // Anchor each 24h probe to the START of a local day beginning tomorrow (not now+Nd),
  // so a day whose service ends before the current wall-clock time is never skipped and
  // the header's date stamp is the genuine next service day. Rider is in Toronto → local
  // midnight ≈ agency midnight; the server still resolves service days in America/Toronto.
  const start = new Date(liveNow());
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1); // tomorrow, local
  const base = start.getTime();
  for (let d = 0; d < NEXT_SERVICE_MAX_DAYS; d++) {
    if (!current()) return;
    // This walk is the single most expensive thing the client does — up to eight requests
    // for one empty board — so it is the LAST thing that should run while we are backed
    // off. It used to ignore the window entirely and swallow its failures, which both
    // undid the backoff and hid the reason for it. It now yields, and reports.
    if (isBackedOff()) return;
    try {
      const res = await api.arrivals(stopId, { agency, atMs: base + d * 86_400_000, windowMin: NEXT_SERVICE_WINDOW_MIN });
      if (!current()) return;
      if (res.departures.length > 0) { set({ nextService: res }); return; }
    } catch (e) {
      // Best-effort per day, but a server-wide failure still has to be seen by the backoff
      // rather than absorbed eight times in a row.
      noteFailure(e);
      if (isBackedOff()) return;
    }
  }
}

/** Load nearby stops and, if the current selection isn't among them, select the
 *  nearest so the board reflects where the rider actually is. */
async function loadNearby(
  lat: number, lon: number,
  status: GeoStatus,
  set: (p: Partial<LiveState>) => void,
  get: () => LiveState,
): Promise<void> {
  set({ nearbyLoading: true });
  try {
    const res = await api.nearby(lat, lon, NEARBY_RADIUS_M);
    noteOk();
    set({ nearby: res.stops, nearbyLoading: false });

    /**
     * NOTHING IN RANGE OF A FIX THE RIDER ACTUALLY GRANTED.
     *
     * The reported bug: spoofed to Mississauga, the rider tapped "use my location", the
     * default-location banner vanished, and the app kept showing King St W at Spadina as
     * though it were their stop. The empty result was simply dropped on the floor.
     *
     * It is recorded as a state now, with the nearest real stop and its real distance, so
     * the UI can say so — and CRUCIALLY the old selection is left untouched rather than
     * silently re-presented as theirs. The card the state renders is the only thing that
     * can move the rider back to the default view, and it says that it is doing so.
     *
     * Only for a GRANTED fix. The default location is downtown Toronto and always has
     * coverage; if it ever did not, "you are out of coverage" would be a lie about a
     * position the rider never claimed.
     */
    if (res.stops.length === 0 && status === 'granted') {
      set({
        outOfCoverage: {
          nearest: res.nearest ?? null,
          radiusM: res.searchedRadiusM ?? NEARBY_RADIUS_M,
        },
      });
      return; // No board to load here — the honest card replaces it.
    }
    set({ outOfCoverage: null });

    const selected = useStore.getState().selectedStopId;
    if (res.stops.length > 0 && !stopFor(selected, res.stops)) {
      // Changing the selection triggers the subscribe below, which refetches.
      useStore.getState().selectStop(res.stops[0].stopId);
    } else {
      get().refetchArrivals();
    }
  } catch (e) {
    noteFailure(e);
    // A FAILED nearby query is not evidence of no coverage — it is evidence of no answer,
    // which `apiFailure` already reports honestly. Leave `outOfCoverage` alone.
    set({ nearbyLoading: false });
    get().refetchArrivals();
  }
}

// =====================================================================================
// the poll driver: one heartbeat, four due-times, one shared backoff
// =====================================================================================

/** Next epoch ms each task may run at. 0 = due now. */
const dueAt = { health: 0, arrivals: 0, alerts: 0, ghosts: 0 };

/**
 * ROUND ACCOUNTING, so the four tasks cannot argue with each other.
 *
 * `pollDue` fires up to four requests in one tick and they settle milliseconds apart. With
 * a single global flag the LAST one to settle would decide the state, so one persistently
 * broken endpoint (say a 5xx ghost feed) would have its failure wiped by a sibling's
 * success every cycle: the banner flaps on and off and the backoff never actually engages.
 *
 * A round is one `pollDue` pass. A success only clears the backoff if nothing else in the
 * SAME round failed, and the backoff curve advances once per round rather than once per
 * request — otherwise a single failing round counted four times and jumped 2s straight to
 * the 60s cap.
 */
let pollRound = 0;
let failedRound = -1;
let backedOffRound = -1;

/** A success means the server is answering — resume full cadence, unless a sibling in this
 *  same round says otherwise. */
function noteOk(): void {
  if (failedRound === pollRound) return;
  const s = useLive.getState();
  if (s.apiFailure == null && s.apiFailures === 0) return;
  clearBackoff();
}

function clearBackoff(): void {
  failedRound = -1;
  backedOffRound = -1;
  useLive.setState({ apiFailure: null, apiFailures: 0, retryAtMs: 0 });
}

/**
 * Record a failure and set the shared backoff.
 *
 * An `aborted` request is a decision we made, not a failure — counting it would let the
 * search sheet's own cancellations throttle the whole app. A `badRequest` is our own bug:
 * it is REPORTED, because a silent malformed request is how a defect hides, but it never
 * backs anything off, because retrying more slowly cannot fix a malformed URL.
 */
export function noteFailure(e: unknown): void {
  const kind = failureKind(e);
  if (kind === 'aborted') return;
  if (kind === 'badRequest') {
    useLive.setState({ apiFailure: 'badRequest' });
    return;
  }
  failedRound = pollRound;
  // Once per ROUND, not once per request: four tasks failing together is one failure.
  if (backedOffRound === pollRound) return;
  backedOffRound = pollRound;

  const fails = useLive.getState().apiFailures + 1;
  const curve = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (fails - 1));
  /**
   * The server's own retry-after beats our curve — it knows when its window resets — but it
   * is CLAMPED to the same ceiling and jittered like everything else. Unclamped, a proxy or
   * CDN answering `Retry-After: 86400` would freeze every poll for a day with no way back;
   * un-jittered, every tab that hit the same limit would return in lockstep, which is the
   * herd the jitter exists to prevent.
   */
  const asked = e instanceof ApiFailure && e.retryAfterSec != null
    ? Math.min(BACKOFF_MAX_MS, e.retryAfterSec * 1000)
    : null;
  const base = asked ?? curve;
  // Jitter in [0.75, 1.0) of an honoured retry-after (never returning EARLY than asked is
  // the polite half), and [0.5, 1.0) of our own curve.
  const wait = asked != null
    ? Math.round(base * (0.75 + Math.random() * 0.25))
    : Math.round(base * (0.5 + Math.random() * 0.5));
  useLive.setState({ apiFailure: kind, apiFailures: fails, retryAtMs: Date.now() + wait });
}

/** True while the shared backoff window is open. Everything that spends rate-limit budget
 *  on a timer must consult this, or it undoes the backoff for everybody. */
export function isBackedOff(): boolean {
  return useLive.getState().retryAtMs > Date.now();
}

/**
 * Run whichever tasks are due. `force` ignores the due-times (first paint, tab refocus,
 * network regained) but still honours the backoff window unless it was just cleared.
 */
async function pollDue(force: boolean): Promise<void> {
  const now = Date.now();
  const live = useLive.getState();
  // Backed off: say nothing, spend nothing, and let the window expire.
  if (live.retryAtMs > now) return;
  pollRound++;

  // `dueAt.x = now + INTERVAL` rather than `+= INTERVAL`: the heartbeat is 5s, so anchoring
  // to the actual fire time keeps a task from drifting a whole tick later on every pass.
  if (force || now >= dueAt.health) { dueAt.health = now + HEALTH_INTERVAL_MS; live.refetchHealth(); }
  if (force || now >= dueAt.arrivals) { dueAt.arrivals = now + ARRIVALS_INTERVAL_MS; live.refetchArrivals(); }
  if (force || now >= dueAt.alerts) { dueAt.alerts = now + ALERTS_INTERVAL_MS; live.refetchAlerts(); }
  if (force || now >= dueAt.ghosts) { dueAt.ghosts = now + GHOSTS_INTERVAL_MS; live.refetchGhosts(); }
}

// Re-fetch arrivals whenever the selected stop changes.
useStore.subscribe((s, prev) => {
  if (s.selectedStopId !== prev.selectedStopId) {
    useLive.setState({ arrivals: null, nextService: null });
    useLive.getState().refetchArrivals();
  }
});

/** Server-corrected "now" so freshness/countdowns are honest regardless of clock skew. */
export function liveNow(): number {
  return Date.now() + useLive.getState().skewMs;
}

/** The StopDto for the currently-selected stop (carries distanceM for walk math).
 *  Falls back to a stop opened from search, which is the only way the selection can
 *  be somewhere the nearby query never reached. */
export function selectedNearbyStop(): StopDto | undefined {
  const id = useStore.getState().selectedStopId;
  const s = useLive.getState();
  const near = stopFor(id, s.nearby);
  if (near) return near;
  return s.pickedStop?.stopId === id ? s.pickedStop : undefined;
}
