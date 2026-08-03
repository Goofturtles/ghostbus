// xwalk — the learned RT-stop -> static-stop crosswalk, and RT pattern resolution.
//
// WHY THIS EXISTS. The TTC realtime feed and our static GTFS use DISJOINT stop-id
// namespaces. Measured on a live snapshot: of 10,262 (route, rt_stop_id) pairs, only 69
// (0.67%) name a stop that route actually serves in the static board. The tempting
// 59.3% global id overlap is pure numeric coincidence — the control measurement is
// decisive: for a bus reported STOPPED_AT rt-stop X, the static stop *numbered* X sits a
// median 13,703 m away, and 0 of 55 are within 100 m. Matching the ids directly would
// produce confident, plausible, completely wrong delays.
//
// So stop identity has to be LEARNED, from the one thing both namespaces share: physical
// position. When a vehicle reports currentStatus === STOPPED_AT with an rt stop id and a
// route, its coordinates name a static stop on that route (measured: nearest static stop
// on the route is a median 17.9 m away, 90 of 93 within 50 m). That is a geometric anchor.
//
// Geometric anchors alone are far too slow — only ~100 usable vehicles per cycle out of
// ~1,400. The multiplier is TRANSITIVE PROPAGATION: once a whole RT pattern is resolved
// to a static pattern, every stop on it is crosswalked, and those stops become anchors
// for other patterns. Iterating that to a fixpoint is what turns "usable in days" into
// "usable in hours".
//
// Everything here is pure: no database, no clock, no network. The DB-facing wrapper is
// engine.ts.

import { createHash } from 'node:crypto';
import type { StopPoint } from './patterns.ts';

// ---------- geometry ----------

// Local equirectangular approximation, centred on Toronto. Over the <200 m distances
// this module cares about, the error against a full haversine is far below a metre, and
// the stop spacing we must discriminate is tens of metres.
const M_LAT = 111_320;
const M_LON = 111_320 * Math.cos((43.70 * Math.PI) / 180); // ~80,540 m per degree of longitude

export function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return Math.hypot((lon1 - lon2) * M_LON, (lat1 - lat2) * M_LAT);
}

export interface NearestStop { stopId: string; distM: number; gapM: number }

/**
 * The static stop a STOPPED_AT vehicle is at, or null when the evidence is not clean.
 *
 * Two rejections, both deliberate:
 *  - `maxDistM` (default 80 m, about 2x the measured p90 of 44 m) rejects a vehicle that
 *    is not actually at a stop on this route.
 *  - `minGapM` (default 15 m) rejects TERMINAL-BAY AMBIGUITY: at a loop or terminal,
 *    several static stops sit within metres of each other, and picking the nearer by a
 *    hair would assign a whole pattern to the wrong bay. Measured gap to the second
 *    nearest is p10 10 m / p50 65 m, so this rejects roughly the worst tenth.
 */
export function nearestStopOnRoute(
  lat: number,
  lon: number,
  candidates: readonly StopPoint[],
  maxDistM = 80,
  minGapM = 15,
): NearestStop | null {
  let best: StopPoint | null = null;
  let d1 = Infinity;
  let d2 = Infinity;
  for (const c of candidates) {
    const d = metres(lat, lon, c.lat, c.lon);
    if (d < d1) { d2 = d1; d1 = d; best = c; } else if (d < d2) { d2 = d; }
  }
  if (!best || d1 > maxDistM) return null;
  const gap = d2 === Infinity ? Infinity : d2 - d1;
  if (gap < minGapM) return null;
  return { stopId: best.stopId, distM: d1, gapM: gap };
}

// ---------- RT pattern clustering ----------

export interface RtPattern {
  rtPatternId: string;
  routeId: string;
  /** stopSequence -> rt stop id. */
  seqStops: Map<number, string>;
  maxSeq: number;
  /** how many distinct RT trips have folded into this pattern. */
  nTrips: number;
}

export function rtPatternIdFor(routeId: string, seqStops: ReadonlyMap<number, string>): string {
  const parts = [...seqStops.entries()].sort((a, b) => a[0] - b[0]).map(([s, st]) => `${s}=${st}`);
  return createHash('sha1').update(`${routeId}|${parts.join(',')}`).digest('hex').slice(0, 16);
}

export interface MergeOptions {
  /** the route's longest static pattern; null when the route is unknown to the board. */
  maxStaticLen: number | null;
  /** shared sequences required before two RT trips may be called the same pattern. */
  minOverlap?: number;
  maxPatternsPerRoute?: number;
}

