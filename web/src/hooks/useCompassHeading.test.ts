// The compass has one job it must never do: show a direction it does not have. These
// pin the ways it could — a relative reading, an uncalibrated magnetometer, a course
// measured at a standstill, a feed that stopped reporting — plus the arithmetic
// conversions that are easy to get backwards and impossible to notice without a phone in
// your hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compassHeading, headingSource, noteGpsFix,
  __onOrientationForTest as fire, __resetCompassForTest as reset,
} from './useCompassHeading';

/** A reading, shaped like the event the browser delivers. */
function reading(fields: Record<string, unknown>): DeviceOrientationEvent {
  return fields as unknown as DeviceOrientationEvent;
}

/** A geolocation fix, shaped like the one a watch delivers. */
function fix(coords: Partial<GeolocationCoordinates>): GeolocationPosition {
  return { coords: { accuracy: 12, ...coords }, timestamp: Date.now() } as unknown as GeolocationPosition;
}

/**
 * The smoother is a low-pass, so one event lands only a quarter of the way there. Real
 * use gets events at 60 Hz; these tests just drive it to convergence.
 */
function settle(ev: DeviceOrientationEvent, n = 60): void {
  for (let i = 0; i < n; i++) fire(ev);
}
function settleFix(pos: GeolocationPosition, n = 60): void {
  for (let i = 0; i < n; i++) noteGpsFix(pos);
}

test.beforeEach(() => {
  reset();
  (globalThis as { screen?: unknown }).screen = { orientation: { angle: 0 } };
  // The GPS-course source is phones-only (rule 3), and `matchMedia` is how that is asked.
  (globalThis as { matchMedia?: unknown }).matchMedia = () => ({ matches: true });
});

test('nothing to draw before any reading arrives', () => {
  assert.equal(compassHeading(), null);
  assert.equal(headingSource(), null);
});

test('a RELATIVE reading is refused — it is measured from wherever the device booted', () => {
  // The trap: `alpha` is always populated, so a naive handler shows an arrow that looks
  // authoritative and points at nothing. `absolute: false` is the browser telling us so.
  settle(reading({ type: 'deviceorientation', absolute: false, alpha: 90 }));
  assert.equal(compassHeading(), null, 'a relative alpha must never become a heading');
});

test('an absolute alpha is INVERTED — alpha counts counter-clockwise, headings clockwise', () => {
  settle(reading({ absolute: true, alpha: 90 }));
  // alpha 90 (a quarter turn counter-clockwise from north) is a heading of 270, WEST.
  // Skipping the inversion yields 90/EAST — a mirror error nobody catches at a desk.
  assert.ok(Math.abs(compassHeading()! - 270) < 1, `expected ~270, got ${compassHeading()}`);
});

test('a landscape phone adds its screen angle back', () => {
  (globalThis as { screen?: unknown }).screen = { orientation: { angle: 90 } };
  settle(reading({ absolute: true, alpha: 0 }));
  // Held in landscape, alpha is measured against a frame that turned with the screen.
  assert.ok(Math.abs(compassHeading()! - 90) < 1, `expected ~90, got ${compassHeading()}`);
});

test('ANDROID: `deviceorientationabsolute` qualifies on its own name, flag or no flag', () => {
  // The Samsung bug. Chrome fires the earth-referenced feed as a separate EVENT TYPE, and
  // an implementation that omits the now-redundant `absolute` flag on it used to publish
  // nothing at all — so the wedge never appeared on Android. The event's name is the
  // absolute claim; the honesty rule is unchanged, only the way it is read.
  settle(reading({ type: 'deviceorientationabsolute', alpha: 90 }));
  assert.ok(Math.abs(compassHeading()! - 270) < 1, `expected ~270, got ${compassHeading()}`);
  assert.equal(headingSource(), 'absolute');
});

test('the RELATIVE event stays refused even once the absolute one is understood', () => {
  // Chrome fires BOTH feeds. Widening the absolute test must not widen this one.
  settle(reading({ type: 'deviceorientation', absolute: false, alpha: 90 }));
  assert.equal(compassHeading(), null);
});

