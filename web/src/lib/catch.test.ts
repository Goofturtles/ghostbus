// Tests for the Catch verdict — the one function allowed to tell a rider they
// will make it. Every case here is a way of getting that wrong.
//
// NOTE: `npm test` currently globs `server/src/**/*.test.ts` only, so this file
// is not picked up by it yet. It runs today with:
//   node --import tsx --test web/src/lib/catch.test.ts
// Adding `web/src/**/*.test.ts` to the test script (package.json is owned by the
// orchestrator) is all it needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, haversineM, AT_STOP_M, STALE_FIX_MS, COMFORTABLE_SEC } from './catch.ts';

const NOW = 1_784_900_000_000;
const STOP = { lat: 43.645671, lon: -79.395169 };
/** ~208 m due south of STOP: a genuine walk, and the distance the screenshots
 *  were driven at. 0.00187° of latitude is 208 m anywhere. */
const RIDER_FAR = { lat: 43.645671 - 0.00187, lon: -79.395169 };
const PACE = 4.8 / 3.6; // the 'average' profile pace, m/s

const freshFix = { ...STOP, ts: NOW - 30_000 };

function v(over = {}) {
  return computeVerdict({
    nowMs: NOW, rider: RIDER_FAR, stop: STOP, paceMps: PACE,
    arrivalMs: NOW + 10 * 60_000, vehicle: freshFix, ...over,
  });
}

test('the calibration point really is a ~200 m walk', () => {
  const d = haversineM(RIDER_FAR, STOP);
  assert.ok(d > 190 && d < 230, `expected ~208 m, got ${Math.round(d)}`);
});

test('comfortable when the walk fits with room to spare', () => {
  const r = v();
  assert.equal(r.kind, 'comfortable');
  assert.ok((r.bufferSec ?? 0) >= COMFORTABLE_SEC);
  assert.ok(r.leaveByMs != null && r.leaveByMs < NOW + 10 * 60_000);
});

test('tight when the buffer is under two minutes, missed when it is negative', () => {
  const walkSec = v().walkSec as number;
  assert.equal(v({ arrivalMs: NOW + (walkSec + 60) * 1000 }).kind, 'tight');
  assert.equal(v({ arrivalMs: NOW + (walkSec - 30) * 1000 }).kind, 'missed');
});

test('a rider AT the stop can never be told they missed it', () => {
  // Standing on the pole, bus five minutes past its own live prediction.
  const r = v({ rider: STOP, arrivalMs: NOW - 5 * 60_000 });
  assert.equal(r.kind, 'atStop');
  assert.ok((r.distanceM as number) <= AT_STOP_M);
});

test('no rider position yields no verdict, and no walk numbers to imply one', () => {
  const r = v({ rider: null });
  assert.equal(r.kind, 'noGeo');
  assert.equal(r.distanceM, null);
  assert.equal(r.walkSec, null);
  assert.equal(r.bufferSec, null);
});

test('a missing stop position is also noGeo rather than a confident answer', () => {
  assert.equal(v({ stop: null }).kind, 'noGeo');
});

test('not knowing where the RIDER is does not erase what we know about the vehicle', () => {
  const r = v({ rider: null, vehicle: { lat: 43.64, lon: -79.4, ts: NOW - 20_000 } });
  assert.equal(r.kind, 'noGeo');
  assert.ok((r.vehicleDistM as number) > 0, 'the fix is good; only the rider is unknown');
  assert.equal(r.fixAgeSec, 20);
});

test('a trip that left the live board is gone, not late', () => {
  const r = v({ arrivalMs: null });
  assert.equal(r.kind, 'gone');
  assert.equal(r.bufferSec, null);
  // The walk is still known and still true — only the arrival is not.
  assert.ok((r.distanceM as number) > 0);
});

test('a stale fix stops the arithmetic and withholds the vehicle distance', () => {
  const r = v({ vehicle: { ...STOP, ts: NOW - STALE_FIX_MS - 1000 } });
  assert.equal(r.kind, 'unseen');
  assert.equal(r.vehicleDistM, null, 'a position we distrust must not be printed');
  assert.ok((r.fixAgeSec as number) > STALE_FIX_MS / 1000, 'but its age is still reportable');
});

test('a fix exactly at the threshold is still usable', () => {
  assert.equal(v({ vehicle: { ...STOP, ts: NOW - STALE_FIX_MS } }).kind, 'comfortable');
});

test('never having seen a vehicle is unseen with no age to report', () => {
  const r = v({ vehicle: null });
  assert.equal(r.kind, 'unseen');
  assert.equal(r.fixAgeSec, null);
});

test('a down feed invalidates even a brand-new fix', () => {
  const r = v({ feedDown: true });
  assert.equal(r.kind, 'unseen');
  assert.equal(r.vehicleDistM, null);
});

test('a fix stamped in the future is not treated as maximally fresh', () => {
  // The feed stamps positions with the VEHICLE's clock; a skewed one would
  // otherwise sit at "0s ago" for ever and never age out.
  assert.equal(v({ vehicle: { ...STOP, ts: NOW + 120_000 } }).kind, 'unseen');
  // A few seconds of ordinary skew is tolerated rather than punished.
  assert.equal(v({ vehicle: { ...STOP, ts: NOW + 5_000 } }).kind, 'comfortable');
});

test('non-finite inputs degrade to noGeo instead of falling through to comfortable', () => {
  // NaN fails every comparison, so an unguarded path would reach the MOST
  // confident verdict. Each of these must be refused instead.
  assert.equal(v({ rider: { lat: NaN, lon: NaN } }).kind, 'noGeo');
  assert.equal(v({ stop: { lat: 43.6, lon: NaN } }).kind, 'noGeo');
  assert.equal(v({ paceMps: NaN }).kind, 'noGeo');
  assert.equal(v({ paceMps: 0 }).kind, 'noGeo', 'a zero pace would make any walk take zero seconds');
  assert.equal(v({ nowMs: NaN }).kind, 'noGeo');
  assert.equal(v({ arrivalMs: NaN }).kind, 'gone');
});

test('the walk uses the profile pace and the 1.25 route factor, not straight-line time', () => {
  const r = v();
  const straight = (r.distanceM as number) / PACE;
  assert.equal(r.walkSec, Math.round(straight * 1.25));
});

test('a slower pace makes the same catch harder, never easier', () => {
  const fast = v({ paceMps: 6 / 3.6 }).bufferSec as number;
  const slow = v({ paceMps: 3.6 / 3.6 }).bufferSec as number;
  assert.ok(slow < fast);
});
