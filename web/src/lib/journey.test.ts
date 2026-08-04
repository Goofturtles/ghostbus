// The options menu and the journey timeline.
//
// These tests are about what the two journey surfaces are ALLOWED to say: that the list
// never offers a ride nobody can reach, never lists one bus three times, never draws a
// live arc over a schedule-only departure, and never carries a percentage a sample did not
// earn — and that the timeline the GO view highlights is contiguous, ordered, and built on
// the plan's own instants rather than on a second set of arithmetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import type { RideCandidateDto, ItineraryDto, PlanResponse } from '../../../shared/types.ts';
import {
  buildOptions, toJourney, journeySteps, journeyProgress, nextRideStep, optionIsLive, optionLikelihood,
  optionLegs, optionBoardMs, MAX_OPTIONS, RUNS_PER_CARD, buildTimeAxis, axisFrac,
} from './journey.ts';
import { buildRidePlan, buildItineraryPlan } from './plan.ts';
import { MIN_OBSERVATIONS, ON_TIME_SEC } from './likelihood.ts';

const T0 = Date.parse('2026-07-27T13:00:00Z');
const PACE = 4.8 / 3.6;
const opts = { nowMs: T0, paceMps: PACE };

/**
 * A candidate on a route of its own, so it cannot be grouped with the next one.
 *
 * `buildOptions` folds runs of the SAME route sequence into one card, which is the point
 * of the options list — so a test that wants two OPTIONS has to ask for two ROUTES.
 * Tests that want two runs of one route call `candidate` directly and get the shared 504.
 */
function onOwnRoute(o: Parameters<typeof candidate>[0] & { route: string }): RideCandidateDto {
  const { route, ...rest } = o;
  return candidate({ ...rest, routeId: route, shortName: route });
}

function candidate(o: Partial<RideCandidateDto> & {
  tripId: string; departureMs: number; arrivalMs: number;
  boardStopId?: string; alightStopId?: string; boardDistanceM?: number;
}): RideCandidateDto {
  const {
    boardStopId = 'B1', alightStopId = 'A1', boardDistanceM = 120, ...rest
  } = o;
  return {
    routeId: '504', shortName: '504', longName: 'King', routeType: 0, color: 'ED1C24',
    headsign: 'East - 504 King towards Distillery Loop', directionId: 0,
    directionLabel: 'East - 504 King towards Distillery Loop',
    board: {
      agency: 'ttc', stopId: boardStopId, name: 'King St West at Spadina Ave',
      lat: 43.64537, lon: -79.395811, wheelchairBoarding: 1, distanceM: boardDistanceM,
    },
    alight: {
      agency: 'ttc', stopId: alightStopId, name: 'Dundas West Station',
      lat: 43.656862, lon: -79.453415, wheelchairBoarding: 1, distanceM: 150,
    },
    boardStopSequence: 14, alightStopSequence: 38, stopsRidden: 24,
    liveEtaMs: null,
    honest: { estimateMs: null, bandLowMs: null, bandHighMs: null, medianDelaySec: null },
    evidence: { n: 0, windowDays: 14, bucket: 'none' },
    ...rest,
  };
}

/** A candidate carrying a real observed band, anchored on its own scheduled departure. */
function withEvidence(
  c: RideCandidateDto, p25: number, p50: number, p75: number, n = 40,
): RideCandidateDto {
  return {
    ...c,
    honest: {
      estimateMs: c.departureMs + p50 * 1000,
      bandLowMs: c.departureMs + p25 * 1000,
      bandHighMs: c.departureMs + p75 * 1000,
      medianDelaySec: p50,
    },
    evidence: { n, windowDays: 14, bucket: 'stop-hour' },
  };
}

