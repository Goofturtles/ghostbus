// Stitching rides into one journey — the arithmetic only, kept pure so every rule
// below can be exercised in a plain Node test with no database and no network.
//
// The planner's first tier answers "one vehicle takes you there". This is the second:
// when no single trip links the rider to their destination, TWO trips joined by a walk
// often do — and across the GTA's agency boundaries, sometimes only THREE do. Refusing
// to say so was leaving riders to a third-party maps app for journeys the loaded board
// can answer perfectly well.
//
// FOUR RULES, and they are the whole design. They are stated per TRANSFER, so they hold
// identically at the first seam and the second:
//
//   1. A CONNECTION THE RIDER CANNOT MAKE IS NOT A CONNECTION. The next leg must depart
//      no earlier than the previous one arrives PLUS the time to walk between the stops
//      PLUS a slack floor. A plan that has someone sprinting across a platform in nine
//      seconds is not honest just because the timetable permits it.
//   2. EVERY TRANSFER WALK IS CAPPED at the same WALKABLE radius the rest of the app uses
//      to decide a stop is reachable on foot. Past it, this is not a transfer; it is a
//      second journey, and the app says it cannot plan it rather than inventing a hike.
//   3. EACH LEG KEEPS ITS OWN EVIDENCE. Nothing here merges or averages the legs'
//      confidence. A live-tracked first leg and a schedule-only third leg stay exactly
//      that, all the way to the screen.
//   4. RANK BY WHEN THE RIDER ARRIVES, not by departure and not by leg count — the same
//      standard the single-ride planner already uses.
//
// A FIFTH RULE was added after the search was measured against everybody else's requests
// rather than only against its own answer: the search must be polite and bounded, and a
// search that was cut short must say so rather than call itself a refusal. It is stated
// in full beside PLAN_SEARCH_BUDGET_MS below, because unlike the four above it is not
// about which journeys are honest — it is about who pays for the question.
//
// WHY A THIRD LEG IS FENCED RATHER THAN FREE. Two was where the honest evidence used to
// run out, and the fear was real: by the third leg the compounding schedule assumption
// does more work than the data. So the third leg is not a general graph search. It is the
// same join run twice, under bounds that make an implausible answer impossible to return:
// a walk cap per seam (rule 2), a wait ceiling per seam, a TOTAL journey budget measured
// against the best answer the search itself found (THREE_LEG_* below), a frontier cap so
// the middle of the search cannot explode, and at most three results. A three-leg answer
// that survives all of that is one the board really contains — and every leg still ships
// its own evidence, so the rider can see precisely which part of it is guessed.

/** Metres a rider will walk between two rides. Rule 2. */
export const TRANSFER_MAX_WALK_M = 400;

/**
 * THE FIFTH RULE, and it is about everyone who is NOT this rider.
 *
 * The board this search reads is single-threaded and in-process, so the whole of it — the
 * queries and the joins below — happens on the one thread that also answers every other
 * rider's request. A cross-region search measured 24 s of that thread, during which the
 * arrivals board was frozen for the entire city. Nothing about the answer was wrong; the
 * cost of computing it was simply charged to strangers.
 *
 * Two mechanisms, and they do different jobs:
 *
 *   `breathe()` hands the event loop back at a boundary, so a health check or an arrivals
 *   board that arrived mid-search is served now rather than in twenty seconds. It makes
 *   the search POLITE. It does not make it shorter.
 *
 *   `startSearchBudget()` puts a wall on how long the search may run at all. It makes the
 *   search BOUNDED — and the honesty rule that comes with it is absolute: a search that
 *   was cut short has proved NOTHING, so it must never be reported as "no connection
 *   exists". It reports that it ran out of time, in those words. Anything already found
 *   when the wall is hit is returned, because a real two-leg answer in hand beats an
 *   aborted sweep for a third leg every time.
 */
export const PLAN_SEARCH_BUDGET_MS = 8_000;

/** How long a search may run before it must stop and say so. */
export interface SearchBudget {
  /** True once the wall is spent. Cheap enough to ask in a loop. */
  expired(): boolean;
}

