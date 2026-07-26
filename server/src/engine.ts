// engine — the database-facing delay engine. Everything algorithmic lives in the pure
// modules (patterns / xwalk / bind / delay / gates); this file owns the state that has to
// survive a cycle, the SQL, and the order of operations.
//
// Per cycle, in this order:
//   a. accumulate geometric anchors from STOPPED_AT vehicles
//   b. cluster RT trip updates into RT patterns
//   c. resolve those patterns to static patterns, iterating to a fixpoint
//   d. capture births, and origin-lock the ones whose pattern has become resolvable
//   e. settle and emit delay rows for bound trips
//   f. evaluate the honesty gates, which decide whether anything is written at all
//
// The crosswalk half (a-c) is CALENDAR-INDEPENDENT: it works, and warms, today, months
// before the loaded board activates. The binding half (d-f) is gated off until it does.

import type { Db } from './db.ts';
import {
  boardFingerprint, loadOrBuildPatternIndex, emptyPatternIndex,
  type PatternIndex, type StaticTripSlot,
} from './patterns.ts';
import {
  nearestStopOnRoute, mergeRtTrip, resolvePatterns, promotionState,
  crossRouteAgreement, monotonicityViolations, crosswalkedStaticSeqs, corroboratedConfidence,
  structurallyAmbiguousStops, GEO_SELF_CONFIRM_M, createPatternCreditStore, validationSufficient,
  type RtPattern, type StaticPatternLite, type XwalkEntry, type PatternState,
  type PatternValidation, type XwalkState,
} from './xwalk.ts';
import { originLock, preferBinding, type LockAnchor, type LockSlot, type LockResult } from './bind.ts';
import {
  settleTrip, addCounters, emptyCounters, type TrackedStop, type DelayRow, type SettleCounters,
} from './delay.ts';
import { evaluateGates, patternHealthy, type GateResult } from './gates.ts';

/**
 * Collapse rows that share a conflict key, last writer winning.
 *
 * Postgres rejects an INSERT ... ON CONFLICT DO UPDATE whose own VALUES list names the
 * same key twice ("ON CONFLICT DO UPDATE command cannot affect row a second time"), and
 * it rejects the WHOLE statement — so one duplicate silently costs the entire batch. This
 * is not defensive padding: it was found by running the engine against the live feed,
 * where the crosswalk persist failed on three of eight cycles. RT patterns are identified
 * by a content hash, so two pattern objects can legitimately carry one identity.
 *
 * `keyCols` is how many LEADING columns form the conflict target, which is why every
 * table in migration 004 puts its primary key first.
 */
export function dedupeByKey(rows: readonly unknown[][], keyCols: number): unknown[][] {
  // U+001F never appears in a GTFS id, so composite keys cannot collide by concatenation.
  const SEP = String.fromCharCode(31);
  const out = new Map<string, unknown[]>();
  for (const r of rows) out.set(r.slice(0, keyCols).join(SEP), r as unknown[]);
  return [...out.values()];
}

const AGENCY_DEFAULT = 'ttc';
/** A vehicle ping older than this is not evidence of where the bus is now. */
const ANCHOR_MAX_AGE_S = 120;
/** A pending birth we still cannot bind after this long is given up on. */
const BIRTH_EXPIRY_S = 3600;
/** How many recent bindings the board-agreement gate looks at. */
const BOARD_AGREEMENT_WINDOW = 200;
const XWALK_MIN_CONF = 0.60;

// ---------- inputs the poller hands us ----------

export interface EngineVehicle {
  vehicleId: string;
  routeId: string | null;
  rtTripId: string | null;
  rtStopId: string | null;
  /** presentInt(v,'currentStatus') — null when absent on the wire, NOT 2. */
  currentStatus: number | null;
  lat: number;
  lon: number;
  tsS: number | null;
}

export interface EngineStopUpdate {
  stopSequence: number | null;
  rtStopId: string | null;
  epochS: number | null;
  kind: 'arrival' | 'departure';
  noData: boolean;
}

export interface EngineTripUpdate {
  rtTripId: string;
  routeId: string | null;
  scheduleRelationship: number | null;
  stops: EngineStopUpdate[];
}

export interface EngineCycleInput {
  nowMs: number;
  serviceDate: number;
  vehicles: EngineVehicle[];
  tripUpdates: EngineTripUpdate[];
  /** calendar-active static service_ids for this service date. */
  activeServices: Set<string>;
}

// ---------- stats surfaced through getJoinStats().delayEngine ----------

export interface DelayEngineStats {
  boardTag: string;
  boardActive: boolean;
  activeServiceIds: number;
  indexReady: boolean;
  indexPatterns: number;
  indexBuildMs: number;
  directTripIdMatchRate: number;
  xwalk: {
    rtStopsSeen: number; confirmed: number; conflicted: number; occurrenceCoverage: number;
    crossRouteAgreement: number | null; medianResidM: number | null; unhealthy: boolean;
  };
  patterns: {
    rtTotal: number; resolved: number; ambiguous: number; noCandidate: number;
    tooFewAnchors: number; quarantined: number; maxResolveIter: number;
  };
  bindings: {
    births: number; pending: number; active: number; locked: number;
    refusedAmbiguous: number; refusedMidroute: number; refusedUnresolved: number;
    refusedTooFewAnchors: number; refusedHeadwayBand: number; refusedBoardInactive: number;
    refusedNoSlot: number; refusedScheduleRelationship8: number; doubleBookRejected: number;
    medianFirstStopResidS: number | null; boardAgreementOk: boolean;
  };
  obs: SettleCounters & { droppedNoBinding: number; suppressedByGate: number };
  suppressionReason: string | null;
  suppressionGate: string | null;
}

// ---------- state that survives a cycle ----------

interface AnchorAcc { n: number; sumLat: number; sumLon: number; vehicles: Set<string> }

interface Birth {
  rtTripId: string;
  routeId: string;
  /** the first predicted event, captured at BIRTH and never refreshed. */
  predFirstEpochS: number;
  minSeq: number;
  anchors: Array<{ stopSequence: number; predEpochS: number }>;
  rtStops: Map<number, string>;
  bornAtS: number;
}

interface Binding {
  rtTripId: string;
  staticTripId: string;
  routeId: string;
  rtPatternId: string;
  staticPatternId: string;
  confidence: 'high' | 'low';
  marginS: number | null;
  headwayS: number | null;
  residS: number | null;
  agree: number;
  slot: StaticTripSlot;
  tracked: Map<number, TrackedStop>;
}

export interface DelayEngine {
  reloadStatic(boardTag: string): Promise<void>;
  runCycle(inp: EngineCycleInput): Promise<{ rows: number; gate: GateResult }>;
  getStats(): DelayEngineStats;
  /** static trip ids currently believed present, for ghost detection. */
  getPresentStaticTrips(): Set<string>;
  /** rt trip id -> bound STATIC trip id, for the live-prediction store. */
  getBindingsByRtTrip(): Map<string, string>;
  /** the confirmed static stop for an RT stop id, or null when we do not know it. */
  staticStopFor(rtStopId: string): string | null;
  isReady(): boolean;
  getIndex(): PatternIndex;
}

/**
 * `agency` is the STATIC board to read (the seeded GTFS schedule). `writeAgency` is the
 * namespace every learned or observed row is written under, and it defaults to `agency`
 * so the live path is unchanged.
 *
 * They differ in exactly one case: a recorded replay (Demo Mode) reads the same published
 * board a live run reads — a schedule is not an observation, and there is only one — while
 * writing its crosswalk, bindings, delay observations and slot claims under 'ttc-demo'.
 * That makes the spec's "never blend demo and live data" rule a property of the primary
 * keys rather than of anyone's discipline: every read here is already agency-filtered, so
 * neither mode can see the other's rows even by accident.
 */