function itinerary(o: {
  leg1Dep: number; leg1Arr: number; leg2Dep: number; leg2Arr: number;
  leg1?: RideCandidateDto; transferM?: number; sameStop?: boolean;
}): ItineraryDto {
  const { transferM = 130, sameStop = false } = o;
  const leg1 = o.leg1 ?? candidate({
    tripId: 'T1', departureMs: o.leg1Dep, arrivalMs: o.leg1Arr, alightStopId: 'X1',
  });
  const leg2 = candidate({
    tripId: 'T2', departureMs: o.leg2Dep, arrivalMs: o.leg2Arr,
    boardStopId: sameStop ? 'X1' : 'X2', alightStopId: 'A2', boardDistanceM: 0,
    routeId: '505', shortName: '505', color: '00A650',
  });
  return {
    legs: [
      { ...leg1, alight: { ...leg1.alight, stopId: 'X1', distanceM: 0 } },
      leg2,
    ],
    transfer: {
      from: { ...leg1.alight, stopId: 'X1', distanceM: 0 },
      to: { ...leg2.board, distanceM: 0 },
      distanceM: sameStop ? 0 : transferM,
      sameStop,
    },
    transferWaitSec: Math.round((o.leg2Dep - o.leg1Arr) / 1000),
    // Both spellings of the same seam — see the note on ItineraryDto.transfer.
    transfers: [{
      from: { ...leg1.alight, stopId: 'X1', distanceM: 0 },
      to: { ...leg2.board, distanceM: 0 },
      distanceM: sameStop ? 0 : transferM,
      sameStop,
      waitSec: Math.round((o.leg2Dep - o.leg1Arr) / 1000),
    }],
    crossAgency: false,
  };
}

const rideRes = (candidates: RideCandidateDto[]): PlanResponse => ({
  from: { lat: 43.64, lon: -79.39 }, to: { lat: 43.65, lon: -79.45 },
  serverNowMs: T0, atMs: T0, windowMinutes: 90, radiusM: 500,
  outcome: 'ride', candidates, itineraries: [],
});
const twoLegRes = (itineraries: ItineraryDto[]): PlanResponse => ({
  from: { lat: 43.64, lon: -79.39 }, to: { lat: 43.65, lon: -79.45 },
  serverNowMs: T0, atMs: T0, windowMinutes: 90, radiusM: 500,
  outcome: 'twoLeg', candidates: [], itineraries,
});

// ---------------------------------------------------------------- the options menu

