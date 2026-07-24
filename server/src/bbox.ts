// Bounding-box parsing + validation for /api/vehicles. Pure and unit-tested.
//
// Wire format: "minLon,minLat,maxLon,maxLat" (the GeoJSON/Leaflet order).
// We validate ranges, ordering, and cap the area so a single request can never
// ask the server to serialize the whole city (payloads stay lean and bounded).

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export type BboxResult =
  | { ok: true; value: Bbox }
  | { ok: false; error: string };

// Whole-planet-safe hard ranges; the agency box is far smaller but we validate
// against the geographic maxima, not a hardcoded Toronto box (no magic city consts).
const LON_MIN = -180;
const LON_MAX = 180;
const LAT_MIN = -90;
const LAT_MAX = 90;

// Cap the span so one viewport request stays bounded. ~3 degrees (~330 km) is far
// larger than any real map viewport yet still refuses "give me everything".
const MAX_SPAN_DEG = 3;

export function parseBbox(raw: string | undefined | null): BboxResult {
  if (raw == null || raw.trim() === '') return { ok: false, error: 'bbox is required (minLon,minLat,maxLon,maxLat)' };
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 4) return { ok: false, error: 'bbox must have 4 comma-separated numbers' };
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n))) return { ok: false, error: 'bbox values must be finite numbers' };
  const [minLon, minLat, maxLon, maxLat] = nums;
  if (minLon < LON_MIN || maxLon > LON_MAX || minLon > LON_MAX || maxLon < LON_MIN) {
    return { ok: false, error: 'longitude out of range [-180, 180]' };
  }
  if (minLat < LAT_MIN || maxLat > LAT_MAX || minLat > LAT_MAX || maxLat < LAT_MIN) {
    return { ok: false, error: 'latitude out of range [-90, 90]' };
  }
  if (minLon >= maxLon) return { ok: false, error: 'minLon must be < maxLon' };
  if (minLat >= maxLat) return { ok: false, error: 'minLat must be < maxLat' };
  if (maxLon - minLon > MAX_SPAN_DEG || maxLat - minLat > MAX_SPAN_DEG) {
    return { ok: false, error: `bbox span too large (max ${MAX_SPAN_DEG}° per side)` };
  }
  return { ok: true, value: { minLon, minLat, maxLon, maxLat } };
}

/** True if a point falls inside the box (inclusive). */
export function pointInBbox(lat: number, lon: number, b: Bbox): boolean {
  return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}
