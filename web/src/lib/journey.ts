// ONE JOURNEY SHAPE, so the options list and the in-progress view cannot disagree.
//
// The planner answers in two currencies — a `RidePlan` (one vehicle) and an
// `ItineraryPlan` (two, with a walk between). Rendering an options list from one and a GO
// mode from the other is how the two surfaces would come to describe the same trip
// differently: the card says 34 minutes, the live view counts down to something else.
//
// So both collapse here, exactly once, into:
//
//   PlanOption   an entry in the ranked list. Carries the underlying plan, plus the few
//                facts the card needs (when it leaves, when you arrive, is the FIRST
//                departure genuinely live, what percentage — if any — is backed).
//   Journey      the same option as an ordered list of steps on a timeline, which is what
//                the GO view highlights, counts down and draws the progress bar from.
//
// Everything here is pure and clock-free apart from the `nowMs` a caller passes in, so the
// whole model is exercised in a plain Node test with no browser around.

import type { ItineraryDto, RideCandidateDto, PlanResponse } from '@shared/types';
import type { WalkKind } from './walk';
import {
  allRidePlans, allItineraryPlans, type RidePlan, type ItineraryPlan, type PlanOptions,
} from './plan';
import { onTimeLikelihood, connectionLikelihood, type Likelihood } from './likelihood';

// =====================================================================================
// options
// =====================================================================================

export type PlanOption =
  | { kind: 'ride'; id: string; plan: RidePlan }
  | { kind: 'twoLeg'; id: string; plan: ItineraryPlan };

/** How many options the list shows. Beyond this the rider is reading a timetable, not
 *  choosing; the count of what is not shown is stated rather than hidden. */
export const MAX_OPTIONS = 6;

/** The rides an option is made of, in order. One for a single ride, two for an itinerary. */
export function optionLegs(o: PlanOption): RideCandidateDto[] {
  return o.kind === 'ride'
    ? [o.plan.candidate]
    : [o.plan.itinerary.legs[0], o.plan.itinerary.legs[1]];
}

/** The instant this option's FIRST vehicle is expected to leave its boarding stop. */
export const optionBoardMs = (o: PlanOption): number =>
  o.kind === 'ride' ? o.plan.boardMs : o.plan.leg1.boardMs;

export const optionLeaveByMs = (o: PlanOption): number => o.plan.leaveByMs;
export const optionDoorMs = (o: PlanOption): number => o.plan.doorMs;
export const optionTotalSec = (o: PlanOption): number => o.plan.totalSec;

/**
 * IS THE BOARDING DEPARTURE GENUINELY LIVE-TRACKED — the one question the live-arc glyph
 * is allowed to be drawn from.
 *
 * The FIRST leg only, and `liveEtaMs` only. An honest ETA is evidence-backed but it is not
 * a vehicle anybody can see, and a second leg's tracking says nothing about the departure
 * the card's big numeral is counting down to. Drawing the arc off anything looser is
 * exactly the "live styling on scheduled data" this app refuses.
 */
export function optionIsLive(o: PlanOption): boolean {
  const legs = optionLegs(o);
  return legs[0].liveEtaMs != null;
}

/**
 * The percentage this option has earned, or null when it has earned none.
 *
 * Two different questions, because the two option kinds carry two different risks:
 *   twoLeg — will the connection survive? Measured on leg 1's observed lateness against
 *            the slack both published timetables leave for it.
 *   ride   — does this departure keep its promise? Measured on the same distribution
 *            against the on-time threshold.
 *
 * Null is a first-class answer and the UI must render the schedule-only evidence line for
 * it, never a substitute number. See lib/likelihood.ts for every gate that produces one.
 */
export function optionLikelihood(o: PlanOption): Likelihood | null {
  if (o.kind === 'twoLeg') {
    const leg1 = o.plan.itinerary.legs[0];
    return connectionLikelihood(leg1, leg1.departureMs, o.plan.scheduledSlackSec);
  }
  const c = o.plan.candidate;
  return onTimeLikelihood(c, c.departureMs);
}

/**
 * A stable identity for an option, so React keys and the rider's selection survive the
 * 30-second re-render without the list shuffling under their thumb.
 *
 * The trip id alone is not enough: the server may offer the SAME trip boarded at two
 * different stops (see PLAN_PAIRS_PER_TRIP), which are genuinely different options.
 */