test('every reachable ride becomes an option, soonest at the door first', () => {
  const { options, totalCount, hiddenCount } = buildOptions(rideRes([
    onOwnRoute({ route: '505', tripId: 'B', departureMs: T0 + 1_800_000, arrivalMs: T0 + 2_400_000 }),
    onOwnRoute({ route: '504', tripId: 'A', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
  ]), opts);
  assert.equal(totalCount, 2);
  assert.equal(hiddenCount, 0);
  assert.deepEqual(options.map((o) => optionLegs(o)[0].tripId), ['A', 'B']);
});

// --------------------------------------------------- grouping and route diversity

test('runs of one route are ONE card carrying its next departures, not many cards', () => {
  const { options, laterBoardMs, totalCount, hiddenCount } = buildOptions(rideRes([
    candidate({ tripId: 'R1', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
    candidate({ tripId: 'R2', departureMs: T0 + 1_200_000, arrivalMs: T0 + 1_800_000 }),
    candidate({ tripId: 'R3', departureMs: T0 + 1_800_000, arrivalMs: T0 + 2_400_000 }),
  ]), opts);
  assert.equal(options.length, 1, 'one route sequence is one row');
  assert.equal(totalCount, 3);
  // The card speaks for all three, so nothing is left uncounted-for.
  assert.equal(hiddenCount, 0);
  assert.deepEqual(laterBoardMs.get(options[0].id), [T0 + 1_200_000, T0 + 1_800_000]);
  // The headline is still the soonest run; the later ones are only extra times.
  assert.equal(optionBoardMs(options[0]), T0 + 600_000);
});

test('a slower distinct route is still offered — six runs of the best one cannot bury it', () => {
  // Every 504 arrives before the 505 does, so an arrival-ranked list without grouping
  // fills all six slots with 504s and the rider never learns the 505 goes there at all.
  const fast = Array.from({ length: MAX_OPTIONS }, (_, i) => candidate({
    tripId: `F${i}`, departureMs: T0 + 600_000 + i * 60_000, arrivalMs: T0 + 1_200_000 + i * 60_000,
  }));
  const slow = onOwnRoute({
    route: '505', tripId: 'SLOW', departureMs: T0 + 900_000, arrivalMs: T0 + 3_000_000,
  });
  const { options } = buildOptions(rideRes([...fast, slow]), opts);
  const routes = options.map((o) => optionLegs(o)[0].routeId);
  assert.deepEqual(routes, ['504', '505']);
});

test('a card speaks for at most RUNS_PER_CARD runs; the rest stay in the honest remainder', () => {
  const many = Array.from({ length: 7 }, (_, i) => candidate({
    tripId: `T${i}`, departureMs: T0 + 600_000 + i * 60_000, arrivalMs: T0 + 1_200_000 + i * 60_000,
  }));
  const { options, laterBoardMs, totalCount, hiddenCount } = buildOptions(rideRes(many), opts);
  assert.equal(options.length, 1);
  assert.equal(laterBoardMs.get(options[0].id)?.length, RUNS_PER_CARD - 1);
  assert.equal(totalCount, 7);
  // 7 reachable, 3 spoken for by the single card, 4 stated as the remainder.
  assert.equal(hiddenCount, 7 - RUNS_PER_CARD);
});

test('a ride nobody can walk to in time is not an option', () => {
  // 2 km away, leaving in one minute.
  const { options, totalCount } = buildOptions(rideRes([
    candidate({
      tripId: 'GONE', departureMs: T0 + 60_000, arrivalMs: T0 + 600_000, boardDistanceM: 2000,
    }),
  ]), opts);
  assert.equal(totalCount, 0);
  assert.equal(options.length, 0);
});

test('one bus is one option, however many boarding pairs the server offered for it', () => {
  const { options, totalCount } = buildOptions(rideRes([
    candidate({ tripId: 'SAME', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000, boardStopId: 'B1' }),
    candidate({ tripId: 'SAME', departureMs: T0 + 660_000, arrivalMs: T0 + 1_260_000, boardStopId: 'B2' }),
    candidate({ tripId: 'SAME', departureMs: T0 + 720_000, arrivalMs: T0 + 1_320_000, boardStopId: 'B3' }),
    // A different route, so this test measures the boarding-pair dedupe alone and does
    // not also depend on how runs of one route are grouped (covered above).
    onOwnRoute({ route: '505', tripId: 'OTHER', departureMs: T0 + 900_000, arrivalMs: T0 + 1_500_000 }),
  ]), opts);
  assert.equal(totalCount, 2);
  assert.deepEqual(options.map((o) => optionLegs(o)[0].tripId), ['SAME', 'OTHER']);
  // The surviving pair is the best one — soonest at the door.
  assert.equal(optionBoardMs(options[0]), T0 + 600_000);
});

test('the cap is applied and the remainder is counted, never dropped silently', () => {
  // One run each on MAX_OPTIONS + 3 different routes: nothing to group, so the cap is
  // the only thing deciding what is on screen and three whole routes fall past it.
  const many = Array.from({ length: MAX_OPTIONS + 3 }, (_, i) => onOwnRoute({
    route: `R${i}`,
    tripId: `T${i}`, departureMs: T0 + 600_000 + i * 60_000, arrivalMs: T0 + 1_200_000 + i * 60_000,
  }));
  const { options, hiddenCount, totalCount } = buildOptions(rideRes(many), opts);
  assert.equal(options.length, MAX_OPTIONS);
  assert.equal(totalCount, MAX_OPTIONS + 3);
  assert.equal(hiddenCount, 3);
});

test('an itinerary whose connection no longer holds is not an option', () => {
  // Leg 1 predicted 12 min late; only 5 min of scheduled slack. The rider is still on the
  // first vehicle when the second leaves.
  const late = candidate({
    tripId: 'T1', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000, alightStopId: 'X1',
    liveEtaMs: T0 + 1_320_000,
  });
  const { totalCount } = buildOptions(twoLegRes([itinerary({
    leg1: late, leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_500_000, leg2Arr: T0 + 2_100_000,
  })]), opts);
  assert.equal(totalCount, 0);
});

test('a planner outcome that is not a menu produces no options at all', () => {
  // The two refusals added when the planner learned to say WHICH kind of nothing it found
  // belong here for the same reason as the rest: a refusal is not a menu, so it can never
  // produce a card. `searchBudgetExhausted` especially — a search that was cut short must
  // not leave a half-built option behind that reads like an answer.
  for (const outcome of [
    'transfer', 'noService', 'noStopsNearYou', 'noStopsNearDestination',
    'beyondSearchDepth', 'searchBudgetExhausted',
  ] as const) {
    const { options, totalCount } = buildOptions({ ...rideRes([]), outcome }, opts);
    assert.equal(options.length, 0);
    assert.equal(totalCount, 0);
  }
});

// ---------------------------------------------------------------- the live-arc rule

test('only a genuinely live-tracked boarding departure counts as live', () => {
  const sched = buildOptions(rideRes([
    candidate({ tripId: 'S', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
  ]), opts).options[0];
  assert.equal(optionIsLive(sched), false);

  // An honest ETA is evidence, not a vehicle anybody can see. It must NOT earn the arc.
  const honest = buildOptions(rideRes([
    withEvidence(
      candidate({ tripId: 'H', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
      -30, 60, 240,
    ),
  ]), opts).options[0];
  assert.equal(optionIsLive(honest), false);

  const live = buildOptions(rideRes([
    candidate({
      tripId: 'L', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000,
      liveEtaMs: T0 + 640_000,
    }),
  ]), opts).options[0];
  assert.equal(optionIsLive(live), true);
});

test("a live second leg does not make the option's own boarding departure live", () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_500_000, leg2Arr: T0 + 2_100_000,
  });
  const withLiveLeg2: ItineraryDto = {
    ...it,
    legs: [it.legs[0], { ...it.legs[1], liveEtaMs: T0 + 1_510_000 }],
  };
  const o = buildOptions(twoLegRes([withLiveLeg2]), opts).options[0];
  assert.ok(o);
  assert.equal(optionIsLive(o), false);
});

// ---------------------------------------------------------------- the percentage rule

test('a schedule-only option earns no percentage', () => {
  const o = buildOptions(rideRes([
    candidate({ tripId: 'S', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
  ]), opts).options[0];
  assert.equal(optionLikelihood(o), null);
});

test('a thinly-observed option earns no percentage', () => {
  const o = buildOptions(rideRes([
    withEvidence(
      candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
      -30, 60, 240, MIN_OBSERVATIONS - 1,
    ),
  ]), opts).options[0];
  assert.equal(optionLikelihood(o), null);
});

test('a well-observed single ride earns an on-time percentage', () => {
  const o = buildOptions(rideRes([
    withEvidence(
      candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
      -60, 60, ON_TIME_SEC,
    ),
  ]), opts).options[0];
  const l = optionLikelihood(o);
  assert.ok(l);
  assert.equal(l.kind, 'onTime');
  assert.equal(l.percent, 75);
  assert.equal(l.n, 40);
});

test('a well-observed itinerary earns a CONNECTION percentage, measured on the published slack', () => {
  // Leg 1 arrives T0+20min scheduled; leg 2 leaves T0+30min. 600 s of gap, minus the
  // 130 m transfer walk at this pace.
  const observed = withEvidence(
    candidate({ tripId: 'T1', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000, alightStopId: 'X1' }),
    0, 120, 480,
  );
  const it = itinerary({
    leg1: observed, leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const plan = buildItineraryPlan(it, opts);
  const o = buildOptions(twoLegRes([it]), opts).options[0];
  const l = optionLikelihood(o);
  assert.ok(l);
  assert.equal(l.kind, 'connection');
  assert.equal(l.thresholdSec, plan.scheduledSlackSec);
  // The slack is the PUBLISHED one, not the live-adjusted wait.
  assert.equal(plan.scheduledSlackSec, 600 - plan.transferWalkSec);
  assert.ok(l.percent > 50 && l.percent <= 95);
});

test('more published slack can only ever raise the connection percentage', () => {
  const observed = withEvidence(
    candidate({ tripId: 'T1', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000, alightStopId: 'X1' }),
    0, 120, 480,
  );
  // Tight but still genuinely makeable: leg 1's observed median puts it 2 min late, and
  // the connection still survives that. (Squeeze it further and the option correctly
  // vanishes altogether rather than earning a low percentage — which is the previous
  // test's job, not this one's.)
  const tight = buildOptions(twoLegRes([itinerary({
    leg1: observed, leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_560_000, leg2Arr: T0 + 2_100_000,
  })]), opts).options[0];
  assert.ok(tight, 'the tight option must still be reachable for this comparison to mean anything');
  const roomy = buildOptions(twoLegRes([itinerary({
    leg1: observed, leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  })]), opts).options[0];
  assert.ok(optionLikelihood(roomy)!.p > optionLikelihood(tight)!.p);
});

// ---------------------------------------------------------------- the timeline

test('a single ride lays out as walk, ride, walk — contiguous and in order', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const plan = buildRidePlan(c, opts);
  const j = toJourney({ kind: 'ride', id: 'x', plan }, 'Dundas West', T0);

  assert.deepEqual(j.steps.map((s) => s.kind), ['walkToStop', 'ride', 'walkToDest']);
  assert.equal(j.steps[0].startMs, plan.leaveByMs);
  assert.equal(j.steps[j.steps.length - 1].endMs, plan.doorMs);
  for (let i = 1; i < j.steps.length; i++) {
    assert.equal(j.steps[i].startMs, j.steps[i - 1].endMs, `gap before step ${i}`);
    assert.ok(j.steps[i].endMs >= j.steps[i].startMs);
  }
  assert.equal(j.steps[1].candidate?.tripId, 'T');
  assert.equal(j.steps[0].toStopId, 'B1');
  assert.equal(j.steps[2].toName, 'Dundas West');
});

test('a two-leg itinerary lays out as walk, ride, transfer, ride, walk — contiguous', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const plan = buildItineraryPlan(it, opts);
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan }, 'Somewhere', T0);

  assert.deepEqual(j.steps.map((s) => s.kind),
    ['walkToStop', 'ride', 'transfer', 'ride', 'walkToDest']);
  for (let i = 1; i < j.steps.length; i++) {
    assert.equal(j.steps[i].startMs, j.steps[i - 1].endMs, `gap before step ${i}`);
  }
  assert.equal(j.steps[0].startMs, plan.leaveByMs);
  assert.equal(j.steps[4].endMs, plan.doorMs);
  // The transfer states the standing-around time separately from the walk.
  assert.equal(j.steps[2].waitSec, plan.transferWaitSec);
  assert.equal(j.steps[2].sameStop, false);
  assert.equal(j.steps[1].candidate?.shortName, '504');
  assert.equal(j.steps[3].candidate?.shortName, '505');
});

test('the timeline totals exactly what the plan claims — no second arithmetic', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const plan = buildItineraryPlan(it, opts);
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan }, 'Somewhere', T0);
  const spanned = j.steps.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  assert.equal(Math.round(spanned / 1000), plan.totalSec);
});

test('progress reports where the PLAN is, and clamps at both ends', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const plan = buildRidePlan(c, opts);
  const j = toJourney({ kind: 'ride', id: 'x', plan }, 'Dundas West', T0);

  const before = journeyProgress(j, plan.leaveByMs - 60_000);
  assert.equal(before.index, -1);
  assert.equal(before.fraction, 0);
  assert.equal(before.step, null);

  const walking = journeyProgress(j, plan.leaveByMs + 1000);
  assert.equal(walking.index, 0);
  assert.equal(walking.step?.kind, 'walkToStop');

  const riding = journeyProgress(j, plan.boardMs + 60_000);
  assert.equal(riding.index, 1);
  assert.equal(riding.step?.kind, 'ride');

  const done = journeyProgress(j, plan.doorMs + 60_000);
  assert.equal(done.index, j.steps.length);
  assert.equal(done.fraction, 1);
  assert.equal(done.step, null);
});

test('progress never runs backwards as the clock advances', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan: buildItineraryPlan(it, opts) }, 'S', T0);
  let lastIndex = -2, lastFraction = -1;
  for (let ms = j.leaveByMs - 120_000; ms <= j.doorMs + 120_000; ms += 5_000) {
    const p = journeyProgress(j, ms);
    assert.ok(p.index >= lastIndex, `index went backwards at ${ms}`);
    assert.ok(p.fraction >= lastFraction - 1e-12, `fraction went backwards at ${ms}`);
    lastIndex = p.index; lastFraction = p.fraction;
  }
});

