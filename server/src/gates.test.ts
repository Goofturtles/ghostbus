import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGates, patternHealthy,
  MIN_IDENTITY_MEMBERSHIP, MIN_IDENTITY_GEO_AGREEMENT, MIN_IDENTITY_GEO_SAMPLES,
  type GateInput,
} from './gates.ts';
import { crosswalkedStaticSeqs, monotonicityViolations, type XwalkEntry } from './xwalk.ts';

function gi(over: Partial<GateInput> = {}): GateInput {
  return {
    boardActive: true,
    boardTag: '20260726..20260905',
    serviceDate: 20260803,
    activeServiceTripCount: 29_870,
    boardAgreementMedianResidS: 20,
    // The default is a LEARNED agency (the TTC): the identity gate does not apply, and
    // every pre-identity test below is exercising exactly the evaluation it always did.
    identity: null,
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

// ---------------------------------------------------------------------------------
// identityVerified — the gate ADDED for identity-namespace agencies. Gates are a ratchet:
// adding one is permitted, weakening one is not, and these constants are pinned here for
// the same reason agencies.test.ts pins the original five.
// ---------------------------------------------------------------------------------

test('GUARD: the identityVerified constants are unchanged', () => {
  assert.equal(MIN_IDENTITY_MEMBERSHIP, 0.95, 'identity membership floor moved');
  assert.equal(MIN_IDENTITY_GEO_AGREEMENT, 0.85, 'identity geometric-agreement floor moved');
  assert.equal(MIN_IDENTITY_GEO_SAMPLES, 3, 'identity geometric sample floor moved');
});

/** A fully-verified identity input: full membership, ample agreeing geometry. */
const verified = { membershipRate: 1.0, geoAgree: 10, geoTotal: 10 };

test('identityVerified: a learned agency (identity: null) is never judged by this gate', () => {
  // gi() defaults identity to null and the healthy case publishes — asserted at the top of
  // this file. What must ALSO hold: no identity failure string can ever name a learned run.
  const r = evaluateGates(gi({ identity: null, xwalkOccurrenceCoverage: 0.49 }));
  assert.equal(r.failed, 'xwalkOccurrenceCoverage', 'a learned agency fails its own gates, never identity');
});

test('identityVerified: a verified identity agency publishes', () => {
  const r = evaluateGates(gi({ identity: verified }));
  assert.equal(r.publish, true);
  assert.equal(r.failed, null);
});

test('identityVerified: membership below the floor names the namespace, not a symptom', () => {
  // 0.593 is the TTC's measured COINCIDENTAL global id overlap (METHODS §3.2) — exactly
  // the rate a feed that silently changed namespace could still reach by numeric accident,
  // and exactly what the 0.95 floor exists to exclude.
  const r = evaluateGates(gi({ identity: { ...verified, membershipRate: 0.593 } }));
  assert.equal(r.publish, false);
  assert.equal(r.failed, 'identityVerified');
  assert.match(r.reason ?? '', /namespace/);
  assert.equal(evaluateGates(gi({ identity: { ...verified, membershipRate: 0.94 } })).publish, false);
  assert.equal(evaluateGates(gi({ identity: { ...verified, membershipRate: 0.95 } })).publish, true);
});

test('identityVerified: no occurrences yet is unverified, never verified-by-vacuum', () => {
  const r = evaluateGates(gi({ identity: { membershipRate: null, geoAgree: 10, geoTotal: 10 } }));
  assert.equal(r.publish, false);
  assert.equal(r.failed, 'identityVerified');
});

test('identityVerified: the geometric audit must have run, and it must agree', () => {
  // Too few anchors checked: the claim is not yet earned, whatever the membership says.
  const thin = evaluateGates(gi({ identity: { membershipRate: 1.0, geoAgree: 2, geoTotal: 2 } }));
  assert.equal(thin.publish, false);
  assert.equal(thin.failed, 'identityVerified');
  assert.match(thin.reason ?? '', /still verifying/);
  // Enough anchors, but they contradict the claim: 2 of 3 agreeing is 66.7%, under 85%.
  const contradicted = evaluateGates(gi({ identity: { membershipRate: 1.0, geoAgree: 2, geoTotal: 3 } }));
  assert.equal(contradicted.publish, false);
  assert.equal(contradicted.failed, 'identityVerified');
  assert.match(contradicted.reason ?? '', /contradict/);
  // Exactly at both floors publishes: 3 of 3 is 100%.
  assert.equal(evaluateGates(gi({ identity: { membershipRate: 1.0, geoAgree: 3, geoTotal: 3 } })).publish, true);
});

test('identityVerified sits after boardIntegrity and before the coverage symptom it causes', () => {
  const bad = { membershipRate: 0.1, geoAgree: 0, geoTotal: 0 };
  // A board hole is the root cause and wins the reason string...
  assert.equal(
    evaluateGates(gi({ activeServiceTripCount: 0, identity: bad })).failed,
    'boardIntegrity');
  // ...and a failed identity assumption ALSO reads as zero coverage, so it must be the
  // gate that names itself first.
  assert.equal(
    evaluateGates(gi({ identity: bad, xwalkOccurrenceCoverage: 0 })).failed,
    'identityVerified');
});

test('per-pattern breaker voids only patterns that drifted half a headway', () => {
  assert.equal(patternHealthy(1200, 100), true);
  assert.equal(patternHealthy(1200, 600), true, 'exactly half a headway is still allowed');
  assert.equal(patternHealthy(1200, 601), false);
  // Unknown inputs must not fabricate a failure.
  assert.equal(patternHealthy(null, 900), true);
  assert.equal(patternHealthy(1200, null), true);
});
