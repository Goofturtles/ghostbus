// gates — the honesty gates. Evaluated every cycle; any failure means the engine emits
// NOTHING and reports, in words, why.
//
// The product's whole claim is that no number appears without its evidence. These gates
// are where that claim is enforced mechanically rather than by good intentions: each one
// is a condition under which a published delay would be a confident lie, and each one has
// a distinct, nameable reason string so the UI can say what is actually going on instead
// of rendering a reassuring zero.
//
// Pure: no database, no clock.

export const MIN_XWALK_OCCURRENCE_COVERAGE = 0.50;
export const MIN_CROSS_ROUTE_AGREEMENT = 0.85;
export const MAX_MONOTONICITY_VIOLATION_RATE = 0.05;
export const MAX_BOARD_AGREEMENT_RESID_S = 300;

/**
 * The `identityVerified` gate — for agencies whose descriptor claims realtime ids ARE
 * their static ids (`rtNamespace: 'identity'`). The claim is verified, never assumed:
 * METHODS §4.6 is the record of what trusting one feed-supplied value cost (314,742
 * observations of a protobuf default), and the TTC's 59.3% coincidental global id overlap
 * is exactly what an unverified identity assumption would quietly publish through.
 *
 * MIN_IDENTITY_MEMBERSHIP: share of realtime stop OCCURRENCES naming a stop the loaded
 * board actually holds. Identity agencies measured 99.6-100% (plan §1.4), so 0.95 leaves
 * headroom for feed noise while sitting far above the 59.3% a changed namespace can reach
 * by numeric coincidence. A falling rate is the signal the feed changed namespace.
 *
 * MIN_IDENTITY_GEO_AGREEMENT / MIN_IDENTITY_GEO_SAMPLES: the geometric anchor path keeps
 * running as an AUDIT. For a true identity feed, a STOPPED_AT vehicle's position resolves
 * to the very stop its rt id names (~100%); for a false one it almost never does (TTC
 * control: 0 of 55 within 100 m). 0.85 mirrors MIN_CROSS_ROUTE_AGREEMENT — the same
 * "the crosswalk may not disagree with itself" bar reached by a different road — and at
 * least 3 independent anchors are required before the audit can be said to have run at
 * all: publishing on zero corroborations would be verification by vacuum.
 */
export const MIN_IDENTITY_MEMBERSHIP = 0.95;
export const MIN_IDENTITY_GEO_AGREEMENT = 0.85;
export const MIN_IDENTITY_GEO_SAMPLES = 3;

export interface GateInput {
  /** any calendar-active service_id for this service date. */
  boardActive: boolean;
  boardTag: string;
  serviceDate: number;
  /** static trips the loaded board actually holds for those calendar-active services. */
  activeServiceTripCount: number;
  /** median |first_stop_resid_s| over the most recent bindings, or null when there are none. */
  boardAgreementMedianResidS: number | null;
  /** share of StopTimeUpdate OCCURRENCES (not distinct stops) that resolve through the crosswalk. */
  xwalkOccurrenceCoverage: number;
  crossRouteAgreement: number | null;
  monotonicityViolationRate: number | null;
  /**
   * Identity-crosswalk verification. `null` means the agency is `'learned'` (the TTC) and
   * this gate does not apply — which is a different statement from "verified", and the
   * two never read alike because a learned agency's evidence is judged by every OTHER
   * gate instead. `membershipRate` is null when this cycle carried no realtime stop
   * occurrences to measure, which is unverified, not vacuously verified.
   */
  identity: {
    membershipRate: number | null;
    geoAgree: number;
    geoTotal: number;
  } | null;
}

export interface GateResult {
  publish: boolean;
  /** human-readable, null only when publishing. */
  reason: string | null;
  /** machine-readable gate name, null only when publishing. */
  failed: string | null;
}

/**
 * ORDER IS PART OF THE CONTRACT. Each gate is checked before the symptoms it would cause,
 * so the reason string names the cause rather than a downstream effect: an inactive board
 * would also read as zero coverage, and a board with no seeded trips would also read as
 * zero ghosts. `boardActive` and `boardIntegrity` therefore come first.
 *
 * Until 2026-07-26 this returned publish=false on `boardActive` for every call, because the
 * loaded board covered 20260726..20260905 and had not started. That is no longer the live
 * case and the comment is not left implying it is — but the reason string still names the
 * window, so the UI can distinguish "we hold no schedule for today" from "no data yet" and
 * from "0 min delay", which are three very different statements a naive implementation
 * renders identically.
 */