test('the options carry the SERVER clock they were true at, not the moment they were built', () => {
  // The in-progress view ages leg 2's frozen live prediction against this. Re-dating it to
  // the client's `now` would silently make every stale prediction look fresh — which is
  // the exact fiction the field exists to prevent.
  const res = rideRes([
    candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
  ]);
  const list = buildOptions({ ...res, serverNowMs: T0 - 45_000 }, opts);
  assert.equal(list.asOfMs, T0 - 45_000);
});

test('a journey carries its data provenance through, unchanged', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const plan = buildRidePlan(c, opts);
  const asOf = T0 - 90_000;
  const j = toJourney({ kind: 'ride', id: 'x', plan }, 'Dundas West', asOf);
  assert.equal(j.dataAsOfMs, asOf);
});

test('journeySteps and toJourney describe the same journey', () => {
  // The options list's time axis reads `journeySteps` while GO mode reads `toJourney`, and
  // the two drawing different geometry for one option is exactly the drift splitting them
  // could have introduced.
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const o = { kind: 'ride' as const, id: 'x', plan: buildRidePlan(c, opts) };
  assert.deepEqual(journeySteps(o, 'Dundas West'), toJourney(o, 'Dundas West', T0).steps);
});

test('the next ride to catch is the next one that has not departed, then nothing', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const plan = buildItineraryPlan(it, opts);
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan }, 'S', T0);

  assert.equal(nextRideStep(j, T0)?.step.candidate?.tripId, 'T1');
  assert.equal(nextRideStep(j, plan.leg1.boardMs + 1)?.step.candidate?.tripId, 'T2');
  // Both gone: a catch verdict here would be a countdown to nothing.
  assert.equal(nextRideStep(j, plan.leg2.boardMs + 1), null);
});

