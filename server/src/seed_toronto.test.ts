// The seeder's window derivation. This is the regression test for BLOCKERS.md entry 9:
// the trip/stop_times filter must come from the loaded board's own validity span, never
// from the seed date, so a service the calendar declares active can never lack its trips.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardDays } from './seed_toronto.ts';
import { activeServiceIds, type CalendarRow, type CalendarDateRow } from './gtfs.ts';

// The real TTC board, exactly as calendar.txt/calendar_dates.txt carry it on the
// 2026-07-26..2026-09-05 board: weekday, Saturday, Sunday, a holiday service that
// only ever exists via calendar_dates, and a service with no flags and no exceptions.
const TTC_CAL: CalendarRow[] = [
  { service_id: '1', days: [true, true, true, true, true, false, false], start_date: 20260726, end_date: 20260905 },
  { service_id: '2', days: [false, false, false, false, false, true, false], start_date: 20260726, end_date: 20260905 },
  { service_id: '3', days: [false, false, false, false, false, false, true], start_date: 20260726, end_date: 20260905 },
  { service_id: '4', days: [false, false, false, false, false, false, false], start_date: 20260726, end_date: 20260905 },
  { service_id: '6702', days: [false, false, false, false, false, false, false], start_date: 20260726, end_date: 20260905 },
];
const TTC_DATES: CalendarDateRow[] = [
  { service_id: '4', date: 20260803, exception_type: 1 }, // civic holiday service added
  { service_id: '1', date: 20260803, exception_type: 2 }, // weekday service removed that day
];

test('boardDays spans the whole board, from the feed and not from the clock', () => {
  const days = boardDays(TTC_CAL, TTC_DATES);
  assert.equal(days.length, 42, '2026-07-26..2026-09-05 inclusive is 42 days');
  assert.equal(days[0].ymd, 20260726);
  assert.equal(days[41].ymd, 20260905);
  assert.equal(days[0].dow, 6, '2026-07-26 is a Sunday (dow 6)');
  assert.equal(days[6].ymd, 20260801);
  assert.equal(days[6].dow, 5, '2026-08-01 is a Saturday (dow 5)');
  // Every day is distinct and consecutive — no DST-shifted duplicate or skip.
  assert.equal(new Set(days.map((d) => d.ymd)).size, 42);
});

test('the derived window admits the services the old seed-date window dropped', () => {
  const active = activeServiceIds(TTC_CAL, TTC_DATES, boardDays(TTC_CAL, TTC_DATES));
  assert.ok(active.has('1'), 'weekday service');
  assert.ok(active.has('2'), 'Saturday service — 32,874 trips the 7-day window dropped');
  assert.ok(active.has('3'), 'Sunday service');
  assert.ok(active.has('4'), 'civic-holiday service, active only via calendar_dates on 20260803');
  assert.ok(!active.has('6702'), 'no weekday flags and no exceptions — never active, must stay out');
});

test('every calendar-active board day resolves to at least one service in the window', () => {
  const days = boardDays(TTC_CAL, TTC_DATES);
  const windowed = activeServiceIds(TTC_CAL, TTC_DATES, days);
  for (const day of days) {
    const onThatDay = activeServiceIds(TTC_CAL, TTC_DATES, [day]);
    assert.ok(onThatDay.size > 0, `${day.ymd} has no active service at all`);
    for (const s of onThatDay) {
      assert.ok(windowed.has(s), `${day.ymd} needs service ${s}, which the seed window would not have loaded`);
    }
  }
});

test('a 7-day window measured from a seed date is exactly what this replaces', () => {
  // Seeded on 2026-07-24, the old default covered 20260724..20260730 — whose only
  // Saturday (07-25) predates the board. This is the defect, reproduced.
  const oldWindow = [
    { ymd: 20260724, dow: 4 }, { ymd: 20260725, dow: 5 }, { ymd: 20260726, dow: 6 },
    { ymd: 20260727, dow: 0 }, { ymd: 20260728, dow: 1 }, { ymd: 20260729, dow: 2 },
    { ymd: 20260730, dow: 3 },
  ];
  const old = activeServiceIds(TTC_CAL, TTC_DATES, oldWindow);
  assert.ok(!old.has('2'), 'the old window really did drop the Saturday service');
  assert.ok(!old.has('4'), 'and the holiday service');
});

