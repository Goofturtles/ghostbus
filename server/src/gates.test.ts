import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates, patternHealthy, type GateInput } from './gates.ts';
import { crosswalkedStaticSeqs, monotonicityViolations, type XwalkEntry } from './xwalk.ts';

function gi(over: Partial<GateInput> = {}): GateInput {
  return {
    boardActive: true,
    boardTag: '20260726..20260905',
    serviceDate: 20260803,
    activeServiceTripCount: 29_870,
    boardAgreementMedianResidS: 20,
    xwalkOccurrenceCoverage: 0.7,
    crossRouteAgreement: 0.95,
    monotonicityViolationRate: 0.01,
    ...over,
  };
}

test('all gates healthy -> publish, with no reason to report', () => {
  const r = evaluateGates(gi());
  assert.equal(r.publish, true);
  assert.equal(r.reason, null);
  assert.equal(r.failed, null);
});

test('TODAY: an inactive board suppresses everything and names the window', () => {
  const r = evaluateGates(gi({ boardActive: false, serviceDate: 20260724 }));
  assert.equal(r.publish, false);
  assert.equal(r.failed, 'boardActive');
  assert.match(r.reason ?? '', /20260726\.\.20260905/);
  assert.match(r.reason ?? '', /no calendar-active schedule/);
  // The string must be distinguishable from "no data yet" and from a zero delay.
  assert.doesNotMatch(r.reason ?? '', /0 min|no data yet/i);
});

test('crosswalk coverage: 0.49 emits nothing, 0.51 emits', () => {
  const under = evaluateGates(gi({ xwalkOccurrenceCoverage: 0.49 }));
  assert.equal(under.publish, false);
  assert.equal(under.failed, 'xwalkOccurrenceCoverage');
  assert.ok(under.reason);
  assert.equal(evaluateGates(gi({ xwalkOccurrenceCoverage: 0.51 })).publish, true);
  assert.equal(evaluateGates(gi({ xwalkOccurrenceCoverage: 0.50 })).publish, true);
  // Boot state: nothing learned yet is a suppression, not an empty success.
  assert.equal(evaluateGates(gi({ xwalkOccurrenceCoverage: 0 })).publish, false);
});

test('cross-route agreement: 0.84 emits nothing, 0.86 emits', () => {
  assert.equal(evaluateGates(gi({ crossRouteAgreement: 0.84 })).publish, false);
  assert.equal(evaluateGates(gi({ crossRouteAgreement: 0.84 })).failed, 'crossRouteAgreement');
  assert.equal(evaluateGates(gi({ crossRouteAgreement: 0.86 })).publish, true);
  // Not yet measurable is not the same as failing — but it is also not evidence.
  assert.equal(evaluateGates(gi({ crossRouteAgreement: null })).publish, true);
});

test('monotonicity: above 5% of trips visiting stops out of order stops writing', () => {
  assert.equal(evaluateGates(gi({ monotonicityViolationRate: 0.06 })).publish, false);
  assert.equal(evaluateGates(gi({ monotonicityViolationRate: 0.06 })).failed, 'monotonicity');
  assert.equal(evaluateGates(gi({ monotonicityViolationRate: 0.05 })).publish, true);
});

test('board agreement: a 400 s median first-stop residual means different boards', () => {
  const r = evaluateGates(gi({ boardAgreementMedianResidS: 400 }));
  assert.equal(r.publish, false);
  assert.equal(r.failed, 'boardAgreement');
  assert.match(r.reason ?? '', /different boards/);
  // Negative drift is just as wrong as positive drift.
  assert.equal(evaluateGates(gi({ boardAgreementMedianResidS: -400 })).publish, false);
  assert.equal(evaluateGates(gi({ boardAgreementMedianResidS: 300 })).publish, true);
  // No bindings yet -> nothing to conclude, and nothing to fail on.
  assert.equal(evaluateGates(gi({ boardAgreementMedianResidS: null })).publish, true);
});

test('the inactive board is reported ahead of every downstream symptom', () => {
  // With no board there is also no crosswalk and no agreement. The reason the operator
  // needs is the root one, not the four symptoms it causes.
  const r = evaluateGates(gi({
    boardActive: false, xwalkOccurrenceCoverage: 0, crossRouteAgreement: 0, monotonicityViolationRate: 1,
  }));
  assert.equal(r.failed, 'boardActive');
});

