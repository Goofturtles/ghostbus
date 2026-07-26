// Shared GTFS helpers used by both the seeder and the collector.

/**
 * Parse a GTFS time ("HH:MM:SS", possibly >= 24:00:00 for trips that run past
 * midnight) into seconds-past-service-midnight. Returns null for blanks.
 * Example: "25:30:00" -> 91800.
 */
export function parseGtfsTime(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(trimmed);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export interface CalendarRow {
  service_id: string;
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean]; // Mon..Sun
  start_date: number; // YYYYMMDD
  end_date: number;   // YYYYMMDD
}

export interface CalendarDateRow {
  service_id: string;
  date: number;           // YYYYMMDD
  exception_type: number; // 1 = added, 2 = removed
}

export interface WindowDay {
  ymd: number; // YYYYMMDD
  dow: number; // 0 = Monday .. 6 = Sunday
}

/**
 * A GTFS date is only usable if it is actually a date. A blank column parses as 0, not NaN,
 * so without this one empty cell drags a board span back to 1899.
 */
export function isPlausibleGtfsDate(ymd: number): boolean {
  return Number.isFinite(ymd) && ymd >= 19700101 && ymd <= 21001231;
}

/**
 * The full span of dates a board can speak about: min..max across `calendar`'s validity
 * windows, widened by any `calendar_dates` exception outside them. `null` when the feed
 * carries no usable date at all.
 *
 * THIS IS SHARED ON PURPOSE. The seeder uses it to decide which trips to load, and the
 * poller uses it to compute `boardCoverage` — which IS the `board_tag` scoping the learned
 * crosswalk (migration 004). Two copies of this arithmetic that drift apart would mean the
 * board we seeded and the tag we filed its crosswalk under disagree silently, which is
 * exactly the class of failure ARCHITECTURE.md §6 exists to prevent.
 *
 * Taking calendar_dates into account is not cosmetic: MiWay, GO and Milton ship NO
 * calendar.txt at all and Brampton's has only a header row, so for those feeds the
 * calendar-only span is empty and the entire board lives in calendar_dates.
 */
export function boardSpan(
  calendar: readonly CalendarRow[],
  calendarDates: readonly CalendarDateRow[],
): { first: number; last: number } | null {
  let first = Infinity;
  let last = -Infinity;
  const see = (ymd: number): void => {
    if (!isPlausibleGtfsDate(ymd)) return;
    if (ymd < first) first = ymd;
    if (ymd > last) last = ymd;
  };
  for (const c of calendar) { see(c.start_date); see(c.end_date); }
  for (const d of calendarDates) see(d.date);
  return first === Infinity ? null : { first, last };
}

/**
 * Genuine GTFS service resolution: which service_ids are active on the given
 * set of days, honouring calendar weekday flags, the [start_date, end_date]
 * validity window, and calendar_dates add/remove exceptions.
 */
export function activeServiceIds(
  calendar: CalendarRow[],
  calendarDates: CalendarDateRow[],
  days: WindowDay[],
): Set<string> {
  const added = new Map<number, Set<string>>();
  const removed = new Map<number, Set<string>>();
  for (const cd of calendarDates) {
    const target = cd.exception_type === 1 ? added : removed;
    let set = target.get(cd.date);
    if (!set) { set = new Set(); target.set(cd.date, set); }
    set.add(cd.service_id);
  }

  const active = new Set<string>();
  for (const day of days) {
    const dayRemoved = removed.get(day.ymd);
    for (const c of calendar) {
      if (
        day.ymd >= c.start_date &&
        day.ymd <= c.end_date &&
        c.days[day.dow] &&
        !(dayRemoved && dayRemoved.has(c.service_id))
      ) {
        active.add(c.service_id);
      }
    }
    const dayAdded = added.get(day.ymd);
    if (dayAdded) for (const s of dayAdded) active.add(s);
  }
  return active;
}
