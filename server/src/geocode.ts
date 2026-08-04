// Addresses, via Nominatim — and the reason this runs on the SERVER rather than in the
// browser, which is not a preference.
//
// Nominatim's usage policy has two hard requirements. The first is an identifying
// User-Agent. A browser CANNOT send one: `User-Agent` is a forbidden header name, and a
// `fetch` that tries to set it has the value silently dropped. A client-side geocoder is
// therefore, unavoidably, an unidentified one — exactly the thing the policy forbids and
// the thing that gets a free public endpoint to start returning 403 to everybody using it.
// The second is at most one request per second FOR THE WHOLE APPLICATION. A client-side
// debounce is per-tab; it says nothing about a hundred tabs. Only a single shared point
// can honour a global rate, and this is it.
//
// So: one proxy, our real User-Agent (the same one every other outbound request in this
// project carries), a global one-per-second gate, and a small cache so that repeating a
// query costs the upstream nothing.
//
// WHAT THIS IS NOT. It is not a stop search, and nothing it returns is a claim that
// transit goes there. It answers "where is this address", and the planner then does its
// ordinary honest work of finding the nearest stop and a street-following walk to the
// point — the same machinery a map-pick already uses.

import { USER_AGENT } from './agencies.ts';
import type { GeocodeResultDto } from '../../shared/types.ts';

/**
 * The Greater Toronto and Hamilton Area, as [minLon, minLat, maxLon, maxLat].
 *
 * Bounded on purpose and BOUNDED, not merely preferred: `bounded=1` makes this a filter
 * rather than a ranking hint. A rider searching "200 King St" in an app that only knows
 * GTA transit must not be offered a King Street in another province — a result the app
 * cannot plan a trip to is not a helpful result, it is a dead end with a plausible name.
 * Matches the agencies actually seeded (TTC, MiWay, DRT, Oakville, Milton, Brampton, HSR,
 * YRT, GO), with a small margin.
 */
export const GTA_VIEWBOX: readonly [number, number, number, number] = [-80.25, 43.10, -78.75, 44.20];

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';

/** The ODbL credit, shown wherever a result from this service is rendered. */
export const OSM_ATTRIBUTION = 'Address search © OpenStreetMap contributors, via Nominatim.';

/** At most five, because the sheet shows a group and not a directory. */
export const GEOCODE_LIMIT = 5;

/**
 * The policy's rate, enforced globally. One in flight, one per second, no exceptions —
 * a queue rather than a rejection, because the caller that waits 300 ms is still faster
 * than the rider retyping.
 */
const MIN_INTERVAL_MS = 1_100;
let lastCallMs = 0;
let chain: Promise<unknown> = Promise.resolve();

function gate<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallMs = Date.now();
    return fn();
  });
  // The chain must not break on a rejection, or every later query inherits the failure.
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Answers already paid for. Keyed by the normalised query; addresses do not move, so a
 * short TTL is only about eventually noticing corrections upstream, not about staleness
 * that could mislead. Bounded so a stream of junk queries cannot grow it without limit.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const CACHE_MAX = 500;
const cache = new Map<string, { atMs: number; results: GeocodeResultDto[] }>();

export function normaliseQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Nominatim's row, narrowed to the fields this uses. Everything else is ignored. */
interface NominatimRow {
  lat?: string;
  lon?: string;
  display_name?: string;
}

/**
 * Split the display name into a title and its context. Nominatim returns a comma-joined
 * string from most to least specific, so the first two parts are "193 Yonge Street" and
 * the rest is the city and country a rider does not need shouted at them.
 */
function splitLabel(display: string): { title: string; context: string } {
  const parts = display.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { title: display, context: '' };
  const title = parts.slice(0, 2).join(', ');
  return { title, context: parts.slice(2).join(', ') };
}

/** A row we can actually plan to. Anything without real coordinates is dropped. */
function toResult(row: NominatimRow): GeocodeResultDto | null {
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  const display = typeof row.display_name === 'string' ? row.display_name.trim() : '';
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || display.length === 0) return null;
  const { title, context } = splitLabel(display);
  return { label: display, title, context, lat, lon };
}

export interface GeocodeDeps {
  /** Injected so the tests never touch the network. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Look up an address. Throws only on a genuine upstream failure — a query the geocoder
 * simply does not know returns an EMPTY list, which the client renders as an honest
 * "nothing matches" rather than as an error.
 */
export async function geocode(q: string, deps: GeocodeDeps = {}): Promise<GeocodeResultDto[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const key = normaliseQuery(q);
  if (key.length === 0) return [];

  const hit = cache.get(key);
  if (hit && now() - hit.atMs < CACHE_TTL_MS) return hit.results;

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('limit', String(GEOCODE_LIMIT));
  url.searchParams.set('viewbox', GTA_VIEWBOX.join(','));
  url.searchParams.set('bounded', '1');
  // Canada only. The viewbox already excludes elsewhere; this makes the intent explicit
  // to the upstream ranker rather than relying on the box alone.
  url.searchParams.set('countrycodes', 'ca');

  const rows = await gate(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`nominatim ${res.status}`);
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  });

  const results = (Array.isArray(rows) ? rows : [])
    .map((r) => toResult(r as NominatimRow))
    .filter((r): r is GeocodeResultDto => r != null)
    .slice(0, GEOCODE_LIMIT);

  if (cache.size >= CACHE_MAX) {
    // Oldest first; the Map preserves insertion order, so one shift is enough.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, { atMs: now(), results });
  return results;
}

/** Test seam: forget every cached answer and the rate gate's clock. */
export function __resetGeocodeForTest(): void {
  cache.clear();
  lastCallMs = 0;
  chain = Promise.resolve();
}
