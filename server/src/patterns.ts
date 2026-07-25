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
//
// ...AND THAT COST IS STILL TOO HIGH TO PAY PER BOOT. The build ran on every process start
// and again every 6 hours; four rebuilds in one measurement session exhausted the Neon
// free-tier data-transfer quota outright. Render's free tier sleeps after 15 minutes, so
// every wake is a fresh boot — the charge would recur forever. So the built index is now
// serialised (see packIndex) and restored on the next boot, and the decision to rebuild at
// all is made by a single-row fingerprint query rather than by reading the board.

import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.ts';
import { DbClosedError, isDbClosed } from './db.ts';

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

/** How this index came to exist. `build` read stop_times; the others did not. */
export type IndexSource = 'build' | 'cache-file' | 'cache-db' | 'empty';

export interface PatternIndex {
  boardTag: string;
  /**
   * Content fingerprint of the static tables this index was derived from — see
   * boardFingerprint. `''` means unknown, which is treated as "never trust, always
   * rebuild": an index with no fingerprint can neither be cached nor be kept across a
   * reload, because nothing can prove it still describes the board in the database.
   */
  fingerprint: string;
  source: IndexSource;
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
  /**
   * service_id -> how many static trips we actually hold for it. The `calendar` table is
   * seeded whole while `trips` is seeded through a window, so a service can be
   * calendar-ACTIVE on a date and still have no trips loaded — see BLOCKERS 9, where six
   * Saturdays and the civic holiday resolve to exactly that. Without this count the engine
   * cannot tell "nothing was late" from "we hold no schedule for this date".
   */
  tripsByService: Map<string, number>;
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
export async function buildPatternIndex(
  db: Db, agency: string, boardTag: string, fingerprint = '',
): Promise<PatternIndex> {
  const t0 = Date.now();
  const idx = emptyPatternIndex(boardTag);
  idx.fingerprint = fingerprint;
  idx.source = 'build';
  idx.builtAtMs = Date.now();

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

  finalizeIndex(idx);

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

  insertTrip(idx, routeId, dirId, stops, head.trip_id, serviceId, times, arrivals);
}

/**
 * Add one already-validated trip to the index.
 *
 * Split out of foldTrip so the cache restore walks the SAME code path a build does. That
 * is not tidiness: it is what makes "restored index === built index" a property of the
 * construction rather than a claim a test has to take on faith. In particular the pattern
 * id is recomputed here from the stops on both paths, so a cache can never introduce a
 * pattern identity that a rebuild would not have produced.
 */
function insertTrip(
  idx: PatternIndex, routeId: string, dirId: number | null, stops: string[],
  tripId: string, serviceId: string, times: Int32Array, arrivals: Int32Array,
): void {
  const patternId = patternIdFor(routeId, dirId, stops);
  if (!idx.patterns.has(patternId)) {
    const p: StaticPattern = { patternId, routeId, dirId, stops, len: stops.length };
    idx.patterns.set(patternId, p);
    let br = idx.byRoute.get(routeId);
    if (!br) { br = []; idx.byRoute.set(routeId, br); }
    br.push(p);
    idx.maxLenByRoute.set(routeId, Math.max(idx.maxLenByRoute.get(routeId) ?? 0, p.len));
  }
  const slot: StaticTripSlot = { tripId, serviceId, patternId, times, arrivals, firstDepS: times[0] };
  let sl = idx.slotsByPattern.get(patternId);
  if (!sl) { sl = []; idx.slotsByPattern.set(patternId, sl); }
  sl.push(slot);
  idx.slotsByTrip.set(tripId, slot);
  idx.stopsByTrip.set(tripId, patternId);
  idx.serviceByTrip.set(tripId, serviceId);
  idx.tripsByService.set(serviceId, (idx.tripsByService.get(serviceId) ?? 0) + 1);
  idx.tripIds.add(tripId);
}

/** Order the slots and derive the headways. Shared by the build and the cache restore. */
function finalizeIndex(idx: PatternIndex): void {
  for (const [patternId, slots] of idx.slotsByPattern) {
    slots.sort((a, b) => a.firstDepS - b.firstDepS);
    const h = medianHeadwayForSlots(slots);
    if (h != null) idx.medianHeadwayS.set(patternId, h);
  }
}

/** An empty index, so callers have a valid (unready) value before the first build. */
export function emptyPatternIndex(boardTag = '?..?'): PatternIndex {
  return {
    boardTag, fingerprint: '', source: 'empty',
    patterns: new Map(), byRoute: new Map(), slotsByPattern: new Map(), slotsByTrip: new Map(),
    maxLenByRoute: new Map(), medianHeadwayS: new Map(), routeStops: new Map(),
    stopsByTrip: new Map(), serviceByTrip: new Map(), tripsByService: new Map(), tripIds: new Set(),
    builtAtMs: 0, elapsedMs: 0,
  };
}

// ===========================================================================================
// BOARD FINGERPRINT
// ===========================================================================================

/**
 * Bumped whenever the serialised layout or the index shape changes. It is part of the
 * cache key, so an old blob written by an older build is not found rather than mis-read.
 */
export const PATTERN_CACHE_FORMAT = 1;

/** `('x'||md5)::bit(32)::int` — the portable order-independent text hash, summable exactly. */
const H = (col: string): string => `sum(('x'||substr(md5(${col}),1,8))::bit(32)::int::bigint)`;

/**
 * ONE ROW that describes the whole static board.
 *
 * The point of this query is that it is the ONLY thing a boot has to read before it can
 * decide whether the cached index is still true. Every sub-select is a scalar aggregate,
 * so the result is a handful of bytes however large the board is — the check can never
 * itself become the cost it exists to avoid.
 *
 * It covers every column buildPatternIndex reads: trips (route/direction/service),
 * stop_times (sequence, stop, arrival, departure) and stops (the lat/lon that become
 * routeStops). It also covers `calendar` and `calendar_dates`, which the index does NOT
 * read — deliberately. The board tag is only min(start_date)..max(end_date), so a calendar
 * edit that leaves those two dates alone (a service withdrawn, an exception added) changes
 * which trips are active on a date while leaving the tag identical. Folding the calendar
 * into the fingerprint means such an edit invalidates the cache instead of hiding behind
 * an unchanged tag.
 *
 * Sums are integer-typed throughout. A float8 sum would be at the mercy of the aggregation
 * order a parallel plan happens to pick, which would make the fingerprint flap.
 */
const FINGERPRINT_SQL = `
SELECT
  (SELECT count(*)||'/'||coalesce(min(start_date),0)||'/'||coalesce(max(end_date),0)
       ||'/'||coalesce(sum(start_date::bigint*100000+end_date::bigint),0)
       ||'/'||coalesce(sum((mon::int)+(tue::int)*2+(wed::int)*4+(thu::int)*8
                          +(fri::int)*16+(sat::int)*32+(sun::int)*64),0)
       ||'/'||coalesce(${H('service_id')},0)
     FROM calendar WHERE agency=$1) AS calendar,
  (SELECT count(*)||'/'||coalesce(sum(date::bigint*10+exception_type),0)
       ||'/'||coalesce(${H('service_id')},0)
     FROM calendar_dates WHERE agency=$1) AS calendar_dates,
  (SELECT count(*)||'/'||coalesce(min(trip_id),'')||'/'||coalesce(max(trip_id),'')
       ||'/'||coalesce(${H('trip_id')},0)
       ||'/'||coalesce(${H("coalesce(route_id,'')")},0)
       ||'/'||coalesce(${H("coalesce(service_id,'')")},0)
       ||'/'||coalesce(sum(coalesce(direction_id,-1)::bigint),0)
     FROM trips WHERE agency=$1) AS trips,
  (SELECT count(*)||'/'||coalesce(min(trip_id),'')||'/'||coalesce(max(trip_id),'')
       ||'/'||coalesce(sum(stop_sequence::bigint),0)
       ||'/'||coalesce(sum(coalesce(arrival_s,-1)::bigint),0)
       ||'/'||coalesce(sum(coalesce(departure_s,-1)::bigint),0)
       ||'/'||coalesce(${H('stop_id')},0)
     FROM stop_times WHERE agency=$1) AS stop_times,
  (SELECT count(*)||'/'||coalesce(${H('stop_id')},0)
       ||'/'||coalesce(sum((coalesce(lat,0)*1000000)::bigint),0)
       ||'/'||coalesce(sum((coalesce(lon,0)*1000000)::bigint),0)
     FROM stops WHERE agency=$1) AS stops`;

/**
 * A content fingerprint of the static board, or `null` if it could not be taken.
 *
 * `null` is the safe answer, not an error: it disables both the cache and the
 * skip-the-reload shortcut, which puts the caller back on today's behaviour of always
 * rebuilding. A shutdown mid-query is re-thrown so it stays distinguishable.
 */
export async function boardFingerprint(db: Db, agency: string): Promise<string | null> {
  if (db.closed) throw new DbClosedError();
  try {
    const r = await db.query<Record<string, string | null>>(FINGERPRINT_SQL, [agency]);
    const row = r.rows[0];
    if (!row) return null;
    const parts = ['calendar', 'calendar_dates', 'trips', 'stop_times', 'stops']
      .map((k) => (row[k] == null ? null : String(row[k])));
    if (parts.some((p) => p == null)) return null;
    return createHash('sha256').update(`${agency}\n${parts.join('\n')}`).digest('hex').slice(0, 32);
  } catch (e) {
    if (isDbClosed(e)) throw e;
    console.error('[patterns] board fingerprint failed, forcing a rebuild:',
      e instanceof Error ? e.message : e);
    return null;
  }
}

// ===========================================================================================
// SERIALISATION
// ===========================================================================================
//
// JSON is the wrong answer here and it is worth saying why in numbers: the index holds
// 68,401 trips whose times and arrivals are Int32Array, roughly 4.3M integers. As JSON
// those alone run to tens of megabytes of decimal digits and commas, and JSON.parse would
// then hand back Arrays of doubles that have to be copied into Int32Array anyway.
//
// The layout below writes each integer as 4 fixed bytes, interns every id once into a
// string table, and stores NOTHING that can be derived. Pattern ids, byRoute,
// maxLenByRoute, medianHeadwayS, stopsByTrip, serviceByTrip, tripsByService, tripIds and
// the slot ordering are all recomputed on load by the same insertTrip/finalizeIndex the
// build uses, which keeps the payload small AND makes a restored index identical to a
// built one by construction.
//
//   sealed blob := 'GBPX' | u32 format | sha256(body_gz) | body_gz
//   body        := u32 metaLen | meta(JSON utf8)
//                | u32 nStrings   | (u32 len | utf8)*
//                | u32 nPatterns  | (u32 routeIdx | u8 hasDir | i32 dir | u32 len | u32 stop*)*
//                | u32 nSlots     | (u32 tripIdx | u32 serviceIdx | u32 patternIdx
//                                    | i32 times* | i32 arrivals*)*      [len from pattern]
//                | u32 nRoutes    | (u32 routeIdx | u32 n | (u32 stopIdx | f64 lat | f64 lon)*)*
//
// All multi-byte fields are little-endian and read field-by-field, so the format does not
// depend on the host's byte order or on any alignment of the decompressed buffer.

const MAGIC = 'GBPX';
const HEAD_BYTES = 4 + 4 + 32;   // magic, format, sha256

interface CacheMeta {
  agency: string;
  boardTag: string;
  fingerprint: string;
  builtAtMs: number;
  buildMs: number;
  strings: number;
  patterns: number;
  slots: number;
  routes: number;
}

/** Serialise the index into one sealed, compressed buffer. */
export function packIndex(idx: PatternIndex, agency: string): Buffer {
  // Pass 1: intern every id, order the patterns, and total the exact byte length. Sizing
  // the buffer up front means the write allocates once — a growable writer would peak at
  // twice the payload for no benefit, and the payload is already tens of megabytes.
  const strings: string[] = [];
  const strIdx = new Map<string, number>();
  const intern = (s: string): number => {
    let i = strIdx.get(s);
    if (i === undefined) { i = strings.length; strings.push(s); strIdx.set(s, i); }
    return i;
  };
  const patternOrd = new Map<string, number>();

  let patBytes = 4;
  for (const p of idx.patterns.values()) {
    patternOrd.set(p.patternId, patternOrd.size);
    intern(p.routeId);
    for (const s of p.stops) intern(s);
    patBytes += 4 + 1 + 4 + 4 + p.len * 4;
  }
  let slotBytes = 4;
  for (const slot of idx.slotsByTrip.values()) {
    intern(slot.tripId); intern(slot.serviceId);
    slotBytes += 4 + 4 + 4 + slot.times.length * 4 + slot.arrivals.length * 4;
  }
  let geoBytes = 4;
  for (const [routeId, pts] of idx.routeStops) {
    intern(routeId);
    for (const pt of pts) intern(pt.stopId);
    geoBytes += 4 + 4 + pts.length * 20;
  }
  let strBytes = 4;
  const strLens = strings.map((s) => Buffer.byteLength(s, 'utf8'));
  for (const n of strLens) strBytes += 4 + n;

  const meta: CacheMeta = {
    agency, boardTag: idx.boardTag, fingerprint: idx.fingerprint,
    builtAtMs: idx.builtAtMs, buildMs: idx.elapsedMs,
    strings: strings.length, patterns: idx.patterns.size,
    slots: idx.slotsByTrip.size, routes: idx.routeStops.size,
  };
  const metaBuf = Buffer.from(JSON.stringify(meta), 'utf8');

  // Pass 2: write.
  const body = Buffer.allocUnsafe(4 + metaBuf.length + strBytes + patBytes + slotBytes + geoBytes);
  let o = 0;
  o = body.writeUInt32LE(metaBuf.length, o);
  o += metaBuf.copy(body, o);

  o = body.writeUInt32LE(strings.length, o);
  for (let i = 0; i < strings.length; i++) {
    o = body.writeUInt32LE(strLens[i], o);
    o += body.write(strings[i], o, 'utf8');
  }

  o = body.writeUInt32LE(idx.patterns.size, o);
  for (const p of idx.patterns.values()) {
    o = body.writeUInt32LE(strIdx.get(p.routeId)!, o);
    o = body.writeUInt8(p.dirId == null ? 0 : 1, o);
    o = body.writeInt32LE(p.dirId ?? 0, o);
    o = body.writeUInt32LE(p.len, o);
    for (const s of p.stops) o = body.writeUInt32LE(strIdx.get(s)!, o);
  }

  o = body.writeUInt32LE(idx.slotsByTrip.size, o);
  for (const slot of idx.slotsByTrip.values()) {
    o = body.writeUInt32LE(strIdx.get(slot.tripId)!, o);
    o = body.writeUInt32LE(strIdx.get(slot.serviceId)!, o);
    o = body.writeUInt32LE(patternOrd.get(slot.patternId)!, o);
    for (let i = 0; i < slot.times.length; i++) o = body.writeInt32LE(slot.times[i], o);
    for (let i = 0; i < slot.arrivals.length; i++) o = body.writeInt32LE(slot.arrivals[i], o);
  }

  o = body.writeUInt32LE(idx.routeStops.size, o);
  for (const [routeId, pts] of idx.routeStops) {
    o = body.writeUInt32LE(strIdx.get(routeId)!, o);
    o = body.writeUInt32LE(pts.length, o);
    for (const pt of pts) {
      o = body.writeUInt32LE(strIdx.get(pt.stopId)!, o);
      o = body.writeDoubleLE(pt.lat, o);
      o = body.writeDoubleLE(pt.lon, o);
    }
  }
  if (o !== body.length) throw new Error(`packIndex: wrote ${o} of ${body.length} bytes`);

  // Level 6 (the default) over level 1 was measured on the real board: see DECISIONS.
  const gz = gzipSync(body);
  const sealed = Buffer.allocUnsafe(HEAD_BYTES + gz.length);
  sealed.write(MAGIC, 0, 'ascii');
  sealed.writeUInt32LE(PATTERN_CACHE_FORMAT, 4);
  createHash('sha256').update(gz).digest().copy(sealed, 8);
  gz.copy(sealed, HEAD_BYTES);
  return sealed;
}

/** What a restore has to match before it is allowed to become the live index. */
export interface CacheExpectation { agency: string; boardTag: string; fingerprint: string }

/**
 * Rebuild the index from a sealed buffer, or return null.
 *
 * NULL IS THE ONLY FAILURE MODE. Every rejection — wrong magic, wrong format, bad
 * checksum, truncation, a length field that runs off the end, a count that does not match
 * the metadata, a fingerprint that is not the one we asked for — returns null so the
 * caller rebuilds. Nothing here may throw a partial index into the caller's hands, because
 * a half-loaded board would bind realtime trips to a schedule that is missing trips.
 */
export function unpackIndex(sealed: Buffer, expect: CacheExpectation): PatternIndex | null {
  const t0 = Date.now();
  try {
    if (sealed.length <= HEAD_BYTES) return null;
    if (sealed.toString('ascii', 0, 4) !== MAGIC) return null;
    if (sealed.readUInt32LE(4) !== PATTERN_CACHE_FORMAT) return null;
    const gz = sealed.subarray(HEAD_BYTES);
    // The checksum is what catches a truncated payload that still gunzips, and it runs
    // before the inflate so a corrupt blob never becomes an allocation.
    if (!createHash('sha256').update(gz).digest().equals(sealed.subarray(8, 40))) return null;
    const body = gunzipSync(gz);

    let o = 0;
    const need = (n: number): void => {
      if (o + n > body.length) throw new Error('truncated');
    };
    const u32 = (): number => { need(4); const v = body.readUInt32LE(o); o += 4; return v; };
    const i32 = (): number => { need(4); const v = body.readInt32LE(o); o += 4; return v; };
    const f64 = (): number => { need(8); const v = body.readDoubleLE(o); o += 8; return v; };

    const metaLen = u32();
    need(metaLen);
    const meta = JSON.parse(body.toString('utf8', o, o + metaLen)) as CacheMeta;
    o += metaLen;

    // Identity first: a blob for another agency, another board or another board CONTENT is
    // not a cache miss to be papered over, it is a different schedule.
    if (meta.agency !== expect.agency) return null;
    if (meta.boardTag !== expect.boardTag) return null;
    if (!expect.fingerprint || meta.fingerprint !== expect.fingerprint) return null;

    const nStrings = u32();
    if (nStrings !== meta.strings) return null;
    const strings = new Array<string>(nStrings);
    for (let i = 0; i < nStrings; i++) {
      const len = u32();
      need(len);
      strings[i] = body.toString('utf8', o, o + len);
      o += len;
    }
    const str = (i: number): string => {
      if (i >>> 0 >= strings.length) throw new Error('string index out of range');
      return strings[i];
    };

    const idx = emptyPatternIndex(meta.boardTag);
    idx.fingerprint = meta.fingerprint;
    idx.builtAtMs = meta.builtAtMs;

    const nPatterns = u32();
    if (nPatterns !== meta.patterns) return null;
    const patRoute = new Array<string>(nPatterns);
    const patDir = new Array<number | null>(nPatterns);
    const patStops = new Array<string[]>(nPatterns);
    for (let p = 0; p < nPatterns; p++) {
      patRoute[p] = str(u32());
      need(1);
      const hasDir = body.readUInt8(o); o += 1;
      const dir = i32();
      patDir[p] = hasDir ? dir : null;
      const len = u32();
      if (len === 0 || len * 4 > body.length - o) throw new Error('bad pattern length');
      const stops = new Array<string>(len);
      for (let i = 0; i < len; i++) stops[i] = str(u32());
      patStops[p] = stops;
    }

    const nSlots = u32();
    if (nSlots !== meta.slots) return null;
    for (let s = 0; s < nSlots; s++) {
      const tripId = str(u32());
      const serviceId = str(u32());
      const p = u32();
      if (p >= nPatterns) throw new Error('pattern index out of range');
      const len = patStops[p].length;
      const times = new Int32Array(len);
      const arrivals = new Int32Array(len);
      for (let i = 0; i < len; i++) times[i] = i32();
      for (let i = 0; i < len; i++) arrivals[i] = i32();
      insertTrip(idx, patRoute[p], patDir[p], patStops[p], tripId, serviceId, times, arrivals);
    }

    const nRoutes = u32();
    if (nRoutes !== meta.routes) return null;
    for (let r = 0; r < nRoutes; r++) {
      const routeId = str(u32());
      const n = u32();
      if (n * 20 > body.length - o) throw new Error('bad route geometry length');
      const pts = new Array<StopPoint>(n);
      for (let i = 0; i < n; i++) pts[i] = { stopId: str(u32()), lat: f64(), lon: f64() };
      idx.routeStops.set(routeId, pts);
    }
    if (o !== body.length) return null;   // trailing bytes mean this is not our payload

    // Every trip must have landed. A slot silently dropped (a duplicate trip id, a pattern
    // that failed to form) would leave the index short of trips it claims to hold, which
    // is exactly the partial load this function exists to refuse.
    if (idx.patterns.size !== meta.patterns) return null;
    if (idx.slotsByTrip.size !== meta.slots) return null;
    if (idx.tripIds.size !== meta.slots) return null;

    finalizeIndex(idx);
    idx.elapsedMs = Date.now() - t0;
    return idx;
  } catch {
    return null;   // truncation, a bad length, malformed JSON — all mean "rebuild"
  }
}

// ===========================================================================================
// THE TWO CACHE TIERS
// ===========================================================================================
//
// WHERE TO PUT THE BLOB, and what each choice actually buys:
//
//   Local file   Free to read and write, and dies with the container. On Render's free
//                tier the disk is ephemeral and the service sleeps after 15 minutes, so a
//                cold wake never sees it. It IS the whole answer for a process restart on
//                a live container and for the local collector, which restarts often.
//   Postgres     Survives the container, so it is the only tier that helps a cold wake —
//                which is the case that was killing us. It is not free: reading the blob
//                back costs transfer. That is the trade, and it is a good one only because
//                the blob is ~4 orders of magnitude smaller than the rows it replaces.
//
// So: both, file first. The file is tried first because it costs nothing; Postgres is the
// authority because it is the one that survives. Neither is trusted without the
// fingerprint, and the Postgres lookup puts the fingerprint in the WHERE clause so a stale
// row is not even downloaded to be rejected.

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Read per call rather than captured at import, so a test can point it at a temp dir. */
const cacheDir = (): string =>
  process.env.PATTERN_CACHE_DIR ?? join(__dirname, '..', '..', '.data', 'pattern-cache');
const cacheFileFor = (agency: string, fingerprint: string): string =>
  join(cacheDir(), `${agency}-${fingerprint}.gbpx`);

async function readFileCache(agency: string, expect: CacheExpectation): Promise<PatternIndex | null> {
  try {
    const buf = await readFile(cacheFileFor(agency, expect.fingerprint));
    const idx = unpackIndex(buf, expect);
    if (idx) idx.source = 'cache-file';
    return idx;
  } catch {
    return null;   // absent (the common case), unreadable, or not ours
  }
}

async function writeFileCache(agency: string, fingerprint: string, sealed: Buffer): Promise<void> {
  const target = cacheFileFor(agency, fingerprint);
  const tmp = `${target}.${process.pid}.tmp`;
  await mkdir(cacheDir(), { recursive: true });
  // Write-then-rename: a crash mid-write leaves a .tmp nobody looks for, never a truncated
  // file under the name a boot would trust.
  await writeFile(tmp, sealed);
  await rename(tmp, target);
  // One board is live at a time; older fingerprints for this agency are dead weight.
  try {
    for (const f of await readdir(cacheDir())) {
      if (f.startsWith(`${agency}-`) && f.endsWith('.gbpx') && f !== `${agency}-${fingerprint}.gbpx`) {
        await unlink(join(cacheDir(), f)).catch(() => {});
      }
    }
  } catch { /* housekeeping only */ }
}

async function readDbCache(db: Db, agency: string, expect: CacheExpectation): Promise<PatternIndex | null> {
  const res = await db.query<{ payload_b64: string; sha256: string; bytes: number | string }>(
    `SELECT payload_b64, sha256, bytes FROM pattern_index_cache
      WHERE agency=$1 AND board_tag=$2 AND fingerprint=$3 AND format=$4`,
    [agency, expect.boardTag, expect.fingerprint, PATTERN_CACHE_FORMAT],
  );
  const row = res.rows[0];
  if (!row) return null;
  const sealed = Buffer.from(row.payload_b64, 'base64');
  if (sealed.length !== Number(row.bytes)) {
    console.warn('[patterns] cached index is the wrong length; rebuilding');
    return null;
  }
  const idx = unpackIndex(sealed, expect);
  if (idx) idx.source = 'cache-db';
  return idx;
}

async function writeDbCache(db: Db, agency: string, idx: PatternIndex, sealed: Buffer): Promise<void> {
  await db.query(
    `INSERT INTO pattern_index_cache
       (agency, board_tag, fingerprint, format, bytes, sha256, payload_b64,
        patterns, slots, built_at_ms, build_ms, updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (agency) DO UPDATE SET
       board_tag=EXCLUDED.board_tag, fingerprint=EXCLUDED.fingerprint, format=EXCLUDED.format,
       bytes=EXCLUDED.bytes, sha256=EXCLUDED.sha256, payload_b64=EXCLUDED.payload_b64,
       patterns=EXCLUDED.patterns, slots=EXCLUDED.slots, built_at_ms=EXCLUDED.built_at_ms,
       build_ms=EXCLUDED.build_ms, updated=now()`,
    [agency, idx.boardTag, idx.fingerprint, PATTERN_CACHE_FORMAT, sealed.length,
      createHash('sha256').update(sealed).digest('hex'), sealed.toString('base64'),
      idx.patterns.size, idx.slotsByTrip.size, idx.builtAtMs, idx.elapsedMs],
  );
}

/**
 * The boot path: restore the index if the board has not changed, otherwise build it.
 *
 * `fingerprint` is null when the board could not be fingerprinted, which disables both
 * tiers and falls back to the old always-build behaviour rather than guessing.
 */
export async function loadOrBuildPatternIndex(
  db: Db, agency: string, boardTag: string, fingerprint: string | null,
): Promise<PatternIndex> {
  if (fingerprint) {
    const expect: CacheExpectation = { agency, boardTag, fingerprint };
    const fromFile = await readFileCache(agency, expect);
    if (fromFile) {
      console.log(`[patterns] restored index from disk in ${fromFile.elapsedMs} ms ` +
        `(${fromFile.patterns.size} patterns, ${fromFile.slotsByTrip.size} trips, ` +
        `board ${boardTag}) — stop_times not read`);
      return fromFile;
    }
    try {
      const fromDb = await readDbCache(db, agency, expect);
      if (fromDb) {
        console.log(`[patterns] restored index from the database in ${fromDb.elapsedMs} ms ` +
          `(${fromDb.patterns.size} patterns, ${fromDb.slotsByTrip.size} trips, ` +
          `board ${boardTag}) — stop_times not read`);
        // Land it on disk so the next restart on this container is free.
        try { await writeFileCache(agency, fingerprint, packIndex(fromDb, agency)); }
        catch (e) { console.warn('[patterns] could not write the disk cache:', e instanceof Error ? e.message : e); }
        return fromDb;
      }
    } catch (e) {
      if (isDbClosed(e)) throw e;
      console.error('[patterns] cached index unreadable, rebuilding:', e instanceof Error ? e.message : e);
    }
  }

  const idx = await buildPatternIndex(db, agency, boardTag, fingerprint ?? '');
  if (fingerprint) await persistPatternIndex(db, agency, idx);
  return idx;
}

/** Write the freshly built index to both tiers. Never fatal: a cache that cannot be
 *  written costs the NEXT boot time, not this one correctness. */
export async function persistPatternIndex(db: Db, agency: string, idx: PatternIndex): Promise<void> {
  if (!idx.fingerprint) return;
  try {
    const t0 = Date.now();
    const sealed = packIndex(idx, agency);
    const packMs = Date.now() - t0;
    try { await writeFileCache(agency, idx.fingerprint, sealed); }
    catch (e) { console.warn('[patterns] disk cache write failed:', e instanceof Error ? e.message : e); }
    if (db.closed) return;
    await writeDbCache(db, agency, idx, sealed);
    console.log(`[patterns] cached index for board ${idx.boardTag}: ` +
      `${(sealed.length / 1048576).toFixed(2)} MiB sealed, packed in ${packMs} ms`);
  } catch (e) {
    if (isDbClosed(e)) return;   // shutting down; the next boot rebuilds
    console.error('[patterns] could not persist the index:', e instanceof Error ? e.message : e);
  }
}
