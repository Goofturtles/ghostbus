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
