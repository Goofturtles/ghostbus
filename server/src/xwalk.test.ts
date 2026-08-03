import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  metres, nearestStopOnRoute, mergeRtTrip, resolvePatterns, promotionState,
  xwalkConfidence, usableForDelay, crossRouteAgreement, monotonicityViolations,
  crosswalkedStaticSeqs, corroboratedConfidence, XWALK_MIN_CONFIDENCE,
  structurallyAmbiguousStops, MIN_VALIDATING_BINDINGS, MIN_VALIDATING_CYCLES,
  createPatternCreditStore, validationSufficient,
  type RtPattern, type StaticPatternLite, type XwalkEntry,
} from './xwalk.ts';
import { dedupeByKey } from './engine.ts';

// A degree of latitude is ~111,320 m; place test stops by offsetting metres directly.
const LAT0 = 43.70, LON0 = -79.40;
const atMetres = (stopId: string, north: number): { stopId: string; lat: number; lon: number } =>
  ({ stopId, lat: LAT0 + north / 111_320, lon: LON0 });

const seq = (...pairs: Array<[number, string]>): Map<number, string> => new Map(pairs);

// ---------- geometry ----------

test('nearestStopOnRoute accepts a clean anchor and rejects both failure modes', () => {
  // Clean: 19 m away, next-nearest 65 m further.
  const clean = [atMetres('S1', 19), atMetres('S2', 19 + 65)];
  const hit = nearestStopOnRoute(LAT0, LON0, clean);
  assert.ok(hit);
  assert.equal(hit.stopId, 'S1');
  assert.ok(Math.abs(hit.distM - 19) < 0.5, `distM ${hit.distM}`);
  assert.ok(Math.abs(hit.gapM - 65) < 0.5, `gapM ${hit.gapM}`);

  // Too far: 95 m from the nearest stop on this route means the bus is not at it.
  assert.equal(nearestStopOnRoute(LAT0, LON0, [atMetres('S1', 95), atMetres('S2', 400)]), null);

  // TERMINAL-BAY AMBIGUITY: 20 m away but the runner-up is only 8 m further. Picking the
  // nearer by a hair would bind a whole pattern to the wrong bay.
  assert.equal(nearestStopOnRoute(LAT0, LON0, [atMetres('S1', 20), atMetres('S2', 28)]), null);

  assert.equal(nearestStopOnRoute(LAT0, LON0, []), null);
  // A lone candidate has no runner-up to be ambiguous with.
  assert.ok(nearestStopOnRoute(LAT0, LON0, [atMetres('S1', 20)]));
});

test('metres is symmetric and zero at identity', () => {
  assert.equal(metres(LAT0, LON0, LAT0, LON0), 0);
  assert.ok(Math.abs(metres(LAT0, LON0, LAT0 + 100 / 111_320, LON0) - 100) < 0.01);
});

// ---------- pattern merge ----------

test('THE ROUTE-52 REGRESSION: a merge may not exceed the route\'s longest static pattern', () => {
  // A short-turn (sequences 1..40) and a full run (36..78) agree on their shared prefix
  // 36..40, so the naive "every shared sequence agrees" rule fuses them into a phantom
  // pattern of maxSeq 78 — longer than anything the route actually runs.
  const shortTurn = seq(...Array.from({ length: 40 }, (_, i) => [i + 1, `X${i + 1}`] as [number, string]));
  const fullRun = seq(...Array.from({ length: 43 }, (_, i) => [i + 36, `X${i + 36}`] as [number, string]));

  const capped: RtPattern[] = [];
  mergeRtTrip(capped, '52', shortTurn, { maxStaticLen: 73 });
  const second = mergeRtTrip(capped, '52', fullRun, { maxStaticLen: 73 });
  assert.equal(second.kind, 'created', 'the over-length union must not merge');
  assert.equal(capped.length, 2, 'two separate RT patterns, not one phantom');

  // Control: with no cap the naive rule does exactly the wrong thing, which is why the
  // cap is not optional.
  const uncapped: RtPattern[] = [];
  mergeRtTrip(uncapped, '52', shortTurn, { maxStaticLen: null });
  mergeRtTrip(uncapped, '52', fullRun, { maxStaticLen: null });
  assert.equal(uncapped.length, 1);
  assert.equal(uncapped[0].maxSeq, 78);
});

test('a 1-2 stop newborn must not fuse two distinct patterns', () => {
  const patterns: RtPattern[] = [];
  mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']), { maxStaticLen: 20 });
  mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B'], [3, 'Q'], [4, 'Z']), { maxStaticLen: 20 });
  assert.equal(patterns.length, 2, 'the two branches diverge at sequence 3');

  // A newborn publishing only {1:A, 2:B} agrees with BOTH — it must not pick one.
  const out = mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B']), { maxStaticLen: 20 });
  assert.equal(out.kind, 'created');
  assert.equal(patterns.length, 3);
});

