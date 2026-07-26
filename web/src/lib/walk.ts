// Walk timing — the one place GhostBus turns metres into minutes.
//
// It lives apart from format.ts (which pulls in the i18n runtime, and with it the
// DOM) purely so that this arithmetic, and the Catch verdict built on top of it,
// can be exercised in a plain Node test with no browser around.

/** Walking seconds to cover `metres` at `mps`, inflated by a route factor to
 *  account for real (non-straight-line) walking paths. Default 1.25. */
export function walkSeconds(metres: number, mps: number, routeFactor = 1.25): number {
  if (!Number.isFinite(metres) || metres <= 0 || !Number.isFinite(mps) || mps <= 0) return 0;
  return Math.round((metres / mps) * routeFactor);
}

/**
 * How a walk's distance was arrived at. The distinction is not cosmetic: it decides
 * both the arithmetic below and the wording on screen.
 *
 *   'routed' — measured along a real line of ways this device has the geometry for.
 *              The one the map draws.
 *   'direct' — the straight line between the two points, because no walkable line
 *              could be found. An estimate, and every surface that prints it must
 *              say so.
 */
export type WalkKind = 'routed' | 'direct';

/** A walk with its provenance attached, as produced by the map's routing pass. */
export interface MeasuredWalk {
  kind: WalkKind;
  /** metres along `kind === 'routed'` geometry, else straight-line metres. */
  distanceM: number;
  seconds: number;
  /** the boarding stop this walk ends at — how a consumer knows it is theirs. */
  stopId: string;
}

/**
 * Seconds for a walk of a known kind.
 *
 * THE ROUTE FACTOR IS AN APOLOGY FOR NOT KNOWING THE ROUTE. 1.25 was a documented
 * guess at how much longer the real pavement is than the crow's flight — the best
 * this app could do while it drew walks as straight lines. Once the walk has been
 * measured along actual ways, applying it again would inflate a real number by a
 * correction for an error that is no longer being made: a routed 620 m would be
 * billed as 775 m. So a routed walk is timed at face value, and only the straight-
 * line fallback keeps the factor — where it still means what it always meant.
 */
export function walkLegSeconds(kind: WalkKind, metres: number, mps: number): number {
  return walkSeconds(metres, mps, kind === 'routed' ? 1 : 1.25);
}

/**
 * The walk to quote for one stop — the measured one when the map has drawn it, the
 * straight-line estimate otherwise.
 *
 * ONE FUNCTION, because the alternative is five surfaces each deciding for themselves
 * whether the published leg is theirs, and four of them getting it right. The stop id
 * is the whole test: a leg measured to King & Spadina says nothing about the walk to
 * Queen & Bathurst, and quoting it there would be worse than the estimate it replaced.
 *
 * Returns null when there is no walk to state at all.
 */
export function walkFor(
  leg: MeasuredWalk | null | undefined,
  stopId: string,
  straightM: number | null | undefined,
  mps: number,
): MeasuredWalk | null {
  if (leg && leg.stopId === stopId) return leg;
  if (straightM == null || !Number.isFinite(straightM)) return null;
  return {
    kind: 'direct',
    distanceM: Math.round(straightM),
    seconds: walkLegSeconds('direct', straightM, mps),
    stopId,
  };
}

/** Whole minutes, never zero — a walk that exists takes at least a minute to say. */
export const walkMinutes = (seconds: number): number => Math.max(1, Math.round(seconds / 60));
