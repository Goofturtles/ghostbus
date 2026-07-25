// patterns — the static GTFS pattern index the delay engine matches against.
//
// A "pattern" is a route's distinct ordered stop list. Our 68,401 seeded trips collapse
// to roughly 1,250 distinct patterns, which is what makes matching a realtime trip to a
// static trip tractable: pick the pattern first (from stop identities), then pick the
// slot on that pattern (from the origin departure time).
//
// COST IS THE REASON THIS FILE EXISTS. Reading stop_times in one shot measured 45.5 s and
// 184 MB of heap against Neon, which is far too much to do on a request path or to hold
// as pg row objects. The build is therefore keyset-paged on trip_id (so each page's row
// objects are collected before the next arrives), stop ids are interned, and times are
// held in Int32Array. The result is built into a fresh object and swapped atomically, so
// a concurrent poll cycle never sees a half-built index.
//
// The paged query is served exactly by the existing stop_times_pkey (agency, trip_id,
// stop_sequence). No new index is added on stop_times or trips.

import { createHash } from 'node:crypto';
import type { Db } from './db.ts';
import { DbClosedError } from './db.ts';

export interface StaticPattern {
  patternId: string;
  routeId: string;
  dirId: number | null;
  /** index i corresponds to stop_sequence i+1 (verified: all trips start at 1, contiguous). */
  stops: string[];
  len: number;
}

export interface StaticTripSlot {
  tripId: string;
  serviceId: string;
  patternId: string;
  /** COALESCE(departure_s, arrival_s) by stop_sequence-1. */
  times: Int32Array;
  /** arrival_s by stop_sequence-1 (differs from departure on ~0.05% of rows). */
  arrivals: Int32Array;
  firstDepS: number;
}

export interface StopPoint { stopId: string; lat: number; lon: number }

export interface PatternIndex {
  boardTag: string;
  patterns: Map<string, StaticPattern>;
  byRoute: Map<string, StaticPattern[]>;
  /** patternId -> slots, sorted ascending by firstDepS. */
  slotsByPattern: Map<string, StaticTripSlot[]>;
  slotsByTrip: Map<string, StaticTripSlot>;
  maxLenByRoute: Map<string, number>;
  /** patternId -> median headway in seconds on its most-populated service_id. */
  medianHeadwayS: Map<string, number>;
  routeStops: Map<string, StopPoint[]>;
  stopsByTrip: Map<string, string>;
  serviceByTrip: Map<string, string>;
  tripIds: Set<string>;
  builtAtMs: number;
  elapsedMs: number;
}

