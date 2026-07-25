import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates, patternHealthy, type GateInput } from './gates.ts';

function gi(over: Partial<GateInput> = {}): GateInput {
  return {
    boardActive: true,
    boardTag: '20260726..20260905',
    serviceDate: 20260803,
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

test('per-pattern breaker voids only patterns that drifted half a headway', () => {
  assert.equal(patternHealthy(1200, 100), true);
  assert.equal(patternHealthy(1200, 600), true, 'exactly half a headway is still allowed');
  assert.equal(patternHealthy(1200, 601), false);
  // Unknown inputs must not fabricate a failure.
  assert.equal(patternHealthy(null, 900), true);
  assert.equal(patternHealthy(1200, null), true);
});