// ---------------------------------------------------------- the shared time axis

// One route per spec: the axis is about comparing DIFFERENT options, and runs of a
// single route are now one row, which would leave nothing to compare.
const axisOptions = (specs: Array<[number, number]>) =>
  buildOptions(rideRes(specs.map(([dep, arr], i) =>
    onOwnRoute({ route: 'R' + i, tripId: 'T' + i, departureMs: T0 + dep, arrivalMs: T0 + arr }))), opts).options;

test('the axis spans every option and its gridlines land on wall-clock instants', () => {
  const options = axisOptions([[600_000, 1_200_000], [1_800_000, 2_400_000]]);
  const axis = buildTimeAxis(options);
  assert.ok(axis, 'expected an axis over two ordinary options');
  // The domain is the plans' own instants, not a rounded window.
  assert.equal(axis.t0, Math.min(...options.map((o) => o.plan.leaveByMs)));
  assert.equal(axis.t1, Math.max(...options.map((o) => o.plan.doorMs)));
  assert.ok(axis.ticks.length >= 2 && axis.ticks.length <= 6, `ticks ${axis.ticks.length}`);
  for (const tk of axis.ticks) {
    assert.equal(tk % axis.stepMs, 0, 'a gridline must be a whole step of wall clock');
    assert.ok(tk >= axis.t0 && tk <= axis.t1, 'a gridline must lie inside the domain');
  }
});