test('iOS webkitCompassHeading is taken as-is — it is already true-north clockwise', () => {
  settle(reading({ webkitCompassHeading: 137, webkitCompassAccuracy: 15, alpha: 999 }));
  assert.ok(Math.abs(compassHeading()! - 137) < 1, `expected ~137, got ${compassHeading()}`);
  assert.equal(headingSource(), 'ios');
});

test('an UNCALIBRATED iOS magnetometer is refused — negative accuracy is not a direction', () => {
  settle(reading({ webkitCompassHeading: 137, webkitCompassAccuracy: -1 }));
  assert.equal(compassHeading(), null, 'negative accuracy means the value is meaningless');
});

test('smoothing averages as a VECTOR, so north does not swing through south', () => {
  // The bug this exists for: the arithmetic mean of 359 and 1 is 180 — the wedge would
  // flip to point backwards every time the rider faced north.
  settle(reading({ absolute: true, alpha: 1 }));    // heading 359
  for (let i = 0; i < 30; i++) fire(reading({ absolute: true, alpha: 359 })); // heading 1
  const h = compassHeading()!;
  const distanceFromNorth = Math.min(h, 360 - h);
  assert.ok(distanceFromNorth < 20, `expected a heading near north, got ${h}`);
});

test('a non-finite reading changes nothing rather than poisoning the filter', () => {
  settle(reading({ absolute: true, alpha: 90 }));
  const before = compassHeading();
  fire(reading({ absolute: true, alpha: Number.NaN }));
  assert.equal(compassHeading(), before, 'NaN must not reach the smoother');
});

// ---------------------------------------------------------------------------------
// the third source: course over ground, for the phones with no magnetometer at all
// ---------------------------------------------------------------------------------

test('a MOVING rider with no compass gets their real course over ground', () => {
  settleFix(fix({ heading: 42, speed: 1.4 }));
  assert.ok(Math.abs(compassHeading()! - 42) < 1, `expected ~42, got ${compassHeading()}`);
  assert.equal(headingSource(), 'gpsCourse');
});

test('a STANDING rider gets no wedge — a course at a standstill is GPS noise', () => {
  settleFix(fix({ heading: 42, speed: 0.1 }));
  assert.equal(compassHeading(), null, 'below walking pace the course is not a direction');
});

test('a device that reports no course at all publishes nothing', () => {
  settleFix(fix({ heading: null, speed: 3 }));
  assert.equal(compassHeading(), null);
});

test('stopping RETRACTS a course already on screen', () => {
  // Otherwise the last direction of travel stands in for a rider who has since turned
  // around on the spot — a stale claim, which is the same defect as a relative alpha.
  settleFix(fix({ heading: 42, speed: 1.4 }));
  assert.equal(headingSource(), 'gpsCourse');
  noteGpsFix(fix({ heading: 42, speed: 0 }));
  assert.equal(compassHeading(), null);
});

test('the MAGNETOMETER wins over a course — facing is the question, not travelling', () => {
  settleFix(fix({ heading: 42, speed: 5 }));
  settle(reading({ type: 'deviceorientationabsolute', alpha: 90 }));
  assert.equal(headingSource(), 'absolute');
  assert.ok(Math.abs(compassHeading()! - 270) < 1, `expected ~270, got ${compassHeading()}`);
});

test('a compass feed that STOPS expires rather than leaving a stale wedge', () => {
  const realNow = Date.now;
  try {
    settle(reading({ absolute: true, alpha: 90 }));
    assert.ok(compassHeading() != null);
    Date.now = () => realNow() + 6_000; // past MAG_STALE_MS
    assert.equal(compassHeading(), null, 'a heading is a claim about NOW');
  } finally {
    Date.now = realNow;
  }
});

test('a stale magnetometer falls back to a still-fresh course rather than to nothing', () => {
  const realNow = Date.now;
  try {
    settleFix(fix({ heading: 200, speed: 4 }));
    settle(reading({ absolute: true, alpha: 90 }));
    assert.equal(headingSource(), 'absolute');
    Date.now = () => realNow() + 6_000; // magnetometer stale, GPS course is not
    assert.equal(headingSource(), 'gpsCourse');
    assert.ok(Math.abs(compassHeading()! - 200) < 1, `expected ~200, got ${compassHeading()}`);
  } finally {
    Date.now = realNow;
  }
});