test('REGRESSION (BLOCKERS 9): a calendar-active date with no seeded trips is not silence', () => {
  // Measured on the seeded board: seven of its 42 days are calendar-active and hold zero
  // trips — 2026-08-01/08/15/22/29 and 09-05 on service 2 (32,874 trips in the published
  // feed, none loaded) and 2026-08-03 on service 4 (31,295 in the feed, none loaded),
  // because `calendar` is seeded whole while `trips` is seeded through a 7-day window.
  // Those days used to pass every gate and emit nothing, which is indistinguishable from
  // a day on which nothing went wrong.
  const blank = evaluateGates(gi({ serviceDate: 20260801, activeServiceTripCount: 0 }));
  assert.equal(blank.publish, false);
  assert.equal(blank.failed, 'boardIntegrity');
  assert.match(blank.reason ?? '', /20260801/);
  assert.match(blank.reason ?? '', /not seeded/);
  // It must not be confusable with the inactive-board case, which is a different fact.
  assert.notEqual(blank.failed, 'boardActive');

  // A date with no calendar-active service at all is still reported as such, not as a
  // seeding hole — there is nothing missing on a day the agency runs no service.
  assert.equal(evaluateGates(gi({ boardActive: false, activeServiceTripCount: 0 })).failed, 'boardActive');
  // And a properly seeded day is unaffected.
  assert.equal(evaluateGates(gi({ activeServiceTripCount: 1 })).publish, true);
});

test('REGRESSION (BLOCKERS 17): a bad crosswalk trips the monotonicity gate end to end', () => {
  // Build the exact chain runCycle runs: a crosswalk -> static sequences -> violation rate
  // -> evaluateGates. Before the fix runCycle handed the audit its own realtime sequences,
  // so this whole path was pinned at 0 violations and the gate could not fire.
  const staticStops = ['s1', 's2', 's3', 's4', 's5', 's6'];
  const e = (rtStopId: string, stopId: string): XwalkEntry => ({
    rtStopId, stopId, votes: 12, distinctPatterns: 2, geoResidM: null,
    source: 'propagated', state: 'confirmed', confidence: 0.85,
  });
  // Twenty bound trips, one of which has its middle two stops crosswalked in the wrong
  // order — 5% violations, exactly at the limit, so it must NOT fire...
  const healthy = new Map([['a', e('a', 's1')], ['b', e('b', 's2')], ['c', e('c', 's3')]]);
  const broken = new Map([['a', e('a', 's1')], ['b', e('b', 's4')], ['c', e('c', 's2')]]);
  const trips = (nBroken: number, nTotal: number) =>
    Array.from({ length: nTotal }, (_, i) => ({
      staticSeqs: crosswalkedStaticSeqs(['a', 'b', 'c'], staticStops, i < nBroken ? broken : healthy),
    }));

  const atLimit = monotonicityViolations(trips(1, 20));
  assert.equal(atLimit.violations, 1);
  assert.equal(atLimit.rate, 0.05);
  assert.equal(evaluateGates(gi({ monotonicityViolationRate: atLimit.rate })).publish, true);

  // ...and two of twenty is 10%, which must suppress everything and say so.
  const overLimit = monotonicityViolations(trips(2, 20));
  assert.equal(overLimit.rate, 0.10);
  const r = evaluateGates(gi({ monotonicityViolationRate: overLimit.rate }));
  assert.equal(r.publish, false);
  assert.equal(r.failed, 'monotonicity');
  assert.match(r.reason ?? '', /out of order/);

  // And the clean crosswalk must still publish, or the gate is merely noisy.
  assert.equal(monotonicityViolations(trips(0, 20)).violations, 0);
});

test('per-pattern breaker voids only patterns that drifted half a headway', () => {
  assert.equal(patternHealthy(1200, 100), true);
  assert.equal(patternHealthy(1200, 600), true, 'exactly half a headway is still allowed');
  assert.equal(patternHealthy(1200, 601), false);
  // Unknown inputs must not fabricate a failure.
  assert.equal(patternHealthy(null, 900), true);
  assert.equal(patternHealthy(1200, null), true);
});