test('a menu too spread out to draw to scale REFUSES an axis rather than squashing a row', () => {
  // One option now, one twelve hours out (the `widened` next-service case). Drawing both
  // on one domain would render the first as a hairline, so nothing is drawn at all.
  assert.equal(buildTimeAxis(axisOptions([[600_000, 1_200_000], [43_200_000, 43_800_000]])), null);
  // A single option has nothing to be compared against, so it earns no axis either.
  assert.equal(buildTimeAxis(axisOptions([[600_000, 1_200_000]])), null);
});

test('axisFrac is clamped, so a live re-estimate outside the domain cannot draw off-track', () => {
  const axis = buildTimeAxis(axisOptions([[600_000, 1_200_000], [1_800_000, 2_400_000]]));
  assert.ok(axis);
  assert.equal(axisFrac(axis, axis.t0 - 9_999_999), 0);
  assert.equal(axisFrac(axis, axis.t1 + 9_999_999), 1);
  assert.ok(Math.abs(axisFrac(axis, (axis.t0 + axis.t1) / 2) - 0.5) < 1e-9);
});

test('every step of every option lies inside the axis it was laid out on', () => {
  const options = axisOptions([[600_000, 1_200_000], [1_500_000, 2_100_000], [1_800_000, 2_400_000]]);
  const axis = buildTimeAxis(options);
  assert.ok(axis);
  for (const o of options) {
    for (const s of journeySteps(o, 'somewhere')) {
      assert.ok(s.startMs >= axis.t0 && s.endMs <= axis.t1,
        `step ${s.kind} ${s.startMs}..${s.endMs} outside ${axis.t0}..${axis.t1}`);
    }
  }
});