test('trips agreeing on >= 3 shared sequences DO merge, and the union is kept', () => {
  const patterns: RtPattern[] = [];
  mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B'], [3, 'C']), { maxStaticLen: 20 });
  // Three shared sequences (1,2,3) clears the floor; 4 and 5 extend the pattern.
  const out = mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B'], [3, 'C'], [4, 'D'], [5, 'E']), { maxStaticLen: 20 });
  assert.equal(out.kind, 'extended');
  assert.equal(patterns.length, 1);
  assert.deepEqual([...patterns[0].seqStops.entries()].sort((a, b) => a[0] - b[0]),
    [[1, 'A'], [2, 'B'], [3, 'C'], [4, 'D'], [5, 'E']]);
  assert.equal(patterns[0].maxSeq, 5);
  assert.equal(patterns[0].nTrips, 2);
});

test('one disagreeing shared sequence blocks the merge outright', () => {
  const patterns: RtPattern[] = [];
  mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B'], [3, 'C'], [4, 'D']), { maxStaticLen: 20 });
  mergeRtTrip(patterns, 'R', seq([1, 'A'], [2, 'B'], [3, 'C'], [4, 'WRONG']), { maxStaticLen: 20 });
  assert.equal(patterns.length, 2);
});

test('two identical newborn stop maps are one pattern, not a duplicate identity', () => {
  const patterns: RtPattern[] = [];
  const a = mergeRtTrip(patterns, 'R', seq([1, 'A']), { maxStaticLen: 20 });
  const b = mergeRtTrip(patterns, 'R', seq([1, 'A']), { maxStaticLen: 20 });
  assert.equal(a.kind, 'created');
  assert.equal(b.kind, 'merged');
  assert.equal(patterns.length, 1, 'identical content must not produce two objects sharing one hash');
  assert.equal(patterns[0].nTrips, 2);
});

test('the per-route pattern cap is enforced and reported, not silently exceeded', () => {
  const patterns: RtPattern[] = [];
  for (let i = 0; i < 3; i++) mergeRtTrip(patterns, 'R', seq([1, `S${i}`]), { maxStaticLen: 20, maxPatternsPerRoute: 3 });
  const out = mergeRtTrip(patterns, 'R', seq([1, 'S99']), { maxStaticLen: 20, maxPatternsPerRoute: 3 });
  assert.equal(out.kind, 'capped');
  assert.equal(out.pattern, null);
  assert.equal(patterns.length, 3);
});

// ---------- resolution ----------

function pat(id: string, routeId: string, stops: Array<[number, string]>): RtPattern {
  return { rtPatternId: id, routeId, seqStops: new Map(stops), maxSeq: Math.max(...stops.map((s) => s[0])), nTrips: 1 };
}
const staticPat = (patternId: string, stops: string[]): StaticPatternLite => ({ patternId, stops });

test('FIXPOINT PROPAGATION: a pattern with no geometric anchors resolves off another one', () => {
  // Pattern A has 2 geometric anchors. Pattern B has none, but shares two rt stops with A.
  const A = pat('A', 'R', [[1, 'rt1'], [2, 'rt2'], [3, 'rt3'], [4, 'rt4']]);
  const B = pat('B', 'R', [[1, 'rt1'], [2, 'rt2'], [3, 'rt3'], [4, 'rt4']]);
  B.rtPatternId = 'B';
  const byRoute = new Map([['R', [staticPat('SP1', ['s1', 's2', 's3', 's4'])]]]);
  const geo = new Map([['R|rt1', 's1'], ['R|rt2', 's2']]);

  // With only A present, A resolves at iteration 0 from geometry alone.
  const first = resolvePatterns([A], byRoute, geo, new Map());
  assert.equal(first.resolved.get('A')?.iter, 0);
  assert.equal(first.learned.get('rt3'), 's3', 'resolving A publishes the stops it implies');

  // B alone, with NO geometric anchors, cannot resolve.
  const bAlone = resolvePatterns([B], byRoute, new Map(), new Map());
  assert.equal(bAlone.resolved.has('B'), false);
  assert.equal(bAlone.states.get('B'), 'unresolved');

  // B alone, seeded with the crosswalk A produced, resolves — that is the propagation.
  const bSeeded = resolvePatterns([B], byRoute, new Map(), first.learned);
  assert.equal(bSeeded.resolved.get('B')?.staticPatternId, 'SP1');
});

