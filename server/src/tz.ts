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