export type MergeOutcome =
  | { kind: 'merged'; pattern: RtPattern }
  | { kind: 'created'; pattern: RtPattern }
  | { kind: 'extended'; pattern: RtPattern }
  | { kind: 'capped'; pattern: null };

/**
 * Fold one RT trip's (stopSequence -> rt stop id) map into a route's pattern set.
 *
 * THE MERGE RULE, and why each clause is load-bearing:
 *  1. every SHARED sequence must agree. Disagreement means a different pattern, full stop.
 *  2. at least `minOverlap` (3) shared sequences. Without this floor a newborn trip
 *     publishing 1-2 stops fuses two genuinely distinct patterns that happen to share an
 *     origin — and newborns are exactly what we bind on.
 *  3. the merged pattern may not exceed the route's longest STATIC pattern. Without this
 *     cap the rule over-merges: a short-turn and a full run agree on their shared prefix,
 *     so route 52 fused into a phantom 78-stop pattern against a real maximum of 73.
 *     Structurally only ~0.7% of RT patterns genuinely exceed their route's static max,
 *     so an over-length merge is far more likely to be an artifact than a discovery.
 *
 * Note the merge rule is doing real work, not rubber-stamping: at route level the RT
 * (route, stopSequence) -> stopId map is NOT self-consistent (measured 6,340 agreements
 * against 11,728 conflicts on one snapshot), because opposite directions and branches
 * put different stops at the same sequence number. Splitting those apart is the point.
 */
export function mergeRtTrip(
  patterns: RtPattern[],
  routeId: string,
  seqStops: ReadonlyMap<number, string>,
  opts: MergeOptions,
): MergeOutcome {
  const minOverlap = opts.minOverlap ?? 3;
  const maxPatterns = opts.maxPatternsPerRoute ?? 48;
  let maxSeq = 0;
  for (const s of seqStops.keys()) if (s > maxSeq) maxSeq = s;

  let best: RtPattern | null = null;
  let bestShared = -1;
  for (const p of patterns) {
    if (p.routeId !== routeId) continue;
    let shared = 0;
    let conflict = false;
    const unionMax = p.maxSeq > maxSeq ? p.maxSeq : maxSeq;
    for (const [seq, stop] of seqStops) {
      const have = p.seqStops.get(seq);
      if (have === undefined) continue;
      if (have !== stop) { conflict = true; break; }
      shared++;
    }
    if (conflict) continue;
    // Clause 0: an EXACTLY identical stop map is the same pattern by definition, whatever
    // the overlap floor says. Without this, two newborn trips that both publish only
    // {1: X} would create two pattern objects with the same content hash — a duplicate
    // identity that collapses in every downstream map keyed by rtPatternId.
    const identical = shared === seqStops.size && shared === p.seqStops.size;
    if (!identical && shared < minOverlap) continue;
    if (opts.maxStaticLen != null && unionMax > opts.maxStaticLen) continue; // clause 3
    if (shared > bestShared) { bestShared = shared; best = p; }
  }

  if (best) {
    let extended = false;
    for (const [seq, stop] of seqStops) {
      if (!best.seqStops.has(seq)) { best.seqStops.set(seq, stop); extended = true; }
    }
    if (maxSeq > best.maxSeq) best.maxSeq = maxSeq;
    best.nTrips++;
    // The identity is derived from the stop list, so extending the pattern renames it.
    best.rtPatternId = rtPatternIdFor(routeId, best.seqStops);
    return { kind: extended ? 'extended' : 'merged', pattern: best };
  }

  if (patterns.filter((p) => p.routeId === routeId).length >= maxPatterns) {
    return { kind: 'capped', pattern: null };
  }
  const created: RtPattern = {
    rtPatternId: rtPatternIdFor(routeId, seqStops),
    routeId,
    seqStops: new Map(seqStops),
    maxSeq,
    nTrips: 1,
  };
  patterns.push(created);
  return { kind: 'created', pattern: created };
}

// ---------- resolution to a fixpoint ----------

export type PatternState = 'unresolved' | 'resolved' | 'ambiguous' | 'no_candidate' | 'quarantined';

export interface StaticPatternLite {
  patternId: string;
  /** index i corresponds to stop_sequence i+1. */
  stops: readonly string[];
}

export interface ResolveOptions {
  minAnchors?: number;
  maxIters?: number;
}

export interface ResolvedPattern {
  staticPatternId: string;
  iter: number;
  nAnchors: number;
}