test('propagation walks a chain across ITERATIONS, which is the whole point of the fixpoint', () => {
  // A is geo-anchored. B overlaps A by two stops. C overlaps only B by two stops.
  // Presented in reverse order so neither B nor C can resolve on the first sweep, which
  // is exactly the case a single non-iterated pass would leave on the table.
  const A = pat('A', 'R', [[1, 'rt1'], [2, 'rt2'], [3, 'rt3'], [4, 'rt4']]);
  const B = pat('B', 'R', [[3, 'rt3'], [4, 'rt4'], [5, 'rt5'], [6, 'rt6']]);
  const C = pat('C', 'R', [[5, 'rt5'], [6, 'rt6'], [7, 'rt7']]);
  const stops = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const byRoute = new Map([['R', [staticPat('SP1', stops)]]]);
  const geo = new Map([['R|rt1', 's1'], ['R|rt2', 's2']]);

  const r = resolvePatterns([C, B, A], byRoute, geo, new Map());
  assert.equal(r.resolved.get('A')?.iter, 0, 'geometry resolves A immediately');
  assert.equal(r.resolved.get('B')?.iter, 1, 'B needs A\'s output, so it waits a sweep');
  assert.equal(r.resolved.get('C')?.iter, 2, 'C needs B\'s output, so it waits another');
  assert.equal(r.learned.get('rt7'), 's7', 'a stop no vehicle was ever seen at is now known');

  // A single non-iterating pass would have resolved only A — this is the measured gain.
  const onePass = resolvePatterns([C, B, A], byRoute, geo, new Map(), { maxIters: 1 });
  assert.equal(onePass.resolved.size, 1);

  // The loop stopped on a no-progress sweep rather than exhausting its budget.
  assert.ok(r.iterations < 8);
  assert.equal(r.newlyResolvedPerIter[r.newlyResolvedPerIter.length - 1], 0);
});

test('AMBIGUITY IS JUDGED ON THE IMPLIED CROSSWALK, not on pattern identity', () => {
  const P = pat('P', 'R', [[1, 'rt1'], [2, 'rt2'], [3, 'rt3']]);
  const geo = new Map([['R|rt1', 's1'], ['R|rt2', 's2']]);

  // Two surviving candidates that agree everywhere P has a stop: the choice is immaterial.
  const agreeing = new Map([['R', [staticPat('SP1', ['s1', 's2', 's3']), staticPat('SP2', ['s1', 's2', 's3', 's9'])]]]);
  const ok = resolvePatterns([P], agreeing, geo, new Map());
  assert.equal(ok.states.get('P'), 'resolved');
  assert.equal(ok.learned.get('rt3'), 's3');

  // Two candidates that differ at sequence 3: stay silent, and write no crosswalk at all.
  const differing = new Map([['R', [staticPat('SP1', ['s1', 's2', 's3']), staticPat('SP2', ['s1', 's2', 'sX'])]]]);
  const amb = resolvePatterns([P], differing, geo, new Map());
  assert.equal(amb.states.get('P'), 'ambiguous');
  assert.equal(amb.learned.size, 0, 'an ambiguous pattern must not publish stop identities');
});

test('the hard anchor constraint eliminates a candidate that misses ONE anchor', () => {
  const P = pat('P', 'R', [[1, 'rt1'], [2, 'rt2'], [3, 'rt3']]);
  const geo = new Map([['R|rt1', 's1'], ['R|rt2', 's2'], ['R|rt3', 's3']]);
  // SP2 matches anchors 1 and 3 but not 2. One violation is enough.
  const byRoute = new Map([['R', [staticPat('SP2', ['s1', 'sZ', 's3'])]]]);
  const r = resolvePatterns([P], byRoute, geo, new Map());
  assert.equal(r.states.get('P'), 'no_candidate');
  assert.equal(r.resolved.size, 0);
  assert.equal(r.learned.size, 0);
});

test('fewer than two anchors leaves a pattern unresolved rather than guessing', () => {
  const P = pat('P', 'R', [[1, 'rt1'], [2, 'rt2']]);
  const byRoute = new Map([['R', [staticPat('SP1', ['s1', 's2'])]]]);
  const r = resolvePatterns([P], byRoute, new Map([['R|rt1', 's1']]), new Map());
  assert.equal(r.states.get('P'), 'unresolved');
  assert.equal(r.resolved.size, 0);
});

test('two resolutions disagreeing about one rt stop mark it conflicted, not "latest wins"', () => {
  // Two routes' patterns share rt stop 'rtX' but imply different static stops for it.
  const A = pat('A', 'R1', [[1, 'a1'], [2, 'a2'], [3, 'rtX']]);
  const B = pat('B', 'R2', [[1, 'b1'], [2, 'b2'], [3, 'rtX']]);
  const byRoute = new Map<string, StaticPatternLite[]>([
    ['R1', [staticPat('SP1', ['s1', 's2', 'sHERE'])]],
    ['R2', [staticPat('SP2', ['t1', 't2', 'sTHERE'])]],
  ]);
  const geo = new Map([['R1|a1', 's1'], ['R1|a2', 's2'], ['R2|b1', 't1'], ['R2|b2', 't2']]);
  const r = resolvePatterns([A, B], byRoute, geo, new Map());
  assert.ok(r.conflicted.has('rtX'));
  assert.equal(r.learned.has('rtX'), false, 'a conflicted stop must never back a delay row');
});