/**
 * Start the wall clock. `now` is injected rather than read from `Date` so the expiry path
 * can be tested without a test that actually waits eight seconds.
 */
export function startSearchBudget(
  budgetMs: number = PLAN_SEARCH_BUDGET_MS,
  now: () => number = Date.now,
): SearchBudget {
  const deadline = now() + budgetMs;
  return { expired: () => now() >= deadline };
}

/**
 * Give the event loop one turn.
 *
 * `setImmediate` and not `Promise.resolve()`: an awaited microtask keeps the same tick and
 * so lets exactly nobody else in, which is how a chain of a hundred awaited queries can
 * still block every socket on the process. The macrotask boundary is the entire point.
 */
export const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/** Transfer pairs joined between breaths. Small enough that no breath is far away. */
export const STITCH_BREATH_PAIRS = 256;

/**
 * Seconds of slack demanded on top of the walk.
 *
 * Not padding for its own sake: the legs' scheduled times come from independent boards
 * (often independent agencies), and a connection with zero margin is one that fails on
 * any real-world minute of variance. 90 s is roughly the headway-independent floor a
 * rider needs to cross a platform, find the bay and be standing there.
 */
export const TRANSFER_MIN_SLACK_S = 90;

/** Beyond this the rider is not connecting, they are waiting out a service gap. */
export const TRANSFER_MAX_WAIT_S = 45 * 60;

/**
 * The total-journey budget for a three-leg answer, relative to the best three-leg answer
 * the search found: keep anything within 1.6x of it, or within 45 minutes of it, whichever
 * is the LARGER allowance. Two shapes because neither alone is honest — a ratio alone
 * throws away a 20-minute-longer option on a short journey that a rider might well prefer
 * for a shorter walk, and a flat floor alone would keep a two-hour detour on a two-hour
 * trip. Applied to (last arrival - first departure), the only span the rider experiences.
 */
export const THREE_LEG_BUDGET_RATIO = 1.6;
export const THREE_LEG_BUDGET_FLOOR_MS = 45 * 60_000;

/**
 * How many partial two-leg chains survive into the third-leg search.
 *
 * The prune before it is the load-bearing one and it is a dominance argument, not a
 * heuristic: among chains standing at the SAME transfer stop, the one that got there
 * earliest can catch every onward ride the others can and possibly more, so keeping the
 * rest can only ever produce a strictly worse journey. This cap is the backstop for a
 * query where even the deduped frontier is enormous.
 */
export const THREE_LEG_MAX_FRONTIER = 400;

/** One ride, reduced to what stitching actually needs. */
export interface StitchRide {
  agency: string;
  tripId: string;
  routeId: string | null;
  /** the stop this ride is boarded at. */
  boardStopId: string;
  /** the stop this ride is left at. */
  alightStopId: string;
  departureMs: number;
  arrivalMs: number;
}

/** A stop's position, for measuring the walk between two of them. */
export interface StitchStop {
  agency: string;
  stopId: string;
  lat: number;
  lon: number;
}

/** One seam between two consecutive legs. Never merged into a total — rule 3's sibling. */
export interface StitchTransfer {
  from: StitchStop;
  to: StitchStop;
  walkM: number;
  walkSec: number;
  /** previous leg's scheduled arrival to the next leg's scheduled departure. */
  waitSec: number;
}

/**
 * A finished journey: N legs and N-1 transfers, always in that relationship. `transfers[i]`
 * is the seam between `legs[i]` and `legs[i + 1]`, which is what lets the wire state the
 * connection arithmetic per leg PAIR rather than once for the whole trip.
 */
export interface StitchedItinerary<R> {
  legs: R[];
  transfers: StitchTransfer[];
  /** epoch ms the rider is off the last vehicle. */
  arrivalMs: number;
  /** true when the legs are not all the same agency (e.g. MiWay -> TTC). */
  crossAgency: boolean;
}

/** Metres between two points. Duplicated rather than imported so this module stays pure. */
function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const key = (agency: string, stopId: string) => `${agency} ${stopId}`;

/**
 * Every pair of transfer stops close enough to walk between, bucketed rather than
 * compared pairwise.
 *
 * A naive double loop is |from stops| x |to stops|, which on a downtown query is
 * millions of haversines for a handful of hits. The grid is sized to the walk cap, so
 * a stop's partners can only be in its own cell or the eight around it.
 */
