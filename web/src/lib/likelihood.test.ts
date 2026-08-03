// The percentage estimator's contract, exercised in plain Node.
//
// Two halves, and the second one matters more than the first: the arithmetic has to be a
// real non-decreasing CDF, AND every gate that turns a percentage back into silence has to
// actually hold. A fabricated 87% is the worst bug this project could ship, so the refusal
// paths are tested as hard as the happy one.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { EtaEvidence, HonestEta } from '@shared/types';
import {
  bandsOf, delayCdf, onTimeLikelihood, connectionLikelihood,
  MIN_OBSERVATIONS, P_FLOOR, P_CEIL, ON_TIME_SEC, type DelayBands,
} from './likelihood.ts';

const SCHED = 1_700_000_000_000;

/** A wire row anchored on SCHED, built the way the server builds one. */
function row(
  p25Sec: number, p50Sec: number, p75Sec: number,
  ev: Partial<EtaEvidence> = {},
): { honest: HonestEta; evidence: EtaEvidence } {
  return {
    honest: {
      estimateMs: SCHED + p50Sec * 1000,
      bandLowMs: SCHED + p25Sec * 1000,
      bandHighMs: SCHED + p75Sec * 1000,
      medianDelaySec: p50Sec,
    },
    evidence: { n: 40, windowDays: 14, bucket: 'stop-hour', ...ev },
  };
}

const bands = (p25: number, p50: number, p75: number, n = 40): DelayBands =>
  ({ p25Sec: p25, p50Sec: p50, p75Sec: p75, n, windowDays: 14, bucket: 'stop-hour' });

// ---------------------------------------------------------------- bandsOf: the gates

test('bandsOf recovers the quantiles a correctly anchored row was built from', () => {
  assert.deepEqual(bandsOf(row(-30, 60, 240), SCHED), {
    p25Sec: -30, p50Sec: 60, p75Sec: 240, n: 40, windowDays: 14, bucket: 'stop-hour',
  });
});

test('bandsOf refuses a row with no evidence bucket — there is no band to read', () => {
  assert.equal(bandsOf(row(-30, 60, 240, { bucket: 'none' }), SCHED), null);
});

test('bandsOf refuses a row whose band fields are absent', () => {
  const r = row(-30, 60, 240);
  assert.equal(bandsOf({ ...r, honest: { ...r.honest, bandLowMs: null } }, SCHED), null);
  assert.equal(bandsOf({ ...r, honest: { ...r.honest, bandHighMs: null } }, SCHED), null);
  assert.equal(bandsOf({ ...r, honest: { ...r.honest, medianDelaySec: null } }, SCHED), null);
  assert.equal(bandsOf({ ...r, honest: { ...r.honest, estimateMs: null } }, SCHED), null);
});

test('bandsOf refuses non-monotonic quantiles rather than sorting them into shape', () => {
  // A corrupt aggregate is not a distribution, and reading one "charitably" would invent
  // a spread nobody measured.
  const r = row(0, 0, 0);
  assert.equal(bandsOf({
    ...r,
    honest: { ...r.honest, bandLowMs: SCHED + 300_000, bandHighMs: SCHED, medianDelaySec: 0 },
  }, SCHED), null);
});

test('bandsOf refuses a mis-anchored row — the p50 identity is the tripwire', () => {
  const r = row(-30, 60, 240);
  // Anchored on the honest estimate instead of the schedule: still finite, still
  // monotonic (-90 <= 60 <= 180), and completely wrong. This is the failure the identity
  // check exists to catch.
  assert.equal(bandsOf(r, SCHED + 60_000), null);
  // One second of slop is tolerated, because both sides round.
  assert.notEqual(bandsOf(r, SCHED + 900), null);
});

test('bandsOf refuses zero/absent samples and windows', () => {
  assert.equal(bandsOf(row(-30, 60, 240, { n: 0 }), SCHED), null);
  assert.equal(bandsOf(row(-30, 60, 240, { n: Number.NaN }), SCHED), null);
  assert.equal(bandsOf(row(-30, 60, 240, { windowDays: 0 }), SCHED), null);
  assert.equal(bandsOf(row(-30, 60, 240, { windowDays: Number.NaN }), SCHED), null);
});

