// agencies — the registry. One descriptor per transit agency GhostBus can observe.
//
// WHY THIS EXISTS. Until now the agency was eight hardcoded `'ttc'` literals scattered
// across poller.ts, engine.ts, aggregate.ts, eval.ts, seed_toronto.ts and demo.ts, plus
// three hardcoded feed URLs. `ARCHITECTURE.md` §5 always said the `agency` seam "runs
// through every table's primary key… preparation rather than a feature". This module is
// where that preparation stops being preparation: it is the single place that answers
// "what is this agency called, where does its schedule come from, what realtime does it
// publish, and whose licence covers it".
//
// ---------------------------------------------------------------------------------
// THE FACT THAT SHAPES THIS FILE: TWO KINDS OF REALTIME FEED
// ---------------------------------------------------------------------------------
// `METHODS.md` §3.2 measured the TTC's realtime feed against the TTC's own static board:
// direct trip_id match 0.3%, per-route stop_id overlap 0.67%, and for a vehicle reported
// STOPPED_AT realtime stop X the static stop NUMBERED X sits a median 13,703 m away. The
// entire learned-crosswalk stack (xwalk.ts, and the anchor/cluster/fixpoint/promote
// machinery in engine.ts) exists because of those numbers.
//
// That is NOT how most publishers behave, and it was worth measuring rather than assuming.
// Every other GTA agency with an open feed was checked by decoding its live protobuf and
// diffing the ids against its own downloaded static zip: MiWay, Brampton, YRT, DRT,
// Burlington, Milton and HSR all reference their own static stop_id / trip_id / route_id
// directly, at 99.6-100%.
//
//   rtNamespace: 'learned'   the TTC. RT ids name nothing we hold; identity must be
//                            inferred geometrically and audited. Slow to warm, and the
//                            reason the crosswalk exists at all.
//   rtNamespace: 'identity'  the normal case. RT ids ARE static ids.
//
// `'identity'` is a CLAIM ABOUT A FEED, not a licence to skip verification. METHODS §4 is
// the record of what trusting an unverified feed-supplied value cost once already (314,742
// observations of a protobuf default). So the claim is earned per stop against the loaded
// static board and audited against geometry before it can back a delay row — see the
// identity crosswalk and the `identityVerified` gate. Nothing here bypasses a gate.

import type { FeedId } from '../../shared/types.ts';

/**
 * The User-Agent EVERY outbound request carries — realtime polls, static zip downloads and
 * feed discovery alike.
 *
 * NOT COSMETIC, and this is why it is a named constant rather than an inline string:
 * Durham Region Transit and Hamilton's HSR both answer HTTP 403 to a default library
 * User-Agent while answering 200 to an identified one (measured 2026-07-26). Without this
 * header those feeds fail every fetch, the poller's backoff walks out to its 5-minute
 * ceiling, and `/api/health` reports them permanently `down` — a silently dead feed rather
 * than a loudly broken one. Identifying ourselves is also simply the polite thing to do to
 * a free public endpoint we poll every 45 seconds.
 *
 * It lives HERE rather than in poller.ts so the seeder can use it without importing the
 * poller — and with it the whole delay engine — just to read one string.
 *
 * NO CONTACT URL, DELIBERATELY. A User-Agent is a claim we make about ourselves to a
 * stranger's server, and an unreachable "+https://…" is a false one. This string carries a
 * URL again only when there is a real published home for the project to point at. It also
 * does not impersonate a browser: the fix for a 403 is to say who we are, not to pretend
 * to be Chrome.
 */
export const USER_AGENT = 'GhostBus/0.1 (transit accountability project)';

/** How a static GTFS zip is located. Agencies publish it in more than one shape. */
export type StaticSource =
  /** A CKAN portal: GET package_show, find the ZIP resource, download its url. */
  | { kind: 'ckan'; packageUrl: string }
  /** A plain, stable URL to the zip itself. */
  | { kind: 'direct'; url: string };

export interface AgencyLicence {
  /** The dataset's own name, as the publisher writes it. */
  name: string;
  /** Where it comes from and under what licence. */
  via: string;
  /**
   * The attribution sentence the publisher REQUIRES us to display, verbatim, or null when
   * the licence demands none. Rendered in the About sheet. A `null` here is a statement
   * that the terms were read and asked for nothing — never a placeholder for "not checked".
   */
  attribution: string | null;
}

export interface AgencyDescriptor {
  /** The namespace every row of this agency's data is keyed by. Never changes. */
  id: string;
  /** Human name, e.g. "Toronto TTC". Seeded into `cities.name`. */
  name: string;
  /** IANA zone. Every GTA agency is America/Toronto; the field exists so that is a fact
   *  the registry states rather than an assumption tz.ts bakes in. */
  tz: string;
  staticSource: StaticSource;
  /**
   * Realtime endpoints. A MISSING KEY MEANS THE AGENCY PUBLISHES NO SUCH FEED — which is
   * a different statement from "the feed is down", and the two must never render alike
   * (the same argument gates.ts makes for boardIntegrity). Oakville publishes none at all.
   */
  rt: Partial<Record<FeedId, string>>;
  /** See the long note at the top of this file. */
  rtNamespace: 'learned' | 'identity';
  licence: AgencyLicence;
}