export function createDelayEngine(db: Db, agency: string = AGENCY_DEFAULT, writeAgency: string = agency): DelayEngine {
  let index: PatternIndex = emptyPatternIndex();
  let boardTag = '?..?';
  let ready = false;

  // Crosswalk state, all scoped to the current board tag.
  const anchors = new Map<string, AnchorAcc>();          // `${routeId}|${rtStopId}`
  const dwellSeen = new Map<string, string>();           // vehicleId -> rtStopId of current dwell
  const geoAnchors = new Map<string, string>();          // `${routeId}|${rtStopId}` -> static stop id
  const geoResid = new Map<string, number>();
  const xwalk = new Map<string, XwalkEntry>();
  const xwalkProposals = new Map<string, Set<string>>(); // rtStopId -> static stop ids ever proposed
  const xwalkVotes = new Map<string, number>();
  /**
   * rtStopId -> every STATIC pattern that has agreed on this stop's identity, accumulated.
   *
   * This is the evidence `promotionState` weighs, and it used to be recounted from scratch
   * every cycle off the patterns resolved in THAT cycle. Corroboration is a historical
   * fact, not a property of the current minute: a stop confirmed by two patterns at
   * 08:00 fell back to `candidate` at 03:00 when only one of them was running. The live
   * run shows exactly that oscillation (confirmed 3,043 -> 3,031 -> 3,019 -> 3,025 -> 3,042
   * over five consecutive cycles) and occurrence coverage drifting DOWN, 36.4% -> 35.3%,
   * while the crosswalk was still learning.
   *
   * Keyed by STATIC pattern id rather than RT pattern id on purpose: an RT pattern's id is
   * a content hash, so extending it renames it, and counting RT ids would let one line of
   * evidence corroborate itself under two names. Two RT patterns that are really one
   * resolve to the same static pattern and collapse to one vote here.
   */
  const xwalkAgreeingPatterns = new Map<string, Set<string>>();
  /** distinct_patterns restored from the database, so a warm start does not forget it. */
  const xwalkDistinctFloor = new Map<string, number>();
  /**
   * staticPatternId -> the bindings that have RUN and SURVIVED on it, and how many
   * distinct cycles they covered. This is the evidence behind the second promotion path
   * (xwalk.ts, `PatternValidation`), and "survived" is the load-bearing word: a binding is
   * credited only after it has cleared the per-trip consistency gate and the per-pattern
   * drift breaker in a cycle, and its credit is taken back when either later voids it.
   * Crediting at lock time instead would count the bindings the audits went on to reject.
   */
  const patternValidation = createPatternCreditStore();
  /**
   * Stops where the adjacent-platform failure mode is structurally possible. Computed once
   * per pattern-index load; the second promotion path refuses on every stop in here.
   */
  let ambiguousStops = new Set<string>();
  const conflictedStops = new Set<string>();
  const rtPatterns: RtPattern[] = [];
  const rtPatternByTrip = new Map<string, RtPattern>();
  const patternStates = new Map<string, PatternState>();
  const quarantined = new Set<string>();
  const patternResid = new Map<string, number[]>();      // staticPatternId -> recent |resid|
  let resolvedStatic = new Map<string, string>();        // rtPatternId -> staticPatternId
  let resolvedIter = new Map<string, number>();

  // Binding state.
  const births = new Map<string, Birth>();
  const bindings = new Map<string, Binding>();
  const refusedTrips = new Map<string, string>();
  const claimedStatic = new Map<string, string>();       // staticTripId -> rtTripId
  const firstStopResids: number[] = [];
  let serviceDateOfState = 0;
  /** Monotonic cycle counter, so binding validation can count DISTINCT cycles. */
  let cycleSeq = 0;

  const stats = blankStats();
  let lastGate: GateResult = { publish: false, reason: 'engine has not run a cycle yet', failed: 'boot' };

  function blankStats(): DelayEngineStats {
    return {
      boardTag: '?..?', boardActive: false, activeServiceIds: 0, indexReady: false,
      indexPatterns: 0, indexBuildMs: 0, directTripIdMatchRate: 0,
      xwalk: {
        rtStopsSeen: 0, confirmed: 0, conflicted: 0, occurrenceCoverage: 0,
        crossRouteAgreement: null, medianResidM: null, unhealthy: false,
      },
      patterns: {
        rtTotal: 0, resolved: 0, ambiguous: 0, noCandidate: 0, tooFewAnchors: 0,
        quarantined: 0, maxResolveIter: 0,
      },
      bindings: {
        births: 0, pending: 0, active: 0, locked: 0, refusedAmbiguous: 0, refusedMidroute: 0,
        refusedUnresolved: 0, refusedTooFewAnchors: 0, refusedHeadwayBand: 0,
        refusedBoardInactive: 0, refusedNoSlot: 0, refusedScheduleRelationship8: 0,
        doubleBookRejected: 0, medianFirstStopResidS: null, boardAgreementOk: true,
      },
      obs: { ...emptyCounters(), droppedNoBinding: 0, suppressedByGate: 0 },
      suppressionReason: null, suppressionGate: null,
    };
  }

  function med(a: readonly number[]): number | null {
    if (a.length === 0) return null;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function rtStopOfKey(key: string): string { return key.slice(key.indexOf('|') + 1); }
  function routeOfKey(key: string): string { return key.slice(0, key.indexOf('|')); }
  function fireAndLog(p: Promise<unknown>, what: string): void {
    p.catch((e) => console.error(`[engine] ${what} failed:`, e instanceof Error ? e.message : e));
  }

  // ---------- static reload ----------

  /**
   * Make the static pattern index current. Called on boot and every 6 hours.
   *
   * THIS USED TO READ 2.15M stop_times ROWS EVERY TIME, on a free-tier database with a
   * monthly transfer quota — four rebuilds in one session spent the month. Now the first
   * thing it does is take a one-row fingerprint of the static board, and three outcomes
   * follow from it:
   *
   *   unchanged        keep the index we already hold and read nothing else at all. This
   *                    is the 6-hourly reload's normal case, and it now costs one row.
   *   changed          rebuild, and cache the result for the next boot.
   *   unfingerprintable  rebuild, and cache nothing. Never guess.
   *
   * A boot has no index yet, so it falls through to loadOrBuildPatternIndex, which
   * restores the cached blob when the fingerprint proves it still describes this board.
   */
  async function reloadStatic(newBoardTag: string): Promise<void> {
    const fingerprint = await boardFingerprint(db, agency);
    if (ready && boardTag === newBoardTag && fingerprint !== null && index.fingerprint === fingerprint) {
      console.log(`[engine] board ${boardTag} is unchanged (fingerprint ${fingerprint.slice(0, 12)}) ` +
        '— keeping the loaded index, no static read');
      // The reload still gets to retry a crosswalk restore that failed at boot. loadCrosswalk
      // swallows its own errors (a failed restore costs warm-up, not correctness), so before
      // this early return existed the 6-hourly reload was the only thing that ever tried
      // again. That retry is worth keeping: it reads rt_stop_xwalk, which is thousands of
      // rows, not the 2.15M this early return is here to avoid.
      if (xwalk.size === 0) await loadCrosswalk();
      return;
    }
    const next = await loadOrBuildPatternIndex(db, agency, newBoardTag, fingerprint);
    const boardChanged = newBoardTag !== boardTag && boardTag !== '?..?';
    index = next;
    boardTag = newBoardTag;
    ready = true;
    recomputeAmbiguousStops();
    if (boardChanged) {
      // A new board is a new set of stop identities. Carrying the old crosswalk across
      // would silently map realtime stops onto a schedule they were never learned from.
      anchors.clear(); dwellSeen.clear(); geoAnchors.clear(); geoResid.clear();
      xwalk.clear(); xwalkProposals.clear(); xwalkVotes.clear(); conflictedStops.clear();
      xwalkAgreeingPatterns.clear(); xwalkDistinctFloor.clear();
      rtPatterns.length = 0; rtPatternByTrip.clear(); patternStates.clear(); quarantined.clear();
      patternResid.clear(); births.clear(); bindings.clear(); refusedTrips.clear();
      claimedStatic.clear(); firstStopResids.length = 0;
      patternValidation.clear();
      resolvedStatic = new Map(); resolvedIter = new Map();
      console.log(`[engine] board changed to ${boardTag} — crosswalk and bindings invalidated`);
    }
    // COLD START. `rt_stop_xwalk` used to be written and never read, so every restart began
    // from an empty crosswalk and needed ~8 cycles (a propagated entry needs 8 corroborating
    // votes to clear the 0.60 floor) before it could back anything at all. On a host that
    // sleeps when idle that warm-up is longer than the uptime, so the engine would publish
    // nothing, ever. Only on a genuinely cold crosswalk: a periodic reload of the same board
    // must not stomp on fresher in-memory state with the row we ourselves wrote.
    if (xwalk.size === 0) await loadCrosswalk();
    console.log(`[engine] pattern index: ${index.patterns.size} patterns, ${index.tripIds.size} trips, ` +
      `${index.routeStops.size} routes with geometry (${(index.elapsedMs / 1000).toFixed(1)}s, ${index.source})`);
  }

  /**
   * Which stops the adjacent-platform failure mode can reach on THIS board. Recomputed
   * whenever the index is replaced, because it is a property of the schedule's geometry.
   * Roughly a second on the live board (225 routes, 9,361 stops), paid once per index
   * load against a 30-70 s build — never on a cycle.
   */
  function recomputeAmbiguousStops(): void {
    const dirsOfStop = new Map<string, Set<number | null>>();
    for (const p of index.patterns.values()) {
      for (const stopId of p.stops) {
        let d = dirsOfStop.get(stopId);
        if (!d) { d = new Set(); dirsOfStop.set(stopId, d); }
        d.add(p.dirId);
      }
    }
    const t0 = Date.now();
    ambiguousStops = structurallyAmbiguousStops(index.routeStops, dirsOfStop);
    console.log(`[engine] ${ambiguousStops.size} of ${dirsOfStop.size} static stops are structurally ` +
      `ambiguous (a same-route stop within 80 m served the same direction) — the second ` +
      `promotion path refuses on these (${Date.now() - t0} ms)`);
  }

  /** The validation held by the best-validated pattern that agrees on this stop. */
  function validationFor(rtStop: string): PatternValidation | null {
    const agreeing = xwalkAgreeingPatterns.get(rtStop);
    if (!agreeing || agreeing.size === 0) return null;
    return patternValidation.validation(agreeing);
  }

  /**
   * Credit a binding that has just survived a full settle cycle. Called only after the
   * per-trip consistency gate and the per-pattern drift breaker have both passed for it,
   * so the credit means "this pattern ran against the schedule and the audits did not
   * object", not "this pattern was guessed at once".
   */
  function creditBinding(b: Binding): void {
    patternValidation.credit(b.staticPatternId, b.rtTripId, cycleSeq);
  }

  /** Take the credit back. A binding the audits later rejected was never evidence. */
  function retractBinding(b: Binding, wholePattern: boolean): void {
    // The consistency gate fired: the pattern ASSIGNMENT is in doubt, so no binding on
    // it — past, present or later this cycle — counts as validation again.
    if (wholePattern) patternValidation.distrust(b.staticPatternId);
    else patternValidation.retractTrip(b.staticPatternId, b.rtTripId);
  }

  /**
   * Demote entries whose only claim to `confirmed` was time-domain validation that has
   * since been withdrawn — a pattern distrusted by the consistency gate, or one whose
   * bindings were all voided by the drift breaker.
   *
   * The promotion loop only rewrites entries the current cycle re-proposed, and a stop can
   * stop being proposed the moment its RT pattern is quarantined. Without this sweep such
   * an entry would keep backing delay rows on evidence that no longer exists — the exact
   * failure the warm-start guard closes across a restart, left open within one process.
   * Paths 1 and 2 rest on evidence that only accumulates, so they are never swept.
   */
  function demoteUnvalidated(): void {
    for (const e of xwalk.values()) {
      if (e.state !== 'confirmed' || e.distinctPatterns >= 2) continue;
      if (e.source === 'geo' && e.geoResidM != null && e.geoResidM <= GEO_SELF_CONFIRM_M) continue;
      if (validationSufficient(validationFor(e.rtStopId))) continue;
      e.state = 'candidate';
    }
  }

  /**
   * Restore the learned crosswalk for the CURRENT board tag.
   *
   * Three merge properties this has to get right, because a warm start that lies is worse
   * than a cold one:
   *
   *  1. A loaded entry is NOT a fresh observation. `xwalkVotes` is seeded with the persisted
   *     count and nothing else: the usual `+ 1` then only fires when this cycle genuinely
   *     re-derives the identity. Crediting a vote for merely reading a row would let an
   *     entry climb the confidence ladder by restarting the process.
   *  2. New evidence must still be able to overturn a stale mapping. `xwalkProposals` is
   *     seeded with the loaded stop id, so a later cycle proposing a DIFFERENT static stop
   *     makes the set size 2 and marks the rt stop conflicted — exactly as it would have
   *     within one process. Without this seeding a contradiction would silently overwrite,
   *     which is the one outcome the conflict machinery exists to prevent.
   *  3. Entries persisted as `conflicted` come back conflicted, at confidence 0, and stay
   *     out of the propagation seed.
   *
   * Scoped by board tag, so a board rollover cannot resurrect stop identities that were
   * learned against a schedule we no longer hold.
   */
  async function loadCrosswalk(): Promise<void> {
    try {
      const res = await db.query<{
        rt_stop_id: string; stop_id: string; votes: number | string;
        distinct_patterns: number | string; geo_resid_m: number | string | null;
        source: string; state: string; confidence: number | string;
      }>(
        `SELECT rt_stop_id, stop_id, votes, distinct_patterns, geo_resid_m, source, state, confidence
           FROM rt_stop_xwalk WHERE agency=$1 AND board_tag=$2`,
        [writeAgency, boardTag],
      );
      let usable = 0;
      let demoted = 0;
      for (const r of res.rows) {
        let state: XwalkState = r.state === 'confirmed' || r.state === 'conflicted' ? r.state : 'candidate';
        // A ROW MAY NOT CARRY MORE AUTHORITY THAN THE EVIDENCE THAT COMES BACK WITH IT.
        // `distinct_patterns` and `geo_resid_m` are persisted, so the first two promotion
        // paths can be re-checked here. The third — time-domain validation by surviving
        // bindings — is NOT persisted: bindings are a property of the running service day,
        // not of the board. Restoring such a row as `confirmed` would republish a promotion
        // whose evidence no longer exists anywhere in the process. It comes back as a
        // `candidate` and re-earns confirmation within a few cycles if the service is still
        // doing what it was doing. This is a no-op for rows written before the third path
        // existed, because nothing else could have confirmed them.
        if (state === 'confirmed') {
          const dp = Number(r.distinct_patterns);
          const resid = r.geo_resid_m == null ? null : Number(r.geo_resid_m);
          const geoSelfConfirmed = r.source === 'geo' && resid != null && resid <= GEO_SELF_CONFIRM_M;
          if (dp < 2 && !geoSelfConfirmed) { state = 'candidate'; demoted++; }
        }
        const confidence = state === 'conflicted' ? 0 : Number(r.confidence);
        xwalk.set(r.rt_stop_id, {
          rtStopId: r.rt_stop_id,
          stopId: r.stop_id,
          votes: Number(r.votes),
          distinctPatterns: Number(r.distinct_patterns),
          geoResidM: r.geo_resid_m == null ? null : Number(r.geo_resid_m),
          source: r.source === 'geo' ? 'geo' : 'propagated',
          state,
          confidence,
        });
        xwalkVotes.set(r.rt_stop_id, Number(r.votes));          // continue the count, do not restart it
        xwalkProposals.set(r.rt_stop_id, new Set([r.stop_id])); // so a contradiction still conflicts
        xwalkDistinctFloor.set(r.rt_stop_id, Number(r.distinct_patterns));
        if (state === 'conflicted') conflictedStops.add(r.rt_stop_id);
        else if (state === 'confirmed' && confidence >= XWALK_MIN_CONF) usable++;
      }
      if (res.rows.length > 0) {
        console.log(`[engine] restored ${res.rows.length} crosswalk entries for ${boardTag} ` +
          `(${usable} usable for a delay row, ${conflictedStops.size} conflicted` +
          `${demoted > 0 ? `, ${demoted} back to candidate pending fresh binding evidence` : ''}) — warm start`);
      }
    } catch (e) {
      // A failed restore costs warm-up time, not correctness: the crosswalk relearns.
      console.error('[engine] crosswalk restore failed:', e instanceof Error ? e.message : e);
    }
  }

  // ---------- (a) geometric anchors ----------

  function accumulateAnchors(vehicles: readonly EngineVehicle[], nowS: number): void {
    for (const v of vehicles) {
      // STOPPED_AT only, and only when explicitly on the wire. The proto2 default for
      // currentStatus is IN_TRANSIT_TO (2), so an absent field must never be read as a
      // status at all — see pb.ts.
      if (v.currentStatus !== 1 || !v.rtStopId || !v.routeId) {
        if (v.currentStatus !== 1) dwellSeen.delete(v.vehicleId);
        continue;
      }
      if (v.tsS != null && Math.abs(nowS - v.tsS) > ANCHOR_MAX_AGE_S) continue;

      // ONE VOTE PER DWELL EPISODE. A bus parked five minutes at a terminal would
      // otherwise vote every cycle and drown out genuine cross-vehicle agreement.
      if (dwellSeen.get(v.vehicleId) === v.rtStopId) continue;
      dwellSeen.set(v.vehicleId, v.rtStopId);

      const key = `${v.routeId}|${v.rtStopId}`;
      let acc = anchors.get(key);
      if (!acc) { acc = { n: 0, sumLat: 0, sumLon: 0, vehicles: new Set() }; anchors.set(key, acc); }
      acc.n++; acc.sumLat += v.lat; acc.sumLon += v.lon; acc.vehicles.add(v.vehicleId);
    }
  }

  function resolveGeoAnchors(): void {
    for (const [key, acc] of anchors) {
      const candidates = index.routeStops.get(routeOfKey(key));
      if (!candidates || candidates.length === 0) continue;
      const hit = nearestStopOnRoute(acc.sumLat / acc.n, acc.sumLon / acc.n, candidates);
      if (!hit) { geoAnchors.delete(key); geoResid.delete(key); continue; }
      geoAnchors.set(key, hit.stopId);
      geoResid.set(key, hit.distM);
    }
  }

  // ---------- (b) RT pattern clustering ----------

  function clusterPatterns(tripUpdates: readonly EngineTripUpdate[]): void {
    for (const tu of tripUpdates) {
      if (!tu.routeId) continue;
      const seqStops = new Map<number, string>();
      for (const s of tu.stops) {
        if (s.stopSequence == null || !s.rtStopId) continue;
        seqStops.set(s.stopSequence, s.rtStopId);
      }
      if (seqStops.size === 0) continue;
      const out = mergeRtTrip(rtPatterns, tu.routeId, seqStops, {
        maxStaticLen: index.maxLenByRoute.get(tu.routeId) ?? null,
      });
      if (out.pattern) rtPatternByTrip.set(tu.rtTripId, out.pattern);
      else console.warn(`[engine] route ${tu.routeId} hit the RT pattern cap; not clustering further`);
    }
    collapseDuplicatePatterns();
  }

  /**
   * Two patterns that grew independently can converge on identical stop lists, and the
   * pattern id is a content hash — so they become the same identity while remaining two
   * objects. Left alone that double-counts `distinctPatterns`, which would promote a
   * crosswalk entry to `confirmed` on what is really a single line of evidence.
   */
  function collapseDuplicatePatterns(): void {
    const byId = new Map<string, RtPattern>();
    const remap = new Map<RtPattern, RtPattern>();
    for (const p of rtPatterns) {
      const keep = byId.get(p.rtPatternId);
      if (!keep) { byId.set(p.rtPatternId, p); continue; }
      keep.nTrips += p.nTrips;
      remap.set(p, keep);
    }
    if (remap.size === 0) return;
    rtPatterns.length = 0;
    for (const p of byId.values()) rtPatterns.push(p);
    for (const [tripId, p] of rtPatternByTrip) {
      const keep = remap.get(p);
      if (keep) rtPatternByTrip.set(tripId, keep);
    }
  }

  // ---------- (c) resolution to a fixpoint, and crosswalk promotion ----------

  function resolveAndPromote(): number {
    const byRoute = new Map<string, StaticPatternLite[]>();
    for (const [routeId, pats] of index.byRoute) {
      byRoute.set(routeId, pats.map((p) => ({ patternId: p.patternId, stops: p.stops })));
    }
    const seed = new Map<string, string>();
    for (const [rtStop, e] of xwalk) if (!conflictedStops.has(rtStop)) seed.set(rtStop, e.stopId);

    const live = rtPatterns.filter((p) => !quarantined.has(p.rtPatternId));
    const rr = resolvePatterns(live, byRoute, geoAnchors, seed);

    resolvedStatic = new Map([...rr.resolved].map(([k, v]) => [k, v.staticPatternId]));
    resolvedIter = new Map([...rr.resolved].map(([k, v]) => [k, v.iter]));
    patternStates.clear();
    for (const [id, st] of rr.states) patternStates.set(id, st);
    for (const id of quarantined) patternStates.set(id, 'quarantined');
    for (const s of rr.conflicted) conflictedStops.add(s);

    // Publish stop identities. Geometry overwrites propagation where both exist, because
    // geometry is measured and propagation is derived.
    // Votes are counted on `implied`, not `learned`: a stop first identified on cycle 1 is
    // in the seed on every later cycle and so never appears in `learned` again. Counting
    // only new discoveries froze every propagated entry at one vote, permanently below the
    // 0.60 usability floor.
    // Where geometry and propagation BOTH name a stop they are two agreeing sources, not a
    // replacement — see corroboratedConfidence. Both are recorded rather than one
    // overwriting the other.
    interface Proposal { stop: string; geo: boolean; propagated: boolean; resid: number | null }
    const proposals = new Map<string, Proposal>();
    for (const [rtStop, stop] of rr.implied) {
      proposals.set(rtStop, { stop, geo: false, propagated: true, resid: null });
    }
    for (const [key, stop] of geoAnchors) {
      const rtStop = rtStopOfKey(key);
      const resid = geoResid.get(key) ?? null;
      const prior = proposals.get(rtStop);
      // Geometry is measured, so it names the stop when the two disagree — and the
      // disagreement is recorded below, where two distinct ids mark the stop conflicted.
      if (prior && prior.stop === stop) { prior.geo = true; prior.resid = resid; }
      else proposals.set(rtStop, { stop, geo: true, propagated: false, resid });
    }

    const agreeingPatterns = staticPatternsByRtStop();
    for (const [rtStop, prop] of proposals) {
      let seen = xwalkProposals.get(rtStop);
      if (!seen) { seen = new Set(); xwalkProposals.set(rtStop, seen); }
      seen.add(prop.stop);
      const votes = (xwalkVotes.get(rtStop) ?? 0) + 1;
      xwalkVotes.set(rtStop, votes);
      const hasConflict = conflictedStops.has(rtStop) || seen.size > 1;
      if (hasConflict) conflictedStops.add(rtStop);
      const distinctPatterns = accumulateAgreement(rtStop, agreeingPatterns.get(rtStop));
      const source = prop.geo ? 'geo' : 'propagated';
      xwalk.set(rtStop, {
        rtStopId: rtStop, stopId: prop.stop, votes, distinctPatterns, geoResidM: prop.resid,
        source,
        state: promotionState(distinctPatterns, source, prop.resid, hasConflict,
          validationFor(rtStop), ambiguousStops.has(prop.stop)),
        confidence: hasConflict ? 0 : corroboratedConfidence(votes, prop.resid, prop),
      });
    }
    demoteUnvalidated();
    // A stop that became conflicted after it was written must lose its usability too.
    for (const rtStop of conflictedStops) {
      const e = xwalk.get(rtStop);
      if (e) { e.state = 'conflicted'; e.confidence = 0; }
    }

    let maxIter = 0;
    for (const v of rr.resolved.values()) if (v.iter > maxIter) maxIter = v.iter;

    let ambiguous = 0, noCandidate = 0, tooFew = 0;
    for (const st of patternStates.values()) {
      if (st === 'ambiguous') ambiguous++;
      else if (st === 'no_candidate') noCandidate++;
      else if (st === 'unresolved') tooFew++;
    }
    stats.patterns = {
      rtTotal: rtPatterns.length, resolved: rr.resolved.size, ambiguous, noCandidate,
      tooFewAnchors: tooFew, quarantined: quarantined.size, maxResolveIter: maxIter,
    };
    return rr.resolved.size;
  }

  /**
   * rt stop id -> the STATIC patterns that agree on it this cycle. Built once and inverted,
   * rather than scanned per stop: the previous per-stop scan was O(stops x patterns x
   * pattern length), roughly 4.5e8 comparisons a cycle at live volumes.
   */
  function staticPatternsByRtStop(): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const p of rtPatterns) {
      if (patternStates.get(p.rtPatternId) !== 'resolved') continue;
      const staticPatternId = resolvedStatic.get(p.rtPatternId);
      if (!staticPatternId) continue;
      for (const rtStop of p.seqStops.values()) {
        let s = out.get(rtStop);
        if (!s) { s = new Set(); out.set(rtStop, s); }
        s.add(staticPatternId);
      }
    }
    return out;
  }

  /** Fold this cycle's agreement into the accumulated set and report its size. */
  function accumulateAgreement(rtStop: string, thisCycle: ReadonlySet<string> | undefined): number {
    let all = xwalkAgreeingPatterns.get(rtStop);
    if (!all) { all = new Set(); xwalkAgreeingPatterns.set(rtStop, all); }
    if (thisCycle) for (const sp of thisCycle) all.add(sp);
    // A restored entry brings the count it was promoted on; it cannot bring the set.
    return Math.max(all.size, xwalkDistinctFloor.get(rtStop) ?? 0);
  }

  // ---------- (d) births and origin lock ----------

  function captureBirths(inp: EngineCycleInput, nowS: number): number {
    let n = 0;
    for (const tu of inp.tripUpdates) {
      if (!tu.routeId) continue;
      if (bindings.has(tu.rtTripId) || refusedTrips.has(tu.rtTripId) || births.has(tu.rtTripId)) continue;

      // scheduleRelationship 8 is undocumented and not in the GTFS-rt enum (13 of 1,392
      // entities on a live snapshot, exactly the ones carrying a negative synthetic trip
      // id). Counted, excluded from binding, never interpreted.
      if (tu.scheduleRelationship === 8) {
        refusedTrips.set(tu.rtTripId, 'refused_schedule_relationship_8');
        stats.bindings.refusedScheduleRelationship8++;
        continue;
      }

      let minSeq = Infinity;
      let firstEpochS: number | null = null;
      const rtStops = new Map<number, string>();
      const bAnchors: Array<{ stopSequence: number; predEpochS: number }> = [];
      for (const s of tu.stops) {
        if (s.stopSequence == null || !s.rtStopId || s.noData || s.epochS == null) continue;
        rtStops.set(s.stopSequence, s.rtStopId);
        bAnchors.push({ stopSequence: s.stopSequence, predEpochS: s.epochS });
        if (s.stopSequence < minSeq) { minSeq = s.stopSequence; firstEpochS = s.epochS; }
      }
      if (firstEpochS == null) continue;

      // Mid-route arrival: we never saw this trip's origin, so the uncontaminated anchor
      // this design depends on does not exist for it and never will.
      if (minSeq > 2 || firstEpochS <= nowS) {
        refusedTrips.set(tu.rtTripId, 'refused_midroute');
        stats.bindings.refusedMidroute++;
        continue;
      }

      bAnchors.sort((a, b) => a.stopSequence - b.stopSequence);
      births.set(tu.rtTripId, {
        rtTripId: tu.rtTripId, routeId: tu.routeId, predFirstEpochS: firstEpochS,
        minSeq, anchors: bAnchors, rtStops, bornAtS: nowS,
      });
      n++;
    }
    return n;
  }

  /**
   * Lock every pending birth whose RT pattern has become resolvable.
   *
   * A newborn publishes a median of ONE stop, which can never clear the 3-shared-sequence
   * merge floor, so its pattern is usually not resolvable in the cycle it is born. The
   * binding therefore waits — but it waits on the ANCHORS CAPTURED AT BIRTH, which are
   * never refreshed. That preserves the property the whole design rests on (the origin
   * measurement is taken before any live drift accumulates) while letting the crosswalk
   * catch up. This is a deliberate deviation from "bind in the birth cycle"; binding in
   * the birth cycle is impossible given the merge floor, and refreshing the anchor would
   * destroy the only clean measurement available.
   */
  /**
   * Drop births we can no longer bind. This runs EVERY cycle, not only when the board is
   * active: with an inactive board nothing is ever locked, so pruning inside the lock path
   * left the pending map growing by ~100 entries a cycle forever — a leak that only shows
   * up in exactly the state this deployment sits in until the board activates.
   */
  function expireBirths(nowS: number): void {
    for (const [rtTripId, birth] of births) {
      if (nowS - birth.bornAtS > BIRTH_EXPIRY_S || birth.predFirstEpochS < nowS - BIRTH_EXPIRY_S) {
        births.delete(rtTripId);
        refusedTrips.set(rtTripId, 'refused_unresolved');
        stats.bindings.refusedUnresolved++;
      }
    }
    // refusedTrips is the other unbounded map: it exists to stop us retrying a trip we
    // already judged, and a trip id never returns once it has left the feed.
    if (refusedTrips.size > 50_000) refusedTrips.clear();
  }

  async function lockPendingBirths(inp: EngineCycleInput, nowS: number): Promise<void> {
    for (const [rtTripId, birth] of [...births]) {
      const pattern = rtPatternByTrip.get(rtTripId);
      if (!pattern) continue;
      if (quarantined.has(pattern.rtPatternId)) {
        births.delete(rtTripId);
        refusedTrips.set(rtTripId, 'refused_unresolved');
        stats.bindings.refusedUnresolved++;
        continue;
      }
      const staticPatternId = resolvedStatic.get(pattern.rtPatternId);
      if (!staticPatternId) continue;   // still unresolved; try again next cycle

      // The origin stop's identity must be confirmed, or the residual we are about to
      // measure is against a stop we only think we know.
      const firstRtStop = birth.rtStops.get(birth.minSeq);
      const firstXw = firstRtStop ? xwalk.get(firstRtStop) : undefined;
      if (!firstXw || firstXw.state !== 'confirmed' || firstXw.confidence < XWALK_MIN_CONF) continue;

      const slots: LockSlot[] = (index.slotsByPattern.get(staticPatternId) ?? [])
        .filter((s) => inp.activeServices.has(s.serviceId) && !claimedStatic.has(s.tripId))
        .map((s) => ({ tripId: s.tripId, firstDepS: s.firstDepS, claimed: false, times: s.times }));

      const lockAnchors: LockAnchor[] = [];
      for (const a of birth.anchors) {
        const rtStop = birth.rtStops.get(a.stopSequence);
        const e = rtStop ? xwalk.get(rtStop) : undefined;
        if (e && e.state === 'confirmed') {
          lockAnchors.push({ stopSequence: a.stopSequence, staticStopId: e.stopId, predEpochS: a.predEpochS });
        }
      }

      const res = originLock({
        serviceDate: inp.serviceDate,
        routeId: birth.routeId,
        staticPatternId,
        predFirstEpochS: birth.predFirstEpochS,
        anchors: lockAnchors,
        slots,
        medianHeadwayS: index.medianHeadwayS.get(staticPatternId) ?? null,
      });
      countRefusal(res);

      if (res.method !== 'origin_lock' || !res.tripId) {
        // refused_board_inactive is not this trip's fault and may become lockable later;
        // everything else is final for this trip.
        if (res.method !== 'refused_board_inactive') {
          births.delete(rtTripId);
          refusedTrips.set(rtTripId, res.method);
          await persistBinding(inp.serviceDate, rtTripId, null, pattern.rtPatternId, staticPatternId, birth.routeId, res);
        }
        continue;
      }

      // Double-book: two RT trips claiming one static trip. The partial unique index makes
      // this a database error rather than two silently wrong delay series; resolve it here
      // so the loser is voided rather than re-solved under a different band.
      const holderRt = claimedStatic.get(res.tripId);
      if (holderRt && holderRt !== rtTripId) {
        const holder = bindings.get(holderRt);
        stats.bindings.doubleBookRejected++;
        if (holder) {
          const pick = preferBinding(
            { agree: holder.agree, residS: holder.residS, rtTripId: holderRt },
            { agree: res.agree, residS: res.residS, rtTripId },
          );
          if (pick.winner.rtTripId === holderRt) {
            births.delete(rtTripId);
            refusedTrips.set(rtTripId, 'refused_ambiguous');
            continue;
          }
          retractBinding(holder, false);
          bindings.delete(holderRt);
          claimedStatic.delete(res.tripId);
          fireAndLog(db.query(
            "UPDATE rt_trip_binding SET state='voided' WHERE agency=$1 AND service_date=$2 AND rt_trip_id=$3",
            [writeAgency, inp.serviceDate, holderRt]), 'void losing binding');
        } else {
          births.delete(rtTripId);
          refusedTrips.set(rtTripId, 'refused_ambiguous');
          continue;
        }
      }

      const slot = index.slotsByTrip.get(res.tripId);
      if (!slot) {
        births.delete(rtTripId);
        refusedTrips.set(rtTripId, 'refused_no_slot');
        continue;
      }

      bindings.set(rtTripId, {
        rtTripId, staticTripId: res.tripId, routeId: birth.routeId,
        rtPatternId: pattern.rtPatternId, staticPatternId,
        confidence: res.confidence ?? 'low', marginS: res.marginS, headwayS: res.headwayS,
        residS: res.residS, agree: res.agree, slot, tracked: new Map(),
      });
      claimedStatic.set(res.tripId, rtTripId);
      births.delete(rtTripId);
      stats.bindings.locked++;

      if (res.residS != null) {
        firstStopResids.push(res.residS);
        if (firstStopResids.length > BOARD_AGREEMENT_WINDOW) firstStopResids.shift();
        const pr = patternResid.get(staticPatternId) ?? [];
        pr.push(Math.abs(res.residS));
        if (pr.length > 50) pr.shift();
        patternResid.set(staticPatternId, pr);
      }

      await persistBinding(inp.serviceDate, rtTripId, res.tripId, pattern.rtPatternId, staticPatternId, birth.routeId, res);
      fireAndLog(db.query(
        `INSERT INTO sched_slot_claim (agency, service_date, trip_id, rt_trip_id, state)
         VALUES ($1,$2,$3,$4,'claimed')
         ON CONFLICT (agency, service_date, trip_id)
         DO UPDATE SET rt_trip_id=EXCLUDED.rt_trip_id, state='claimed', updated=now()`,
        [writeAgency, inp.serviceDate, res.tripId, rtTripId]), 'slot claim');
    }
  }

  function countRefusal(res: LockResult): void {
    switch (res.method) {
      case 'refused_ambiguous': stats.bindings.refusedAmbiguous++; break;
      case 'refused_no_slot': stats.bindings.refusedNoSlot++; break;
      case 'refused_too_few_anchors': stats.bindings.refusedTooFewAnchors++; break;
      case 'refused_unresolved': stats.bindings.refusedUnresolved++; break;
      case 'refused_midroute': stats.bindings.refusedMidroute++; break;
      case 'refused_headway_band': stats.bindings.refusedHeadwayBand++; break;
      case 'refused_board_inactive': stats.bindings.refusedBoardInactive++; break;
      default: break;
    }
  }

  async function persistBinding(
    serviceDate: number, rtTripId: string, staticTripId: string | null,
    rtPatternId: string, staticPatternId: string | null, routeId: string, res: LockResult,
  ): Promise<void> {
    try {
      await db.query(
        `INSERT INTO rt_trip_binding
           (agency, service_date, rt_trip_id, trip_id, rt_pattern_id, static_pattern_id, route_id,
            method, state, first_stop_resid_s, margin_s, headway_s, anchors, agree, confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (agency, service_date, rt_trip_id) DO NOTHING`,
        [writeAgency, serviceDate, rtTripId, staticTripId, rtPatternId, staticPatternId, routeId,
          res.method, staticTripId ? 'bound' : 'refused',
          res.residS == null ? null : Math.round(res.residS),
          res.marginS == null ? null : Math.round(res.marginS),
          res.headwayS == null ? null : Math.round(res.headwayS),
          res.candidates, res.agree, res.confidence],
      );
    } catch (e) {
      // The partial unique index on trip_id is the backstop for a double-book that raced
      // past the in-memory check. Losing the write is correct; losing the count is not.
      stats.bindings.doubleBookRejected++;
      console.error('[engine] binding insert rejected:', e instanceof Error ? e.message : e);
    }
  }

  // ---------- (e) settle and emit ----------

  async function trackAndSettle(inp: EngineCycleInput, nowS: number, publish: boolean): Promise<DelayRow[]> {
    const byTrip = new Map<string, EngineTripUpdate>();
    for (const tu of inp.tripUpdates) byTrip.set(tu.rtTripId, tu);

    // Ground truth where we have it: a VehiclePosition reporting STOPPED_AT is an
    // observation, not a prediction. ~100 per cycle system-wide, which is enough to
    // measure the predicted rows' bias instead of assuming it is zero.
    const observedAt = new Map<string, number>();
    for (const v of inp.vehicles) {
      if (v.currentStatus !== 1 || !v.rtTripId || !v.rtStopId || v.tsS == null) continue;
      observedAt.set(`${v.rtTripId}|${v.rtStopId}`, v.tsS);
    }

    const out: DelayRow[] = [];
    let counters = emptyCounters();
    let suppressed = 0;

    for (const [rtTripId, b] of [...bindings]) {
      const tu = byTrip.get(rtTripId);
      let current: Map<number, TrackedStop> | null = null;
      if (tu) {
        current = new Map();
        for (const s of tu.stops) {
          if (s.stopSequence == null || !s.rtStopId) continue;
          if (s.epochS == null && !s.noData) continue;
          current.set(s.stopSequence, {
            stopSequence: s.stopSequence, rtStopId: s.rtStopId,
            epochS: s.epochS ?? 0, kind: s.kind, noData: s.noData,
          });
        }
      }

      const observed = new Map<number, number>();
      for (const [seq, st] of b.tracked) {
        const o = observedAt.get(`${rtTripId}|${st.rtStopId}`);
        if (o != null) observed.set(seq, o);
      }

      const res = settleTrip({
        nowS, serviceDate: inp.serviceDate, boardTag,
        rtTripId, staticTripId: b.staticTripId, routeId: b.routeId,
        confidence: b.confidence, matchMarginS: b.marginS, headwayS: b.headwayS,
        prev: b.tracked, current,
        times: b.slot.times, arrivals: b.slot.arrivals,
        staticStops: index.patterns.get(b.staticPatternId)?.stops ?? [],
        xwalk, observed,
      });

      if (res.inconsistent) {
        // The crosswalk and the binding contradict each other, so the pattern assignment
        // is in doubt — and every promotion that leaned on this pattern's validation was
        // leaning on a pattern the audit just rejected. Take the whole pattern's credit.
        retractBinding(b, true);
        await voidForInconsistency(inp.serviceDate, rtTripId, b, res.inconsistent);
        continue;
      }

      // Per-pattern breaker: a pattern whose rolling residual has drifted past half its own
      // headway is producing self-consistent delays that are wrong by about one headway.
      if (!patternHealthy(b.headwayS, med(patternResid.get(b.staticPatternId) ?? []))) {
        retractBinding(b, false);
        bindings.delete(rtTripId);
        claimedStatic.delete(b.staticTripId);
        fireAndLog(db.query(
          "UPDATE rt_trip_binding SET state='voided' WHERE agency=$1 AND service_date=$2 AND rt_trip_id=$3",
          [writeAgency, inp.serviceDate, rtTripId]), 'void drifted binding');
        continue;
      }

      // Survived both audits this cycle: this is what the second promotion path counts.
      creditBinding(b);
      counters = addCounters(counters, res.counters);
      if (publish) out.push(...res.rows);
      else suppressed += res.rows.length;

      // Roll forward: settled stops leave, live ones carry their latest prediction. A trip
      // that has left the feed is finished with.
      if (current === null) { bindings.delete(rtTripId); claimedStatic.delete(b.staticTripId); }
      else b.tracked = current;
    }

    // Live RT trips we cannot measure at all because nothing bound them. Reported rather
    // than hidden: it is the honest denominator behind every published delay.
    let noBinding = 0;
    for (const id of byTrip.keys()) if (!bindings.has(id)) noBinding++;
    stats.obs = { ...counters, droppedNoBinding: noBinding, suppressedByGate: suppressed };
    return out;
  }

  async function voidForInconsistency(
    serviceDate: number, rtTripId: string, b: Binding,
    bad: { stopSequence: number; expected: string; got: string },
  ): Promise<void> {
    quarantined.add(b.rtPatternId);
    bindings.delete(rtTripId);
    claimedStatic.delete(b.staticTripId);
    console.warn(`[engine] consistency gate: rt trip ${rtTripId} seq ${bad.stopSequence} — bound trip has ` +
      `${bad.expected}, crosswalk says ${bad.got}; voided binding + quarantined pattern`);
    fireAndLog(db.query(
      "UPDATE rt_trip_binding SET state='voided' WHERE agency=$1 AND service_date=$2 AND rt_trip_id=$3",
      [writeAgency, serviceDate, rtTripId]), 'void inconsistent binding');
    fireAndLog(db.query(
      'DELETE FROM trip_delay_obs WHERE agency=$1 AND trip_id=$2 AND service_date=$3',
      [writeAgency, rtTripId, serviceDate]), 'remove inconsistent obs');
    fireAndLog(db.query(
      "UPDATE rt_pattern SET state='quarantined', updated=now() WHERE agency=$1 AND rt_pattern_id=$2 AND board_tag=$3",
      [writeAgency, b.rtPatternId, boardTag]), 'quarantine pattern');
  }

  // ---------- persistence ----------

  async function upsertBatch(
    table: string, columns: string[], rows: unknown[][], conflict: string,
    keyCols: number, jsonbCol1Based = -1,
  ): Promise<void> {
    if (rows.length === 0) return;
    rows = dedupeByKey(rows, keyCols);
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const row of slice) {
        const ph: string[] = [];
        for (let c = 0; c < columns.length; c++) {
          const isJson = c + 1 === jsonbCol1Based;
          ph.push(isJson ? `$${p++}::jsonb` : `$${p++}`);
          values.push(row[c]);
        }
        tuples.push(`(${ph.join(',')})`);
      }
      await db.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${conflict}`, values);
    }
  }

  async function persistCrosswalk(): Promise<void> {
    const anchorRows: unknown[][] = [];
    for (const [key, acc] of anchors) {
      anchorRows.push([writeAgency, rtStopOfKey(key), routeOfKey(key), acc.n, acc.sumLat, acc.sumLon, acc.vehicles.size]);
    }
    await upsertBatch('rt_stop_anchor',
      ['agency', 'rt_stop_id', 'route_id', 'n', 'sum_lat', 'sum_lon', 'n_vehicles'], anchorRows,
      `ON CONFLICT (agency, rt_stop_id, route_id) DO UPDATE SET
         n=EXCLUDED.n, sum_lat=EXCLUDED.sum_lat, sum_lon=EXCLUDED.sum_lon,
         n_vehicles=EXCLUDED.n_vehicles, last_seen=now()`, 3);

    // The raw vote ledger, so the promoted winner is always recomputable from evidence.
    const voteRows: unknown[][] = [];
    for (const [key, stop] of geoAnchors) {
      voteRows.push([writeAgency, rtStopOfKey(key), boardTag, stop, routeOfKey(key), 'geo',
        anchors.get(key)?.n ?? 1, geoResid.get(key) ?? 0]);
    }
    await upsertBatch('rt_stop_xwalk_votes',
      ['agency', 'rt_stop_id', 'board_tag', 'stop_id', 'route_id', 'source', 'votes', 'sum_resid_m'], voteRows,
      `ON CONFLICT (agency, rt_stop_id, board_tag, stop_id, route_id, source) DO UPDATE SET
         votes=EXCLUDED.votes, sum_resid_m=EXCLUDED.sum_resid_m, updated=now()`, 6);

    const xwRows: unknown[][] = [];
    for (const e of xwalk.values()) {
      xwRows.push([writeAgency, e.rtStopId, boardTag, e.stopId, e.votes, e.distinctPatterns,
        e.geoResidM, e.source, e.state, e.confidence]);
    }
    await upsertBatch('rt_stop_xwalk',
      ['agency', 'rt_stop_id', 'board_tag', 'stop_id', 'votes', 'distinct_patterns', 'geo_resid_m', 'source', 'state', 'confidence'],
      xwRows,
      `ON CONFLICT (agency, rt_stop_id, board_tag) DO UPDATE SET
         stop_id=EXCLUDED.stop_id, votes=EXCLUDED.votes, distinct_patterns=EXCLUDED.distinct_patterns,
         geo_resid_m=EXCLUDED.geo_resid_m, source=EXCLUDED.source, state=EXCLUDED.state,
         confidence=EXCLUDED.confidence, updated=now()`, 3);

    const patRows: unknown[][] = [];
    for (const p of rtPatterns) {
      patRows.push([writeAgency, p.rtPatternId, boardTag, p.routeId,
        JSON.stringify([...p.seqStops.entries()].sort((a, b) => a[0] - b[0])),
        p.seqStops.size, resolvedStatic.get(p.rtPatternId) ?? null,
        resolvedIter.get(p.rtPatternId) ?? null, patternStates.get(p.rtPatternId) ?? 'unresolved']);
    }
    await upsertBatch('rt_pattern',
      ['agency', 'rt_pattern_id', 'board_tag', 'route_id', 'seq_stops', 'n_stops', 'static_pattern_id', 'resolve_iter', 'state'],
      patRows,
      `ON CONFLICT (agency, rt_pattern_id, board_tag) DO UPDATE SET
         seq_stops=EXCLUDED.seq_stops, n_stops=EXCLUDED.n_stops,
         static_pattern_id=EXCLUDED.static_pattern_id, resolve_iter=EXCLUDED.resolve_iter,
         state=EXCLUDED.state, updated=now()`,
      3, 5);
  }

  async function writeObs(rows: readonly DelayRow[]): Promise<number> {
    const cols = ['agency', 'route_id', 'stop_id', 'trip_id', 'static_trip_id', 'stop_sequence',
      'hour_of_week', 'delay_s', 'sched_epoch_s', 'event_epoch_s', 'service_date', 'method',
      'source', 'confidence', 'xwalk_conf', 'match_margin_s', 'headway_s', 'board_tag'];
    const asRow = (r: DelayRow): unknown[] => [writeAgency, r.routeId, r.stopId, r.rtTripId, r.staticTripId,
      r.stopSequence, r.hourOfWeek, r.delayS, r.schedEpochS, r.eventEpochS, r.serviceDate, r.method,
      r.source, r.confidence, r.xwalkConf, r.matchMarginS, r.headwayS, r.boardTag];
    let inserted = 0;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const values: unknown[] = [];
      const tuples: string[] = [];
      let p = 1;
      for (const r of slice) {
        const ph: string[] = [];
        for (const v of asRow(r)) { ph.push(`$${p++}`); values.push(v); }
        tuples.push(`(${ph.join(',')})`);
      }
      const res = await db.query(
        `INSERT INTO trip_delay_obs (${cols.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, values);
      inserted += res.rowCount;
    }
    return inserted;
  }

  // ---------- measurement probe ----------

  /**
   * Dump the engine's crosswalk/pattern/binding state to `GHOSTBUS_XWALK_PROBE_DIR`, one
   * file per cycle. OFF unless the variable is set, and it is never set in production.
   *
   * This exists because §35's held-out-geometry experiment could not be repeated: it was
   * run from a throwaway script against state that no longer exists, so the next attempt
   * had to start by rebuilding the instrument rather than from the evidence. A promotion
   * rule that guards published delay numbers will be re-examined more than once, and the
   * only honest way to re-examine it is on live state. The dump is deliberately raw —
   * every input a promotion decision sees, and nothing summarised — so an analyser written
   * later can ask a question this cycle did not anticipate.
   */
  const probeDir = process.env.GHOSTBUS_XWALK_PROBE_DIR ?? null;
  let probeStaticWritten = false;

  function probeDump(n: number, inp: EngineCycleInput, occ: ReadonlyMap<string, number>): void {
    if (!probeDir) return;
    // SERIALISED SYNCHRONOUSLY, written asynchronously. Every map below is live engine
    // state that the next cycle mutates in place, so building the JSON inside the async
    // path would race the engine and could dump a half-updated crosswalk.
    const staticJson = probeStaticWritten ? null : JSON.stringify({
      boardTag,
      patterns: [...index.patterns.values()].map((p) => [p.patternId, p.routeId, p.dirId, p.stops]),
      routeStops: [...index.routeStops].map(([r, ss]) => [r, ss.map((s) => [s.stopId, s.lat, s.lon])]),
      medianHeadwayS: [...index.medianHeadwayS],
    });
    const cycleJson = JSON.stringify({
      cycleNo: n,
      // Every cycle carries the board tag, so an analyser can never join rt stops learned
      // against one board onto another board's geometry across a rollover.
      boardTag,
      nowMs: inp.nowMs,
      serviceDate: inp.serviceDate,
      occurrences: [...occ],
      xwalk: [...xwalk.values()].map((e) => [e.rtStopId, e.stopId, e.votes, e.distinctPatterns,
        e.geoResidM, e.source, e.state, e.confidence]),
      agreeing: [...xwalkAgreeingPatterns].map(([s, set]) => [s, [...set]]),
      distinctFloor: [...xwalkDistinctFloor],
      conflicted: [...conflictedStops],
      // Centroid, not the resolved stop: the analyser recomputes the nearest-stop match
      // itself so it can also see the runner-up gap, which promotion never stores.
      anchorCentroids: [...anchors].map(([k, a]) => [k, a.sumLat / a.n, a.sumLon / a.n, a.n, a.vehicles.size]),
      geoAnchors: [...geoAnchors].map(([k, s]) => [k, s, geoResid.get(k) ?? null]),
      rtPatterns: rtPatterns.map((p) => [p.rtPatternId, p.routeId, p.nTrips, [...p.seqStops]]),
      patternStates: [...patternStates],
      resolvedStatic: [...resolvedStatic],
      bindings: [...bindings.values()].map((b) => [b.rtTripId, b.staticTripId, b.routeId,
        b.rtPatternId, b.staticPatternId, b.confidence, b.residS, b.marginS, b.agree,
        [...b.tracked.values()].map((t) => [t.stopSequence, t.rtStopId])]),
    });
    void (async () => {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await mkdir(probeDir, { recursive: true });
      // Flagged only once the write has actually landed: a transient first-cycle failure
      // would otherwise lose static.json permanently, and every cycle dump is useless
      // without the pattern geometry it joins against.
      if (staticJson) { await writeFile(join(probeDir, 'static.json'), staticJson); probeStaticWritten = true; }
      await writeFile(join(probeDir, `cycle-${String(n).padStart(4, '0')}.json`), cycleJson);
    })().catch((e) => console.error('[engine] probe dump failed:', e instanceof Error ? e.message : e));
  }

  // ---------- the cycle ----------

  let cycleNo = 0;

  async function runCycle(inp: EngineCycleInput): Promise<{ rows: number; gate: GateResult }> {
    const nowS = Math.floor(inp.nowMs / 1000);
    cycleSeq++;

    if (serviceDateOfState !== inp.serviceDate) {
      births.clear(); bindings.clear(); refusedTrips.clear(); claimedStatic.clear();
      firstStopResids.length = 0;
      // Binding validation is evidence about the service that ran, not about the board. A
      // new service day has none of yesterday's bindings alive, so the credit goes with
      // them; the patterns still running re-earn it within a couple of cycles.
      patternValidation.clear();
      serviceDateOfState = inp.serviceDate;
    }

    stats.boardTag = boardTag;
    stats.indexReady = ready;
    stats.indexPatterns = index.patterns.size;
    stats.indexBuildMs = index.elapsedMs;
    stats.activeServiceIds = inp.activeServices.size;
    stats.boardActive = inp.activeServices.size > 0;

    // STAGE 0 FAST PATH, re-measured every cycle and never hardcoded. Every positive RT
    // trip id ends in "020", which reads like a board tag, so a board rollover could make
    // ids match outright — in which case the whole inference stack below is unnecessary
    // and we should notice for free rather than keep inferring.
    let directHits = 0;
    for (const tu of inp.tripUpdates) if (index.tripIds.has(tu.rtTripId)) directHits++;
    stats.directTripIdMatchRate = inp.tripUpdates.length > 0 ? directHits / inp.tripUpdates.length : 0;

    if (!ready) {
      lastGate = { publish: false, reason: 'static pattern index still building', failed: 'indexReady' };
      stats.suppressionReason = lastGate.reason;
      stats.suppressionGate = lastGate.failed;
      return { rows: 0, gate: lastGate };
    }

    accumulateAnchors(inp.vehicles, nowS);
    resolveGeoAnchors();
    clusterPatterns(inp.tripUpdates);
    resolveAndPromote();

    // Crosswalk health.
    let confirmed = 0;
    const residuals: number[] = [];
    for (const e of xwalk.values()) {
      if (e.state === 'confirmed') confirmed++;
      if (e.geoResidM != null) residuals.push(e.geoResidM);
    }
    // Coverage is measured on OCCURRENCES, not distinct stops: what matters is how much of
    // the live feed we can actually read, and popular stops appear far more often.
    let occTotal = 0, occCovered = 0;
    const occByStop = probeDir ? new Map<string, number>() : null;
    for (const tu of inp.tripUpdates) {
      for (const s of tu.stops) {
        if (!s.rtStopId) continue;
        occTotal++;
        if (occByStop) occByStop.set(s.rtStopId, (occByStop.get(s.rtStopId) ?? 0) + 1);
        const e = xwalk.get(s.rtStopId);
        if (e && e.state === 'confirmed' && e.confidence >= XWALK_MIN_CONF) occCovered++;
      }
    }
    const perRoute = new Map<string, Map<string, string>>();
    for (const [key, stop] of geoAnchors) {
      const routeId = routeOfKey(key);
      let m = perRoute.get(routeId);
      if (!m) { m = new Map(); perRoute.set(routeId, m); }
      m.set(rtStopOfKey(key), stop);
    }
    const cra = crossRouteAgreement(perRoute);
    // The monotonicity audit must be fed the STATIC sequences the crosswalk resolved each
    // tracked stop to. It used to be fed `[...b.tracked.keys()].sort()` — the binding's own
    // REALTIME sequences, ascending by construction — so it compared a sorted list against
    // itself and could not fail on any input. See crosswalkedStaticSeqs in xwalk.ts.
    const mono = monotonicityViolations([...bindings.values()].map((b) => ({
      staticSeqs: crosswalkedStaticSeqs(
        [...b.tracked.keys()].sort((a, c) => a - c).map((seq) => b.tracked.get(seq)!.rtStopId),
        index.patterns.get(b.staticPatternId)?.stops ?? [],
        xwalk,
      ),
    })));
    stats.xwalk = {
      rtStopsSeen: xwalk.size, confirmed, conflicted: conflictedStops.size,
      occurrenceCoverage: occTotal > 0 ? occCovered / occTotal : 0,
      crossRouteAgreement: cra.rate, medianResidM: med(residuals),
      unhealthy: (cra.rate != null && cra.rate < 0.85) || (mono.rate != null && mono.rate > 0.05),
    };

    // (f) gates, evaluated BEFORE anything is written.
    const boardMedian = med(firstStopResids.map(Math.abs));
    // A service can be calendar-active on a date whose trips were never seeded — see the
    // boardIntegrity gate and BLOCKERS 9.
    let activeServiceTripCount = 0;
    for (const s of inp.activeServices) activeServiceTripCount += index.tripsByService.get(s) ?? 0;
    const gate = evaluateGates({
      boardActive: stats.boardActive,
      boardTag,
      serviceDate: inp.serviceDate,
      activeServiceTripCount,
      boardAgreementMedianResidS: boardMedian,
      xwalkOccurrenceCoverage: stats.xwalk.occurrenceCoverage,
      crossRouteAgreement: cra.rate,
      monotonicityViolationRate: mono.rate,
    });
    lastGate = gate;
    stats.suppressionReason = gate.reason;
    stats.suppressionGate = gate.failed;
    stats.bindings.medianFirstStopResidS = boardMedian;
    stats.bindings.boardAgreementOk = boardMedian == null || boardMedian <= 300;

    // (d) Births and locking run even while suppressed, so the machinery keeps warming;
    // only the WRITE of delay rows is gated.
    stats.bindings.births += captureBirths(inp, nowS);
    expireBirths(nowS);
    if (stats.boardActive) {
      try { await lockPendingBirths(inp, nowS); } catch (e) { console.error('[engine] lock failed:', e); }
    }
    stats.bindings.pending = births.size;
    stats.bindings.active = bindings.size;

    // (e) settle.
    const rows = await trackAndSettle(inp, nowS, gate.publish);
    let written = 0;
    if (gate.publish && rows.length > 0) written = await writeObs(rows);

    await persistCrosswalk().catch((e) => console.error('[engine] crosswalk persist failed:', e));
    if (occByStop) probeDump(++cycleNo, inp, occByStop);
    return { rows: written, gate };
  }

  return {
    reloadStatic,
    runCycle,
    getStats() {
      return {
        ...stats,
        xwalk: { ...stats.xwalk },
        patterns: { ...stats.patterns },
        bindings: { ...stats.bindings },
        obs: { ...stats.obs },
      };
    },
    getPresentStaticTrips() {
      return new Set([...bindings.values()].map((b) => b.staticTripId));
    },
    getBindingsByRtTrip() {
      return new Map([...bindings].map(([rt, b]) => [rt, b.staticTripId]));
    },
    staticStopFor(rtStopId) {
      const e = xwalk.get(rtStopId);
      return e && e.state === 'confirmed' && e.confidence >= XWALK_MIN_CONF ? e.stopId : null;
    },
    isReady() { return ready; },
    getIndex() { return index; },
  };
}
