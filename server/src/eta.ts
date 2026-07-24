// Honest-ETA math: percentiles and evidence-threshold selection. Pure + unit-tested.
//
// The estimate an arrival row shows is: scheduled + median historical delay, with a
// band of P25..P75. Which historical bucket supplies those percentiles is governed by
// hard evidence thresholds so we never present a confident number we cannot back:
//   - (route, stop, hour_of_week) needs n >= 8   -> bucket 'stop-hour'
//   - else (route, hour_of_week)  needs n >= 20   -> bucket 'route-hour'
//   - else no estimate (null), bucket 'none'      -> schedule-only
export const STOP_HOUR_MIN_N = 8;
export const ROUTE_HOUR_MIN_N = 20;

export interface Percentiles {
  p25: number;
  p50: number;
  p75: number;
}

/**
 * Continuous percentile (linear interpolation between closest ranks), matching
 * Postgres `percentile_cont`. `q` in [0,1]. Values need not be pre-sorted.
 * Returns null for an empty input.
 */
export function percentileCont(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const arr = [...values].sort((a, b) => a - b);
  if (arr.length === 1) return arr[0];
  const rank = q * (arr.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return arr[lo] + (arr[hi] - arr[lo]) * frac;
}

/** P25/P50/P75 for a set of delay observations, or null if empty. */
export function percentiles(values: number[]): Percentiles | null {
  if (values.length === 0) return null;
  return {
    p25: percentileCont(values, 0.25) as number,
    p50: percentileCont(values, 0.5) as number,
    p75: percentileCont(values, 0.75) as number,
  };
}

export type EtaBucket = 'stop-hour' | 'route-hour' | 'none';

/** A pre-aggregated delay bucket read from agg_delay / agg_delay_route. */
export interface Agg {
  n: number;
  p25: number;
  p50: number;
  p75: number;
}

export interface EvidenceSelection {
  bucket: EtaBucket;
  n: number;
  /** the chosen bucket's percentiles in seconds, or null when bucket = 'none'. */
  p25: number | null;
  p50: number | null;
  p75: number | null;
}

/**
 * Pick the evidence bucket for a departure. `stop` is the (route, stop, hour) bucket;
 * `route` is the (route, hour) rollup used as fallback. Thresholds are hard:
 * a bucket is only used when it clears its minimum n. Otherwise the estimate is
 * withheld (bucket 'none') — we never dress a thin sample as a confident ETA.
 */
export function selectEvidence(stop: Agg | null, route: Agg | null): EvidenceSelection {
  if (stop && stop.n >= STOP_HOUR_MIN_N) {
    return { bucket: 'stop-hour', n: stop.n, p25: stop.p25, p50: stop.p50, p75: stop.p75 };
  }
  if (route && route.n >= ROUTE_HOUR_MIN_N) {
    return { bucket: 'route-hour', n: route.n, p25: route.p25, p50: route.p50, p75: route.p75 };
  }
  return { bucket: 'none', n: 0, p25: null, p50: null, p75: null };
}