export interface ResolveResult {
  resolved: Map<string, ResolvedPattern>;
  states: Map<string, PatternState>;
  /** rt stop id -> static stop id, NEWLY learned during this run (geo anchors excluded). */
  learned: Map<string, string>;
  /**
   * Every stop identity the resolved patterns implied this run, including ones that were
   * already known and were re-derived in agreement. `learned` alone is not enough for
   * vote counting: a stop discovered on the first cycle is in the seed on every later
   * cycle, so it would never appear in `learned` again and its vote count would freeze at
   * one — permanently below the confidence floor, making the crosswalk unable to ever
   * back a delay row. Re-derivation IS the evidence.
   */
  implied: Map<string, string>;
  /** rt stop ids where two different static stops were proposed — permanently unusable. */
  conflicted: Set<string>;
  iterations: number;
  newlyResolvedPerIter: number[];
}

/**
 * Resolve RT patterns to static patterns, iterating until nothing new resolves.
 *
 * Each iteration, an unresolved pattern gathers its anchors (geometric first, then the
 * crosswalk learned so far), and keeps only static patterns of the same route where
 * `stops[seq - 1]` equals the anchor's static stop for EVERY anchor. One violation
 * eliminates the candidate — the constraint is deliberately hard. Relaxing it to tolerate
 * a mismatch was measured to rescue only 39 of 137 no-candidate patterns while admitting a
 * wrong anchor, and a single wrong anchor shifts an entire pattern's delays by a constant
 * that no downstream shape check can detect.
 *
 * AMBIGUITY IS JUDGED ON THE IMPLIED CROSSWALK, NOT ON PATTERN IDENTITY. If several
 * candidate patterns survive but all of them map every sequence of P to the same static
 * stop, the choice between them is immaterial and we resolve. If they differ anywhere,
 * we stay silent.
 */
