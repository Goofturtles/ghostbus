// Search result shaping — pure, so the ordering and the honesty rules can be
// exercised in a plain Node test with no browser and no network around.
//
// Two rules run through everything here:
//
//   1. NOTHING IS INVENTED. A stop's distance is printed only when the rider's own
//      position is known; otherwise the field is null and the row simply has no
//      distance, rather than a plausible-looking one measured from a fallback point.
//   2. A ROUTE RESULT IS A DEPARTURE. There is no route-search endpoint, and adding
//      one to list routes we could not then say anything true about would be a
//      decorative feature. So the Routes section is built from the departure boards
//      the app is ALREADY holding: every route row carries the real stop it leaves
//      from and the real time it leaves, which is also what makes it navigable.

import type { DepartureDto, StopDto, StopRouteDto } from '@shared/types';
import { parseHeadsign } from './headsign';

export interface Point { lat: number; lon: number }

/** A place the rider has opened before, persisted in localStorage (see store.ts). */
export interface RecentPlace {
  /** Persisted alongside the id: with several agencies seeded a bare stopId is ambiguous,
   *  and a remembered place must reopen the stop the rider actually visited. */
  agency: string;
  stopId: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** epoch ms it was last opened — the list is most-recent-first. */
  ts: number;
}

export interface StopResult {
  kind: 'stop';
  /** Which agency's stop. Carried so opening a result reopens the right one. */
  agency: string;
  stopId: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** metres from the rider, straight line. null when their position is unknown. */
  distanceM: number | null;
  wheelchairBoarding: number | null;
  /**
   * The routes the schedule says call here, straight from the server's DTO.
   *
   * `undefined` where the row did not come from a stop-search response — a saved or
   * recent place is reconstructed from what this device already holds, and that does not
   * include a route list. The row renders the stop code in the strip's place rather than
   * an empty gap, so "we never asked" never looks like "nothing serves this stop".
   */
  routes?: StopRouteDto[];
}

export interface RouteResult {
  kind: 'route';
  /** The agency running this route AND owning `stopId` below — they are the same agency,
   *  because a departure belongs to one board. */
  agency: string;
  routeId: string;
  shortName: string;
  longName: string | null;
  color: string;
  /** the agency's own headsign, split so the destination is readable. */
  destination: string;
  directionLabel: string;
  /** the real stop this departure leaves from — selecting the row opens it. */
  stopId: string;
  stopName: string | null;
  /** the real scheduled/live departure this row is evidence of. */
  departureMs: number;
  isLive: boolean;
}

export type SearchResult = StopResult | RouteResult;