export function evaluateGates(i: GateInput): GateResult {
  const fail = (failed: string, reason: string): GateResult => ({ publish: false, reason, failed });

  if (!i.boardActive) {
    return fail('boardActive',
      `no calendar-active schedule for ${i.serviceDate}; the loaded board covers ${i.boardTag}`);
  }
  // BOARD INTEGRITY. The calendar can declare a service active on a date for which we hold
  // no trips at all: `calendar` and `calendar_dates` are seeded whole while `trips` is
  // seeded through a rolling window, so seven of this board's 42 days — six Saturdays on
  // service 2 and the civic holiday on service 4 — are calendar-active and completely
  // empty (BLOCKERS 9). Without this gate those days pass `boardActive`, produce zero due
  // trips, zero ghosts and zero delays, and render as a clean day. "We hold no schedule
  // for this date" and "nothing went wrong" are opposite statements and must not look
  // alike. This does not repair the seed; it stops the hole from reading as good news.
  if (i.boardActive && i.activeServiceTripCount === 0) {
    return fail('boardIntegrity',
      `the calendar activates service for ${i.serviceDate}, but the loaded board (${i.boardTag}) ` +
      `holds no trips for it — that date was not seeded, so silence here would mean missing data, ` +
      `not an on-time service`);
  }
  // IDENTITY VERIFICATION, immediately after boardIntegrity and before every coverage
  // symptom it would cause: a failed identity assumption would ALSO read as low occurrence
  // coverage, and the reason string must name the cause, not the effect.
  if (i.identity != null) {
    const { membershipRate, geoAgree, geoTotal } = i.identity;
    if (membershipRate == null) {
      return fail('identityVerified',
        'this agency claims its realtime ids are its static ids, but no realtime stop ' +
        'occurrences have arrived yet to check that claim against the loaded board');
    }
    if (membershipRate < MIN_IDENTITY_MEMBERSHIP) {
      return fail('identityVerified',
        `only ${(membershipRate * 100).toFixed(1)}% of realtime stop occurrences name a stop the loaded board ` +
        `holds (need ${(MIN_IDENTITY_MEMBERSHIP * 100).toFixed(0)}%) — the feed may have changed namespace, and ` +
        `identity cannot be assumed`);
    }
    if (geoTotal < MIN_IDENTITY_GEO_SAMPLES) {
      return fail('identityVerified',
        `the geometric audit has checked only ${geoTotal} identity mapping${geoTotal === 1 ? '' : 's'} against ` +
        `vehicle positions (need ${MIN_IDENTITY_GEO_SAMPLES}); still verifying`);
    }
    if (geoAgree / geoTotal < MIN_IDENTITY_GEO_AGREEMENT) {
      return fail('identityVerified',
        `vehicle positions contradict the identity claim: only ${((geoAgree / geoTotal) * 100).toFixed(1)}% of ` +
        `geometrically-anchored identity stops agree (need ${(MIN_IDENTITY_GEO_AGREEMENT * 100).toFixed(0)}%)`);
    }
  }
  if (i.xwalkOccurrenceCoverage < MIN_XWALK_OCCURRENCE_COVERAGE) {
    return fail('xwalkOccurrenceCoverage',
      `stop crosswalk covers only ${(i.xwalkOccurrenceCoverage * 100).toFixed(1)}% of realtime stop occurrences ` +
      `(need ${(MIN_XWALK_OCCURRENCE_COVERAGE * 100).toFixed(0)}%); still learning`);
  }
  if (i.crossRouteAgreement != null && i.crossRouteAgreement < MIN_CROSS_ROUTE_AGREEMENT) {
    return fail('crossRouteAgreement',
      `stop crosswalk disagrees with itself across routes (${(i.crossRouteAgreement * 100).toFixed(1)}% agreement, ` +
      `need ${(MIN_CROSS_ROUTE_AGREEMENT * 100).toFixed(0)}%)`);
  }
  if (i.monotonicityViolationRate != null && i.monotonicityViolationRate > MAX_MONOTONICITY_VIOLATION_RATE) {
    return fail('monotonicity',
      `${(i.monotonicityViolationRate * 100).toFixed(1)}% of bound trips visit their crosswalked stops out of order ` +
      `(limit ${(MAX_MONOTONICITY_VIOLATION_RATE * 100).toFixed(0)}%)`);
  }
  // A large systematic first-stop residual means the realtime feed and our seeded static
  // are simply different boards. This self-detects the mid-transition case that a
  // hand-set flag would miss.
  if (i.boardAgreementMedianResidS != null && Math.abs(i.boardAgreementMedianResidS) > MAX_BOARD_AGREEMENT_RESID_S) {
    return fail('boardAgreement',
      `realtime feed and loaded static board disagree by a median ${Math.round(i.boardAgreementMedianResidS)}s at the ` +
      `first stop (limit ${MAX_BOARD_AGREEMENT_RESID_S}s); they are different boards`);
  }
  return { publish: true, reason: null, failed: null };
}

/**
 * Per-pattern breaker. A pattern whose rolling median |residual| exceeds half its own
 * headway has drifted onto the wrong slots — the delays it produces would be
 * self-consistent and wrong by roughly one headway. Voids that pattern's bindings for the
 * day WITHOUT stopping the rest of the cycle, because the fault is local.
 */
export function patternHealthy(medianHeadwayS: number | null, rollingMedianAbsResidS: number | null): boolean {
  if (medianHeadwayS == null || rollingMedianAbsResidS == null) return true;
  return rollingMedianAbsResidS <= medianHeadwayS / 2;
}