const rideId = (c: RideCandidateDto): string => `${c.tripId}@${c.board.stopId}>${c.alight.stopId}`;
const itineraryId = (it: ItineraryDto): string => `${rideId(it.legs[0])}+${rideId(it.legs[1])}`;

/**
 * THE RANKED MENU, from one planner response.
 *
 * Three things happen here and each is a refusal to show something:
 *
 *   1. UNREACHABLE OPTIONS ARE NOT OPTIONS. A ride the rider cannot walk to in time, or a
 *      connection that no longer holds once leg 1's own delay is counted, is dropped —
 *      the same rule the single-best pick has always applied, now applied to the list.
 *      When that empties the list the caller renders the existing honest refusal.
 *   2. ONE ROW PER VEHICLE RUN. The server hands back up to three boarding/alighting pairs
 *      of the same trip; they are all true and they are all the same bus. The best pair
 *      (soonest at the door) represents it and the rest are dropped, because a rider
 *      choosing between three spellings of one option is choosing nothing.
 *   3. A CAP, WITH THE REMAINDER COUNTED. `hiddenCount` is what the fine print states.
 *
 * Ordering is `allRidePlans`/`allItineraryPlans`' own — soonest at the destination, ties
 * to the later departure — so the list is ranked by when the rider actually arrives, not
 * by which vehicle leaves first.
 */
export interface OptionList {
  options: PlanOption[];
  /** reachable options that exist but are past the cap. Never a guess. */
  hiddenCount: number;
  /** reachable options in total, before the cap. */
  totalCount: number;
}