// ---------- promotion, confidence, audits ----------

test('promotion: one propagated pattern stays candidate, two agreeing patterns confirm', () => {
  assert.equal(promotionState(1, 'propagated', null, false), 'candidate');
  assert.equal(promotionState(2, 'propagated', null, false), 'confirmed');
  // A geometric anchor whose own centroid sits on the stop self-confirms.
  assert.equal(promotionState(1, 'geo', 20, false), 'confirmed');
  assert.equal(promotionState(1, 'geo', 90, false), 'candidate');
  // A conflict overrides everything, at any vote count.
  assert.equal(promotionState(9, 'geo', 5, true), 'conflicted');
});

// ---------- the second promotion path (DECISIONS §46) ----------

const VALID = { bindings: MIN_VALIDATING_BINDINGS, cycles: MIN_VALIDATING_CYCLES };

test('SECOND PATH: one pattern plus a time-domain-validated pattern confirms', () => {
  // The first path still needs two patterns; the second needs one pattern whose
  // assignment surviving bindings have independently corroborated against the schedule.
  assert.equal(promotionState(1, 'propagated', null, false), 'candidate');
  assert.equal(promotionState(1, 'propagated', null, false, VALID, false), 'confirmed');
});

test('SECOND PATH: both thresholds are floors, and either one alone is not enough', () => {
  const under = (b: number, c: number) =>
    promotionState(1, 'propagated', null, false, { bindings: b, cycles: c }, false);
  assert.equal(under(MIN_VALIDATING_BINDINGS - 1, MIN_VALIDATING_CYCLES), 'candidate');
  assert.equal(under(MIN_VALIDATING_BINDINGS, MIN_VALIDATING_CYCLES - 1), 'candidate');
  assert.equal(under(MIN_VALIDATING_BINDINGS, MIN_VALIDATING_CYCLES), 'confirmed');
  // Many bindings inside a single cycle are one line of evidence, not many: the cycle
  // floor is what stops one busy minute from confirming a whole pattern's stops.
  assert.equal(under(50, 1), 'candidate');
});

test('SECOND PATH: no pattern at all is never promoted, however many bindings agree', () => {
  // distinctPatterns 0 means nothing on the board implies this identity. A binding
  // validates a PATTERN; with no pattern there is nothing for it to validate.
  assert.equal(promotionState(0, 'propagated', null, false, { bindings: 99, cycles: 99 }, false), 'candidate');
});

test('SECOND PATH: THE ADJACENT-PLATFORM CASE — a structurally ambiguous stop refuses', () => {
  // 1037 and 1036 across the street from each other, both served the same direction. This
  // is the case DECISIONS §35 refused the whole relaxation over, and it is why the path
  // carries a structural condition rather than a direction check: measured on the live
  // board, direction_id separates only 79.19% of adjacent same-route pairs.
  assert.equal(promotionState(1, 'propagated', null, false, VALID, true), 'candidate');
  // …and no amount of validation buys past it.
  assert.equal(promotionState(1, 'propagated', null, false, { bindings: 500, cycles: 500 }, true), 'candidate');
  // The first two paths are unaffected — they never rested on this argument.
  assert.equal(promotionState(2, 'propagated', null, false, null, true), 'confirmed');
  assert.equal(promotionState(1, 'geo', 20, false, null, true), 'confirmed');
});

test('SECOND PATH: a conflict still overrides validation, as it overrides everything', () => {
  assert.equal(promotionState(1, 'propagated', null, true, VALID, false), 'conflicted');
  assert.equal(promotionState(9, 'geo', 5, true, VALID, false), 'conflicted');
});

