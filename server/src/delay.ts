// delay — turn a bound trip's predictions into settled delay observations.
//
// delay_s = event_epoch_s - sched_epoch_s
//
// where sched_epoch_s comes from OUR OWN seeded stop_times through the GTFS noon-minus-12h
// service anchor, and event_epoch_s is the last thing the feed said about that stop before
// it settled. Nothing is reconstructed from a feed-provided delay, because the feed
// provides none — that circularity (scheduled = predicted - delay) is what produced a 0%
// join rate and 300k information-free rows.
//
// NO BAND IS APPLIED AFTER THE LOCK. Once a trip is bound, a 40-minute delay is measurable
// and gets measured. Any "plausibility" window on the post-lock computation would censor
// the distribution toward zero and make the app under-report exactly the lateness it
// exists to expose. Values beyond +/-5400 s are DROPPED AND COUNTED, never clamped.
//
// Pure: no database, no wall clock (the caller supplies `nowS`).

import { hourOfWeek } from './tz.ts';
import { serviceEpochSeconds } from './tz.ts';
import { usableForDelay, type XwalkEntry } from './xwalk.ts';

/** Beyond this, the row is evidence of a bug, not of a late bus. Dropped, never clamped. */
export const MAX_PLAUSIBLE_DELAY_S = 5400;
/** A still-listed stop whose predicted time is this far past counts as settled. */
export const SETTLE_LAG_S = 30;

export interface TrackedStop {
  stopSequence: number;
  rtStopId: string;
  epochS: number;
  kind: 'arrival' | 'departure';
  /** StopTimeUpdate.scheduleRelationship === 2 (NO_DATA). Carries no time; never emitted. */
  noData: boolean;
}

export interface SettleInput {
  nowS: number;
  serviceDate: number;
  boardTag: string;
  rtTripId: string;
  staticTripId: string;
  routeId: string;
  confidence: 'high' | 'low';
  matchMarginS: number | null;
  headwayS: number | null;
  /** last cycle's latest prediction per stop_sequence. */
  prev: ReadonlyMap<number, TrackedStop>;
  /** this cycle's list, or null when the trip has left the feed entirely. */
  current: ReadonlyMap<number, TrackedStop> | null;
  /** the bound static trip's scheduled seconds by stop_sequence-1. */
  times: ArrayLike<number>;
  arrivals: ArrayLike<number>;
  /** the bound static trip's stop ids by stop_sequence-1. */
  staticStops: readonly string[];
  xwalk: ReadonlyMap<string, XwalkEntry>;
  /** stop_sequence -> epoch seconds a VehiclePosition reported STOPPED_AT there. */
  observed?: ReadonlyMap<number, number>;
}

export interface DelayRow {
  routeId: string;
  stopId: string;          // STATIC stop id
  rtTripId: string;
  staticTripId: string;
  stopSequence: number;
  hourOfWeek: number;
  delayS: number;
  schedEpochS: number;
  eventEpochS: number;
  serviceDate: number;
  method: 'sched_diff';
  source: 'observed' | 'predicted';
  confidence: 'high' | 'low';
  xwalkConf: number;
  matchMarginS: number | null;
  headwayS: number | null;
  boardTag: string;
}

export interface SettleCounters {
  written: number;
  observed: number;
  predicted: number;
  droppedNoXwalk: number;
  droppedNotSettled: number;
  droppedImplausible: number;
  droppedNoData: number;
  droppedNoSchedule: number;
}

export interface SettleResult {
  rows: DelayRow[];
  counters: SettleCounters;
  /** set when the crosswalk contradicted the binding — caller voids and quarantines. */
  inconsistent: { stopSequence: number; expected: string; got: string } | null;
}

function zero(): SettleCounters {
  return {
    written: 0, observed: 0, predicted: 0, droppedNoXwalk: 0, droppedNotSettled: 0,
    droppedImplausible: 0, droppedNoData: 0, droppedNoSchedule: 0,
  };
}

/**
 * Emit one row per stop that SETTLED this cycle. A stop settles when
 *   - its stop_sequence disappeared from the trip's StopTimeUpdate list (measured: 30.6%
 *     of carried-over trips drop at least one leading sequence per cycle), or
 *   - the trip left the feed entirely, or
 *   - its predicted time is at least SETTLE_LAG_S in the past while still listed.
 *
 * A stop still in the future is never emitted — that would be publishing a prediction as
 * a measurement.
 */
