// PERCENTAGES, AND THE RULE THAT GOVERNS THEM.
//
// "87% you make this connection" is a far more useful sentence than "this connection is
// checked against both schedules" — and it is also a far easier sentence to fake. This
// file exists so that the number can only ever be produced from observations GhostBus
// actually recorded, and so that the arithmetic behind it can be exercised in a plain
// Node test with no browser and no network around.
//
// FOUR RULES, all enforced here rather than at the call sites:
//
//   1. NO EVIDENCE, NO PERCENTAGE. `bandsOf` returns null the moment the wire says
//      `evidence.bucket === 'none'`, or the band fields are absent, or the quantiles are
//      not monotonic. Every public function short-circuits on that null, and the UI's
//      contract is: null means render the existing schedule-only evidence line instead.
//      There is no fallback number and no default.
//   2. THIN EVIDENCE IS NO EVIDENCE EITHER. `MIN_OBSERVATIONS` is the same floor the
//      server's weakest trust grade uses (GRADE_TIERS' D tier, n >= 8, which is also the
//      floor `selectEvidence` requires for its tightest bucket). A percentage derived
//      from three sightings would be arithmetic, not knowledge.
//   3. THE TAILS ARE NOT OBSERVED, SO THEY ARE NOT CLAIMED. All we hold is P25/P50/P75 —
//      the middle half of the distribution. Everything outside the IQR is extrapolation
//      along the only slope we can see, and the result is clamped to [P_FLOOR, P_CEIL].
//      GhostBus will not print 99% or 1% off a three-point summary.
//   4. THE BASIS TRAVELS WITH THE NUMBER. Every `Likelihood` carries `n`, `windowDays`,
//      `bucket` and the threshold it was computed against, so the UI can show the
//      receipts without re-deriving (and possibly mis-stating) them.

import type { EtaBucket, EtaEvidence, HonestEta } from '@shared/types';

/**
 * The observed delay distribution for one (route, stop, hour-of-week) cell, as the three
 * quantiles the aggregates actually store. Seconds, signed — a negative P25 means the
 * middle half of this cell's sightings included departures that ran EARLY.
 */
export interface DelayBands {
  p25Sec: number;
  p50Sec: number;
  p75Sec: number;
  n: number;
  windowDays: number;
  /** 'stop-hour' is this stop's own cell; 'route-hour' is the route-wide rollup. Both are
   *  real observations, and the UI names which one it is reading. Never 'none' here. */
  bucket: Exclude<EtaBucket, 'none'>;
}

/** Weakest sample a percentage may be built on. See rule 2 above. */
export const MIN_OBSERVATIONS = 8;
/** The estimator never claims more certainty than a three-point summary can carry. */
export const P_FLOOR = 0.05;
export const P_CEIL = 0.95;
/**
 * "On time" for the single-ride percentage: departs no more than five minutes after the
 * published time. Stated on screen rather than assumed — an unlabelled on-time figure is
 * a number whose definition the reader has to guess at, and every agency guesses
 * differently.
 */
export const ON_TIME_SEC = 300;

const clamp = (p: number): number => Math.min(P_CEIL, Math.max(P_FLOOR, p));

/**
 * Recover the delay quantiles from a wire row.
 *
 * The API publishes the band as INSTANTS (`bandLowMs`/`bandHighMs`) anchored on the row's
 * own scheduled time, because that is what a departure board needs to render. The delay
 * distribution is what a probability needs, so it is subtracted back out here — against
 * the scheduled instant the caller names, since a departure board anchors on `scheduledMs`
 * and a plan candidate on `departureMs`.
 *
 * Returns null rather than a guess whenever the row cannot support the arithmetic:
 * no evidence bucket, a missing band field, or quantiles that are not in order (which
 * would mean the aggregate itself is corrupt, and inventing a monotonic reading of a
 * corrupt row is exactly the kind of confident nonsense this project argues against).
 */