export function buildOptions(res: PlanResponse, opts: PlanOptions): OptionList {
  let all: PlanOption[] = [];

  if (res.outcome === 'ride') {
    const seen = new Set<string>();
    for (const plan of allRidePlans(res.candidates, opts)) {
      if (!plan.reachable) continue;
      // Sorted soonest-at-the-door first, so the first pair of a trip to survive the
      // filter is that trip's best one by construction.
      if (seen.has(plan.candidate.tripId)) continue;
      seen.add(plan.candidate.tripId);
      all.push({ kind: 'ride', id: rideId(plan.candidate), plan });
    }
  } else if (res.outcome === 'twoLeg') {
    const seen = new Set<string>();
    for (const plan of allItineraryPlans(res.itineraries, opts)) {
      if (!plan.reachable) continue;
      const pair = `${plan.itinerary.legs[0].tripId}+${plan.itinerary.legs[1].tripId}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      all.push({ kind: 'twoLeg', id: itineraryId(plan.itinerary), plan });
    }
  }

  return {
    options: all.slice(0, MAX_OPTIONS),
    hiddenCount: Math.max(0, all.length - MAX_OPTIONS),
    totalCount: all.length,
  };
}

// =====================================================================================
// the journey timeline
// =====================================================================================

/**
 * The four things a rider does, each with its own copy and its own glyph. Four kinds
 * rather than a `walk` with a role flag, because "walk to the stop" and "walk to where you
 * are going" are different sentences and a boolean is how they end up sharing one.
 */
export type JourneyStepKind = 'walkToStop' | 'ride' | 'transfer' | 'walkToDest';

export interface JourneyStep {
  kind: JourneyStepKind;
  /** epoch ms this step begins. */
  startMs: number;
  /** epoch ms it ends. Never before `startMs`. */
  endMs: number;
  /** 'ride' only — the vehicle, and with it its own colour, badge and evidence. */
  candidate?: RideCandidateDto;
  /** walking steps only. */
  distanceM?: number;
  walkKind?: WalkKind;
  /** 'transfer' only — seconds standing at the stop once the walk is done. */
  waitSec?: number;
  /** the stop this step ends at, when it ends at one. */
  toName?: string | null;
  toStopId?: string | null;
  /** 'transfer' only, and true when both rides call at the same stop — nothing to walk. */
  sameStop?: boolean;
}

export interface Journey {
  kind: 'ride' | 'twoLeg';
  /** the option this was built from, so GO mode can re-read its evidence and percentage. */
  option: PlanOption;
  steps: JourneyStep[];
  leaveByMs: number;
  doorMs: number;
  totalSec: number;
  destinationName: string;
}

const stopName = (s: { name: string | null; stopId: string }): string | null => s.name ?? s.stopId;

/** One option, laid out on the clock. The instants are the plan's own — nothing here
 *  re-times anything, so the card and the live view count down to the same second. */
export function toJourney(option: PlanOption, destinationName: string): Journey {
  const steps: JourneyStep[] = [];

  if (option.kind === 'ride') {
    const p = option.plan;
    const c = p.candidate;
    const alightMs = p.boardMs + p.rideSec * 1000;
    steps.push({
      kind: 'walkToStop',
      startMs: p.leaveByMs, endMs: p.boardMs,
      distanceM: p.toStop.distanceM, walkKind: p.toStop.kind,
      toName: stopName(c.board), toStopId: c.board.stopId,
    });
    steps.push({
      kind: 'ride', startMs: p.boardMs, endMs: alightMs,
      candidate: c, toName: stopName(c.alight), toStopId: c.alight.stopId,
    });
    steps.push({
      kind: 'walkToDest', startMs: alightMs, endMs: p.doorMs,
      distanceM: p.fromStop.distanceM, walkKind: p.fromStop.kind,
      toName: destinationName,
    });
  } else {
    const p = option.plan;
    const [c1, c2] = p.itinerary.legs;
    const leg1AlightMs = p.leg1.boardMs + p.leg1.rideSec * 1000;
    const leg2AlightMs = p.leg2.boardMs + p.leg2.rideSec * 1000;
    steps.push({
      kind: 'walkToStop',
      startMs: p.leg1.leaveByMs, endMs: p.leg1.boardMs,
      distanceM: p.leg1.toStop.distanceM, walkKind: p.leg1.toStop.kind,
      toName: stopName(c1.board), toStopId: c1.board.stopId,
    });
    steps.push({
      kind: 'ride', startMs: p.leg1.boardMs, endMs: leg1AlightMs,
      candidate: c1, toName: stopName(c1.alight), toStopId: c1.alight.stopId,
    });
    steps.push({
      kind: 'transfer', startMs: leg1AlightMs, endMs: p.leg2.boardMs,
      distanceM: p.itinerary.transfer.distanceM, walkKind: 'direct',
      waitSec: p.transferWaitSec, sameStop: p.itinerary.transfer.sameStop,
      toName: stopName(p.itinerary.transfer.to), toStopId: p.itinerary.transfer.to.stopId,
    });
    steps.push({
      kind: 'ride', startMs: p.leg2.boardMs, endMs: leg2AlightMs,
      candidate: c2, toName: stopName(c2.alight), toStopId: c2.alight.stopId,
    });
    steps.push({
      kind: 'walkToDest', startMs: leg2AlightMs, endMs: p.doorMs,
      distanceM: p.leg2.fromStop.distanceM, walkKind: p.leg2.fromStop.kind,
      toName: destinationName,
    });
  }

  return {
    kind: option.kind,
    option,
    // A feed row that makes a step end before it starts would otherwise draw a negative
    // segment on the progress bar. Clamped rather than dropped: the step is real, its
    // duration is what the schedule made of it.
    steps: steps.map((s) => (s.endMs < s.startMs ? { ...s, endMs: s.startMs } : s)),
    leaveByMs: option.plan.leaveByMs,
    doorMs: option.plan.doorMs,
    totalSec: option.plan.totalSec,
    destinationName,
  };
}

export interface JourneyProgress {
  /**
   * Which step the PLAN says the rider is on. -1 before they have set off, `steps.length`
   * once the last one's end has passed.
   *
   * A claim about the plan's clock, never about the rider: nothing in this app knows
   * whether anyone actually boarded, and the GO view says so on its face rather than
   * asserting "you are on the 504".
   */
  index: number;
  /** 0..1 of the way through, clamped. What the segmented bar fills to. */
  fraction: number;
  step: JourneyStep | null;
}

export function journeyProgress(j: Journey, nowMs: number): JourneyProgress {
  const steps = j.steps;
  const start = j.leaveByMs;
  const end = j.doorMs;
  const span = Math.max(1, end - start);
  const fraction = Math.min(1, Math.max(0, (nowMs - start) / span));

  if (!Number.isFinite(nowMs) || nowMs < start) return { index: -1, fraction: 0, step: null };
  if (nowMs >= end) return { index: steps.length, fraction: 1, step: null };

  // The last step that has begun. Steps are contiguous by construction, so this is also
  // the step that has not yet ended.
  let index = 0;
  for (let i = 0; i < steps.length; i++) if (nowMs >= steps[i].startMs) index = i;
  return { index, fraction, step: steps[index] ?? null };
}

/**
 * The next RIDE the rider has to catch, and where it sits in the list — the step GO mode
 * puts its countdown and its catch verdict on.
 *
 * Null once every ride has departed: from there the journey is a walk, and a catch verdict
 * for a vehicle already gone would be a countdown to nothing.
 */
export function nextRideStep(j: Journey, nowMs: number): { step: JourneyStep; index: number } | null {
  for (let i = 0; i < j.steps.length; i++) {
    const s = j.steps[i];
    if (s.kind === 'ride' && s.startMs > nowMs) return { step: s, index: i };
  }
  return null;
}

// =====================================================================================
// the shared proportional time axis
// =====================================================================================

/**
 * THE ONE PIECE OF THE TRANSIT-APP NOTES THAT WAS DELIBERATELY LEFT OUT — itineraries
 * drawn to scale against a shared set of gridlines, so a rider can SEE that one option
 * leaves sooner and another gets there faster, instead of reading two numbers and doing
 * the arithmetic.
 *
 * It is an honest drawing, not a new claim: every instant on it is one the plan already
 * published and the card already prints in words (`leaveByMs`, each leg's own
 * `startMs`/`endMs` out of `toJourney`, `doorMs`). Nothing is estimated here and nothing
 * is rounded except for display. A row that is longer on screen is longer in minutes.
 *
 * WHY IT CAN REFUSE TO DRAW. A shared axis is only readable while every row is big enough
 * to read, and a menu of real transit options does not guarantee that: the last row can be
 * tomorrow morning's first service (`widened`), which would squash the other five into
 * hairlines. Rather than clamp, bucket or fake a break in the scale — all of which draw a
 * length that is not the duration — this returns null and the list renders without an
 * axis. Refusing to draw is the only option here that cannot mislead.
 */
export interface TimeAxis {
  /** domain start / end, epoch ms. */
  t0: number;
  t1: number;
  /** wall-clock instants to draw a gridline at, inside [t0, t1]. */
  ticks: number[];
  /** the spacing those ticks were chosen at, ms — the caller labels with it. */
  stepMs: number;
}

/** Gridline spacings, in minutes. Wall-clock friendly: every one divides an hour. */
const TICK_STEPS_MIN = [5, 10, 15, 20, 30, 60];
/** Widest span the axis will draw. Past this the rows are not comparable by eye. */
const AXIS_MAX_SPAN_MS = 3 * 60 * 60_000;
/** An option narrower than this share of the track cannot be read, so nothing is drawn. */
const AXIS_MIN_ROW_SHARE = 0.06;
/** Gridlines the 314px-wide track at 390px can label without the labels colliding —
 *  a label is ~34px, so six of them leave ~52px of clear space between each pair. */
const MAX_TICKS = 5;

export function buildTimeAxis(options: PlanOption[]): TimeAxis | null {
  if (options.length < 2) return null;

  let t0 = Infinity;
  let t1 = -Infinity;
  let narrowest = Infinity;
  for (const o of options) {
    const a = optionLeaveByMs(o);
    const b = optionDoorMs(o);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
    if (a < t0) t0 = a;
    if (b > t1) t1 = b;
    if (b - a < narrowest) narrowest = b - a;
  }

  const span = t1 - t0;
  if (span <= 0 || span > AXIS_MAX_SPAN_MS) return null;
  if (narrowest / span < AXIS_MIN_ROW_SHARE) return null;

  // The finest spacing that still fits inside MAX_TICKS. Walking the list upward and
  // stopping at the first one that fits is what keeps a 20-minute menu on 5-minute
  // gridlines and a two-hour one on 30-minute gridlines; taking the first with "at
  // least three" instead would put 36 labelled gridlines on the wide case.
  const count = (ms: number) => Math.floor(t1 / ms) - Math.ceil(t0 / ms) + 1;
  let stepMs = TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1]! * 60_000;
  for (const m of TICK_STEPS_MIN) {
    const ms = m * 60_000;
    if (count(ms) <= MAX_TICKS) { stepMs = ms; break; }
  }

  const ticks: number[] = [];
  for (let tk = Math.ceil(t0 / stepMs) * stepMs; tk <= t1; tk += stepMs) ticks.push(tk);
  // Two gridlines are the fewest that can establish a scale; one is just a mark.
  if (ticks.length < 2) return null;

  return { t0, t1, ticks, stepMs };
}

/** Where an instant sits on the axis, 0..1. Clamped, because a live re-estimate can
 *  move a leg a few seconds outside the domain the list was laid out on. */
export function axisFrac(axis: TimeAxis, ms: number): number {
  const span = axis.t1 - axis.t0;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (ms - axis.t0) / span));
}