export function resolvePatterns(
  rtPatterns: readonly RtPattern[],
  byRoute: ReadonlyMap<string, readonly StaticPatternLite[]>,
  geoAnchors: ReadonlyMap<string, string>, // `${routeId}|${rtStopId}` -> static stop id
  seedXwalk: ReadonlyMap<string, string>,  // rt stop id -> static stop id, already known
  opts: ResolveOptions = {},
): ResolveResult {
  const minAnchors = opts.minAnchors ?? 2;
  const maxIters = opts.maxIters ?? 8;

  const working = new Map<string, string>(seedXwalk);
  const learned = new Map<string, string>();
  const implied = new Map<string, string>();
  const conflicted = new Set<string>();
  const resolved = new Map<string, ResolvedPattern>();
  const states = new Map<string, PatternState>();
  for (const p of rtPatterns) states.set(p.rtPatternId, 'unresolved');

  const newlyResolvedPerIter: number[] = [];
  let iter = 0;
  for (; iter < maxIters; iter++) {
    let newly = 0;
    for (const p of rtPatterns) {
      if (resolved.has(p.rtPatternId)) continue;

      // 1. anchors: geometry first (strongest), then whatever the crosswalk already knows.
      const anchors: Array<{ seq: number; rtStop: string; staticStopId: string; fromGeo: boolean }> = [];
      for (const [seq, rtStop] of p.seqStops) {
        if (conflicted.has(rtStop)) continue;
        const geo = geoAnchors.get(`${p.routeId}|${rtStop}`);
        const staticStopId = geo ?? working.get(rtStop);
        if (staticStopId) anchors.push({ seq, rtStop, staticStopId, fromGeo: geo !== undefined });
      }
      if (anchors.length < minAnchors) { states.set(p.rtPatternId, 'unresolved'); continue; }

      // 2. hard anchor constraint: one violation eliminates a candidate.
      const statics = byRoute.get(p.routeId) ?? [];
      const fits = (c: StaticPatternLite, as: typeof anchors): boolean =>
        as.every((a) => a.seq >= 1 && a.seq <= c.stops.length && c.stops[a.seq - 1] === a.staticStopId);
      let candidates = statics.filter((c) => fits(c, anchors));

      if (candidates.length === 0) {
        // Zero survivors can mean two very different things, and collapsing them would
        // hide a real error. Re-run on GEOMETRIC anchors alone: if candidates then survive,
        // the elimination was caused by a PROPAGATED crosswalk entry contradicting direct
        // observation. Geometry is measured and propagation is derived, so geometry wins —
        // and the offending entry is marked conflicted so it stops backing delay rows and
        // stops poisoning other patterns. Without this, a wrong propagated stop identity
        // would silently sterilise every pattern that touches it.
        const geoAnch = anchors.filter((a) => a.fromGeo);
        const geoCands = geoAnch.length >= minAnchors ? statics.filter((c) => fits(c, geoAnch)) : [];
        if (geoCands.length > 0) {
          for (const a of anchors) {
            if (a.fromGeo) continue;
            if (geoCands.some((c) => a.seq <= c.stops.length && c.stops[a.seq - 1] === a.staticStopId)) continue;
            conflicted.add(a.rtStop);
            working.delete(a.rtStop);
            learned.delete(a.rtStop);
            // …and retract its vote: a contested identity is not corroboration.
            implied.delete(a.rtStop);
          }
          candidates = geoCands;
        }
      }
      if (candidates.length === 0) { states.set(p.rtPatternId, 'no_candidate'); continue; }

      // 3. ambiguity on the implied crosswalk.
      const impliedHere = new Map<number, string>();
      let differs = false;
      for (const [seq] of p.seqStops) {
        let mapped: string | null = null;
        for (const c of candidates) {
          const s = seq >= 1 && seq <= c.stops.length ? c.stops[seq - 1] : null;
          if (s == null) continue;
          if (mapped == null) mapped = s;
          else if (mapped !== s) { differs = true; break; }
        }
        if (differs) break;
        if (mapped != null) impliedHere.set(seq, mapped);
      }
      if (differs) { states.set(p.rtPatternId, 'ambiguous'); continue; }

      // 4. resolve, and publish every stop identity it implies.
      resolved.set(p.rtPatternId, { staticPatternId: candidates[0].patternId, iter, nAnchors: anchors.length });
      states.set(p.rtPatternId, 'resolved');
      newly++;
      for (const [seq, staticStop] of impliedHere) {
        const rtStop = p.seqStops.get(seq);
        if (!rtStop || conflicted.has(rtStop)) continue;
        const prior = working.get(rtStop);
        if (prior === undefined) {
          working.set(rtStop, staticStop);
          learned.set(rtStop, staticStop);
          implied.set(rtStop, staticStop);
        } else if (prior === staticStop) {
          implied.set(rtStop, staticStop);   // independently re-derived: this is a vote
        } else {
          // Two resolutions disagree about one physical stop. Neither is trustworthy.
          conflicted.add(rtStop);
          working.delete(rtStop);
          learned.delete(rtStop);
          implied.delete(rtStop);
        }
      }
    }
    newlyResolvedPerIter.push(newly);
    if (newly === 0) { iter++; break; }
  }

  return { resolved, states, learned, implied, conflicted, iterations: iter, newlyResolvedPerIter };
}

// ---------- promotion and confidence ----------

export type XwalkState = 'candidate' | 'confirmed' | 'conflicted';

export interface XwalkEntry {
  rtStopId: string;
  stopId: string;
  votes: number;
  distinctPatterns: number;
  geoResidM: number | null;
  /**
   * 'geo' and 'propagated' are the LEARNED sources this module derives. 'identity' is
   * minted by the engine for an agency whose realtime ids ARE its static ids (MiWay et
   * al, measured at 99.6-100% direct correspondence) — only ever for an rt_stop_id the
   * loaded static board actually holds, and falsifiable per stop: a geometric anchor
   * naming a different stop conflicts it out. Separately, the `identityVerified` gate
   * refuses to WRITE delay rows until the membership rate and the geometric audit both
   * clear in aggregate. Nothing in THIS module creates one.
   */
  source: 'geo' | 'propagated' | 'identity';
  state: XwalkState;
  confidence: number;
}

export const XWALK_MIN_CONFIDENCE = 0.60;
/** Exported so the warm-start guard tests the same threshold promotion used. */
export const GEO_SELF_CONFIRM_M = 60;

/**
 * Time-domain validation of the STATIC PATTERN that implies a stop identity: how many
 * distinct origin-locked bindings have run on it and survived the consistency gate and
 * the per-pattern drift breaker, over how many distinct cycles.
 *
 * READ THE NAME CAREFULLY. This is not a second observation of the stop. A bound trip's
 * `staticStops[seq - 1]` is the very pattern entry that implied the mapping, so asking a
 * binding whether it agrees is asking the same inference twice. That was measured, not
 * assumed: over 23 live cycles, 37,319 binding "confirmations" of blocked mappings
 * produced 0 disagreements and 29 (0.08%) that came from a pattern the stop did not
 * already have. A test that cannot fail is not evidence — see §33 and BLOCKERS 17 for the
 * two previous times this project shipped one.
 *
 * What a surviving binding DOES establish is independent: the pattern was matched to a
 * scheduled slot at its origin, beat its runner-up by 120 s, and kept agreeing with the
 * schedule for cycles afterwards. That is evidence in the TIME domain about the pattern
 * assignment — the one thing that, if wrong, makes every identity the pattern implies
 * wrong together. It is the failure mode the two-pattern rule exists to catch, reached by
 * a different road.
 */
