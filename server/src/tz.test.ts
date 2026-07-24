// Unit tests for the riskiest math in the app: America/Toronto DST handling.
// Run with `npm test`. Uses Node's built-in test runner via tsx (no extra deps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offsetSeconds, torontoMidnightEpoch, hourOfWeek, torontoParts, torontoYmd } from './tz.ts';

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