function nearbyPairs(
  fromStops: readonly StitchStop[],
  toStops: readonly StitchStop[],
): Array<{ from: StitchStop; to: StitchStop; distanceM: number }> {
  // ~1 cell per TRANSFER_MAX_WALK_M, in degrees. Longitude is scaled by latitude so the
  // cells stay roughly square this far north instead of three times too wide.
  const latCell = TRANSFER_MAX_WALK_M / 111_320;
  const midLat = toStops.length > 0 ? toStops[0].lat : 43.65;
  const lonCell = TRANSFER_MAX_WALK_M / (111_320 * Math.max(0.01, Math.cos((midLat * Math.PI) / 180)));
  const buckets = new Map<string, StitchStop[]>();
  for (const s of toStops) {
    const bk = `${Math.floor(s.lat / latCell)}|${Math.floor(s.lon / lonCell)}`;
    const list = buckets.get(bk);
    if (list) list.push(s); else buckets.set(bk, [s]);
  }
  const out: Array<{ from: StitchStop; to: StitchStop; distanceM: number }> = [];
  for (const f of fromStops) {
    const bx = Math.floor(f.lat / latCell);
    const by = Math.floor(f.lon / lonCell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const t of buckets.get(`${bx + dx}|${by + dy}`) ?? []) {
          const distanceM = metresBetween(f.lat, f.lon, t.lat, t.lon);
          if (distanceM > TRANSFER_MAX_WALK_M) continue;
          out.push({ from: f, to: t, distanceM });
        }
      }
    }
  }
  return out;
}

export interface StitchOptions {
  /** metres/second the transfer walk is timed at. */
  paceMps: number;
  /** at most this many itineraries come back, soonest arrival first. */
  limit: number;
  /**
   * Called at every seam and every `STITCH_BREATH_PAIRS` transfer pairs — see rule 5.
   *
   * OPTIONAL, and the default is to do nothing: a caller with no other riders to be
   * polite to (a test, a script) should not pay a macrotask per seam, and the join's
   * RESULT is identical either way. Nothing inside this module reads a clock or decides
   * anything from how long it took.
   */
  breathe?: () => Promise<void>;
}

/** Total walking across every seam — the tie-break, and the dedupe's preference. */
const walkTotalM = (it: StitchedItinerary<unknown>) =>
  it.transfers.reduce((n, t) => n + t.walkM, 0);

/** The span the rider actually experiences: first departure to last arrival. */
const spanMs = <R extends StitchRide>(it: StitchedItinerary<R>) =>
  it.arrivalMs - it.legs[0].departureMs;

/** The trips a chain has already used, so it can never board one of them twice. */
const tripsOf = <R extends StitchRide>(it: StitchedItinerary<R>) =>
  new Set(it.legs.map((l) => key(l.agency, l.tripId)));

/**
 * Extend every chain by one more ride through a walkable transfer.
 *
 * This is THE join, and it is the only place the four rules are enforced. A two-leg
 * search is one call; a three-leg search is two. Nothing about the rules is relaxed for
 * the second seam — that is the entire reason it is written once.
 */