test('structurallyAmbiguousStops flags same-direction neighbours and nothing else', () => {
  const dirs = (m: Record<string, Array<number | null>>): Map<string, Set<number | null>> =>
    new Map(Object.entries(m).map(([k, v]) => [k, new Set(v)]));

  // Across the street, SAME direction — indistinguishable. Both are flagged.
  assert.deepEqual(
    [...structurallyAmbiguousStops(
      new Map([['R1', [atMetres('s1', 0), atMetres('s2', 25)]]]),
      dirs({ s1: [0], s2: [0] }),
    )].sort(),
    ['s1', 's2'],
  );
  // Across the street, OPPOSITE directions — this is the normal pair, and it is safe.
  assert.equal(
    structurallyAmbiguousStops(
      new Map([['R1', [atMetres('s1', 0), atMetres('s2', 25)]]]),
      dirs({ s1: [0], s2: [1] }),
    ).size, 0,
  );
  // Same direction but a real block apart — not confusable.
  assert.equal(
    structurallyAmbiguousStops(
      new Map([['R1', [atMetres('s1', 0), atMetres('s2', 300)]]]),
      dirs({ s1: [0], s2: [0] }),
    ).size, 0,
  );
  // A stop served in BOTH directions shares a direction with each neighbour, so a
  // terminal loop where one platform does both ways is correctly flagged.
  assert.equal(
    structurallyAmbiguousStops(
      new Map([['R1', [atMetres('s1', 0), atMetres('s2', 25)]]]),
      dirs({ s1: [0, 1], s2: [1] }),
    ).size, 2,
  );
  // Different routes never make each other ambiguous, however close they are.
  assert.equal(
    structurallyAmbiguousStops(
      new Map([['R1', [atMetres('s1', 0)]], ['R2', [atMetres('s2', 25)]]]),
      dirs({ s1: [0], s2: [0] }),
    ).size, 0,
  );
});

// ---------- the credit store: three rules that were wrong in the first draft ----------

test('CREDIT: two bindings across two cycles validate; either alone does not', () => {
  const s = createPatternCreditStore();
  s.credit('P', 't1', 1);
  assert.equal(validationSufficient(s.validation(['P'])), false, 'one binding, one cycle');
  s.credit('P', 't2', 1);
  assert.equal(validationSufficient(s.validation(['P'])), false, 'two bindings, still ONE cycle');
  s.credit('P', 't2', 2);
  assert.equal(validationSufficient(s.validation(['P'])), true);
});

test('CREDIT: a voided binding takes its CYCLES with it, not just its count', () => {
  // The first draft counted cycles per pattern, so cycles contributed by a binding the
  // audits later threw out kept propping up the two-cycle floor. Here t1 supplies both
  // cycles and is then voided; t2 and t3 arrive together in a single later cycle. Two
  // surviving bindings, but only one cycle between them — that must not validate.
  const s = createPatternCreditStore();
  s.credit('P', 't1', 1);
  s.credit('P', 't1', 2);
  s.retractTrip('P', 't1');
  s.credit('P', 't2', 7);
  s.credit('P', 't3', 7);
  assert.deepEqual(s.validation(['P']), { bindings: 2, cycles: 1 });
  assert.equal(validationSufficient(s.validation(['P'])), false);
});

test('CREDIT: a distrusted pattern can never be credited again, in any order', () => {
  // The consistency gate fires mid-pass; sibling bindings on the same pattern are settled
  // AFTER it in the same loop. Deleting the credit was not enough — they put it back.
  const s = createPatternCreditStore();
  s.credit('P', 't1', 1);
  s.credit('P', 't2', 2);
  assert.equal(validationSufficient(s.validation(['P'])), true);
  s.distrust('P');
  assert.equal(s.validation(['P']), null);
  s.credit('P', 't3', 3);   // the sibling, reached later in the same settle pass
  s.credit('P', 't4', 4);
  assert.equal(s.validation(['P']), null, 'distrust is permanent, not a one-off deletion');
});

test('CREDIT: validation is read off ONE pattern, never assembled from several', () => {
  // P has many bindings in one cycle; Q has one binding across many. Neither clears both
  // floors, and combining their best halves would invent a strength neither has.
  const s = createPatternCreditStore();
  s.credit('P', 't1', 1); s.credit('P', 't2', 1); s.credit('P', 't3', 1);
  s.credit('Q', 'u1', 1); s.credit('Q', 'u1', 2);
  assert.deepEqual(s.validation(['P']), { bindings: 3, cycles: 1 });
  assert.deepEqual(s.validation(['Q']), { bindings: 1, cycles: 2 });
  assert.equal(validationSufficient(s.validation(['P', 'Q'])), false);
});

test('CREDIT: the per-trip cycle set is capped without changing any verdict', () => {
  const s = createPatternCreditStore();
  for (let c = 1; c <= 500; c++) s.credit('P', 't1', c);
  // One trip can supply at most the floor's worth of cycles, and never more bindings.
  assert.deepEqual(s.validation(['P']), { bindings: 1, cycles: MIN_VALIDATING_CYCLES });
  assert.equal(validationSufficient(s.validation(['P'])), false, 'one trip is still one binding');
});

