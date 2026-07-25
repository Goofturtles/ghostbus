// bind — origin lock: which STATIC trip is this realtime trip actually running?
//
// WHY BINDING HAPPENS AT BIRTH, AND ONLY ONCE.
//
// The obvious approach — score every live trip against every candidate slot each cycle —
// was measured and does not work. Candidate trips on one pattern are exact time-shifted
// clones of each other, so the residual spread of the correct candidate is not
// distinguishable from the wrong one (best-candidate MAD p50 31 s against worst 42 s).
// There is no signal in the shape of a mid-route trip.
//
// What DOES carry signal is the moment a trip is born. The TTC feed publishes a trip
// roughly 29.5 minutes before its first stop (measured p10 1,734 s / p50 1,766 s / p90
// 1,780 s past the feed header), overwhelmingly at stopSequence 1. At that instant the
// trip has not moved, so its first predicted departure is essentially its scheduled
// departure plus whatever the operator already knows. Comparing that to the scheduled
// slots on the pattern is the one clean measurement available, and it is taken before any
// live drift can contaminate it.
//
// THE BINDING IS THEN IMMUTABLE. It is never re-solved. Re-solving under a
// "plausible delay" band would quietly truncate the delay distribution toward zero — the
// app would under-report exactly the lateness it exists to expose.
//
// TWO THINGS DELIBERATELY NOT DONE HERE:
//  - No day-long FIFO slot chaining. One missed collector cycle would phase-slip an
//    entire (route, pattern) for the rest of the service day, producing delays wrong by
//    exactly one headway that are perfectly self-consistent and invisible to every
//    internal check. Slot claiming is a uniqueness constraint and a ghost signal only.
//  - No order-preserving assignment. TTC bunching means a late bus gets overtaken, so
//    observed order does not preserve scheduled order; order preservation was measured
//    strictly worse than independent selection (64.7% against 77.0%).
//
// Pure: no database, no clock.

import { serviceEpochSeconds } from './tz.ts';

/** Asymmetric on purpose — see ORIGIN_BAND_NOTE below. */
export const ORIGIN_BAND_EARLY_S = -180;
export const ORIGIN_BAND_LATE_S = 420;
/** Runner-up separation required before we believe the winner. */
export const MARGIN_MIN_S = 120;
export const MARGIN_MIN_AGREE = 2;
/** Below this scheduled headway, identification is hopeless and we say so. */
export const MIN_PUBLISHABLE_HEADWAY_S = 300;
export const HIGH_CONFIDENCE_HEADWAY_S = 600;

// ORIGIN_BAND_NOTE. The band is [-180, +420]: a trip published ~29 minutes before it
// departs cannot be meaningfully early, so -180 s only covers clock, rounding and board
// slop, while +420 s covers a genuinely late block handoff. This asymmetry, together with
// headway aliasing (a bus more than half a headway late is shape-identical to the next
// bus departing on time), biases our ERRORS toward under-reporting lateness — that is,
// toward flattering the agency. That is the wrong direction for an accountability
// product. It is stated here rather than buried in a constant, and it is why sub-300 s
// headways are refused outright instead of guessed at.

export interface LockAnchor {
  stopSequence: number;
  staticStopId: string;
  predEpochS: number;
}

export interface LockSlot {
  tripId: string;
  firstDepS: number;
  claimed: boolean;
  /** scheduled seconds past service midnight, by stop_sequence-1. */
  times: ArrayLike<number>;
}

export interface LockInput {
  serviceDate: number;
  routeId: string;
  staticPatternId: string;
  /** the first predicted event, captured at BIRTH and never refreshed. */
  predFirstEpochS: number;
  anchors: readonly LockAnchor[];
  /** calendar-active slots on this pattern only. */
  slots: readonly LockSlot[];
  medianHeadwayS: number | null;
}

export type LockMethod =
  | 'origin_lock'
  | 'refused_ambiguous'
  | 'refused_no_slot'
  | 'refused_too_few_anchors'
  | 'refused_unresolved'
  | 'refused_midroute'
  | 'refused_headway_band'
  | 'refused_board_inactive';

export interface LockResult {
  tripId: string | null;
  method: LockMethod;
  residS: number | null;
  marginS: number | null;
  agree: number;
  confidence: 'high' | 'low' | null;
  headwayS: number | null;
  candidates: number;
}

interface Scored {
  slot: LockSlot;
  resid: number;
  agree: number;
}