async function joinOnward<R extends StitchRide>(
  chains: readonly StitchedItinerary<R>[],
  onward: readonly R[],
  stopByKey: ReadonlyMap<string, StitchStop>,
  opts: StitchOptions,
): Promise<Array<StitchedItinerary<R>>> {
  if (chains.length === 0 || onward.length === 0) return [];
  // Rule 5, at the seam boundary: one breath before a join starts, so a two-leg search
  // breathes once and a three-leg search twice however small the fixture is.
  if (opts.breathe) await opts.breathe();

  // Index by where each side touches the seam, so the pair loop walks rides rather than
  // re-scanning both lists for every candidate stop pair.
  const arrivingAt = new Map<string, Array<StitchedItinerary<R>>>();
  for (const c of chains) {
    const last = c.legs[c.legs.length - 1];
    const k = key(last.agency, last.alightStopId);
    const list = arrivingAt.get(k);
    if (list) list.push(c); else arrivingAt.set(k, [c]);
  }
  const departingFrom = new Map<string, R[]>();
  for (const r of onward) {
    const k = key(r.agency, r.boardStopId);
    const list = departingFrom.get(k);
    if (list) list.push(r); else departingFrom.set(k, [r]);
  }

  const fromStops: StitchStop[] = [];
  for (const k of arrivingAt.keys()) { const s = stopByKey.get(k); if (s) fromStops.push(s); }
  const toStops: StitchStop[] = [];
  for (const k of departingFrom.keys()) { const s = stopByKey.get(k); if (s) toStops.push(s); }

  /**
   * One extension per (chain, transfer pair): the EARLIEST onward ride that can actually
   * be caught. Keeping later ones would bury the answer under a hundred rows of the same
   * journey an hour apart, and the rider asked when they can get there.
   */
  const best = new Map<string, StitchedItinerary<R>>();
  let sinceBreath = 0;
  for (const pair of nearbyPairs(fromStops, toStops)) {
    // Rule 5, inside the loop: a downtown seam is tens of thousands of pairs, and the
    // rest of the city should not wait behind all of them.
    if (opts.breathe && ++sinceBreath >= STITCH_BREATH_PAIRS) { sinceBreath = 0; await opts.breathe(); }
    const walkSec = Math.round(pair.distanceM / Math.max(0.1, opts.paceMps));
    const arrivals = arrivingAt.get(key(pair.from.agency, pair.from.stopId)) ?? [];
    const departures = departingFrom.get(key(pair.to.agency, pair.to.stopId)) ?? [];
    for (const c of arrivals) {
      // Rule 1: the earliest instant the rider could possibly be standing at the next leg.
      const readyMs = c.arrivalMs + (walkSec + TRANSFER_MIN_SLACK_S) * 1000;
      const used = tripsOf(c);
      let chosen: R | null = null;
      for (const d of departures) {
        if (d.departureMs < readyMs) continue;
        if (d.departureMs - c.arrivalMs > TRANSFER_MAX_WAIT_S * 1000) continue;
        // Riding a vehicle this journey is already on is not a transfer, it is a bug.
        if (used.has(key(d.agency, d.tripId))) continue;
        if (chosen == null || d.departureMs < chosen.departureMs) chosen = d;
      }
      if (chosen == null) continue;
      const next = chosen;
      const it: StitchedItinerary<R> = {
        legs: [...c.legs, next],
        transfers: [...c.transfers, {
          from: pair.from,
          to: pair.to,
          walkM: Math.round(pair.distanceM),
          walkSec,
          waitSec: Math.max(0, Math.round((next.departureMs - c.arrivalMs) / 1000)),
        }],
        arrivalMs: next.arrivalMs,
        crossAgency: c.crossAgency || c.legs.some((l) => l.agency !== next.agency),
      };
      // Collapse duplicates: the same trips reached through different nearby stop pairs is
      // one journey, and the rider should be shown the shorter walk.
      const dedupe = it.legs.map((l) => key(l.agency, l.tripId)).join(' > ');
      const prior = best.get(dedupe);
      if (!prior || walkTotalM(it) < walkTotalM(prior)) best.set(dedupe, it);
    }
  }
  return [...best.values()];
}

/**
 * Rule 4: when the rider is standing at their destination decides it. Ties go to the
 * later first departure (less standing around) and then to the shorter total walk.
 */
function rankByArrival<R extends StitchRide>(a: StitchedItinerary<R>, b: StitchedItinerary<R>): number {
  return a.arrivalMs - b.arrivalMs
    || b.legs[0].departureMs - a.legs[0].departureMs
    || walkTotalM(a) - walkTotalM(b);
}

/** A ride on its own, as a one-leg chain the join can extend. */
const seed = <R extends StitchRide>(r: R): StitchedItinerary<R> =>
  ({ legs: [r], transfers: [], arrivalMs: r.arrivalMs, crossAgency: false });

/**
 * Join leg-1 rides to leg-2 rides through a walkable transfer.
 *
 * `leg1` are rides FROM a stop near the rider; `leg2` are rides TO a stop near the
 * destination. Both are the same shape the single-ride planner already produces, which
 * is the point — this tier adds a join, not a second planner.
 */