test('CREDIT: anyDistrusted separates REJECTED from not-yet-earned, which validation() cannot', () => {
  // The five-day production stall: `validation()` answers null for a pattern the audit
  // threw out AND for one that simply has no credit yet, and `demoteUnvalidated` was
  // taking confirmed crosswalk entries away on both. Since the service-day rollover
  // clears the whole store BY DESIGN, the second case fires every night on every pattern.
  const s = createPatternCreditStore();
  s.credit('P', 't1', 1);
  s.distrust('P');
  assert.equal(s.validation(['P']), null);
  assert.equal(s.validation(['Q']), null, 'uncredited Q is indistinguishable to validation()');
  assert.equal(s.anyDistrusted(['P']), true, 'but P was REJECTED');
  assert.equal(s.anyDistrusted(['Q']), false, 'and Q was merely never credited');
  assert.equal(s.anyDistrusted(['Q', 'P']), true, 'one rejected pattern taints the set');
  assert.equal(s.anyDistrusted([]), false);

  // And the rollover the ratchet rode in on: after clear(), nothing is distrusted, so a
  // sweep keyed on anyDistrusted takes nothing away while credit is being re-earned.
  s.clear();
  assert.equal(s.anyDistrusted(['P']), false, 'a cleared store has withdrawn nothing');
});

test('CREDIT: retracting the last binding drops the pattern, and clear() resets distrust', () => {
  const s = createPatternCreditStore();
  s.credit('P', 't1', 1);
  assert.equal(s.size, 1);
  s.retractTrip('P', 't1');
  assert.equal(s.size, 0, 'no empty shells left behind');
  s.distrust('Q');
  s.clear();
  s.credit('Q', 't1', 1);
  assert.notEqual(s.validation(['Q']), null, 'a board or service-day change starts clean');
});

test('only confirmed entries above the confidence floor may back a delay row', () => {
  assert.equal(usableForDelay({ state: 'confirmed', confidence: 0.61 }), true);
  assert.equal(usableForDelay({ state: 'confirmed', confidence: 0.59 }), false);
  assert.equal(usableForDelay({ state: 'candidate', confidence: 0.99 }), false);
  assert.equal(usableForDelay({ state: 'conflicted', confidence: 1 }), false);
  assert.equal(usableForDelay(null), false);
  assert.equal(usableForDelay(undefined), false);
});

test('confidence rises with votes, falls with residual, and discounts propagation', () => {
  assert.equal(xwalkConfidence(10, 0, 'geo'), 1);
  assert.ok(xwalkConfidence(5, 0, 'geo') < xwalkConfidence(10, 0, 'geo'));
  assert.ok(xwalkConfidence(10, 50, 'geo') < xwalkConfidence(10, 10, 'geo'));
  assert.ok(xwalkConfidence(10, 0, 'propagated') < xwalkConfidence(10, 0, 'geo'));
  // The residual factor is floored, so a far-but-heavily-voted entry never reads as zero.
  assert.ok(xwalkConfidence(10, 10_000, 'geo') >= 0.2);
});

test('REGRESSION (BLOCKERS 10): corroboration may never lower confidence', () => {
  // A geometric anchor used to OVERWRITE a propagated entry, and geometry carries a
  // residual penalty that propagation does not. So a stop propagation supported at 0.85
  // was demoted to 0.33 the moment a vehicle was seen 40 m from it — while AGREEING about
  // which stop it was. Measured cost on a live snapshot: 3,185 of 23,636 realtime stop
  // occurrences (13.5%) sat `confirmed` and under the 0.60 floor for exactly this reason.
  const votes = 12, resid = 40;
  assert.ok(xwalkConfidence(votes, resid, 'geo') < XWALK_MIN_CONFIDENCE,
    'geometry alone at 40 m genuinely is below the floor');
  assert.ok(xwalkConfidence(votes, null, 'propagated') >= XWALK_MIN_CONFIDENCE);

  const both = corroboratedConfidence(votes, resid, { geo: true, propagated: true });
  assert.equal(both, xwalkConfidence(votes, null, 'propagated'));
  assert.ok(both >= XWALK_MIN_CONFIDENCE, 'two agreeing sources must not be worse than one');

  // It admits nothing either source would have refused on its own.
  assert.equal(corroboratedConfidence(votes, resid, { geo: true, propagated: false }),
    xwalkConfidence(votes, resid, 'geo'), 'geometry alone still carries its residual');
  assert.equal(corroboratedConfidence(votes, null, { geo: false, propagated: true }),
    xwalkConfidence(votes, null, 'propagated'));
  assert.equal(corroboratedConfidence(votes, resid, { geo: false, propagated: false }), 0);
  // A clean geometric anchor still beats propagation, so measurement keeps its edge.
  assert.ok(corroboratedConfidence(votes, 0, { geo: true, propagated: true })
    > corroboratedConfidence(votes, null, { geo: false, propagated: true }));
  // Monotone in evidence: adding a source can only ever help.
  for (const r of [0, 10, 25, 40, 79]) {
    assert.ok(corroboratedConfidence(votes, r, { geo: true, propagated: true })
      >= corroboratedConfidence(votes, r, { geo: true, propagated: false }), `resid ${r}`);
  }
});