export function bandsOf(
  row: { honest: HonestEta; evidence: EtaEvidence },
  scheduledMs: number,
): DelayBands | null {
  const { honest: h, evidence: ev } = row;
  if (ev.bucket === 'none') return null;
  if (h.bandLowMs == null || h.bandHighMs == null || h.medianDelaySec == null) return null;
  if (!Number.isFinite(scheduledMs)) return null;
  const p25Sec = Math.round((h.bandLowMs - scheduledMs) / 1000);
  const p75Sec = Math.round((h.bandHighMs - scheduledMs) / 1000);
  const p50Sec = Math.round(h.medianDelaySec);
  if (![p25Sec, p50Sec, p75Sec].every(Number.isFinite)) return null;
  if (!(p25Sec <= p50Sec && p50Sec <= p75Sec)) return null;
  if (!Number.isFinite(ev.n) || ev.n <= 0) return null;
  if (!Number.isFinite(ev.windowDays) || ev.windowDays <= 0) return null;
  // Rule 2, enforced at the one door every wire row comes through rather than left to the
  // caller. `bandsOf` and `delayCdf` are both exported, and a sample of one is not a
  // distribution however carefully the arithmetic downstream treats it.
  if (ev.n < MIN_OBSERVATIONS) return null;
  /**
   * THE ANCHOR IS CHECKED, NOT TRUSTED — and this is the only input in the file that a
   * caller could get wrong without anything going visibly bang.
   *
   * `bandLowMs`/`bandHighMs` are instants, so their delays are recovered by subtracting an
   * anchor; `medianDelaySec` is already a delay and is read straight off the wire. Hand in
   * the wrong anchor (a departure board's `scheduledMs` where a plan candidate wanted
   * `departureMs`, or worse, `honest.estimateMs`) and the two OUTER quantiles shift while
   * the middle one does not — producing a band that is still monotonic, still finite, still
   * passes every gate above, and is quietly describing a distribution nobody observed.
   *
   * The server builds all three from one anchor (`estimateMs = anchor + p50 * 1000`, see
   * api.ts) from integer percentile seconds, so on a correctly-anchored row the residual is
   * exactly zero today. The one second of tolerance is slack against the server ever
   * changing HOW it rounds — not against rounding that currently exists — and it is far
   * tighter than any real mis-anchoring, which is off by whole minutes.
   */
  if (h.estimateMs == null) return null;
  if (Math.abs(Math.round((h.estimateMs - scheduledMs) / 1000) - p50Sec) > 1) return null;
  return { p25Sec, p50Sec, p75Sec, n: ev.n, windowDays: ev.windowDays, bucket: ev.bucket };
}

/**
 * P(delay <= `sec`), estimated from the three observed quantiles.
 *
 * Piecewise-linear through the two points we know inside the IQR, and along the IQR's own
 * slope outside it. The extrapolation is the honest weak spot and it is why the result is
 * clamped: past P75 we are reasoning about a tail we have never measured, so the estimator
 * is allowed to say "very likely" and is not allowed to say "certain".
 *
 * A degenerate cell — all three quantiles equal, which happens when a route is so
 * consistent that the middle half of its sightings landed on one value — cannot be
 * interpolated at all, so it answers only the above/below question, at the clamps.
 */
export function delayCdf(b: DelayBands, sec: number): number {
  // A NaN threshold is a caller bug, not a distribution. The least-confident answer is the
  // only wrong answer that cannot over-claim, so that is what a bug gets. ±Infinity is NOT
  // caught here: it is a legitimate limit and the arithmetic below already carries it to
  // the right clamp, which a blanket !isFinite guard used to get backwards (P(delay <= +∞)
  // must be the ceiling, and it was returning the floor).
  if (Number.isNaN(sec)) return P_FLOOR;
  const { p25Sec: lo, p50Sec: mid, p75Sec: hi } = b;

  /**
   * ZERO OBSERVED SPREAD — the quantiles have collapsed onto one value.
   *
   * There is no slope to interpolate along and none to extrapolate down, so all this can
   * honestly report is which side of the atom the threshold falls on, AT THE KNOT LEVELS:
   * the middle half of the sample sits on `mid`, so P(D <= mid) >= 0.75 and
   * P(D < mid) <= 0.25, and those two bounds are the whole of what is known.
   *
   * It used to answer P_CEIL/P_FLOOR here, which was a category error — those are caps on
   * extrapolation, not values — and it produced a 45-point cliff off a rounding artifact:
   * a cell of (0, 0, 1) read 50% at the atom while (0, 0, 0) read 95%, one second of
   * `Math.round` apart in the aggregate. `likelihood()` refuses to print a percentage from
   * a cell this shape at all; these numbers exist so the CDF stays a total function.
   */
  if (hi <= lo) return sec < mid ? 0.25 : 0.75;

  /**
   * RIGHT-CONTINUOUS, which is what makes the knots read correctly when two quantiles
   * land on the same value.
   *
   * F(p25)=0.25, F(p50)=0.5, F(p75)=0.75, and where the sample piles up on one value two
   * of those are the SAME point carrying two levels — a genuine atom. The true CDF of an
   * atom takes the HIGHEST level at that point (P(D <= v) includes the mass at v), so the
   * comparisons below are ordered from the top down: `>= hi` before `>= mid` before the
   * rest. An earlier arrangement tested `<= lo` first and answered 0.25 at a p25==p50 atom
   * where the observations say 0.5 — a 25-point cliff one second wide.
   *
   * Both interior spans are provably non-zero here rather than defensively guarded: the
   * `>= mid` branch is only reached with `sec < hi`, which forces `mid < hi`, and the last
   * branch only with `sec >= lo` and `sec < mid`, which forces `lo < mid`.
   */
  const iqr = hi - lo;
  if (sec < lo) return clamp(0.25 + 0.5 * ((sec - lo) / iqr));
  if (sec >= hi) return clamp(0.75 + 0.5 * ((sec - hi) / iqr));
  if (sec >= mid) return 0.5 + 0.25 * ((sec - mid) / (hi - mid));
  return 0.25 + 0.25 * ((sec - lo) / (mid - lo));
}