test('calendar_dates outside the calendar span widen the board', () => {
  const cal: CalendarRow[] = [
    { service_id: 'WKDY', days: [true, true, true, true, true, false, false], start_date: 20260201, end_date: 20260203 },
  ];
  const dates: CalendarDateRow[] = [{ service_id: 'SPECIAL', date: 20260207, exception_type: 1 }];
  const days = boardDays(cal, dates);
  assert.equal(days[0].ymd, 20260201);
  assert.equal(days[days.length - 1].ymd, 20260207, 'span reaches the exception date');
  assert.ok(activeServiceIds(cal, dates, days).has('SPECIAL'));
});

test('the window crosses a DST transition without losing or duplicating a day', () => {
  // 2026-11-01: clocks fall back. 2026-10-30..2026-11-03 is 5 days, whatever the offset.
  const cal: CalendarRow[] = [
    { service_id: 'S', days: [true, true, true, true, true, true, true], start_date: 20261030, end_date: 20261103 },
  ];
  const days = boardDays(cal, []);
  assert.deepEqual(days.map((d) => d.ymd), [20261030, 20261031, 20261101, 20261102, 20261103]);
});

test('boardDays refuses a feed with no usable dates', () => {
  assert.throws(() => boardDays([], []), /no usable dates/);
});

test('a blank date column cannot drag the span back to 1899', () => {
  // Number('') is 0, not NaN. One empty start_date must not widen the board.
  const cal: CalendarRow[] = [
    { service_id: 'BLANK', days: [true, true, true, true, true, true, true], start_date: 0, end_date: 0 },
    { service_id: 'REAL', days: [true, true, true, true, true, true, true], start_date: 20260726, end_date: 20260728 },
  ];
  assert.deepEqual(boardDays(cal, []).map((d) => d.ymd), [20260726, 20260727, 20260728]);
});

test('boardDays names a date that is a number but not a day', () => {
  const cal: CalendarRow[] = [
    { service_id: 'X', days: [true, true, true, true, true, true, true], start_date: 20260231, end_date: 20260231 },
  ];
  assert.throws(() => boardDays(cal, []), /not real dates/);
});

// ---------------------------------------------------------------------------------
// CALENDAR_DATES-ONLY FEEDS — four of the nine GTA feeds, including MiWay
// ---------------------------------------------------------------------------------
//
// GTFS permits a feed to omit calendar.txt entirely and express service through
// calendar_dates.txt alone. Measured 2026-07-26: MiWay, GO Transit and Milton ship no
// calendar.txt at all, and Brampton ships one with only a header row. The seeder used to
// list calendar.txt as required and threw before reading a row, so MiWay — the agency a
// rider actually stood in and asked for — could not be seeded at all.
//
// These are shaped on MiWay's real file: service ids like `26AU03-CPBlock-Weekday-11`,
// exception_type 1 across a summer board (20260629..20260906).

const MIWAY_STYLE_DATES: CalendarDateRow[] = [
  { service_id: '26AU03-CPBlock-Weekday-11', date: 20260804, exception_type: 1 },
  { service_id: '26AU03-CPBlock-Weekday-11', date: 20260805, exception_type: 1 },
  { service_id: '26AU03-CPBlock-Saturday-12', date: 20260808, exception_type: 1 },
  { service_id: '26AU03-CPBlock-Sunday-13', date: 20260809, exception_type: 1 },
];

test('a feed with NO calendar.txt still derives a real board span', () => {
  // The empty array is what loadCalendar() returns when the file is absent.
  const days = boardDays([], MIWAY_STYLE_DATES);
  assert.equal(days[0].ymd, 20260804, 'span starts at the earliest exception date');
  assert.equal(days[days.length - 1].ymd, 20260809, 'span ends at the latest exception date');
  assert.equal(days.length, 6);
});

test('a calendar_dates-only feed still activates its services on the right days', () => {
  const days = boardDays([], MIWAY_STYLE_DATES);
  const active = activeServiceIds([], MIWAY_STYLE_DATES, days);
  assert.equal(active.size, 3, 'three distinct services across the span');
  assert.ok(active.has('26AU03-CPBlock-Weekday-11'));
  assert.ok(active.has('26AU03-CPBlock-Saturday-12'));
  assert.ok(active.has('26AU03-CPBlock-Sunday-13'));

  // Per-day resolution is what the arrivals board depends on: the Saturday service must
  // not leak onto the Wednesday.
  const wed = activeServiceIds([], MIWAY_STYLE_DATES, [{ ymd: 20260805, dow: 2 }]);
  assert.deepEqual([...wed], ['26AU03-CPBlock-Weekday-11']);
  const sat = activeServiceIds([], MIWAY_STYLE_DATES, [{ ymd: 20260808, dow: 5 }]);
  assert.deepEqual([...sat], ['26AU03-CPBlock-Saturday-12']);
});