export interface PatternValidation {
  /** distinct origin-locked bindings that survived on the implying pattern. */
  bindings: number;
  /** distinct cycles in which at least one such binding was alive. */
  cycles: number;
}

/**
 * Thresholds for the second promotion path, derived from the held-out-geometry run in
 * DECISIONS §46 (one-pattern mappings, the arm of the experiment where errors exist):
 *
 *     validating bindings N=0  89.81% (n=363)   validating cycles M=0  89.81% (n=363)
 *                         N=1 100.00% (n= 25)                     M=1 100.00% (n= 23)
 *                       N=2-3  97.48% (n=159)                     M=2 100.00% (n= 23)
 *                       N=4-7 100.00% (n=140)                    M>=3  98.5% (n=278)
 *
 * Any validation at all lifts a one-pattern mapping from 89.81% to 97.5-100%, so the
 * thresholds are set at the first level the measurement actually covers rather than at
 * the highest number the data would tolerate: 2 bindings across 2 distinct cycles. One of
 * each was measured at 100% too, but on 23-25 samples, and a single long-dwelling vehicle
 * can produce one binding in one cycle. Two of each cannot come from one trip.
 */
export const MIN_VALIDATING_BINDINGS = 2;
export const MIN_VALIDATING_CYCLES = 2;

/**
 * Promotion. An entry becomes `confirmed` on any ONE of three paths:
 *
 *  1. two independent RT patterns agree on it;
 *  2. it is a geometric anchor whose own centroid sits within 60 m of the stop it names;
 *  3. one pattern implies it, that pattern has been validated in the time domain by at
 *     least MIN_VALIDATING_BINDINGS surviving bindings across MIN_VALIDATING_CYCLES
 *     distinct cycles, AND the stop it names is not structurally ambiguous.
 *
 * `structurallyAmbiguous` is the safety condition path 3 cannot go without, and it is
 * measured rather than assumed. The obvious guard — require the corroborating bindings to
 * be direction-consistent, since direction_id names the two sides of a street — was
 * checked against the board first: of 4,262 same-route stop pairs within 80 m of each
 * other, only 3,375 (79.19%) have no direction in common. For the other 887 (20.81%)
 * direction_id cannot separate the platforms at all, so a direction check would have read
 * as a safeguard while silently passing one adjacent pair in five. `structurallyAmbiguous`
 * is the condition direction_id was supposed to approximate, taken directly: is there
 * another stop on this route within 80 m that is served in the SAME direction? If so,
 * nothing available to this engine can tell the two apart, and path 3 refuses.
 *
 * A second, different static stop id for the same rt stop id marks it `conflicted` —
 * permanently unusable until the board tag changes, because we cannot tell which
 * observation was the wrong one.
 */
export function promotionState(
  distinctPatterns: number,
  source: 'geo' | 'propagated',
  geoResidM: number | null,
  hasConflict: boolean,
  validation: PatternValidation | null = null,
  structurallyAmbiguous = false,
): XwalkState {
  if (hasConflict) return 'conflicted';
  if (distinctPatterns >= 2) return 'confirmed';
  if (source === 'geo' && geoResidM != null && geoResidM <= GEO_SELF_CONFIRM_M) return 'confirmed';
  if (
    distinctPatterns >= 1 &&
    !structurallyAmbiguous &&
    validation != null &&
    validation.bindings >= MIN_VALIDATING_BINDINGS &&
    validation.cycles >= MIN_VALIDATING_CYCLES
  ) return 'confirmed';
  return 'candidate';
}