test('bandsOf refuses a non-finite anchor', () => {
  assert.equal(bandsOf(row(-30, 60, 240), Number.NaN), null);
});

// ---------------------------------------------------------------- delayCdf: the knots

test('delayCdf hits the three observed quantiles exactly', () => {
  const b = bands(-30, 60, 240);
  assert.equal(delayCdf(b, -30), 0.25);
  assert.equal(delayCdf(b, 60), 0.5);
  assert.equal(delayCdf(b, 240), 0.75);
});

test('delayCdf interpolates linearly between the knots', () => {
  const b = bands(0, 100, 300);
  assert.equal(delayCdf(b, 50), 0.375);   // halfway p25 -> p50
  assert.equal(delayCdf(b, 200), 0.625);  // halfway p50 -> p75
});

test('delayCdf never claims more than the clamps, however far out the threshold is', () => {
  const b = bands(0, 100, 300);
  assert.equal(delayCdf(b, 10_000), P_CEIL);
  assert.equal(delayCdf(b, -10_000), P_FLOOR);
  // The limits are limits, not bugs: P(delay <= +inf) is the ceiling, not the floor.
  assert.equal(delayCdf(b, Number.POSITIVE_INFINITY), P_CEIL);
  assert.equal(delayCdf(b, Number.NEGATIVE_INFINITY), P_FLOOR);
});

test('delayCdf answers a NaN threshold with the least-confident value, never a high one', () => {
  assert.equal(delayCdf(bands(0, 100, 300), Number.NaN), P_FLOOR);
});

test('delayCdf reads an atom at the HIGHEST level that lands on it', () => {
  // p25 == p50: the sample piles up on one value, and P(D <= that value) includes the
  // whole pile. Reading 0.25 there (and 0.5 one second later) was a 25-point cliff.
  const low = bands(0, 0, 300);
  assert.equal(delayCdf(low, 0), 0.5);
  assert.ok(delayCdf(low, 1) > 0.5);
  assert.ok(delayCdf(low, -1) < 0.25);
  // p50 == p75, the mirror case.
  const high = bands(-300, 0, 0);
  assert.equal(delayCdf(high, 0), 0.75);
  // Approaching the atom from below reaches the level below it, not some value past it.
  assert.ok(delayCdf(high, -1) < 0.5);
});

test('a zero-spread cell reports the two bounds it has, and never the clamps', () => {
  // The clamps are caps on extrapolation, not values. Returning them here produced a
  // 45-point cliff off one second of rounding in the aggregate — (0,0,1) read 0.5 at the
  // atom while (0,0,0) read 0.95. Both now sit in the same neighbourhood.
  const flat = bands(60, 60, 60);
  assert.equal(delayCdf(flat, 59), 0.25);
  assert.equal(delayCdf(flat, 60), 0.75);
  assert.equal(delayCdf(flat, 61), 0.75);

  const nearlyFlat = bands(60, 60, 61);
  assert.equal(delayCdf(nearlyFlat, 60), 0.5);
  assert.ok(Math.abs(delayCdf(flat, 60) - delayCdf(nearlyFlat, 60)) <= 0.25);
});

test('delayCdf is non-decreasing across every legal band shape, knots included', () => {
  const shapes: DelayBands[] = [
    bands(-30, 60, 240), bands(0, 0, 300), bands(-300, 0, 0), bands(60, 60, 60),
    bands(-120, -60, -10), bands(0, 1, 2), bands(-1000, 500, 3600),
  ];
  for (const b of shapes) {
    // The sweep alone steps past most knots (and right-continuity lives exactly AT them),
    // so every quantile and its two neighbours are visited explicitly.
    const probes = new Set<number>();
    for (let sec = -4000; sec <= 4000; sec += 7) probes.add(sec);
    for (const k of [b.p25Sec, b.p50Sec, b.p75Sec]) { probes.add(k - 1); probes.add(k); probes.add(k + 1); }
    let prev = -Infinity;
    for (const sec of [...probes].sort((x, y) => x - y)) {
      const p = delayCdf(b, sec);
      assert.ok(p >= prev - 1e-12, `went backwards at ${sec} on ${JSON.stringify(b)}`);
      assert.ok(p >= P_FLOOR && p <= P_CEIL, `out of clamp at ${sec}: ${p}`);
      prev = p;
    }
  }
});

