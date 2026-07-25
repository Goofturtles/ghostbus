// Unit tests for the riskiest math in the app: America/Toronto DST handling.
// Run with `npm test`. Uses Node's built-in test runner via tsx (no extra deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  offsetSeconds, torontoMidnightEpoch, hourOfWeek, torontoParts, torontoYmd,
  torontoNoonEpoch, serviceEpochSeconds, serviceYmd,
} from './tz.ts';

/** What the (wrong) midnight anchor would have produced, kept only so the tests can
 *  assert the two disagree by exactly an hour on DST days. */
function midnightAnchored(ymd: number, gtfsSeconds: number): number {
  const mid = torontoMidnightEpoch(Math.floor(ymd / 10000), Math.floor(ymd / 100) % 100, ymd % 100);
  return Math.round(mid / 1000) + gtfsSeconds;
}
const wall = (epochS: number): string => {
  const p = torontoParts(epochS * 1000);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
};

test('offset is UTC-5 (EST) in winter', () => {
  // 2026-01-15T12:00:00Z -> 07:00 EST
  assert.equal(offsetSeconds(Date.parse('2026-01-15T12:00:00Z')), -5 * 3600);
});

test('offset is UTC-4 (EDT) in summer', () => {
  // 2026-07-15T12:00:00Z -> 08:00 EDT
  assert.equal(offsetSeconds(Date.parse('2026-07-15T12:00:00Z')), -4 * 3600);
});

test('DST spring-forward boundary is handled by Intl, not a fixed offset', () => {
  // 2021-03-14: clocks jump 02:00 EST -> 03:00 EDT.
  assert.equal(offsetSeconds(Date.parse('2021-03-14T06:30:00Z')), -5 * 3600, 'before jump = EST');
  assert.equal(offsetSeconds(Date.parse('2021-03-14T07:30:00Z')), -4 * 3600, 'after jump = EDT');
});

test('DST fall-back boundary (Nov) is handled by Intl', () => {
  // 2026-11-01: clocks fall back 02:00 EDT -> 01:00 EST (transition at 06:00Z).
  assert.equal(offsetSeconds(Date.parse('2026-11-01T05:30:00Z')), -4 * 3600, 'before fall-back = EDT');
  assert.equal(offsetSeconds(Date.parse('2026-11-01T06:30:00Z')), -5 * 3600, 'after fall-back = EST');
});

test('local midnight epoch lands on 00:00 Toronto', () => {
  const mid = torontoMidnightEpoch(2026, 7, 24);
  const p = torontoParts(mid);
  assert.equal(p.hour, 0);
  assert.equal(p.minute, 0);
  assert.equal(p.second, 0);
  assert.equal(torontoYmd(mid), 20260724);
  // Summer: 00:00 EDT == 04:00Z
  assert.equal(new Date(mid).toISOString(), '2026-07-24T04:00:00.000Z');
});

test('winter local midnight is 05:00Z (EST)', () => {
  const mid = torontoMidnightEpoch(2026, 1, 15);
  assert.equal(new Date(mid).toISOString(), '2026-01-15T05:00:00.000Z');
});

test('hourOfWeek: Monday 00:00 = 0, Sunday 23:00 = 167', () => {
  // 2026-07-27 is a Monday. 00:00 EDT == 2026-07-27T04:00:00Z
  assert.equal(hourOfWeek(Date.parse('2026-07-27T04:00:00Z')), 0);
  // Monday 09:00 EDT == 13:00Z -> 9
  assert.equal(hourOfWeek(Date.parse('2026-07-27T13:00:00Z')), 9);
  // Sunday 2026-08-02 23:00 EDT == 2026-08-03T03:00:00Z -> 6*24+23 = 167
  assert.equal(hourOfWeek(Date.parse('2026-08-03T03:00:00Z')), 167);
});