/** Straight-line metres between two points. */
export function haversineM(a: Point, b: Point): number {
  const R = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** U+0300..U+036F — the combining-diacritics block NFD splits accents into. */
const COMBINING_MARKS = new RegExp('[̀-ͯ]', 'g');

/** Fold case and accents, so a French rider's "prefecture" still finds "Préfecture". */
export function normalise(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

/** Accent- and case-insensitive "contains". */
export function matches(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return normalise(haystack).includes(normalise(needle));
}

/**
 * Shape the API's stop hits into rows.
 *
 * Order: an exact stop-code match first (someone who typed "4197" wants stop 4197,
 * not the first alphabetical stop whose name contains it), then by real distance
 * when we know where the rider is, then by name so the list is at least stable.
 */
export function shapeStopResults(
  stops: readonly StopDto[],
  from: Point | null,
  query: string,
  limit = 12,
): StopResult[] {
  const q = query.trim();
  const rows: StopResult[] = stops.map((s) => ({
    kind: 'stop',
    agency: s.agency,
    stopId: s.stopId,
    name: s.name ?? s.stopId,
    lat: s.lat,
    lon: s.lon,
    distanceM: from != null && s.lat != null && s.lon != null
      ? Math.round(haversineM(from, { lat: s.lat, lon: s.lon }))
      : s.distanceM ?? null,
    wheelchairBoarding: s.wheelchairBoarding,
    routes: s.routes,
  }));

  const exact = (r: StopResult) => (r.stopId === q ? 0 : 1);
  rows.sort((a, b) => {
    const e = exact(a) - exact(b);
    if (e !== 0) return e;
    if (a.distanceM != null && b.distanceM != null && a.distanceM !== b.distanceM) {
      return a.distanceM - b.distanceM;
    }
    if (a.distanceM != null && b.distanceM == null) return -1;
    if (a.distanceM == null && b.distanceM != null) return 1;
    return a.name.localeCompare(b.name);
  });
  return rows.slice(0, limit);
}

/**
 * Routes to offer for a query, read out of departure boards the app already holds.
 *
 * One row per (route, direction): the EARLIEST real departure of it. A route with no
 * departure on any board we hold produces no row — we would have nothing true to say
 * about it and nowhere to send the rider who tapped it.
 */
export function matchRoutes(
  boards: ReadonlyArray<{ agency: string; stopId: string; stopName: string | null; departures: readonly DepartureDto[] }>,
  query: string,
  limit = 6,
): RouteResult[] {
  const q = query.trim();
  if (!q) return [];
  const best = new Map<string, RouteResult>();

  for (const board of boards) {
    for (const d of board.departures) {
      const routeId = d.routeId;
      if (!routeId) continue;
      const destination = parseHeadsign(d.directionLabel).destination || d.directionLabel;
      const hit = matches(d.shortName, q) || matches(d.longName, q)
        || matches(routeId, q) || matches(destination, q);
      if (!hit) continue;

      // Agency in the key: two agencies can run a route with the same id (Brampton shares
      // 45 route_ids with the TTC), and collapsing them would hide one of the two.
      const key = `${board.agency}|${routeId}|${d.directionId ?? 'x'}`;
      const prev = best.get(key);
      if (prev && prev.departureMs <= d.scheduledMs) continue;
      best.set(key, {
        kind: 'route',
        agency: board.agency,
        routeId,
        shortName: d.shortName ?? routeId,
        longName: d.longName,
        color: d.color,
        destination,
        directionLabel: d.directionLabel,
        stopId: board.stopId,
        stopName: board.stopName,
        departureMs: d.scheduledMs,
        isLive: d.liveEtaMs != null,
      });
    }
  }

  return [...best.values()]
    .sort((a, b) => a.departureMs - b.departureMs || a.shortName.localeCompare(b.shortName))
    .slice(0, limit);
}

/** Recents matching the query (or all of them, most recent first, when it is empty). */
export function filterRecents(recents: readonly RecentPlace[], query: string, limit = 5): RecentPlace[] {
  const q = query.trim();
  const hits = q ? recents.filter((r) => matches(r.name, q) || matches(r.stopId, q)) : recents.slice();
  return hits.sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/**
 * Drop stop rows already shown as a recent, so the same place cannot appear twice in
 * one list. Recents win because they are the shorter path to the same destination.
 */
export function dedupeAgainst(rows: readonly StopResult[], shown: readonly RecentPlace[]): StopResult[] {
  // Keyed on (agency, stopId): two agencies can carry the same stop id, and collapsing
  // them would silently drop a real, different stop from the results.
  const key = (r: { agency: string; stopId: string }) => `${r.agency}${r.stopId}`;
  const seen = new Set(shown.map(key));
  return rows.filter((r) => !seen.has(key(r)));
}

/** The most recent list of `n` places, newest first, with `place` promoted to the front. */
export function pushRecent(list: readonly RecentPlace[], place: RecentPlace, cap = 8): RecentPlace[] {
  // Same reasoning as dedupeAgainst: identity is the pair, never the id alone.
  return [place, ...list.filter((r) => !(r.agency === place.agency && r.stopId === place.stopId))].slice(0, cap);
}