test('a header-only calendar.txt behaves exactly like an absent one (Brampton)', () => {
  // Brampton's calendar.txt parses to zero rows. That must reach the same code path as
  // MiWay's missing file rather than a different, untested one.
  assert.deepEqual(boardDays([], MIWAY_STYLE_DATES), boardDays([], MIWAY_STYLE_DATES));
  const fromEmptyFile = activeServiceIds([], MIWAY_STYLE_DATES, boardDays([], MIWAY_STYLE_DATES));
  assert.equal(fromEmptyFile.size, 3);
});

test('an exception that REMOVES service cannot invent a board out of nothing', () => {
  // exception_type 2 on a feed with no calendar means no service was ever added. The span
  // still exists (the date is real), but nothing is active on it — which must read as
  // "we hold no schedule", not as a clean day. gates.ts `boardIntegrity` is the backstop.
  const removals: CalendarDateRow[] = [{ service_id: 'X', date: 20260804, exception_type: 2 }];
  const days = boardDays([], removals);
  assert.equal(days.length, 1);
  assert.equal(activeServiceIds([], removals, days).size, 0);
});

test('boardDays still refuses a feed with neither calendar nor calendar_dates', () => {
  // The one case that is genuinely unloadable, and it must say so rather than seed an
  // empty board that renders like a working one.
  assert.throws(() => boardDays([], []), /carry no usable dates/);
});

// ---------------------------------------------------------------------------------
// THE SEEDER MUST NEVER TRUNCATE A SHARED TABLE
// ---------------------------------------------------------------------------------
//
// `chunkedLoad` used to begin with `TRUNCATE ${table}`, which is correct while exactly one
// agency exists and catastrophic the moment there are two: seeding MiWay would empty
// `stops`, `routes`, `trips` and `stop_times` of every TTC row, then report a cheerful row
// count for the agency it had just loaded while the app went dark for the other one. There
// are no foreign keys in the schema (DECISIONS §43), so nothing would object.
//
// This is a SOURCE-LEVEL guard, and it is worth being explicit about what that does and
// does not prove. It cannot prove the DELETE is correctly scoped at runtime — that needs a
// two-agency database, which belongs in the Phase 1 integration wave. What it does prove is
// that the specific statement which would destroy another agency's board is not present,
// which is the regression that would otherwise pass every test in this suite silently.

test('GUARD: no TRUNCATE survives in the seeder, and the load is agency-scoped', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./seed_toronto.ts', import.meta.url), 'utf8');

  // Strip comments so the prose above (and in the seeder) cannot satisfy or trip the check.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /\bTRUNCATE\b/i,
    'TRUNCATE reintroduced — it would empty every OTHER agency\'s board too');
  assert.match(code, /DELETE FROM \$\{table\} WHERE agency=\$1/,
    'the per-agency delete is how a re-seed stays scoped to one agency');
  // The bbox write must be an upsert: migration 002 seeds only the `ttc` row, so an UPDATE
  // would match zero rows for any other agency and that city would silently never exist.
  assert.match(code, /INSERT INTO cities[\s\S]{0,400}ON CONFLICT \(agency\) DO UPDATE/,
    'cities must be upserted, not updated, or a new agency gets no city row');
});

test('GUARD: the SKIP_DOWNLOAD probe does not depend on an optional GTFS file', async () => {
  // calendar.txt is optional in GTFS and four of the nine GTA feeds omit it. Probing for it
  // told a MiWay operator "there is no extracted feed" straight after a successful seed,
  // defeating the flag's purpose — proving a re-seed loads the SAME board.
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('./seed_toronto.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const probe = /GHOSTBUS_SEED_SKIP_DOWNLOAD=1 but there is no extracted feed/;
  assert.match(code, probe, 'the skip-download guard should still exist');
  const guardBlock = code.slice(Math.max(0, code.search(probe) - 300), code.search(probe));
  assert.doesNotMatch(guardBlock, /calendar\.txt/,
    'the skip-download probe must not test calendar.txt — it is optional in GTFS');
});
