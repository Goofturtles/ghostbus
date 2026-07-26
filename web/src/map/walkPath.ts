// The walk path's data layer: turn the basemap this device has ALREADY downloaded
// into a walkable line between the rider and their boarding stop.
//
// The routing itself lives in `lib/walkRoute.ts`, which knows nothing about maps.
// This file is the seam: it reads the ways out of MapLibre's own tile cache, hands
// them over, caches the answer, and — when there is no answer — produces the honest
// fallback instead of nothing.
//
// ZERO NEW NETWORK, AND THAT IS THE DESIGN. `querySourceFeatures` reads the vector
// tiles the map has already fetched and parsed to draw the streets under the path.
// Nothing here fetches, so:
//   * Demo Mode behaves identically — it replays transit data, and this asks the
//     basemap, not the transit feed. Nothing about a plan triggers a request.
//   * offline, the app degrades to the labelled straight line rather than hanging;
//   * no rate limit, no key, no third-party routing service, no per-request cost.
// The price is stated plainly: WHERE THERE IS NO MAP THERE IS NO ROUTE. On a phone's
// Plan tab, with the map card unmounted, a leg that was never routed on the Nearby
// tab stays an estimate and says so. See DECISIONS §51.

import type { Map as MlMap, GeoJSONFeature } from 'maplibre-gl';
import { routeWalk, haversineM, type WalkLine, type WalkPoint } from '@/lib/walkRoute';
import type { WalkKind } from '@/lib/walk';

/** The basemap source and layer the styles build on (see mapStyle.ts). */
const SOURCE = 'omt';
const SOURCE_LAYER = 'transportation';

/**
 * OpenMapTiles `class` values a person may walk along.
 *
 * Motorway and trunk are absent on purpose — the 401 is not a walk — as are `rail`
 * and `ferry`. `service` (laneways, driveways, parking aisles) IS included: downtown
 * Toronto's mid-block connections are mostly service ways, and leaving them out
 * pushes the route out to the arterials for a walk that really does cut through.
 */
const WALKABLE_CLASS = new Set([
  'path', 'minor', 'service', 'tertiary', 'secondary', 'primary',
  'living_street', 'track', 'unclassified',
]);
/** Transit platforms and indoor corridors are inside the network but not on it. */
const SKIP_SUBCLASS = new Set(['platform', 'corridor']);

/** How far outside the two endpoints' box to gather ways. A route that must go
 *  around a block needs the block; more than this is graph we pay to build and
 *  never walk. */
const PAD_M = 350;

export interface WalkLeg {
  kind: WalkKind;
  /** lon/lat, always from the rider to the stop, both ends included. */
  coordinates: [number, number][];
  distanceM: number;
}

/** Read the walkable ways near a walk out of the tiles already in the map. */
export function collectWalkLines(map: MlMap, from: WalkPoint, to: WalkPoint): WalkLine[] {
  let feats: GeoJSONFeature[];
  try {
    feats = map.querySourceFeatures(SOURCE, { sourceLayer: SOURCE_LAYER });
  } catch {
    // The source is not in the style yet (or the style was just swapped). Not an
    // error — there is simply nothing loaded to route over.
    return [];
  }
  const dLat = PAD_M / 110_574;
  const dLon = PAD_M / (111_320 * Math.cos(((from.lat + to.lat) / 2) * (Math.PI / 180)));
  const w = Math.min(from.lon, to.lon) - dLon, e = Math.max(from.lon, to.lon) + dLon;
  const s = Math.min(from.lat, to.lat) - dLat, n = Math.max(from.lat, to.lat) + dLat;

  const out: WalkLine[] = [];
  for (const f of feats) {
    const p = f.properties as { class?: string; subclass?: string; foot?: string; access?: string; indoor?: number };
    if (!p || !WALKABLE_CLASS.has(p.class ?? '')) continue;
    if (SKIP_SUBCLASS.has(p.subclass ?? '')) continue;
    if (p.indoor === 1) continue;
    // The tags that say, in the agency of the map, "not on foot".
    if (p.foot === 'no' || p.access === 'no' || p.access === 'private') continue;
    const g = f.geometry;
    const parts: [number, number][][] = g.type === 'LineString'
      ? [g.coordinates as [number, number][]]
      : g.type === 'MultiLineString' ? (g.coordinates as [number, number][][]) : [];
    const steps = p.subclass === 'steps';
    for (const part of parts) {
      if (part.length < 2) continue;
      let hit = false;
      for (const c of part) {
        if (c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n) { hit = true; break; }
      }
      if (hit) out.push({ coords: part, steps });
    }
  }
  return out;
}

