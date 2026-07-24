import { create } from 'zustand';
import { api, type Scene } from '@/lib/api';
import type {
  StopArrivals, Vehicle, GhostEvent, ServiceAlert, CityStats, AnomalyBanner, Freshness,
} from '@shared/types';
import { useStore } from '@/store';

interface LiveState {
  scene: Scene | null;
  arrivals: StopArrivals | null;
  vehicles: Vehicle[];
  ghosts: GhostEvent[];
  alerts: ServiceAlert[];
  stats: CityStats | null;
  anomalies: AnomalyBanner[];
  source: Freshness;
  lastPollMs: number;
  serverNowMs: number;
  skewMs: number; // serverNow - clientNow, so the client can render honest freshness
  feedReachable: boolean;
  loaded: boolean;
  start: () => () => void;
  refetchArrivals: () => void;
}

export const useLive = create<LiveState>((set, get) => ({
  scene: null,
  arrivals: null,
  vehicles: [],
  ghosts: [],
  alerts: [],
  stats: null,
  anomalies: [],
  source: 'demo',
  lastPollMs: 0,
  serverNowMs: Date.now(),
  skewMs: 0,
  feedReachable: false,
  loaded: false,

  start: () => {
    const city = useStore.getState().city;
    let stopped = false;

    // one-time scene + slow-changing data
    (async () => {
      try {
        const [scene, ghosts, alerts, stats, health] = await Promise.all([
          api.scene(city), api.ghosts(city), api.alerts(city), api.stats(city), api.health(),
        ]);
        if (stopped) return;
        set({
          scene, ghosts: ghosts.ghosts, alerts: alerts.alerts, stats,
          feedReachable: health.feeds[city]?.reachable ?? false, loaded: true,
        });
      } catch {
        set({ loaded: true });
      }
    })();

    const pollVehicles = async () => {
      if (document.hidden || stopped) return;
      try {
        const v = await api.vehicles(city);
        set({
          vehicles: v.vehicles, source: v.source, lastPollMs: v.lastPollMs,
          serverNowMs: v.serverNowMs, skewMs: v.serverNowMs - Date.now(),
          anomalies: v.anomalies,
        });
      } catch {
        set({ source: 'offline' });
      }
    };
    pollVehicles();
    get().refetchArrivals();

    const vTimer = setInterval(pollVehicles, 5000);
    const aTimer = setInterval(() => get().refetchArrivals(), 15000);
    const onVis = () => { if (!document.hidden) { pollVehicles(); get().refetchArrivals(); } };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      stopped = true;
      clearInterval(vTimer);
      clearInterval(aTimer);
      document.removeEventListener('visibilitychange', onVis);
    };
  },

  refetchArrivals: () => {
    const city = useStore.getState().city;
    const stopId = useStore.getState().selectedStopId;
    api.arrivals(city, stopId).then((arrivals) => set({ arrivals })).catch(() => {});
  },
}));

// re-fetch arrivals whenever the selected stop changes
useStore.subscribe((s, prev) => {
  if (s.selectedStopId !== prev.selectedStopId) useLive.getState().refetchArrivals();
});

/** Server-corrected "now" so freshness labels are honest regardless of clock skew. */
export function liveNow(): number {
  return Date.now() + useLive.getState().skewMs;
}