/** Stable pattern identity: same stops in the same order on the same route+direction. */
export function patternIdFor(routeId: string, dirId: number | null, stops: readonly string[]): string {
  return createHash('sha1')
    .update(`${routeId}|${dirId ?? ''}|${stops.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}

/** Median of a numeric list (lower-mean convention for even counts). */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const a = [...values].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * Median gap between consecutive slot departures on a pattern, computed on the pattern's
 * most-populated service_id so a handful of special-service trips cannot distort it.
 * Fewer than 3 slots on the dominant service means there is no headway to speak of.
 */
export function medianHeadwayForSlots(slots: readonly StaticTripSlot[]): number | null {
  if (slots.length < 3) return null;
  const byService = new Map<string, number[]>();
  for (const s of slots) {
    let a = byService.get(s.serviceId);
    if (!a) { a = []; byService.set(s.serviceId, a); }
    a.push(s.firstDepS);
  }
  let best: number[] | null = null;
  for (const a of byService.values()) if (!best || a.length > best.length) best = a;
  if (!best || best.length < 3) return null;
  best.sort((x, y) => x - y);
  const gaps: number[] = [];
  for (let i = 1; i < best.length; i++) gaps.push(best[i] - best[i - 1]);
  return median(gaps);
}

interface RawRow {
  trip_id: string;
  route_id: string | null;
  direction_id: number | null;
  service_id: string | null;
  stop_sequence: number;
  stop_id: string;
  arrival_s: number | null;
  departure_s: number | null;
}

const PAGE = 200_000;

/**
 * Build the index. Keyset-paged so the driver never materialises 2.1M rows at once.
 * Pure assembly lives in `foldTrip` so the shape logic is testable without a database.
 */
export async function buildPatternIndex(db: Db, agency: string, boardTag: string): Promise<PatternIndex> {
  const t0 = Date.now();
  const idx: PatternIndex = {
    boardTag,
    patterns: new Map(), byRoute: new Map(), slotsByPattern: new Map(), slotsByTrip: new Map(),
    maxLenByRoute: new Map(), medianHeadwayS: new Map(), routeStops: new Map(),
    stopsByTrip: new Map(), serviceByTrip: new Map(), tripIds: new Set(),
    builtAtMs: Date.now(), elapsedMs: 0,
  };

  let cursor = '';
  for (;;) {
    // This loop pages through 2.15M stop_times and takes ~109 s over Neon, so it
    // routinely outlives a Ctrl-C. Check for shutdown between pages and abort quietly
    // rather than letting the next query throw "pool after calling end".
    if (db.closed) throw new DbClosedError();
    const page = await db.query<RawRow>(
      `SELECT st.trip_id, t.route_id, t.direction_id, t.service_id,
              st.stop_sequence, st.stop_id, st.arrival_s, st.departure_s
       FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id AND t.agency = st.agency
       WHERE st.agency = $1 AND st.trip_id > $2
       ORDER BY st.trip_id, st.stop_sequence
       LIMIT $3`,
      [agency, cursor, PAGE],
    );
    const rows = page.rows;
    if (rows.length === 0) break;
    const lastPage = rows.length < PAGE;
    // The final trip of a full page is very likely cut in half by the LIMIT. Folding it
    // would emit a pattern that is missing its tail, so on a full page we stop before it
    // and let the next page refetch it whole. Only a short (final) page is folded entire.
    const lastTripId = rows[rows.length - 1].trip_id;
    const end = lastPage ? rows.length : rows.findIndex((r) => r.trip_id === lastTripId);
    if (!lastPage && end <= 0) {
      throw new Error(`patterns: trip ${lastTripId} exceeds the ${PAGE}-row page size; cannot page safely`);
    }
    let start = 0;
    for (let i = 1; i <= end; i++) {
      if (i === end || rows[i].trip_id !== rows[start].trip_id) { foldTrip(idx, rows.slice(start, i)); start = i; }
    }
    if (lastPage) break;
    cursor = rows[end - 1].trip_id; // strictly less than lastTripId, so it is refetched next page
  }

  for (const [patternId, slots] of idx.slotsByPattern) {
    slots.sort((a, b) => a.firstDepS - b.firstDepS);
    const h = medianHeadwayForSlots(slots);
    if (h != null) idx.medianHeadwayS.set(patternId, h);
  }

  // Route stop geometry, for the crosswalk's geometric anchors.
  const stopRows = await db.query<{ route_id: string; stop_id: string; lat: number | null; lon: number | null }>(
    `SELECT DISTINCT t.route_id, st.stop_id, s.lat, s.lon
     FROM stop_times st
     JOIN trips t ON t.agency = st.agency AND t.trip_id = st.trip_id
     JOIN stops s ON s.agency = st.agency AND s.stop_id = st.stop_id
     WHERE st.agency = $1 AND t.route_id IS NOT NULL AND s.lat IS NOT NULL AND s.lon IS NOT NULL`,
    [agency],
  );
  for (const r of stopRows.rows) {
    let a = idx.routeStops.get(r.route_id);
    if (!a) { a = []; idx.routeStops.set(r.route_id, a); }
    a.push({ stopId: r.stop_id, lat: Number(r.lat), lon: Number(r.lon) });
  }

  idx.elapsedMs = Date.now() - t0;
  return idx;
}

/** Fold one trip's ordered stop_times rows into the index. Exported for tests. */
export function foldTrip(idx: PatternIndex, rows: readonly RawRow[]): void {
  if (rows.length === 0) return;
  const head = rows[0];
  if (!head.route_id) return;
  const routeId = head.route_id;
  const dirId = head.direction_id == null ? null : Number(head.direction_id);
  const serviceId = head.service_id ?? '';

  // Max over all rows rather than the last row, so the fold does not silently depend on
  // the caller having sorted them (the query does, but the identity must not rely on it).
  let maxSeq = 0;
  for (const r of rows) if (r.stop_sequence > maxSeq) maxSeq = r.stop_sequence;
  if (maxSeq <= 0) return;
  const stops = new Array<string>(maxSeq).fill('');
  const times = new Int32Array(maxSeq).fill(-1);
  const arrivals = new Int32Array(maxSeq).fill(-1);
  for (const r of rows) {
    const i = r.stop_sequence - 1;
    if (i < 0 || i >= maxSeq) continue;
    stops[i] = r.stop_id;
    const dep = r.departure_s == null ? (r.arrival_s == null ? null : Number(r.arrival_s)) : Number(r.departure_s);
    const arr = r.arrival_s == null ? (r.departure_s == null ? null : Number(r.departure_s)) : Number(r.arrival_s);
    if (dep != null) times[i] = dep;
    if (arr != null) arrivals[i] = arr;
  }
  // A gap in the sequence would mean stops[i] === '' and a pattern id that silently
  // encodes a hole. Refuse the trip instead of inventing a stop.
  for (const s of stops) if (s === '') return;
  if (times[0] < 0) return;

  const patternId = patternIdFor(routeId, dirId, stops);
  if (!idx.patterns.has(patternId)) {
    const p: StaticPattern = { patternId, routeId, dirId, stops, len: stops.length };
    idx.patterns.set(patternId, p);
    let br = idx.byRoute.get(routeId);
    if (!br) { br = []; idx.byRoute.set(routeId, br); }
    br.push(p);
    idx.maxLenByRoute.set(routeId, Math.max(idx.maxLenByRoute.get(routeId) ?? 0, p.len));
  }
  const slot: StaticTripSlot = { tripId: head.trip_id, serviceId, patternId, times, arrivals, firstDepS: times[0] };
  let sl = idx.slotsByPattern.get(patternId);
  if (!sl) { sl = []; idx.slotsByPattern.set(patternId, sl); }
  sl.push(slot);
  idx.slotsByTrip.set(head.trip_id, slot);
  idx.stopsByTrip.set(head.trip_id, patternId);
  idx.serviceByTrip.set(head.trip_id, serviceId);
  idx.tripIds.add(head.trip_id);
}

/** An empty index, so callers have a valid (unready) value before the first build. */
export function emptyPatternIndex(boardTag = '?..?'): PatternIndex {
  return {
    boardTag,
    patterns: new Map(), byRoute: new Map(), slotsByPattern: new Map(), slotsByTrip: new Map(),
    maxLenByRoute: new Map(), medianHeadwayS: new Map(), routeStops: new Map(),
    stopsByTrip: new Map(), serviceByTrip: new Map(), tripIds: new Set(),
    builtAtMs: 0, elapsedMs: 0,
  };
}