// ------------------------------------------------------------------ three legs
//
// The third tier is the server's (see server/src/itinerary.ts). What is under test here
// is the only thing the CLIENT can get wrong about it: silently describing a three-ride
// journey as a two-ride one. Every assertion below is a count — three badges, two seams,
// seven steps, both waits — because every defect this tier can produce on a card is a
// missing item in a list that used to be a fixed pair.

/** Three rides, two seams, in journey order. Leg 2 is the middle: it touches transfer
 *  ground at BOTH ends, which is why both its walk distances are zero. */
function threeLegItinerary(o: {
  dep1: number; arr1: number; dep2: number; arr2: number; dep3: number; arr3: number;
  leg1?: RideCandidateDto; leg2?: RideCandidateDto;
}): ItineraryDto {
  const leg1 = o.leg1 ?? candidate({
    tripId: 'T1', departureMs: o.dep1, arrivalMs: o.arr1, alightStopId: 'X1',
  });
  const leg2 = o.leg2 ?? candidate({
    tripId: 'T2', departureMs: o.dep2, arrivalMs: o.arr2,
    boardStopId: 'X2', alightStopId: 'X3', boardDistanceM: 0,
    routeId: '505', shortName: '505', color: '00A650',
  });
  const leg3 = candidate({
    tripId: 'T3', departureMs: o.dep3, arrivalMs: o.arr3,
    boardStopId: 'X4', alightStopId: 'A3', boardDistanceM: 0,
    routeId: '506', shortName: '506', color: '0072BC',
  });
  const seam = (from: RideCandidateDto, to: RideCandidateDto, distanceM: number) => ({
    from: { ...from.alight, distanceM: 0 },
    to: { ...to.board, distanceM: 0 },
    distanceM,
    sameStop: false,
    waitSec: Math.round((to.departureMs - from.arrivalMs) / 1000),
  });
  const legs = [
    { ...leg1, alight: { ...leg1.alight, stopId: 'X1', distanceM: 0 } },
    { ...leg2, alight: { ...leg2.alight, stopId: 'X3', distanceM: 0 } },
    leg3,
  ];
  const transfers = [seam(legs[0], legs[1], 130), seam(legs[1], legs[2], 90)];
  return {
    legs,
    transfers,
    transfer: transfers[0],
    transferWaitSec: transfers[0].waitSec,
    crossAgency: true,
  };
}

const threeLegRes = (itineraries: ItineraryDto[]): PlanResponse => ({
  from: { lat: 43.64, lon: -79.39 }, to: { lat: 43.65, lon: -79.45 },
  serverNowMs: T0, atMs: T0, windowMinutes: 90, radiusM: 500,
  outcome: 'threeLeg', candidates: [], itineraries,
});

