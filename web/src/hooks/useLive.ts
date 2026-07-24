// Live data flow against the real API. Everything personal (location) stays on
// the device; only anonymous lat/lon queries leave it.
//
// Cadence (no map this phase, so no 5s vehicle polling): health every 20s,
// arrivals every 30s, both paused while the tab is hidden. All timers cleared on
// stop(). Server clock skew is tracked so freshness labels stay honest.
import { create } from 'zustand';
import { api } from '@/lib/api';
import type { HealthResponse, ArrivalsResponse, StopDto } from '@shared/types';
import { useStore } from '@/store';

/** Fallback when geolocation is denied/unavailable: King & Spadina, Toronto. */
export const DEFAULT_LOCATION = { lat: 43.6455, lon: -79.3954 };
const NEARBY_RADIUS_M = 800;
const HEALTH_INTERVAL_MS = 20_000;
const ARRIVALS_INTERVAL_MS = 30_000;
/** When "now" has no departures, probe one week ahead (same hour-of-week, richest
 *  evidence per DECISIONS §15) to surface this stop's real scheduled service. */
const NEXT_SERVICE_PROBE_MS = 7 * 86_400_000;

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

  /** serverNow - clientNow, so countdowns/freshness are honest despite clock skew. */
  skewMs: number;

  start: () => () => void;
  requestLocation: () => void;
  refetchArrivals: () => void;
  refetchHealth: () => void;
}

function stopFor(id: string, list: StopDto[]): StopDto | undefined {
  return list.find((s) => s.stopId === id);
}

// Monotonic request id: a slow arrivals/probe response for a stop the rider has
// since switched away from must never overwrite the current board.
let arrivalsSeq = 0;

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
  skewMs: 0,

  start: () => {
    get().requestLocation();
    get().refetchHealth();

    const healthTimer = setInterval(() => { if (!document.hidden) get().refetchHealth(); }, HEALTH_INTERVAL_MS);
    const arrivalsTimer = setInterval(() => { if (!document.hidden) get().refetchArrivals(); }, ARRIVALS_INTERVAL_MS);
    const onVis = () => { if (!document.hidden) { get().refetchHealth(); get().refetchArrivals(); } };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearInterval(healthTimer);
      clearInterval(arrivalsTimer);
      document.removeEventListener('visibilitychange', onVis);
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
          api.arrivals(stopId, { atMs: liveNow() + NEXT_SERVICE_PROBE_MS })
            .then((nextService) => { if (current()) set({ nextService }); })
            .catch(() => { /* probe is best-effort */ });
        } else {
          set({ nextService: null });
        }
      })
      .catch(() => { if (current()) set({ arrivalsError: true, arrivalsLoading: false }); });
  },
}));

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