/**
 * The bookkeeping behind `PatternValidation`, kept pure so its retraction rules can be
 * tested without a database. Three properties earn that separation, because all three
 * were wrong in the first draft and none of them is visible from a passing coverage
 * number:
 *
 *  1. **Cycles are held per TRIP, not per pattern.** A pattern-level cycle counter kept
 *     counting cycles contributed by bindings that were later voided, so two bindings
 *     credited in one cycle could clear a two-cycle floor on the strength of a third
 *     binding the audits had already thrown out.
 *  2. **Distrust is permanent and order-independent.** When the per-trip consistency gate
 *     catches a pattern contradicting the crosswalk, deleting its credit is not enough:
 *     sibling bindings on the same pattern, reached later in the same settle pass, put it
 *     straight back. The pattern is marked, and marked patterns never validate again.
 *  3. **Validation is read off ONE pattern.** Taking the largest binding count from one
 *     pattern and the largest cycle count from another reports a strength no pattern has.
 */
export interface PatternCreditStore {
  /** One binding survived a settle cycle on this pattern. */
  credit(staticPatternId: string, rtTripId: string, cycle: number): void;
  /** This binding was voided; it was never evidence, and its cycles go with it. */
  retractTrip(staticPatternId: string, rtTripId: string): void;
  /** The consistency gate caught this pattern. It may never validate anything again. */
  distrust(staticPatternId: string): void;
  /** The best-validated single pattern among those given, or null. */
  validation(staticPatternIds: Iterable<string>): PatternValidation | null;
  /**
   * Has the consistency gate caught any of these patterns?
   *
   * `validation()` answers null for two different situations — a pattern the audit
   * REJECTED, and a pattern that simply has not earned credit yet — and the difference
   * decides whether a confirmed crosswalk entry should be taken away. This separates
   * them, so a caller can demote on withdrawn evidence without also demoting on
   * evidence that has not been re-earned. See `demoteUnvalidated` in engine.ts.
   */
  anyDistrusted(staticPatternIds: Iterable<string>): boolean;
  clear(): void;
  readonly size: number;
}

export function createPatternCreditStore(): PatternCreditStore {
  const credits = new Map<string, Map<string, Set<number>>>();
  const distrusted = new Set<string>();
  return {
    credit(staticPatternId, rtTripId, cycle) {
      if (distrusted.has(staticPatternId)) return;
      let trips = credits.get(staticPatternId);
      if (!trips) { trips = new Map(); credits.set(staticPatternId, trips); }
      let cycles = trips.get(rtTripId);
      if (!cycles) { cycles = new Set(); trips.set(rtTripId, cycles); }
      // Capped at the threshold: beyond it the exact count changes no decision, and an
      // all-day trip would otherwise grow a set entry every cycle.
      if (cycles.size < MIN_VALIDATING_CYCLES) cycles.add(cycle);
    },
    retractTrip(staticPatternId, rtTripId) {
      const trips = credits.get(staticPatternId);
      if (!trips) return;
      trips.delete(rtTripId);
      if (trips.size === 0) credits.delete(staticPatternId);
    },
    distrust(staticPatternId) {
      distrusted.add(staticPatternId);
      credits.delete(staticPatternId);
    },
    validation(staticPatternIds) {
      let best: PatternValidation | null = null;
      for (const patternId of staticPatternIds) {
        if (distrusted.has(patternId)) continue;
        const trips = credits.get(patternId);
        if (!trips || trips.size === 0) continue;
        const cycles = new Set<number>();
        for (const cs of trips.values()) for (const c of cs) cycles.add(c);
        const here = { bindings: trips.size, cycles: cycles.size };
        if (!best || Math.min(here.bindings, here.cycles) > Math.min(best.bindings, best.cycles)) best = here;
      }
      return best;
    },
    anyDistrusted(staticPatternIds) {
      for (const patternId of staticPatternIds) if (distrusted.has(patternId)) return true;
      return false;
    },
    clear() { credits.clear(); distrusted.clear(); },
    get size() { return credits.size; },
  };
}

/** Does this validation clear both floors of the second promotion path? */
export function validationSufficient(v: PatternValidation | null): boolean {
  return v != null && v.bindings >= MIN_VALIDATING_BINDINGS && v.cycles >= MIN_VALIDATING_CYCLES;
}

/** Metres within which two stops on one route are close enough to be confused. */
export const ADJACENT_STOP_M = 80;

/**
 * The stops for which the adjacent-platform failure mode is structurally possible: a stop
 * with another stop on the SAME ROUTE within ADJACENT_STOP_M that is served in the SAME
 * DIRECTION. Measured on the live board: 1,484 of 9,361 stops (15.85%).
 *
 * The same-direction clause is what makes this a real filter rather than a distance
 * threshold. Two platforms across a street from each other are almost always the two
 * directions of the route, and the crosswalk's own machinery — geometric anchors,
 * propagation, bindings — all carry direction implicitly through the pattern. It is the
 * pairs that share a direction that nothing here can separate.
 *
 * O(stops^2) per route, run once when the pattern index is loaded, never per cycle.
 */
