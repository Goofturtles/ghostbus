import type {
  StopArrivals, VehiclesResponse, GhostEvent, CityStats, RouteReport, ServiceAlert,
} from '@shared/types';

async function j<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json() as Promise<T>;
}

export interface Scene {
  cityId: string;
  center: [number, number];
  user: [number, number];
  board: { stopId: string; name: string; code: string; direction: string; cross: string; ll: [number, number]; routeIds: string[]; wheelchair: number };
  streets: { name: string; pts: [number, number][] }[];
  routes: { routeId: string; short: string; long: string; color: string; mode: string; headsign: string; shape: [number, number][] }[];
  stops: { stopId: string; name: string; code: string; direction: string; cross: string; ll: [number, number]; routeIds: string[]; wheelchair: number }[];
  walkPath: [number, number][];
}

export const api = {
  health: () => j<{ ok: boolean; serverNowMs: number; feeds: Record<string, { reachable: boolean; lastOkMs: number; vehicleCount: number | null; error: string | null }> }>('/api/health'),
  scene: (city: string) => j<Scene>(`/api/${city}/scene`),
  vehicles: (city: string) => j<VehiclesResponse>(`/api/${city}/vehicles`),
  arrivals: (city: string, id: string) => j<StopArrivals>(`/api/${city}/stops/${id}/arrivals`),
  stops: (city: string, q: string) => j<{ stops: { stopId: string; name: string; code: string; direction: string; distanceM: number; nextEtaMin: number | null; nextRoute: string | null }[] }>(`/api/${city}/stops?q=${encodeURIComponent(q)}`),
  alerts: (city: string) => j<{ alerts: ServiceAlert[] }>(`/api/${city}/alerts`),
  ghosts: (city: string) => j<{ ghosts: GhostEvent[] }>(`/api/${city}/ghosts`),
  stats: (city: string) => j<CityStats>(`/api/${city}/stats`),
  report: (city: string, id: string) => j<RouteReport>(`/api/${city}/routes/${id}/report`),
};