/**
 * The TTC. Every value here is exactly what the hardcoded constants held before this
 * module existed — `seed_toronto.ts`'s CKAN_URL, `poller.ts`'s FEEDS, and the licence text
 * already in CREDITS.md §5 and the About sheet — so introducing the registry cannot change
 * TTC behaviour.
 */
const TTC: AgencyDescriptor = {
  id: 'ttc',
  name: 'Toronto TTC',
  tz: 'America/Toronto',
  staticSource: {
    kind: 'ckan',
    packageUrl:
      'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action/package_show?id=ttc-routes-and-schedules',
  },
  rt: {
    vehicles: 'https://bustime.ttc.ca/gtfsrt/vehicles',
    trips: 'https://bustime.ttc.ca/gtfsrt/trips',
    alerts: 'https://bustime.ttc.ca/gtfsrt/alerts',
  },
  rtNamespace: 'learned',
  licence: {
    name: 'TTC Routes and Schedules (GTFS) and TTC GTFS-Realtime',
    via: 'City of Toronto Open Data · Open Government Licence – Toronto',
    attribution: 'Contains information licensed under the Open Government Licence – Toronto.',
  },
};

/**
 * MiWay (Mississauga). Verified 2026-07-26: static zip 8,429,588 B / 1,085,895 stop_times,
 * all three realtime feeds open and unauthenticated, refreshing at exactly 30 s, and RT
 * stop/trip/route ids resolving directly against MiWay's own static board.
 *
 * NOTE THE ALERTS PATH. It is `/gtfs_rt/Alerts/` — lowercase `gtfs_rt`, where the other two
 * are `/GTFS_RT/`. That is the publisher's own inconsistency, it is not a typo here, and
 * "fixing" it to match the others returns 404.
 *
 * MiWay ships NO calendar.txt — service is expressed entirely through calendar_dates.txt.
 * That is valid GTFS and the seeder handles it; see `assertRequiredEntries`.
 */
const MIWAY: AgencyDescriptor = {
  id: 'miway',
  name: 'MiWay (Mississauga)',
  tz: 'America/Toronto',
  staticSource: { kind: 'direct', url: 'https://www.miapp.ca/GTFS/google_transit.zip' },
  rt: {
    vehicles: 'https://www.miapp.ca/GTFS_RT/Vehicle/VehiclePositions.pb',
    trips: 'https://www.miapp.ca/GTFS_RT/TripUpdate/TripUpdates.pb',
    alerts: 'https://www.miapp.ca/gtfs_rt/Alerts/Alerts.pb',
  },
  rtNamespace: 'identity',
  licence: {
    name: 'MiWay GTFS and GTFS-Realtime',
    via: 'City of Mississauga Open Data · City of Mississauga Terms of Use',
    attribution: 'Contains information made available by the City of Mississauga.',
  },
};

const ALL: readonly AgencyDescriptor[] = [TTC, MIWAY];
const BY_ID = new Map(ALL.map((a) => [a.id, a]));

/**
 * The published schedule's namespace for a demo replay of `agency`.
 *
 * A demo process writes its observations here and READS THE STATIC BOARD UNDER `agency`,
 * because a schedule is not an observation and there is only one published board — see
 * DECISIONS.md §44 and §48. Derived rather than a literal so a second agency cannot end up
 * sharing 'ttc-demo'.
 */
export function demoAgencyFor(agency: string): string {
  return `${agency}-demo`;
}

/** Every agency GhostBus knows how to describe. Not the same as the seeded set. */
export function allAgencies(): readonly AgencyDescriptor[] {
  return ALL;
}

/** Throws rather than returning undefined: an unknown agency id is a programming error. */
export function agency(id: string): AgencyDescriptor {
  const d = BY_ID.get(id);
  if (!d) {
    throw new Error(
      `unknown agency '${id}' — known: ${[...BY_ID.keys()].join(', ')}. ` +
      `Add a descriptor in server/src/agencies.ts before referring to it.`,
    );
  }
  return d;
}

export function isKnownAgency(id: string): boolean {
  return BY_ID.has(id);
}

/**
 * The agencies this process actually observes and serves, in order.
 *
 * DEFAULTS TO TTC ALONE, so behaviour is unchanged until an operator opts in. Set
 * `GHOSTBUS_AGENCIES=ttc,miway` to widen it. Unknown ids are a hard failure rather than a
 * silent skip: a typo that quietly halves your coverage is exactly the kind of thing this
 * project refuses to let pass as a quiet zero.
 */
export function enabledAgencies(): readonly AgencyDescriptor[] {
  const raw = process.env.GHOSTBUS_AGENCIES?.trim();
  if (!raw) return [TTC];
  const ids = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (ids.length === 0) return [TTC];
  const seen = new Set<string>();
  const out: AgencyDescriptor[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(agency(id));
  }
  return out;
}

/**
 * Realtime feeds this agency actually publishes. `poller.ts` iterates THIS rather than the
 * three-member FeedId union, so an agency with no alerts feed (YRT) or no realtime at all
 * (Oakville) reports nothing instead of three permanently-`down` feeds.
 */
export function feedIdsFor(d: AgencyDescriptor): FeedId[] {
  return (Object.keys(d.rt) as FeedId[]).filter((k) => d.rt[k] != null);
}

/** True when the agency publishes no realtime at all — schedule-only, and honest about it. */
export function isScheduleOnly(d: AgencyDescriptor): boolean {
  return feedIdsFor(d).length === 0;
}