/** Median of a numeric list. */
function med(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function originLock(inp: LockInput): LockResult {
  const none = (method: LockMethod, headwayS: number | null = inp.medianHeadwayS): LockResult =>
    ({ tripId: null, method, residS: null, marginS: null, agree: 0, confidence: null, headwayS, candidates: 0 });

  // An empty slot list is today's real state: the loaded board has no calendar-active
  // service for this date. That is a distinct outcome from "we looked and could not tell".
  if (inp.slots.length === 0) return none('refused_board_inactive');

  // Refuse the whole sub-5-minute band, at any confidence. Identification is worst exactly
  // there, and it is the busiest, most-watched service. The honest product statement is
  // "too frequent to measure reliably", never a guess.
  if (inp.medianHeadwayS == null || inp.medianHeadwayS < MIN_PUBLISHABLE_HEADWAY_S) {
    return none('refused_headway_band');
  }

  const dayStart = serviceEpochSeconds(inp.serviceDate, 0);
  const predFirstS = inp.predFirstEpochS - dayStart;

  const scored: Scored[] = [];
  for (const slot of inp.slots) {
    const resid = predFirstS - slot.firstDepS;
    if (resid < ORIGIN_BAND_EARLY_S || resid > ORIGIN_BAND_LATE_S) continue;

    // Score the remaining anchors. With a median of one stop published at birth this is
    // usually empty, so `agree` is a bonus discriminator and |resid| does the real work.
    const offsets: number[] = [];
    for (const a of inp.anchors) {
      const sched = slot.times[a.stopSequence - 1];
      if (sched == null || sched < 0) continue;
      offsets.push(a.predEpochS - (dayStart + sched));
    }
    let agree = 0;
    if (offsets.length > 0) {
      const centre = med(offsets);
      const firstSeq = inp.anchors.length > 0 ? inp.anchors[0].stopSequence : 1;
      for (let i = 0; i < inp.anchors.length; i++) {
        const sched = slot.times[inp.anchors[i].stopSequence - 1];
        if (sched == null || sched < 0) continue;
        const o = inp.anchors[i].predEpochS - (dayStart + sched);
        const tol = Math.min(240, 60 + 10 * (inp.anchors[i].stopSequence - firstSeq));
        if (Math.abs(o - centre) <= tol) agree++;
      }
    }
    scored.push({ slot, resid, agree });
  }

  if (scored.length === 0) return none('refused_no_slot');

  scored.sort((a, b) => b.agree - a.agree || Math.abs(a.resid) - Math.abs(b.resid) ||
    (a.slot.tripId < b.slot.tripId ? -1 : 1));
  const win = scored[0];
  const run = scored[1] ?? null;

  // THE MARGIN TEST. Neighbouring slots on a pattern are exact time-shifted clones, so
  // equal `agree` is the normal outcome and the |resid| separation is what actually
  // decides. If the runner-up is within 120 s we genuinely cannot tell the two apart, and
  // saying so is the only honest answer.
  let marginS: number | null = null;
  if (run) {
    const agreeMargin = win.agree - run.agree;
    marginS = Math.abs(run.resid) - Math.abs(win.resid);
    if (agreeMargin < MARGIN_MIN_AGREE && marginS < MARGIN_MIN_S) {
      return {
        tripId: null, method: 'refused_ambiguous', residS: win.resid, marginS,
        agree: win.agree, confidence: null, headwayS: inp.medianHeadwayS, candidates: scored.length,
      };
    }
  }

  const confidence: 'high' | 'low' = inp.medianHeadwayS >= HIGH_CONFIDENCE_HEADWAY_S ? 'high' : 'low';
  return {
    tripId: win.slot.tripId,
    method: 'origin_lock',
    residS: win.resid,
    marginS,
    agree: win.agree,
    confidence,
    headwayS: inp.medianHeadwayS,
    candidates: scored.length,
  };
}

/**
 * Resolve a double-book: two RT trips locked the same static trip. Higher `agree` wins,
 * then the smaller |resid|. The loser is voided rather than re-solved, because a second
 * attempt under a different band is exactly the re-solving this design forbids.
 */
export function preferBinding(
  a: { agree: number; residS: number | null; rtTripId: string },
  b: { agree: number; residS: number | null; rtTripId: string },
): { winner: typeof a; loser: typeof a } {
  const ra = a.residS == null ? Infinity : Math.abs(a.residS);
  const rb = b.residS == null ? Infinity : Math.abs(b.residS);
  if (a.agree !== b.agree) return a.agree > b.agree ? { winner: a, loser: b } : { winner: b, loser: a };
  if (ra !== rb) return ra < rb ? { winner: a, loser: b } : { winner: b, loser: a };
  return a.rtTripId < b.rtTripId ? { winner: a, loser: b } : { winner: b, loser: a };
}
