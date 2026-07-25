// Typed client for the real GhostBus API. One source of truth: @shared/types.
// Every response shape is imported from the server's contract so the UI cannot
// drift from what the API actually returns.
import type {
  HealthResponse, StopsResponse, ArrivalsResponse, VehiclesResponse, RouteShapeResponse,
  AlertsResponse, GhostFeedResponse, StatsResponse,
} from '@shared/types';

/** A viewport box in [minLon, minLat, maxLon, maxLat] order (what the API expects). */
export type Bbox = [number, number, number, number];

/** A fetch that rejects on non-2xx and surfaces the API's JSON error message. */
async function j<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: (signal?: AbortSignal) => j<HealthResponse>('/api/health', signal),

  nearby: (lat: number, lon: number, radiusM: number, signal?: AbortSignal) =>
    j<StopsResponse>(`/api/stops/nearby?lat=${lat}&lon=${lon}&radius=${radiusM}`, signal),

  arrivals: (stopId: string, opts: { atMs?: number; windowMin?: number } = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (opts.atMs != null) p.set('at', String(Math.round(opts.atMs)));
    if (opts.windowMin != null) p.set('windowMin', String(opts.windowMin));
    const qs = p.toString();
    return j<ArrivalsResponse>(`/api/stops/${encodeURIComponent(stopId)}/arrivals${qs ? `?${qs}` : ''}`, signal);
  },

  vehicles: (bbox: Bbox, signal?: AbortSignal) =>
    j<VehiclesResponse>(`/api/vehicles?bbox=${bbox.join(',')}`, signal),

  routeShape: (routeId: string, dir: number | null, signal?: AbortSignal) =>
    j<RouteShapeResponse>(
      `/api/routes/${encodeURIComponent(routeId)}/shape${dir == null ? '' : `?dir=${dir}`}`, signal),

  alerts: (limit?: number, signal?: AbortSignal) =>
    j<AlertsResponse>(`/api/alerts${limit == null ? '' : `?limit=${limit}`}`, signal),

  ghostFeed: (hours?: number, signal?: AbortSignal) =>
    j<GhostFeedResponse>(`/api/ghosts/feed${hours == null ? '' : `?hours=${hours}`}`, signal),

  stats: (signal?: AbortSignal) => j<StatsResponse>('/api/stats', signal),
};
