// OTHER WAYS TO GET THERE — and the prices this app does not print.
//
// A trip planner that only ever answers "transit" is lying by omission: sometimes the
// honest answer is that the walk is fifteen minutes and you should just walk it. So the
// options list is followed by the alternatives GhostBus can state truthfully.
//
// WHAT IS NOT HERE, AND WHY. There are no fare estimates on any row. That is not an
// oversight, it is the same rule the rest of the app runs on:
//
//   TRANSIT   the GTFS feeds this project ingests carry no fare_attributes and no
//             fare_rules — `grep -rn fare server/` returns nothing. A single number
//             would also be wrong across the six seeded agencies (TTC, YRT, MiWay,
//             Brampton and GO price differently, GO by distance) before transfer and
//             co-fare rules are even considered.
//   UBER      uber.com publishes no per-city rate card. Checked directly: the pricing
//             page describes base rate, fees and surge in prose and prints no figures.
//             The only sources that DO carry Toronto numbers are SEO fare-calculator
//             sites with no stated provenance or retrieval date. Laundering one of those
//             into "est. from published rates" would be exactly the confident-sounding
//             fabrication this app exists to argue against.
//   TAXI      the City of Toronto tariff is regulated and public, and two City sources
//             disagree: Municipal Code Ch. 546 Appendix A (page stamped June 27, 2024)
//             sets $3.25 for the first 0.143 km, while the City's own plain-language
//             taxi page says meters "start at $4.25". A dollar on the drop rate is
//             ~15% of a short fare. Separately, the regulated meter applies only to
//             street hails and cabstand pickups — an app-booked taxi may surge — so it
//             is not even the number a rider planning in an app would pay. Unresolvable
//             today, so the row does not ship at all.
//
// A DEEP LINK FABRICATES NOTHING, which is why the Uber row still exists. It hands the
// rider to an app that will quote its own real price.

import type { LatLon } from './planpoint';
// ONE haversine for the whole app. Re-deriving it here gave two copies that were
// byte-identical on the day they were written and free to drift after it; two different
// distances for one pair of points is how a card and a row come to disagree on screen.
import { haversineM } from './search';
import { walkLegSeconds } from './walk';

export { haversineM };

/**
 * Beyond this, walking is not an alternative anybody is weighing — it is a different
 * kind of afternoon. Five kilometres is roughly an hour on foot at the app's default
 * pace, which is the outer edge of "I could just walk this".
 */
export const WALK_ALTERNATIVE_MAX_M = 5_000;

export interface WalkAlternative {
  /**
   * THE STRAIGHT LINE, UNPADDED — because that is what every other walk in this app
   * prints, and the rider-facing explanation says so in as many words: "≈ are straight
   * lines at your pace, padded by a 1.25 route factor". The TIME carries the factor; the
   * distance is the crow's flight.
   *
   * An earlier draft padded the distance too. Same pair of points then read 4.7 km in a
   * journey step and 5.9 km here — one app quoting itself two different numbers, which is
   * the class of defect this project exists to prevent, arrived at by being extra careful.
   */
  distanceM: number;
  /** Seconds at the rider's own pace, inflated by the route factor via `walkLegSeconds`
   *  — the same call the journey steps and the stop header make. */
  seconds: number;
}

/**
 * The walk, when walking is genuinely one of the answers. Null when it is not.
 *
 * Null rather than a very large number on purpose: the caller renders nothing for null,
 * and "Walk 41 km · 8 hr" is not an alternative, it is noise that makes the honest rows
 * beside it look unconsidered.
 */
export function walkAlternative(
  from: LatLon | null, to: LatLon | null, paceMps: number,
): WalkAlternative | null {
  if (!from || !to || !(paceMps > 0)) return null;
  const straight = haversineM(from, to);
  if (straight > WALK_ALTERNATIVE_MAX_M) return null;
  const distanceM = Math.round(straight);
  // 'direct' — there is no routed geometry between two arbitrary points, so this is the
  // estimate branch and it must wear the app's '≈' wherever it is rendered.
  return { distanceM, seconds: walkLegSeconds('direct', distanceM, paceMps) };
}

/**
 * A DEEP LINK TO UBER. It carries what the rider chose and, deliberately, not where they
 * are standing.
 *
 * THE PROMISE, AND BOTH ENDS OF IT. `PlanView`'s maps handoff already states the rule:
 * the rider's own position is the one thing GhostBus does not hand to anyone else. An
 * earlier draft of this function honoured that on the pickup and quietly broke it on the
 * dropoff — `swapPlanEnds` exists precisely so "from the office to here" works, and
 * `here` resolves to the live fix, so a swapped trip serialised the rider's coordinates
 * into a URL while the comment above claimed they never travelled. Both ends are asked
 * now, and neither is assumed.
 *
 *   rider's own fix   pickup becomes the literal `my_location`, which tells the Uber app
 *                     to read the device's position itself. As a DROPOFF there is no such
 *                     keyword, so the destination is simply omitted and the rider sets it
 *                     in Uber — a link that asks one more tap beats one that discloses a
 *                     home address we were trusted with.
 *   a place they set  sent. A stop off a published schedule, or a pin they dropped, is a
 *                     public place the rider chose rather than a fact about their body.
 *                     Withholding it would silently send a car to the wrong end of the
 *                     trip, which is worse than the disclosure it avoids.
 *
 * NO FALLBACK TO `my_location` WHEN A NAMED ORIGIN FAILS TO RESOLVE. A stop the agency
 * published without coordinates is a real case, and defaulting it to the device's
 * position would summon a car to wherever the rider happens to be — the exact outcome the
 * paragraph above calls worse. The parameter is left out instead, so Uber asks.
 *
 * No fare, no estimate, no "from $X". The link fabricates nothing; Uber quotes its own
 * real price on the other side of it.
 */
export function uberUrl(
  from: LatLon | null,
  to: LatLon | null,
  opts: { originIsRider: boolean; destIsRider?: boolean; dropoffName?: string | null },
): string {
  const parts: string[] = ['action=setPickup'];
  // BRACKETS STAY LITERAL. `URLSearchParams` would percent-encode them to %5B/%5D;
  // Uber's own published examples use bare brackets, and rather than bet on which
  // decoding order their parser uses, this builds the query so the shape matches the
  // documented one exactly. Values are still individually encoded.
  const put = (k: string, v: string) => parts.push(`${k}=${encodeURIComponent(v)}`);

  if (opts.originIsRider) put('pickup', 'my_location');
  else if (from) {
    put('pickup[latitude]', from.lat.toFixed(6));
    put('pickup[longitude]', from.lon.toFixed(6));
  }

  if (!opts.destIsRider && to) {
    put('dropoff[latitude]', to.lat.toFixed(6));
    put('dropoff[longitude]', to.lon.toFixed(6));
    // encodeURIComponent, not form encoding: a space must be %20, because a `+` renders
    // as a literal plus under RFC 3986 decoding and the rider would see "Dundas+West".
    if (opts.dropoffName) put('dropoff[nickname]', opts.dropoffName);
  }

  return `https://m.uber.com/ul/?${parts.join('&')}`;
}