test('CROSS-ROUTE AGREEMENT counts only stops seen from two or more routes', () => {
  const perRoute = new Map<string, Map<string, string>>([
    ['R1', new Map([['x', 's1'], ['y', 's2'], ['solo', 's9']])],
    ['R2', new Map([['x', 's1'], ['y', 'DIFFERENT']])],
  ]);
  const a = crossRouteAgreement(perRoute);
  assert.equal(a.total, 2, 'the single-route stop is not evidence either way');
  assert.equal(a.agree, 1);
  assert.equal(a.rate, 0.5);
  // No multi-route stops at all means no estimate — null, never a flattering 1.0.
  assert.equal(crossRouteAgreement(new Map([['R1', new Map([['x', 's1']])]])).rate, null);
});

test('MONOTONICITY flags a trip whose crosswalked stops go backwards', () => {
  const m = monotonicityViolations([
    { staticSeqs: [1, 2, 3, 4] },
    { staticSeqs: [1, 5, 3] },       // backwards
    { staticSeqs: [2, 2] },          // equal is also a violation
    { staticSeqs: [7] },             // too short to judge
  ]);
  assert.equal(m.total, 3);
  assert.equal(m.violations, 2);
  assert.equal(monotonicityViolations([]).rate, null);
});

// ---------- the monotonicity gate's INPUT (BLOCKERS 17) ----------

const xwEntry = (stopId: string, over: Partial<XwalkEntry> = {}): XwalkEntry => ({
  rtStopId: 'rt', stopId, votes: 12, distinctPatterns: 2, geoResidM: null,
  source: 'propagated', state: 'confirmed', confidence: 0.85, ...over,
});
const xwMap = (pairs: Record<string, string>, over: Partial<XwalkEntry> = {}): Map<string, XwalkEntry> =>
  new Map(Object.entries(pairs).map(([rt, st]) => [rt, xwEntry(st, { rtStopId: rt, ...over })]));

test('crosswalkedStaticSeqs reads the STATIC side, in realtime order', () => {
  const staticStops = ['s1', 's2', 's3', 's4'];
  // A healthy crosswalk: realtime order and static order agree.
  assert.deepEqual(
    crosswalkedStaticSeqs(['a', 'b', 'c'], staticStops, xwMap({ a: 's1', b: 's2', c: 's3' })),
    [1, 2, 3]);
  // The RT sequences need not equal the static ones — only the ORDER has to hold.
  assert.deepEqual(
    crosswalkedStaticSeqs(['a', 'b'], staticStops, xwMap({ a: 's2', b: 's4' })),
    [2, 4]);
  // Unknown, unconfirmed and under-confident identities contribute nothing either way.
  const mixed = xwMap({ a: 's1', b: 's2', c: 's3' });
  mixed.get('b')!.state = 'candidate';
  assert.deepEqual(crosswalkedStaticSeqs(['a', 'b', 'c', 'zz'], staticStops, mixed), [1, 3]);
  const thin = xwMap({ a: 's1', b: 's2' }, { confidence: 0.59 });
  assert.deepEqual(crosswalkedStaticSeqs(['a', 'b'], staticStops, thin), []);
  // A named stop that is not on this pattern is delay.ts's consistency gate to void, not
  // evidence of disorder here.
  assert.deepEqual(
    crosswalkedStaticSeqs(['a', 'b'], staticStops, xwMap({ a: 's1', b: 'ELSEWHERE' })),
    [1]);
});

test('crosswalkedStaticSeqs gives a looping pattern the benefit of the doubt', () => {
  // A turnback pattern that visits s2 twice. Two realtime stops mapping to s2 in order is
  // a legal trip, not an inversion — the audit must pick occurrences 2 then 4.
  const loop = ['s1', 's2', 's3', 's2', 's5'];
  assert.deepEqual(
    crosswalkedStaticSeqs(['a', 'b', 'c'], loop, xwMap({ a: 's2', b: 's3', c: 's2' })),
    [2, 3, 4]);
  assert.equal(monotonicityViolations([{
    staticSeqs: crosswalkedStaticSeqs(['a', 'b', 'c'], loop, xwMap({ a: 's2', b: 's3', c: 's2' })),
  }]).violations, 0);
});