// ---------------------------------------------------------------- the two public asks

test('onTimeLikelihood measures against the published on-time threshold', () => {
  // p75 = 300 s exactly: three quarters of observed departures were within five minutes.
  const l = onTimeLikelihood(row(-60, 60, ON_TIME_SEC), SCHED);
  assert.ok(l);
  assert.equal(l.kind, 'onTime');
  assert.equal(l.percent, 75);
  assert.equal(l.thresholdSec, ON_TIME_SEC);
  assert.equal(l.n, 40);
  assert.equal(l.windowDays, 14);
  assert.equal(l.bucket, 'stop-hour');
});

test('connectionLikelihood measures leg 1 against the scheduled slack', () => {
  const l = connectionLikelihood(row(0, 120, 480), SCHED, 480);
  assert.ok(l);
  assert.equal(l.kind, 'connection');
  assert.equal(l.percent, 75);
  assert.equal(l.thresholdSec, 480);
  // More slack can only ever help; less can only ever hurt.
  assert.ok(connectionLikelihood(row(0, 120, 480), SCHED, 900)!.p > l.p);
  assert.ok(connectionLikelihood(row(0, 120, 480), SCHED, 60)!.p < l.p);
});

test('a collapsed cell gets no percentage — two bounds are not a distribution', () => {
  // P25 == P75: at these sample sizes almost always the aggregate's own rounding rather
  // than a route of perfect punctuality. Either way the estimator has no shape to read.
  assert.equal(onTimeLikelihood(row(0, 0, 0), SCHED), null);
  assert.equal(connectionLikelihood(row(45, 45, 45), SCHED, 600), null);
  // One second of genuine spread is enough to interpolate, and is admitted.
  assert.ok(onTimeLikelihood(row(0, 0, 1), SCHED));
});

test('a thin sample gets no percentage at all', () => {
  const thin = { n: MIN_OBSERVATIONS - 1 };
  assert.equal(onTimeLikelihood(row(-60, 60, 300, thin), SCHED), null);
  assert.equal(connectionLikelihood(row(-60, 60, 300, thin), SCHED, 480), null);
  // The floor itself is admitted.
  assert.ok(onTimeLikelihood(row(-60, 60, 300, { n: MIN_OBSERVATIONS }), SCHED));
});

test('a schedule-only row gets no percentage at all', () => {
  const none: Partial<EtaEvidence> = { bucket: 'none' };
  assert.equal(onTimeLikelihood(row(-60, 60, 300, none), SCHED), null);
  assert.equal(connectionLikelihood(row(-60, 60, 300, none), SCHED, 480), null);
});

test('a non-finite slack gets no percentage — a missing number is not a threshold', () => {
  assert.equal(connectionLikelihood(row(0, 120, 480), SCHED, Number.NaN), null);
});

test('the printed percent is always a whole number inside the clamps', () => {
  for (const slack of [-9999, -600, -1, 0, 1, 120, 480, 9999]) {
    const l = connectionLikelihood(row(-60, 60, 300), SCHED, slack);
    assert.ok(l);
    assert.equal(l.percent, Math.round(l.percent));
    assert.ok(l.percent >= P_FLOOR * 100 && l.percent <= P_CEIL * 100);
  }
});

test('the route-hour rollup is admitted, and says which bucket it is', () => {
  const l = onTimeLikelihood(row(-60, 60, 300, { bucket: 'route-hour' }), SCHED);
  assert.ok(l);
  assert.equal(l.bucket, 'route-hour');
});