export function settleTrip(inp: SettleInput): SettleResult {
  const counters = zero();
  const rows: DelayRow[] = [];

  for (const [seq, st] of inp.prev) {
    const stillListed = inp.current?.get(seq);
    const settled =
      inp.current === null ||          // trip gone from the feed
      stillListed === undefined ||     // sequence dropped from the list
      st.epochS <= inp.nowS - SETTLE_LAG_S;
    if (!settled) { counters.droppedNotSettled++; continue; }

    // NO_DATA carries no time. Treating it as on-time would reproduce the exact
    // fabrication this whole engine exists to remove.
    if (st.noData) { counters.droppedNoData++; continue; }

    const xw = inp.xwalk.get(st.rtStopId);
    if (!usableForDelay(xw)) { counters.droppedNoXwalk++; continue; }
    const staticStopId = (xw as XwalkEntry).stopId;

    // CONSISTENCY GATE — the crosswalk's runtime self-check. If the bound static trip's
    // stop at this sequence is not the stop the crosswalk names, one of the two is wrong
    // and neither may be published. The caller voids the binding and quarantines the
    // pattern; we abandon this trip's rows entirely rather than emit the "good" ones.
    const expected = seq >= 1 && seq <= inp.staticStops.length ? inp.staticStops[seq - 1] : null;
    if (expected != null && expected !== staticStopId) {
      return { rows: [], counters, inconsistent: { stopSequence: seq, expected, got: staticStopId } };
    }

    const schedS = st.kind === 'departure' ? inp.times[seq - 1] : inp.arrivals[seq - 1];
    if (schedS == null || schedS < 0) { counters.droppedNoSchedule++; continue; }
    const schedEpochS = serviceEpochSeconds(inp.serviceDate, schedS);

    // GROUND TRUTH where we have it: a VehiclePosition reporting STOPPED_AT at this stop
    // is an observation, not a prediction. Roughly 100 per cycle across the system, which
    // is enough to measure the predicted rows' bias rather than assume it is zero.
    const obs = inp.observed?.get(seq);
    const eventEpochS = obs ?? st.epochS;
    const source: 'observed' | 'predicted' = obs != null ? 'observed' : 'predicted';

    const delayS = eventEpochS - schedEpochS;
    if (Math.abs(delayS) > MAX_PLAUSIBLE_DELAY_S) { counters.droppedImplausible++; continue; }

    rows.push({
      routeId: inp.routeId,
      stopId: staticStopId,
      rtTripId: inp.rtTripId,
      staticTripId: inp.staticTripId,
      stopSequence: seq,
      // Bucketed by the SCHEDULED hour: the arrivals endpoint looks the evidence bucket up
      // by a departure's scheduled time, so a very late stop must not migrate into the
      // next hour's bucket and be compared against the wrong baseline.
      hourOfWeek: hourOfWeek(schedEpochS * 1000),
      delayS,
      schedEpochS,
      eventEpochS,
      serviceDate: inp.serviceDate,
      method: 'sched_diff',
      source,
      confidence: inp.confidence,
      xwalkConf: (xw as XwalkEntry).confidence,
      matchMarginS: inp.matchMarginS,
      headwayS: inp.headwayS,
      boardTag: inp.boardTag,
    });
    counters.written++;
    if (source === 'observed') counters.observed++; else counters.predicted++;
  }

  rows.sort((a, b) => a.stopSequence - b.stopSequence);
  return { rows, counters, inconsistent: null };
}

/** Merge counters from several trips into one cycle total. */
export function addCounters(a: SettleCounters, b: SettleCounters): SettleCounters {
  return {
    written: a.written + b.written,
    observed: a.observed + b.observed,
    predicted: a.predicted + b.predicted,
    droppedNoXwalk: a.droppedNoXwalk + b.droppedNoXwalk,
    droppedNotSettled: a.droppedNotSettled + b.droppedNotSettled,
    droppedImplausible: a.droppedImplausible + b.droppedImplausible,
    droppedNoData: a.droppedNoData + b.droppedNoData,
    droppedNoSchedule: a.droppedNoSchedule + b.droppedNoSchedule,
  };
}

export const emptyCounters = zero;
