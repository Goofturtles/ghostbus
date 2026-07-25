// Live data flow against the real API. Everything personal (location) stays on
// the device; only anonymous lat/lon queries leave it.
//
// Cadence (no map this phase, so no 5s vehicle polling): health every 20s,
// arrivals every 30s, both paused while the tab is hidden. All timers cleared on
// stop(). Server clock skew is tracked so freshness labels stay honest.
import { create } from 'zustand';
import { api } from '@/lib/api';
import type {
  HealthResponse, ArrivalsResponse, StopDto, AlertsResponse, GhostFeedResponse,
} from '@shared/types';
import { useStore } from '@/store';

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
const NEARBY_RADIUS_M = 800;
const HEALTH_INTERVAL_MS = 20_000;
const ARRIVALS_INTERVAL_MS = 30_000;
/** Alerts and ghosts change on the scale of minutes, not seconds. */
const ALERTS_INTERVAL_MS = 60_000;
const GHOSTS_INTERVAL_MS = 60_000;
const GHOST_FEED_HOURS = 24;
/** When "now" has no departures, walk forward day-by-day from tomorrow (up to 8
 *  days) and surface the FIRST day that actually has scheduled service, so the
 *  section header's date is the genuine next service day. See DECISIONS §15. */
const NEXT_SERVICE_MAX_DAYS = 8;
const NEXT_SERVICE_WINDOW_MIN = 24 * 60;

export type GeoStatus = 'pending' | 'granted' | 'default';

interface LiveState {
  health: HealthResponse | null;
  healthError: boolean;

  geo: { lat: number; lon: number } | null;
  geoStatus: GeoStatus;

  nearby: StopDto[];
  nearbyLoading: boolean;

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
   *  fetch outcome (healthError / arrivalsError) is what the UI trusts. */
  online: boolean;

  start: () => () => void;
  requestLocation: () => void;
  refetchArrivals: () => void;
  refetchHealth: () => void;
  refetchAlerts: () => void;
  refetchGhosts: () => void;
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
  healthError: false,
  geo: null,
  geoStatus: 'pending',
  nearby: [],
  nearbyLoading: false,
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
    get().refetchHealth();
    get().refetchAlerts();
    get().refetchGhosts();

    const healthTimer = setInterval(() => { if (!document.hidden) get().refetchHealth(); }, HEALTH_INTERVAL_MS);
    const arrivalsTimer = setInterval(() => { if (!document.hidden) get().refetchArrivals(); }, ARRIVALS_INTERVAL_MS);
    const alertsTimer = setInterval(() => { if (!document.hidden) get().refetchAlerts(); }, ALERTS_INTERVAL_MS);
    const ghostsTimer = setInterval(() => { if (!document.hidden) get().refetchGhosts(); }, GHOSTS_INTERVAL_MS);
    const refetchAll = () => {
      get().refetchHealth(); get().refetchArrivals(); get().refetchAlerts(); get().refetchGhosts();
    };
    const onVis = () => { if (!document.hidden) refetchAll(); };
    // Coming back online recovers immediately rather than waiting out the next
    // poll interval, so the offline empty state resolves itself without a reload.
    const onOnline = () => { set({ online: true }); refetchAll(); };
    const onOffline = () => set({ online: false });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      clearInterval(healthTimer);
      clearInterval(arrivalsTimer);
      clearInterval(alertsTimer);
      clearInterval(ghostsTimer);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },

  requestLocation: () => {
    const apply = (lat: number, lon: number, status: GeoStatus) => {
      set({ geo: { lat, lon }, geoStatus: status });
      void loadNearby(lat, lon, set, get);
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

  refetchHealth: () => {
    api.health()
      .then((health) => set({ health, healthError: false, skewMs: health.serverNowMs - Date.now() }))
      .catch(() => set({ healthError: true }));
  },

  refetchArrivals: () => {
    const stopId = useStore.getState().selectedStopId;
    if (!stopId) return;
    const seq = ++arrivalsSeq;
    const current = () => seq === arrivalsSeq && useStore.getState().selectedStopId === stopId;
    set({ arrivalsLoading: get().arrivals == null });
    api.arrivals(stopId)
      .then((arrivals) => {
        if (!current()) return;
        set({ arrivals, arrivalsError: false, arrivalsLoading: false, skewMs: arrivals.serverNowMs - Date.now() });
        // No live departures right now → surface the next real scheduled service.
        if (arrivals.departures.length === 0) {
          void probeNextService(stopId, current, set);
        } else {
          set({ nextService: null });
        }
      })
      .catch(() => { if (current()) set({ arrivalsError: true, arrivalsLoading: false }); });
  },

  refetchAlerts: () => {
    api.alerts()
      .then((alerts) => set({ alerts, alertsError: false }))
      .catch(() => set({ alertsError: true }));
  },

  refetchGhosts: () => {
    api.ghostFeed(GHOST_FEED_HOURS)
      .then((ghosts) => {
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
      .catch(() => set({ ghostsError: true }));
  },
}));

/** Walk forward day-by-day from tomorrow and set `nextService` to the first day
 *  with real scheduled departures (each probe is a 24h window). Sequential so the
 *  first hit wins; aborts if the rider switches stops mid-walk. */
async function probeNextService(
  stopId: string,
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
    try {
      const res = await api.arrivals(stopId, { atMs: base + d * 86_400_000, windowMin: NEXT_SERVICE_WINDOW_MIN });
      if (!current()) return;
      if (res.departures.length > 0) { set({ nextService: res }); return; }
    } catch { /* best-effort; try the next day */ }
  }
}

/** Load nearby stops and, if the current selection isn't among them, select the
 *  nearest so the board reflects where the rider actually is. */
async function loadNearby(
  lat: number, lon: number,
  set: (p: Partial<LiveState>) => void,
  get: () => LiveState,
): Promise<void> {
  set({ nearbyLoading: true });
  try {
    const res = await api.nearby(lat, lon, NEARBY_RADIUS_M);
    set({ nearby: res.stops, nearbyLoading: false });
    const selected = useStore.getState().selectedStopId;
    if (res.stops.length > 0 && !stopFor(selected, res.stops)) {
      // Changing the selection triggers the subscribe below, which refetches.
      useStore.getState().selectStop(res.stops[0].stopId);
    } else {
      get().refetchArrivals();
    }
  } catch {
    set({ nearbyLoading: false });
    get().refetchArrivals();
  }
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

/** The StopDto for the currently-selected stop (carries distanceM for walk math). */
export function selectedNearbyStop(): StopDto | undefined {
  return stopFor(useStore.getState().selectedStopId, useLive.getState().nearby);
}
