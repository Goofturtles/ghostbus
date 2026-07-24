// Unit tests for Honest-ETA math: percentiles (must match Postgres percentile_cont)
// and evidence-threshold selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentileCont, percentiles, selectEvidence, type Agg } from './eta.ts';

test('percentileCont matches Postgres percentile_cont (linear interpolation)', () => {
  const v = [10, 20, 30, 40];
  assert.equal(percentileCont(v, 0.5), 25);   // rank 1.5 -> 20 + .5*(30-20)
  assert.equal(percentileCont(v, 0.25), 17.5); // rank 0.75 -> 10 + .75*10
  assert.equal(percentileCont(v, 0.75), 32.5); // rank 2.25 -> 30 + .25*10
});

test('percentileCont handles single value and unsorted input', () => {
  assert.equal(percentileCont([42], 0.5), 42);
  assert.equal(percentileCont([40, 10, 30, 20], 0.5), 25); // unsorted -> same as sorted
});

test('percentiles returns null for empty, a triple otherwise', () => {
  assert.equal(percentiles([]), null);
  assert.deepEqual(percentiles([10, 20, 30, 40]), { p25: 17.5, p50: 25, p75: 32.5 });
});

const stop: Agg = { n: 12, p25: 30, p50: 60, p75: 120 };
const route: Agg = { n: 40, p25: 20, p50: 50, p75: 100 };

test('stop-hour bucket is used when n >= 8', () => {
  const e = selectEvidence(stop, route);
  assert.equal(e.bucket, 'stop-hour');
  assert.equal(e.n, 12);
  assert.equal(e.p50, 60);
});

test('falls back to route-hour when stop-hour is below 8 but route-hour >= 20', () => {
  const thin: Agg = { n: 7, p25: 30, p50: 60, p75: 120 };
  const e = selectEvidence(thin, route);
  assert.equal(e.bucket, 'route-hour');
  assert.equal(e.n, 40);
  assert.equal(e.p50, 50);
});

test('exact thresholds: stop n=8 uses stop; route n=20 uses route; below both = none', () => {
  assert.equal(selectEvidence({ n: 8, p25: 1, p50: 2, p75: 3 }, null).bucket, 'stop-hour');
  assert.equal(selectEvidence({ n: 7, p25: 1, p50: 2, p75: 3 }, { n: 20, p25: 1, p50: 2, p75: 3 }).bucket, 'route-hour');
  const none = selectEvidence({ n: 7, p25: 1, p50: 2, p75: 3 }, { n: 19, p25: 1, p50: 2, p75: 3 });
  assert.equal(none.bucket, 'none');
  assert.equal(none.p50, null);
  assert.equal(none.n, 0);
});

test('no evidence at all yields the none bucket with null percentiles', () => {
  const e = selectEvidence(null, null);
  assert.equal(e.bucket, 'none');
  assert.equal(e.p25, null);
  assert.equal(e.p50, null);
  assert.equal(e.p75, null);
});