export function structurallyAmbiguousStops(
  routeStops: ReadonlyMap<string, readonly StopPoint[]>,
  dirsOfStop: ReadonlyMap<string, ReadonlySet<number | null>>,
): Set<string> {
  const out = new Set<string>();
  for (const stops of routeStops.values()) {
    for (let i = 0; i < stops.length; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        const a = stops[i], b = stops[j];
        if (out.has(a.stopId) && out.has(b.stopId)) continue;
        if (metres(a.lat, a.lon, b.lat, b.lon) > ADJACENT_STOP_M) continue;
        const da = dirsOfStop.get(a.stopId);
        const db = dirsOfStop.get(b.stopId);
        if (!da || !db) continue;
        let shared = false;
        for (const d of da) if (db.has(d)) { shared = true; break; }
        if (shared) { out.add(a.stopId); out.add(b.stopId); }
      }
    }
  }
  return out;
}

/**
 * `votes` is the number of independent cycles in which this identity was re-derived and
 * agreed. A stop that flaps between two static ids never accumulates votes — it is marked
 * conflicted instead — so votes measure corroboration, not merely uptime.
 *
 * A propagated entry has no geometric residual of its own. It is NOT penalised twice for
 * that: the residual factor is 1 (no evidence of error) and the 0.85 source discount is
 * what encodes "derived rather than measured". Applying an extra penalty for the missing
 * residual capped propagated entries at 0.595 — permanently below the 0.60 usability
 * floor, which would have made transitive propagation, the single largest source of
 * coverage, incapable of ever backing a delay row.
 */