const THREE = {
  dep1: T0 + 600_000, arr1: T0 + 1_200_000,
  dep2: T0 + 1_500_000, arr2: T0 + 2_100_000,
  dep3: T0 + 3_000_000, arr3: T0 + 3_600_000,
};

test('a threeLeg response becomes an option carrying all THREE route badges', () => {
  const { options, totalCount } = buildOptions(threeLegRes([threeLegItinerary(THREE)]), opts);
  assert.equal(totalCount, 1);
  assert.equal(options[0].kind, 'threeLeg');
  // What the card's badge row draws, in order. Two of these would be a card that leaves
  // a whole vehicle off a journey the rider is being asked to commit to.
  assert.deepEqual(optionLegs(options[0]).map((c) => c.shortName), ['504', '505', '506']);
  // The countdown is still the FIRST vehicle's departure, not the chain's.
  assert.equal(optionBoardMs(options[0]), THREE.dep1);
});

test('the timeline walks all seven steps — walk, ride, transfer, ride, transfer, ride, walk', () => {
  const { options } = buildOptions(threeLegRes([threeLegItinerary(THREE)]), opts);
  const steps = journeySteps(options[0], 'Somewhere');
  assert.deepEqual(steps.map((s) => s.kind), [
    'walkToStop', 'ride', 'transfer', 'ride', 'transfer', 'ride', 'walkToDest',
  ]);
  // Contiguous and ordered, the same guarantee the two-leg timeline carries.
  for (let i = 1; i < steps.length; i++) assert.equal(steps[i].startMs, steps[i - 1].endMs);
  // BOTH waits are real, separately measured numbers — not one repeated.
  const waits = steps.filter((s) => s.kind === 'transfer').map((s) => s.waitSec);
  assert.equal(waits.length, 2);
  for (const w of waits) assert.ok(typeof w === 'number' && w > 0);
});

test('door-to-door is measured to the LAST leg, so a third ride cannot be dropped', () => {
  const { options } = buildOptions(threeLegRes([threeLegItinerary(THREE)]), opts);
  const j = toJourney(options[0], 'Somewhere', T0);
  const steps = journeySteps(options[0], 'Somewhere');
  assert.equal(j.doorMs, steps[steps.length - 1].endMs);
  assert.ok(j.doorMs > THREE.arr3, 'the door is past the third ride, not the second');
  assert.equal(j.totalSec, Math.round((j.doorMs - j.leaveByMs) / 1000));
});

test('the WEAKEST seam speaks for the card, and one bare seam silences the number', () => {
  const punctualLeg1 = withEvidence(candidate({
    tripId: 'T1', departureMs: THREE.dep1, arrivalMs: THREE.arr1, alightStopId: 'X1',
  }), -30, 0, 30);
  const leg2 = (p25: number, p50: number, p75: number) => withEvidence(candidate({
    tripId: 'T2', departureMs: THREE.dep2, arrivalMs: THREE.arr2,
    boardStopId: 'X2', alightStopId: 'X3', boardDistanceM: 0,
    routeId: '505', shortName: '505', color: '00A650',
  }), p25, p50, p75);
  const pctOf = (leg1: RideCandidateDto, mid?: RideCandidateDto) => optionLikelihood(buildOptions(
    threeLegRes([threeLegItinerary({ ...THREE, leg1, leg2: mid })]), opts,
  ).options[0]);

  // ONE BARE SEAM SILENCES THE WHOLE CARD. Leg 2 here carries no observations, so seam 2
  // has no odds — and quoting seam 1's as the journey's would be a number for a risk the
  // rider is not taking.
  assert.equal(pctOf(punctualLeg1), null);

  // Both seams observed, so the card has earned a number — and it is the PESSIMISTIC
  // seam's. A chronically late middle leg must drag the card down even though the first
  // seam is comfortable.
  const good = pctOf(punctualLeg1, leg2(-30, 0, 30));
  const dragged = pctOf(punctualLeg1, leg2(240, 420, 900));
  assert.ok(good && dragged);
  assert.ok(dragged.percent < good.percent,
    `weakest seam must speak: ${dragged.percent}% should be below ${good.percent}%`);
  assert.equal(dragged.kind, 'connection');
});
