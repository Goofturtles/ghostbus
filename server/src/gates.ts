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

export interface GateInput {
  /** any calendar-active service_id for this service date. */
  boardActive: boolean;
  boardTag: string;
  serviceDate: number;
  /** median |first_stop_resid_s| over the most recent bindings, or null when there are none. */
  boardAgreementMedianResidS: number | null;
  /** share of StopTimeUpdate OCCURRENCES (not distinct stops) that resolve through the crosswalk. */
  xwalkOccurrenceCoverage: number;
  crossRouteAgreement: number | null;
  monotonicityViolationRate: number | null;
}

export interface GateResult {
  publish: boolean;
  /** human-readable, null only when publishing. */
  reason: string | null;
  /** machine-readable gate name, null only when publishing. */
  failed: string | null;
}

/**
 * TODAY this returns publish=false on `boardActive`, and that is the correct product
 * state: the loaded board covers 20260726..20260905 and the machine date is 2026-07-24.
 * The reason string names the window, so the UI can distinguish "we hold no schedule for
 * today" from "no data yet" and from "0 min delay" — three very different statements that
 * a naive implementation renders identically.
 */
export function evaluateGates(i: GateInput): GateResult {
  const fail = (failed: string, reason: string): GateResult => ({ publish: false, reason, failed });

  if (!i.boardActive) {
    return fail('boardActive',
      `no calendar-active schedule for ${i.serviceDate}; the loaded board covers ${i.boardTag}`);
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