export async function stitchItineraries<R extends StitchRide>(
  leg1: readonly R[],
  leg2: readonly R[],
  stops: readonly StitchStop[],
  opts: StitchOptions,
): Promise<Array<StitchedItinerary<R>>> {
  if (leg1.length === 0 || leg2.length === 0) return [];
  const stopByKey = new Map(stops.map((s) => [key(s.agency, s.stopId), s]));
  return (await joinOnward(leg1.map(seed), leg2, stopByKey, opts))
    .sort(rankByArrival)
    .slice(0, opts.limit);
}

/**
 * Join THREE rides through two walkable transfers, or nothing.
 *
 * `mid` are the rides that can serve as the middle leg — neither of whose ends is at the
 * rider or the destination. The caller is responsible for having already narrowed that
 * set to rides touching the transfer neighbourhoods; this function narrows it further by
 * the rules, but it cannot make a search over every trip in the region cheap.
 *
 * WHAT MAKES THIS SAFE TO OFFER: the frontier prune, then the budget. After the first
 * seam, chains standing at the same stop collapse to the earliest arrival (a dominance
 * argument — see THREE_LEG_MAX_FRONTIER); after the second, everything more than
 * `THREE_LEG_BUDGET_*` beyond the best journey found is dropped. A three-leg answer that
 * survives is not a long tail of maybes, it is a small set of real ones.
 */
export async function stitchThreeLeg<R extends StitchRide>(
  leg1: readonly R[],
  mid: readonly R[],
  leg3: readonly R[],
  stops: readonly StitchStop[],
  opts: StitchOptions,
): Promise<Array<StitchedItinerary<R>>> {
  if (leg1.length === 0 || mid.length === 0 || leg3.length === 0) return [];
  const stopByKey = new Map(stops.map((s) => [key(s.agency, s.stopId), s]));

  const firstSeam = await joinOnward(leg1.map(seed), mid, stopByKey, opts);
  if (firstSeam.length === 0) return [];

  // THE PRUNE. Among partial journeys standing at the same stop, the earliest arrival can
  // catch every onward ride the others can, so the rest cannot lead anywhere better. Ties
  // are broken toward the later first departure and the shorter walk, exactly as the final
  // ranking does, so pruning never contradicts the ordering the rider is shown.
  const frontier = new Map<string, StitchedItinerary<R>>();
  for (const c of firstSeam) {
    const last = c.legs[c.legs.length - 1];
    const k = key(last.agency, last.alightStopId);
    const prior = frontier.get(k);
    if (!prior || rankByArrival(c, prior) < 0) frontier.set(k, c);
  }
  const pruned = [...frontier.values()].sort(rankByArrival).slice(0, THREE_LEG_MAX_FRONTIER);

  const full = (await joinOnward(pruned, leg3, stopByKey, opts)).sort(rankByArrival);
  if (full.length === 0) return [];

  // THE BUDGET, measured against the best journey this search actually found rather than
  // against a number invented here. Anything beyond it is a detour, not an option.
  const bestSpan = Math.min(...full.map(spanMs));
  const budget = Math.max(bestSpan * THREE_LEG_BUDGET_RATIO, bestSpan + THREE_LEG_BUDGET_FLOOR_MS);
  return full.filter((it) => spanMs(it) <= budget).slice(0, opts.limit);
}

/**
 * The candidate stops within one transfer walk of any anchor.
 *
 * The three-leg search needs this before it can ask the database anything: a middle leg
 * may only board where the rider can reach on foot from a first leg, and may only alight
 * where a last leg can be reached from. Same grid and same cap as the join itself, so the
 * set handed to SQL can never be wider than the set the rules would accept.
 */
export function withinTransferWalk(
  anchors: readonly StitchStop[],
  candidates: readonly StitchStop[],
): StitchStop[] {
  const hit = new Set<string>();
  for (const p of nearbyPairs(anchors, candidates)) hit.add(key(p.to.agency, p.to.stopId));
  return candidates.filter((c) => hit.has(key(c.agency, c.stopId)));
}
