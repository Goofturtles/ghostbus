// Unit tests for GTFS time parsing (incl. >24:00:00) and service resolution.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGtfsTime, activeServiceIds, type CalendarRow, type CalendarDateRow } from './gtfs.ts';

test('parseGtfsTime basic', () => {
  assert.equal(parseGtfsTime('00:00:00'), 0);
  assert.equal(parseGtfsTime('08:05:09'), 8 * 3600 + 5 * 60 + 9);
  assert.equal(parseGtfsTime('23:59:59'), 86399);
});

test('parseGtfsTime handles GTFS times past midnight (>= 24:00:00)', () => {
  assert.equal(parseGtfsTime('25:30:00'), 91800); // the spec example
  assert.equal(parseGtfsTime('26:00:00'), 93600);
});

test('parseGtfsTime returns null for blanks/garbage', () => {
  assert.equal(parseGtfsTime(''), null);
  assert.equal(parseGtfsTime(undefined), null);
  assert.equal(parseGtfsTime('  '), null);
  assert.equal(parseGtfsTime('not-a-time'), null);
});

test('activeServiceIds respects weekday flags and validity window', () => {
  const cal: CalendarRow[] = [
    // WKDY runs Mon-Fri; WKND runs Sat-Sun; both valid all of 2026.
    { service_id: 'WKDY', days: [true, true, true, true, true, false, false], start_date: 20260101, end_date: 20261231 },
    { service_id: 'WKND', days: [false, false, false, false, false, true, true], start_date: 20260101, end_date: 20261231 },
    // EXPIRED valid only in January.
    { service_id: 'EXPIRED', days: [true, true, true, true, true, true, true], start_date: 20260101, end_date: 20260131 },
  ];
  // Monday 2026-07-27 (dow 0)
  assert.deepEqual(activeServiceIds(cal, [], [{ ymd: 20260727, dow: 0 }]), new Set(['WKDY']));
  // Saturday (dow 5)
  assert.deepEqual(activeServiceIds(cal, [], [{ ymd: 20260801, dow: 5 }]), new Set(['WKND']));
  // EXPIRED is out of its window in July
  assert.ok(!activeServiceIds(cal, [], [{ ymd: 20260727, dow: 0 }]).has('EXPIRED'));
});

test('activeServiceIds applies calendar_dates add/remove exceptions', () => {
  const cal: CalendarRow[] = [
    { service_id: 'WKDY', days: [true, true, true, true, true, false, false], start_date: 20260101, end_date: 20261231 },
  ];
  const dates: CalendarDateRow[] = [
    { service_id: 'WKDY', date: 20260727, exception_type: 2 }, // remove WKDY that Monday (holiday)
    { service_id: 'HOLIDAY', date: 20260727, exception_type: 1 }, // add a special service
  ];
  const active = activeServiceIds(cal, dates, [{ ymd: 20260727, dow: 0 }]);
  assert.deepEqual(active, new Set(['HOLIDAY']));
});

/**
 * THE REGRESSION THIS FILE EXISTS TO HOLD DOWN — DECISIONS §54.
 *
 * The poller used to hand the delay engine the union of the current calendar day's
 * services and the PREVIOUS calendar day's, to cover "a trip that started before
 * midnight is still running". `serviceDay` already covers that (it is now − 4 h), so
 * the union only ever added a second, complete service calendar — and the engine
 * filters candidate slots by exactly this set. On the TTC's board every Saturday,
 * Sunday and holiday changes service_id from the day before, so on those days every
 * pattern was scored against two interleaved schedules and the origin lock refused
 * almost everything as ambiguous.
 */
test('one service day means ONE service calendar, never the previous day as well', () => {
  // The TTC's real 2026-08-03 shape: weekday service removed on the civic holiday,
  // a holiday service added in its place. The day before is Sunday.
  const cal: CalendarRow[] = [
    { service_id: '1', days: [true, true, true, true, true, false, false], start_date: 20260726, end_date: 20260905 },
    { service_id: '3', days: [false, false, false, false, false, false, true], start_date: 20260726, end_date: 20260905 },
  ];
  const dates: CalendarDateRow[] = [
    { service_id: '1', date: 20260803, exception_type: 2 },
    { service_id: '4', date: 20260803, exception_type: 1 },
  ];

  const holiday = { ymd: 20260803, dow: 0 };  // Monday
  const sunday = { ymd: 20260802, dow: 6 };

  assert.deepEqual(activeServiceIds(cal, dates, [holiday]), new Set(['4']));
  assert.deepEqual(activeServiceIds(cal, dates, [sunday]), new Set(['3']));

  // What the union produced, kept so the defect is named rather than merely absent: two
  // whole calendars for one service date, which doubles every pattern's candidate slots.
  assert.deepEqual(activeServiceIds(cal, dates, [holiday, sunday]), new Set(['3', '4']));
});
