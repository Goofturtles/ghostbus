// Agency-local time math for America/Toronto, built entirely on the Intl API.
// No manual UTC offsets anywhere: the IANA database inside Intl handles EST/EDT
// and the DST transitions for us. Every function is pure and dependency-free.

const TZ = 'America/Toronto';

const DTF = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  weekday: 'short',
});

// Monday = 0 .. Sunday = 6, matching the GTFS calendar column order.
const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

export interface TzParts {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  hour: number;  // 0-23
  minute: number;
  second: number;
  dow: number;   // 0 = Monday .. 6 = Sunday
}

/** Wall-clock parts in America/Toronto for a given epoch (ms). */
export function torontoParts(epochMs: number): TzParts {
  const parts = DTF.formatToParts(new Date(epochMs));
  const m: Record<string, string> = {};
  for (const p of parts) m[p.type] = p.value;
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour),
    minute: Number(m.minute),
    second: Number(m.second),
    dow: WEEKDAY_INDEX[m.weekday],
  };
}

/**
 * Offset of America/Toronto from UTC, in seconds, at the given instant.
 * Negative for Toronto (UTC-5 in winter, UTC-4 in summer). Derived by asking
 * Intl what the local wall clock reads and comparing to the real epoch.
 */
export function offsetSeconds(epochMs: number): number {
  const p = torontoParts(epochMs);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wallAsUtc - epochMs) / 1000);
}

/**
 * Epoch (ms) of local midnight (00:00:00 Toronto) for a calendar date.
 * Two-pass correction so it stays exact across DST boundaries.
 */
export function torontoMidnightEpoch(year: number, month: number, day: number): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let mid = wallAsUtc - offsetSeconds(wallAsUtc) * 1000;
  mid = wallAsUtc - offsetSeconds(mid) * 1000;
  return mid;
}

/** hour_of_week in 0..167 (Monday 00:00 = 0), Toronto-local. */
export function hourOfWeek(epochMs: number): number {
  const p = torontoParts(epochMs);
  return p.dow * 24 + p.hour;
}

/** GTFS YYYYMMDD integer for the Toronto calendar date at an epoch. */
export function torontoYmd(epochMs: number): number {
  const p = torontoParts(epochMs);
  return p.year * 10000 + p.month * 100 + p.day;
}

/** {ymd, dow} for the Toronto calendar date at an epoch. */
export function torontoDay(epochMs: number): { ymd: number; dow: number } {
  const p = torontoParts(epochMs);
  return { ymd: p.year * 10000 + p.month * 100 + p.day, dow: p.dow };
}

// ---------- GTFS service-day anchoring ----------
//
// GTFS defines its times against NOON MINUS 12 HOURS on the service day, not against
// local midnight. The distinction is invisible for 363 days a year and worth exactly
// one hour on the other two: anchoring at midnight renders a 9h GTFS time as 08:00 wall
// clock on 2026-11-01 (fall back) and 10:00 on 2027-03-14 (spring forward), instead of
// 09:00 both times. That is 3,600 s of fabricated delay on every observation, all day.

/** Epoch (ms) of local noon on a calendar date, DST-exact (two-pass, same as midnight). */
export function torontoNoonEpoch(year: number, month: number, day: number): number {
  const wallAsUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  let noon = wallAsUtc - offsetSeconds(wallAsUtc) * 1000;
  noon = wallAsUtc - offsetSeconds(noon) * 1000;
  return noon;
}

/**
 * Epoch SECONDS for a GTFS seconds-past-service-midnight value on service date `ymd`.
 * Anchored at noon-minus-12h per the GTFS spec, so it is correct across DST transitions
 * and for values >= 86400 (the real maximum in our loaded board is 110,861 = 30:47:41).
 */
export function serviceEpochSeconds(ymd: number, gtfsSeconds: number): number {
  const y = Math.floor(ymd / 10000);
  const m = Math.floor(ymd / 100) % 100;
  const d = ymd % 100;
  return Math.round(torontoNoonEpoch(y, m, d) / 1000) - 12 * 3600 + gtfsSeconds;
}

/**
 * The service date an instant belongs to: the Toronto calendar date of (now - 4h), so a
 * trip running at 01:30 attaches to the service day that started it rather than to the
 * calendar day it happens to be crossing.
 */
export function serviceYmd(epochMs: number): number {
  return torontoYmd(epochMs - 4 * 3600_000);
}