export function xwalkConfidence(
  votes: number,
  geoResidM: number | null,
  source: 'geo' | 'propagated',
): number {
  const byVotes = Math.min(1, votes / 10);
  const resid = geoResidM == null ? 1 : clamp(1 - geoResidM / 60, 0.2, 1);
  return byVotes * resid * (source === 'geo' ? 1.0 : 0.85);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Confidence for an entry that SEVERAL independent sources name the same static stop for.
 *
 * The rule is that corroboration may never make us less sure. It used not to hold. A
 * geometric anchor overwrote a propagated entry outright, and geometry carries a residual
 * penalty that propagation does not: `1 - resid/60` is below the 0.60 usability floor for
 * any residual over 24 m, while `nearestStopOnRoute` accepts up to 80 m. So a stop that
 * propagation supported at 0.85 was demoted to 0.33 the moment a vehicle was seen 40 m
 * from it — WHILE AGREEING about which stop it was. Two agreeing lines of evidence
 * yielding less than one is incoherent, and it is expensive: measured on a live snapshot,
 * 3,185 of 23,636 StopTimeUpdate occurrences (13.5%) resolved to an entry that was
 * `confirmed` and under the floor for exactly this reason.
 *
 * Taking the best of the agreeing sources admits nothing that either source would not have
 * admitted alone, so this is not a loosened threshold — it is the removal of a penalty for
 * having more evidence. The residual still caps what GEOMETRY ALONE is worth, which is the
 * question it can actually answer.
 */
export function corroboratedConfidence(
  votes: number,
  geoResidM: number | null,
  sources: { geo: boolean; propagated: boolean },
): number {
  let best = 0;
  if (sources.geo) best = Math.max(best, xwalkConfidence(votes, geoResidM, 'geo'));
  if (sources.propagated) best = Math.max(best, xwalkConfidence(votes, null, 'propagated'));
  return best;
}

/** Only a confirmed, sufficiently-confident entry may back a written delay row. */
export function usableForDelay(e: Pick<XwalkEntry, 'state' | 'confidence'> | undefined | null): boolean {
  return !!e && e.state === 'confirmed' && e.confidence >= XWALK_MIN_CONFIDENCE;
}

// ---------- falsifiable audits (no ground truth required) ----------

/**
 * CROSS-ROUTE AGREEMENT. An rt stop id seen on two or more routes must resolve to the
 * same static stop from each route independently. This is the only honest accuracy
 * estimate available before the static board activates — it can fail, and a failure means
 * the crosswalk is wrong, not merely thin.
 */
export function crossRouteAgreement(
  perRoute: ReadonlyMap<string, ReadonlyMap<string, string>>, // routeId -> (rtStopId -> staticStopId)
): { agree: number; total: number; rate: number | null } {
  const seen = new Map<string, Set<string>>();
  for (const byStop of perRoute.values()) {
    for (const [rtStop, staticStop] of byStop) {
      let s = seen.get(rtStop);
      if (!s) { s = new Set(); seen.set(rtStop, s); }
      s.add(staticStop);
    }
  }
  const counts = new Map<string, number>();
  for (const byStop of perRoute.values()) {
    for (const rtStop of byStop.keys()) counts.set(rtStop, (counts.get(rtStop) ?? 0) + 1);
  }
  let agree = 0;
  let total = 0;
  for (const [rtStop, routes] of counts) {
    if (routes < 2) continue;
    total++;
    if ((seen.get(rtStop)?.size ?? 0) === 1) agree++;
  }
  return { agree, total, rate: total === 0 ? null : agree / total };
}

/**
 * Resolve one bound trip's tracked RT stops — handed in RT stop_sequence order — to the
 * STATIC stop_sequences the crosswalk claims they occupy on the bound static pattern.
 * This is the input `monotonicityViolations` has to be given.
 *
 * WHY THIS FUNCTION EXISTS. `runCycle` used to pass the binding's own RT stop sequences,
 * sorted. Those are ascending by construction, so the audit compared a strictly increasing
 * list against itself and returned 0 violations on every possible input: a gate that
 * reported "healthy" because it was structurally incapable of reporting anything else.
 * The falsifiable property is about the STATIC side — a crosswalk error shows up as the
 * static sequence going backwards while the realtime sequence goes forwards.
 *
 * TWO DELIBERATE LENIENCIES, so that a reported violation is always a real one:
 *  - A static pattern can visit the same stop twice (loops, turnbacks, on-street
 *    terminals). Where a stop has several occurrences we take the earliest one that still
 *    increases, which is the choice that maximises the remaining options — so a violation
 *    is reported only when NO monotone assignment exists at all.
 *  - Stops the crosswalk cannot name, and stops it names that are not on this pattern,
 *    are skipped. An absent identity is not evidence of disorder, and a named stop that
 *    is off-pattern is the per-trip consistency gate's business (`delay.ts`), which is
 *    stricter than this one and voids the trip outright.
 *
 * Only entries that could actually back a published row are audited, so the gate covers
 * exactly the crosswalk the product would be relying on.
 */
export function crosswalkedStaticSeqs(
  rtStopsInRtOrder: readonly string[],
  staticStops: readonly string[],
  xwalk: ReadonlyMap<string, Pick<XwalkEntry, 'stopId' | 'state' | 'confidence'>>,
): number[] {
  const occurrences = new Map<string, number[]>();
  for (let i = 0; i < staticStops.length; i++) {
    let a = occurrences.get(staticStops[i]);
    if (!a) { a = []; occurrences.set(staticStops[i], a); }
    a.push(i + 1); // stop_sequence is 1-based
  }
  const out: number[] = [];
  let prev = 0;
  for (const rtStop of rtStopsInRtOrder) {
    const e = xwalk.get(rtStop);
    if (!usableForDelay(e)) continue;
    const occ = occurrences.get((e as XwalkEntry).stopId);
    if (!occ || occ.length === 0) continue;
    // Earliest occurrence that keeps the run increasing; failing that, the earliest one at
    // all — which is <= prev and so surfaces as the violation it is.
    const chosen = occ.find((s) => s > prev) ?? occ[0];
    out.push(chosen);
    prev = chosen;
  }
  return out;
}

/**
 * MONOTONICITY. Within one bound trip, the crosswalked static stops must appear in
 * strictly increasing static stop_sequence order. A violation means the crosswalk has
 * mapped two RT stops to static stops that are out of order — a structural error the
 * geometry alone cannot catch.
 *
 * Feed this `crosswalkedStaticSeqs(...)`, never the realtime sequences: see that
 * function's note on why the realtime side makes the audit tautological.
 */
export function monotonicityViolations(
  trips: ReadonlyArray<{ staticSeqs: readonly number[] }>,
): { violations: number; total: number; rate: number | null } {
  let violations = 0;
  let total = 0;
  for (const t of trips) {
    if (t.staticSeqs.length < 2) continue;
    total++;
    for (let i = 1; i < t.staticSeqs.length; i++) {
      if (t.staticSeqs[i] <= t.staticSeqs[i - 1]) { violations++; break; }
    }
  }
  return { violations, total, rate: total === 0 ? null : violations / total };
}
