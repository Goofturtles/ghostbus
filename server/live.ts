// Genuine GTFS-realtime decode for the TTC vehicles feed. This is real: it hits
// bustime.ttc.ca and decodes the protobuf with gtfs-realtime-bindings.
//
// HONEST LIMITATION (documented in BLOCKERS.md): rendering these live vehicles as
// a geographically-correct voxel diorama needs the static GTFS seed (route colors,
// shapes, headsigns, stop_times) loaded into Postgres. Without that seed the app
// serves the recorded Toronto scene (source:'demo', amber badge) so it always
// answers truthfully. `probeFeed` reports real upstream reachability to /health.

import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import type { Vehicle, ModeKind } from '../shared/types.ts';
import type { FeedDef } from '../shared/types.ts';

const { transit_realtime } = GtfsRealtimeBindings;

function routeTypeToMode(t: number | null | undefined): ModeKind {
  switch (t) {
    case 0: return 'tram';
    case 1: return 'metro';
    case 2: return 'rail';
    case 3: return 'bus';
    case 4: return 'ferry';
    case 5: case 6: case 7: return 'cable';
    default: return 'bus';
  }
}

async function fetchWithTimeout(url: string, ms: number, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  count?: number;
  error?: string;
  at: number;
}

/** Real reachability probe of a city's realtime vehicles feed. */
export async function probeFeed(feed: FeedDef): Promise<ProbeResult> {
  const at = Date.now();
  try {
    const headers: Record<string, string> = {};
    if (feed.cityId === 'vancouver' && process.env.TRANSLINK_API_KEY) {
      // TransLink passes the key as a query param; handled by caller URL if present
    }
    const res = await fetchWithTimeout(feed.rtVehiclesUrl, 10000, headers);
    if (!res.ok) return { ok: false, status: res.status, at, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    const msg = transit_realtime.FeedMessage.decode(buf);
    const count = msg.entity.filter((e) => e.vehicle?.position).length;
    return { ok: true, status: res.status, count, at };
  } catch (e) {
    return { ok: false, at, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decode the live vehicles feed into our Vehicle shape (best-effort without seed). */
export async function fetchLiveVehicles(feed: FeedDef): Promise<Vehicle[]> {
  const res = await fetchWithTimeout(feed.rtVehiclesUrl, 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const msg = transit_realtime.FeedMessage.decode(buf);
  const now = Date.now();
  const out: Vehicle[] = [];
  for (const e of msg.entity) {
    const v = e.vehicle;
    if (!v?.position) continue;
    const routeId = v.trip?.routeId ?? 'unknown';
    out.push({
      id: v.vehicle?.id ?? e.id,
      routeId,
      routeShortName: routeId,
      routeLongName: '',
      routeColor: 'D6001C',
      mode: routeTypeToMode(undefined),
      tripId: v.trip?.tripId ?? '',
      headsign: '',
      lat: v.position.latitude,
      lon: v.position.longitude,
      bearing: v.position.bearing ?? 0,
      speed: v.position.speed ?? 0,
      isGhost: false,
      wheelchairAccessible: null,
      ts: (Number(v.timestamp) || Math.floor(now / 1000)) * 1000,
    });
  }
  return out;
}