/** What the percentage is a percentage OF. The UI keys its wording off this. */
export type LikelihoodKind = 'connection' | 'onTime';

export interface Likelihood {
  kind: LikelihoodKind;
  /** 0..1, already clamped. */
  p: number;
  /** whole percent, 5..95 — what actually gets printed. */
  percent: number;
  /** observations behind it. */
  n: number;
  windowDays: number;
  bucket: Exclude<EtaBucket, 'none'>;
  /** the delay, in seconds, the probability was measured against. */
  thresholdSec: number;
}

function likelihood(
  kind: LikelihoodKind,
  bands: DelayBands | null,
  thresholdSec: number,
): Likelihood | null {
  if (bands == null) return null;
  // Defence in depth: `bandsOf` already refuses a thin sample, and this refuses one that
  // reached here some other way.
  if (bands.n < MIN_OBSERVATIONS) return null;
  if (!Number.isFinite(thresholdSec)) return null;
  /**
   * A COLLAPSED CELL EARNS NO PERCENTAGE.
   *
   * P25 == P75 means the middle half of the sightings rounded to one second, which at
   * these sample sizes is far more often an artifact of the aggregate's own rounding than
   * a route of genuinely perfect punctuality. Whatever it is, it leaves the estimator with
   * two bounds and no shape — it cannot say how the probability decays away from the atom,
   * so any number it printed would be a flat claim standing in for an unknown one.
   *
   * Null is a fully supported answer here: the caller renders the existing evidence line,
   * which still shows the sample size and the ±0 spread. That is a truthful account of a
   * collapsed cell. "95% on time" was not.
   */
  if (bands.p75Sec <= bands.p25Sec) return null;
  const p = delayCdf(bands, thresholdSec);
  return {
    kind,
    p,
    percent: Math.round(p * 100),
    n: bands.n,
    windowDays: bands.windowDays,
    bucket: bands.bucket,
    thresholdSec,
  };
}

/**
 * "X% on time" for a single ride — P(this departure runs no more than ON_TIME_SEC late).
 *
 * Anchored on the SCHEDULE, not on whatever instant the plan happens to be built on: the
 * question is how well this route keeps its published promise at this stop and hour, and
 * that question has one answer regardless of what today's live feed says.
 */
export function onTimeLikelihood(
  row: { honest: HonestEta; evidence: EtaEvidence },
  scheduledMs: number,
): Likelihood | null {
  return likelihood('onTime', bandsOf(row, scheduledMs), ON_TIME_SEC);
}

/**
 * "X% you make this connection" — P(the first ride is not late enough to miss the second).
 *
 * `slackSec` is the scheduled slack: leg 2's published departure minus leg 1's published
 * arrival, minus the transfer walk at this rider's pace. Under the plan's own stated model
 * (a delayed boarding shifts the whole leg; the running time after it is the agency's) the
 * connection survives exactly when leg 1's boarding delay does not exceed that slack.
 *
 * TWO ASSUMPTIONS, BOTH DISCLOSED ON SCREEN. The second ride is held to its schedule —
 * conservative, because a late connecting vehicle only ever helps — and leg 1's delay at
 * its boarding stop is taken as the delay it carries to the transfer, which is the same
 * assumption the printed itinerary already makes and already states.
 */
export function connectionLikelihood(
  leg1: { honest: HonestEta; evidence: EtaEvidence },
  leg1ScheduledDepartureMs: number,
  slackSec: number,
): Likelihood | null {
  return likelihood('connection', bandsOf(leg1, leg1ScheduledDepartureMs), slackSec);
}
