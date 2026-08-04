// When to ask for addresses, and what to remember about the answers.
//
// The stop search is free to us and instant; the address search costs a stranger's public
// endpoint a request and is rate-limited to roughly one a second for the whole
// application. So it is NOT fired on every query. It is fired when the stop search has
// visibly failed the rider — either it found almost nothing, or the query is shaped like a
// street address in the first place, which no stop name ever is.
//
// Everything here is pure or localStorage. The request itself is `api.geocode`, and the
// policy compliance that request depends on lives on the server (see server/src/geocode.ts
// for why it must).

import type { GeocodeResultDto } from '@shared/types';

/**
 * Below this many stop hits, the stop search has not answered the question and an address
 * lookup is worth its cost. Three is the point at which the Stops group stops looking like
 * an answer and starts looking like a near-miss.
 */
export const THIN_STOP_RESULTS = 3;

/** Shorter than this and any query still looks like typing rather than a question. */
const MIN_QUERY_LEN = 3;

/**
 * A query that OPENS WITH A NUMBER is a street address essentially every time — "193
 * Yonge", "80 Front St". No stop in any seeded agency's data is named that way (they are
 * "King St W At Spadina Ave"), and a rider who types a house number has told us plainly
 * what they are looking for, so we do not make them fail a stop search first.
 *
 * A bare number is excluded: that is a stop CODE, which the stop search answers exactly.
 */
export function looksLikeAddress(q: string): boolean {
  const s = q.trim();
  return /^\d+\s+\S/.test(s);
}

/**
 * Whether to spend an address lookup on this query.
 *
 * `stopCount` is what the stop search came back with. A query that already produced a
 * healthy list of stops is not improved by addresses underneath it — and the rider who
 * typed a house number gets them regardless, because for that query the stop list is not
 * an answer no matter how long it is.
 */
export function shouldGeocode(q: string, stopCount: number): boolean {
  const s = q.trim();
  if (s.length < MIN_QUERY_LEN) return false;
  if (looksLikeAddress(s)) return true;
  return stopCount < THIN_STOP_RESULTS;
}

// ---------------------------------------------------------------------------------
// recently geocoded, on this device only
// ---------------------------------------------------------------------------------

const KEY = 'gb.geocodes';
const CAP = 12;

/**
 * The ODbL credit, when the server has not just told us what it is.
 *
 * The response carries the attribution so it can never drift from the service that
 * actually answered — but an address group can render from THIS DEVICE'S remembered
 * addresses with no lookup behind it at all, and a licence that requires attribution
 * wherever the data is shown does not stop requiring it because the data came from
 * localStorage. So the group always has a credit, and the server's wording wins whenever
 * there is one.
 */
export const OSM_ATTRIBUTION_FALLBACK = 'Address search © OpenStreetMap contributors, via Nominatim.';

/**
 * What a chosen address is CALLED once it becomes a pin.
 *
 * Nominatim's `display_name` runs to the postcode and the country — 105 characters for a
 * doorway on Yonge Street — and that string ends up in the plan's destination chip and in
 * the final walk leg, where it is unreadable. The row the rider picked from showed the
 * full context, so nothing is being hidden: this is the same address, named the way a
 * rider would say it. Still the geocoder's own words, just the front of them.
 */
export function pinLabel(r: { title: string; label: string }): string {
  return r.title.trim() !== '' ? r.title : r.label;
}

export interface RecentGeocode extends GeocodeResultDto {
  /** epoch ms it was last chosen — the list is most-recent-first. */
  ts: number;
}

/** Re-validated on every read, like every other persisted list in this app: a stored row
 *  is data from an older version of ourselves and is not trusted on sight. */
function valid(v: unknown): RecentGeocode[] {
  if (!Array.isArray(v)) return [];
  const out: RecentGeocode[] = [];
  for (const r of v) {
    if (r == null || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const { label, title, context, lat, lon, ts } = o;
    if (typeof label !== 'string' || label.length === 0) continue;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    out.push({
      label,
      title: typeof title === 'string' && title.length > 0 ? title : label,
      context: typeof context === 'string' ? context : '',
      lat, lon,
      ts: typeof ts === 'number' && Number.isFinite(ts) ? ts : 0,
    });
    if (out.length >= CAP) break;
  }
  return out;
}

export function readRecentGeocodes(): RecentGeocode[] {
  try {
    return valid(JSON.parse(localStorage.getItem(KEY) ?? '[]'));
  } catch {
    return [];
  }
}

/** Newest first, de-duplicated on the point rather than the label — the same doorway can
 *  come back with slightly different wording between lookups. */
export function pushRecentGeocode(
  list: readonly RecentGeocode[],
  next: GeocodeResultDto,
  nowMs: number = Date.now(),
): RecentGeocode[] {
  const key = (r: { lat: number; lon: number }) => `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
  const k = key(next);
  return [{ ...next, ts: nowMs }, ...list.filter((r) => key(r) !== k)].slice(0, CAP);
}

export function saveRecentGeocode(next: GeocodeResultDto): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pushRecentGeocode(readRecentGeocodes(), next)));
  } catch {
    // A full or disabled store costs the rider a convenience, never a result.
  }
}

/** Recents matching what has been typed so far, so a re-used address needs no lookup. */
export function filterRecentGeocodes(list: readonly RecentGeocode[], q: string, limit = 3): RecentGeocode[] {
  const s = q.trim().toLowerCase();
  if (s.length === 0) return [];
  return list.filter((r) => r.label.toLowerCase().includes(s)).slice(0, limit);
}