test('hourOfWeek wraps cleanly from Sunday 23:59 (167) to Monday 00:00 (0)', () => {
  // Sunday 2026-08-02 23:59 EDT == 2026-08-03T03:59:00Z
  assert.equal(hourOfWeek(Date.parse('2026-08-03T03:59:00Z')), 167);
  // The very next hour: Monday 2026-08-03 00:00 EDT == 2026-08-03T04:00:00Z
  assert.equal(hourOfWeek(Date.parse('2026-08-03T04:00:00Z')), 0);
});

// ---------- GTFS service-day anchoring (noon minus 12h) ----------

test('a 9h GTFS time is 09:00 Toronto on BOTH DST transition days', () => {
  // Fall back (2026-11-01) and spring forward (2027-03-14).
  assert.equal(wall(serviceEpochSeconds(20261101, 9 * 3600)), '09:00:00');
  assert.equal(wall(serviceEpochSeconds(20270314, 9 * 3600)), '09:00:00');

  // And this is exactly what midnight-anchoring gets wrong: an hour, the wrong way
  // on each day, for every observation all day long.
  assert.equal(wall(midnightAnchored(20261101, 9 * 3600)), '08:00:00');
  assert.equal(wall(midnightAnchored(20270314, 9 * 3600)), '10:00:00');
  assert.equal(serviceEpochSeconds(20261101, 9 * 3600) - midnightAnchored(20261101, 9 * 3600), 3600);
  assert.equal(serviceEpochSeconds(20270314, 9 * 3600) - midnightAnchored(20270314, 9 * 3600), -3600);
});

test('the DST hour error applies to evening and past-midnight times too', () => {
  assert.equal(wall(serviceEpochSeconds(20261101, 20 * 3600)), '20:00:00');
  assert.equal(wall(serviceEpochSeconds(20270314, 20 * 3600)), '20:00:00');
  // 26h = 02:00 the following calendar day.
  assert.equal(wall(serviceEpochSeconds(20261101, 26 * 3600)), '02:00:00');
  assert.equal(wall(serviceEpochSeconds(20270314, 26 * 3600)), '02:00:00');
  assert.equal(wall(midnightAnchored(20261101, 20 * 3600)), '19:00:00');
  assert.equal(wall(midnightAnchored(20270314, 20 * 3600)), '21:00:00');
});

test('the real maximum GTFS time in our board (110861 = 30:47:41) lands next day', () => {
  const e = serviceEpochSeconds(20260803, 110_861);
  assert.equal(wall(e), '06:47:41');
  assert.equal(torontoYmd(e * 1000), 20260804, 'rolls into the following calendar day');
});

test('on a non-DST date the noon anchor and the midnight anchor agree exactly', () => {
  for (const ymd of [20260724, 20260726, 20260905, 20261225]) {
    for (const s of [0, 9 * 3600, 20 * 3600, 26 * 3600]) {
      assert.equal(serviceEpochSeconds(ymd, s), midnightAnchored(ymd, s), `${ymd}/${s}`);
    }
  }
});

test('torontoNoonEpoch lands on 12:00 local, DST-exact', () => {
  for (const [y, m, d] of [[2026, 11, 1], [2027, 3, 14], [2026, 7, 24], [2026, 1, 15]] as const) {
    const p = torontoParts(torontoNoonEpoch(y, m, d));
    assert.equal(p.hour, 12);
    assert.equal(p.minute, 0);
    assert.equal(p.day, d);
  }
});

test('serviceYmd attaches post-midnight trips to the day that started them', () => {
  // 02:00 EDT on 2026-07-25 -> still the 2026-07-24 service day.
  assert.equal(serviceYmd(Date.parse('2026-07-25T06:00:00Z')), 20260724);
  // 05:00 EDT on 2026-07-25 -> its own service day.
  assert.equal(serviceYmd(Date.parse('2026-07-25T09:00:00Z')), 20260725);
  // 23:00 EDT stays on the same day.
  assert.equal(serviceYmd(Date.parse('2026-07-25T03:00:00Z')), 20260724);
});
