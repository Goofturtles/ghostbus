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
  buildOptions, toJourney, journeyProgress, nextRideStep, optionIsLive, optionLikelihood,
  optionLegs, optionBoardMs, MAX_OPTIONS, buildTimeAxis, axisFrac,
} from './journey.ts';
import { buildRidePlan, buildItineraryPlan } from './plan.ts';
import { MIN_OBSERVATIONS, ON_TIME_SEC } from './likelihood.ts';

const T0 = Date.parse('2026-07-27T13:00:00Z');
const PACE = 4.8 / 3.6;
const opts = { nowMs: T0, paceMps: PACE };

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
    candidate({ tripId: 'B', departureMs: T0 + 1_800_000, arrivalMs: T0 + 2_400_000 }),
    candidate({ tripId: 'A', departureMs: T0 + 600_000, arrivalMs: T0 + 1_200_000 }),
  ]), opts);
  assert.equal(totalCount, 2);
  assert.equal(hiddenCount, 0);
  assert.deepEqual(options.map((o) => optionLegs(o)[0].tripId), ['A', 'B']);
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
    candidate({ tripId: 'OTHER', departureMs: T0 + 900_000, arrivalMs: T0 + 1_500_000 }),
  ]), opts);
  assert.equal(totalCount, 2);
  assert.deepEqual(options.map((o) => optionLegs(o)[0].tripId), ['SAME', 'OTHER']);
  // The surviving pair is the best one — soonest at the door.
  assert.equal(optionBoardMs(options[0]), T0 + 600_000);
});

test('the cap is applied and the remainder is counted, never dropped silently', () => {
  const many = Array.from({ length: MAX_OPTIONS + 3 }, (_, i) => candidate({
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
  for (const outcome of ['transfer', 'noService', 'noStopsNearYou', 'noStopsNearDestination'] as const) {
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
  const j = toJourney({ kind: 'ride', id: 'x', plan }, 'Dundas West');

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
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan }, 'Somewhere');

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
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan }, 'Somewhere');
  const spanned = j.steps.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  assert.equal(Math.round(spanned / 1000), plan.totalSec);
});

test('progress reports where the PLAN is, and clamps at both ends', () => {
  const c = candidate({ tripId: 'T', departureMs: T0 + 600_000, arrivalMs: T0 + 1_800_000 });
  const plan = buildRidePlan(c, opts);
  const j = toJourney({ kind: 'ride', id: 'x', plan }, 'Dundas West');

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
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan: buildItineraryPlan(it, opts) }, 'S');
  let lastIndex = -2, lastFraction = -1;
  for (let ms = j.leaveByMs - 120_000; ms <= j.doorMs + 120_000; ms += 5_000) {
    const p = journeyProgress(j, ms);
    assert.ok(p.index >= lastIndex, `index went backwards at ${ms}`);
    assert.ok(p.fraction >= lastFraction - 1e-12, `fraction went backwards at ${ms}`);
    lastIndex = p.index; lastFraction = p.fraction;
  }
});

test('the next ride to catch is the next one that has not departed, then nothing', () => {
  const it = itinerary({
    leg1Dep: T0 + 600_000, leg1Arr: T0 + 1_200_000,
    leg2Dep: T0 + 1_800_000, leg2Arr: T0 + 2_400_000,
  });
  const plan = buildItineraryPlan(it, opts);
  const j = toJourney({ kind: 'twoLeg', id: 'x', plan }, 'S');

  assert.equal(nextRideStep(j, T0)?.step.candidate?.tripId, 'T1');
  assert.equal(nextRideStep(j, plan.leg1.boardMs + 1)?.step.candidate?.tripId, 'T2');
  // Both gone: a catch verdict here would be a countdown to nothing.
  assert.equal(nextRideStep(j, plan.leg2.boardMs + 1), null);
});

// ---------------------------------------------------------- the shared time axis

const axisOptions = (specs: Array<[number, number]>) =>
  buildOptions(rideRes(specs.map(([dep, arr], i) =>
    candidate({ tripId: 'T' + i, departureMs: T0 + dep, arrivalMs: T0 + arr }))), opts).options;

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
    for (const s of toJourney(o, 'somewhere').steps) {
      assert.ok(s.startMs >= axis.t0 && s.endMs <= axis.t1,
        `step ${s.kind} ${s.startMs}..${s.endMs} outside ${axis.t0}..${axis.t1}`);
    }
  }
});