// ---------------------------------------------------------------- cache

/**
 * Successful routes are kept; failures are only rate-limited.
 *
 * A route is a fact about two fixed points, so once found it stays true and must not
 * be recomputed as the camera moves — recomputing is what made the drawn path flip
 * between routed and straight as the rider zoomed out past the tiles that carry
 * footways. A FAILURE, by contrast, is a fact about what this device had loaded a
 * moment ago, so it is retried — just not on every frame.
 *
 * Keyed by both endpoints to ~1 m. Nothing here can hand one walk's geometry to
 * another walk, which is the property the plan-geometry state machine depends on
 * (DECISIONS §45 §8).
 */
const routed = new Map<string, WalkLeg>();
const failedAt = new Map<string, number>();
const RETRY_MS = 2_000;
const MAX_CACHE = 60;

const keyOf = (from: WalkPoint, to: WalkPoint, avoidSteps: boolean): string =>
  `${from.lat.toFixed(5)},${from.lon.toFixed(5)}>${to.lat.toFixed(5)},${to.lon.toFixed(5)}${avoidSteps ? '!s' : ''}`;

/** Test seam / theme swaps: nothing outside this module holds a route. */
export function clearWalkRouteCache(): void {
  routed.clear();
  failedAt.clear();
}

const straightLeg = (from: WalkPoint, to: WalkPoint): WalkLeg => ({
  kind: 'direct',
  coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
  distanceM: Math.round(haversineM(from, to)),
});

/**
 * The walk to draw, always. Never null, never empty — the caller decides whether a
 * walk should be drawn AT ALL (that is the walkable / plan-resolved question); this
 * only decides what it looks like when it is.
 *
 * A 'direct' answer is not a route and the caller must not present it as one: it is
 * drawn in its own hairline style and labelled as an estimate.
 */
export function resolveWalkLeg(
  map: MlMap | null,
  from: WalkPoint,
  to: WalkPoint,
  opts: { avoidSteps?: boolean; now?: number } = {},
): WalkLeg {
  const avoidSteps = opts.avoidSteps === true;
  const key = keyOf(from, to, avoidSteps);
  const hit = routed.get(key);
  if (hit) return hit;
  if (!map) return straightLeg(from, to);

  const now = opts.now ?? Date.now();
  const last = failedAt.get(key);
  if (last != null && now - last < RETRY_MS) return straightLeg(from, to);

  const lines = collectWalkLines(map, from, to);
  const path = lines.length ? routeWalk(lines, from, to, { avoidSteps }) : null;
  if (!path) {
    failedAt.set(key, now);
    if (failedAt.size > MAX_CACHE) failedAt.clear();
    return straightLeg(from, to);
  }
  const leg: WalkLeg = { kind: 'routed', coordinates: path.coordinates, distanceM: path.distanceM };
  // Bounded: a rider walking across town would otherwise accumulate one entry per
  // GPS fix. The newest answer is the one worth keeping, so the oldest goes.
  if (routed.size >= MAX_CACHE) routed.delete(routed.keys().next().value as string);
  routed.set(key, leg);
  failedAt.delete(key);
  return leg;
}