test('REGRESSION (BLOCKERS 17): the monotonicity gate can actually fail', () => {
  // The bug: runCycle fed monotonicityViolations the binding's REALTIME stop sequences,
  // sorted ascending. Sorted input is monotone by construction, so the audit compared a
  // list against itself and returned 0 violations for EVERY possible crosswalk — a safety
  // check that reported "healthy" because it could not report anything else.
  const staticStops = ['s1', 's2', 's3', 's4', 's5'];
  // A crosswalk error: realtime stops 1,2,3 are mapped to static stops 5,3,1 — the trip
  // would be visiting its own route backwards.
  const scrambled = xwMap({ a: 's5', b: 's3', c: 's1' });
  const rtSeqsSorted = [1, 2, 3];               // what the old code passed
  assert.equal(monotonicityViolations([{ staticSeqs: rtSeqsSorted }]).violations, 0,
    'the OLD input is tautological: sorted realtime sequences can never violate');

  const staticSeqs = crosswalkedStaticSeqs(['a', 'b', 'c'], staticStops, scrambled);
  assert.deepEqual(staticSeqs, [5, 3, 1]);
  assert.equal(monotonicityViolations([{ staticSeqs }]).violations, 1,
    'the NEW input catches the inversion the gate exists to catch');
});

// ---------- regressions found by running the engine against the live feed ----------

test('REGRESSION: a re-derived stop keeps voting, so confidence can actually rise', () => {
  // Cycle 1 discovers rt3 -> s3. Cycle 2 re-derives the same identity from the same
  // evidence. `learned` is empty the second time (it is no longer new), so counting votes
  // off `learned` froze every propagated entry at one vote — permanently below the 0.60
  // usability floor, which made the crosswalk incapable of ever backing a delay row.
  const P = pat('P', 'R', [[1, 'rt1'], [2, 'rt2'], [3, 'rt3']]);
  const byRoute = new Map([['R', [staticPat('SP1', ['s1', 's2', 's3'])]]]);
  const geo = new Map([['R|rt1', 's1'], ['R|rt2', 's2']]);

  const c1 = resolvePatterns([P], byRoute, geo, new Map());
  assert.equal(c1.learned.get('rt3'), 's3');
  assert.equal(c1.implied.get('rt3'), 's3');

  const c2 = resolvePatterns([P], byRoute, geo, c1.learned);
  assert.equal(c2.learned.has('rt3'), false, 'not a new discovery on the second pass');
  assert.equal(c2.implied.get('rt3'), 's3', 'but it WAS re-derived, and that is the vote');

  // Ten corroborating cycles must clear the floor for a propagated entry.
  assert.ok(xwalkConfidence(10, null, 'propagated') >= 0.60,
    'a fully-corroborated propagated entry must be usable, or propagation is pointless');
  assert.ok(xwalkConfidence(1, null, 'propagated') < 0.60, 'one sighting is not enough');
  assert.ok(xwalkConfidence(10, null, 'geo') > xwalkConfidence(10, null, 'propagated'));
});

test('REGRESSION: a stop that flaps between two identities never accumulates votes', () => {
  // The vote count must measure corroboration, not merely how long we have been running.
  const A = pat('A', 'R1', [[1, 'a1'], [2, 'a2'], [3, 'rtX']]);
  const B = pat('B', 'R2', [[1, 'b1'], [2, 'b2'], [3, 'rtX']]);
  const byRoute = new Map<string, StaticPatternLite[]>([
    ['R1', [staticPat('SP1', ['s1', 's2', 'sHERE'])]],
    ['R2', [staticPat('SP2', ['t1', 't2', 'sTHERE'])]],
  ]);
  const geo = new Map([['R1|a1', 's1'], ['R1|a2', 's2'], ['R2|b1', 't1'], ['R2|b2', 't2']]);
  const r = resolvePatterns([A, B], byRoute, geo, new Map());
  assert.ok(r.conflicted.has('rtX'));
  assert.equal(r.implied.has('rtX'), false, 'a contested stop casts no vote for either answer');
});

test('REGRESSION: a batch upsert must tolerate two rows sharing a conflict key', () => {
  // Observed against the live feed: the crosswalk persist failed on three of eight cycles
  // with "ON CONFLICT DO UPDATE command cannot affect row a second time". Postgres
  // rejects the WHOLE statement, so a single duplicated key silently costs the entire
  // batch. RT patterns are keyed by a content hash, so two pattern objects can carry one
  // identity; the writer must collapse them rather than assume they cannot occur.
  const rows = [
    ['ttc', 'P1', 'board', 'routeA'],
    ['ttc', 'P2', 'board', 'routeB'],
    ['ttc', 'P1', 'board', 'routeC'],   // same (agency, pattern, board) as row 0
  ];
  const out = dedupeByKey(rows, 3);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r[1]), ['P1', 'P2']);
  assert.equal(out[0][3], 'routeC', 'last writer wins');

  // A wider key keeps both rows, because they no longer collide.
  assert.equal(dedupeByKey(rows, 4).length, 3);
  // The separator must not let two different keys concatenate into the same string.
  assert.equal(dedupeByKey([['a', 'bc'], ['ab', 'c']], 2).length, 2);
  assert.equal(dedupeByKey([], 3).length, 0);
});
