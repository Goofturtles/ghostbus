// The compass has one job it must never do: show a direction it does not have. These
// pin the three ways it could — a relative reading, an uncalibrated magnetometer, and a
// device that simply never reports — plus the two arithmetic conversions that are easy
// to get backwards and impossible to notice without a phone in your hand.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compassHeading, __onOrientationForTest as fire, __resetCompassForTest as reset,
} from './useCompassHeading';

/** A reading, shaped like the event the browser delivers. */
function reading(fields: Record<string, unknown>): DeviceOrientationEvent {
  return fields as unknown as DeviceOrientationEvent;
}

/**
 * The smoother is a low-pass, so one event lands only a quarter of the way there. Real
 * use gets events at 60 Hz; these tests just drive it to convergence.
 */
function settle(ev: DeviceOrientationEvent, n = 60): void {
  for (let i = 0; i < n; i++) fire(ev);
}

test.beforeEach(() => {
  reset();
  (globalThis as { screen?: unknown }).screen = { orientation: { angle: 0 } };
});

test('nothing to draw before any reading arrives', () => {
  assert.equal(compassHeading(), null);
});

test('a RELATIVE reading is refused — it is measured from wherever the device booted', () => {
  // The trap: `alpha` is always populated, so a naive handler shows an arrow that looks
  // authoritative and points at nothing. `absolute: false` is the browser telling us so.
  settle(reading({ absolute: false, alpha: 90 }));
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

test('iOS webkitCompassHeading is taken as-is — it is already true-north clockwise', () => {
  settle(reading({ webkitCompassHeading: 137, webkitCompassAccuracy: 15, alpha: 999 }));
  assert.ok(Math.abs(compassHeading()! - 137) < 1, `expected ~137, got ${compassHeading()}`);
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
