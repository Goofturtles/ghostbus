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
