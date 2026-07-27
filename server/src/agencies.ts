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
   * The attribution sentence displayed in the About sheet: the publisher's required
   * wording verbatim where the licence dictates one (TTC, DRT, Oakville, Milton,
   * Metrolinx); the publisher's own suggested credit where credit is optional but a form
   * is offered (YRT); or a constructed sentence naming the source where the licence
   * requires attribution without fixing the words (Brampton's CC BY) or requires the
   * terms' URL to travel with the data (Burlington). Null only when the terms were read
   * and asked for nothing — never a placeholder for "not checked". TTC and MiWay are the
   * required-verbatim case; each GTA descriptor's comment states which case it is.
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

/**
 * YRT/Viva (York Region). Verified 2026-07-26: static zip open, RT ids resolve directly
 * against YRT's own static board (200/200 stops, 200/200 trips sampled).
 *
 * NO ALERTS FEED — `rtu.york.ca/gtfsrealtime/Alerts` is a 404, not an outage. YRT
 * publishes two feeds, and the absent key here is the statement that the third does not
 * exist (see the note on `rt` above). Do not "complete" the set.
 *
 * Licence (read 2026-07-27): YRT Open Data Licence Agreement — worldwide, royalty-free,
 * perpetual; commercial use permitted. Credit is NOT required; the attribution below is
 * the credit form YRT's own licence suggests, displayed voluntarily. YRT also asks users
 * to accept the licence via forms.yrt.ca/YRT-GTFS-Data — a policy gate, not a technical
 * one (the feeds answer cold); the operator should complete that form once.
 */
const YRT: AgencyDescriptor = {
  id: 'yrt',
  name: 'YRT/Viva (York Region)',
  tz: 'America/Toronto',
  staticSource: { kind: 'direct', url: 'https://www.yrt.ca/google/google_transit.zip' },
  rt: {
    vehicles: 'https://rtu.york.ca/gtfsrealtime/VehiclePositions',
    trips: 'https://rtu.york.ca/gtfsrealtime/TripUpdates',
  },
  rtNamespace: 'identity',
  licence: {
    name: 'YRT/Viva GTFS and GTFS-Realtime',
    via: 'York Region Transit Open Data · YRT Open Data Licence Agreement',
    attribution: "Contains public transit Information made available under YRT's Open Data Licence",
  },
};

/**
 * Burlington Transit. Verified 2026-07-26: the cleanest feed in the GTA set — RT identity
 * at 100.0% of 635 stops, all three feeds, exactly 30 s cadence, one host for everything.
 *
 * Licence (terms PDF read 2026-07-27): Terms of Use for Open Data Burlington (2011-09-19).
 * Use/reproduce/modify/distribute for any lawful purpose. Credit optional, but anyone
 * redistributing the datasets must include a copy of, or the URL for, the Terms of Use —
 * which is why the attribution line below carries the URL rather than a bare name.
 */
const BURLINGTON: AgencyDescriptor = {
  id: 'burlington',
  name: 'Burlington Transit',
  tz: 'America/Toronto',
  staticSource: { kind: 'direct', url: 'https://opendata.burlington.ca/gtfs-rt/GTFS_Data.zip' },
  rt: {
    vehicles: 'https://opendata.burlington.ca/gtfs-rt/GTFS_VehiclePositions.pb',
    trips: 'https://opendata.burlington.ca/gtfs-rt/GTFS_TripUpdates.pb',
    alerts: 'https://opendata.burlington.ca/gtfs-rt/GTFS_ServiceAlerts.pb',
  },
  rtNamespace: 'identity',
  licence: {
    name: 'Burlington Transit GTFS and GTFS-Realtime',
    via: 'City of Burlington Open Data · Terms of Use for Open Data Burlington',
    attribution:
      'Includes datasets made available by the City of Burlington under its Open Data Terms of Use (https://opendata.burlington.ca/opendata-terms-of-use/City%20of%20Burlington%20-%20Open%20Data%20Terms%20of%20Use.pdf).',
  },
};

/**
 * Durham Region Transit. Verified 2026-07-26: RT identity (200/200 stops, 156/156 trips),
 * exactly 30 s. DRT answers HTTP 403 to an unidentified client — USER_AGENT above exists
 * in large part for this feed.
 *
 * THE ALERTS HOST IS DIFFERENT ON PURPOSE. TripUpdates and VehiclePositions live on
 * drtonline.durhamregiontransit.com; the alerts protobuf is published on maps.durham.ca
 * beside the static zip. That is where DRT actually puts it — "fixing" the host breaks it.
 *
 * Licence (read 2026-07-27, via durham.ca): Region of Durham Open Data Licence v.1.0 —
 * copy/publish/distribute/adapt, commercial use permitted, no endorsement implication.
 * The attribution below is the licence's own required wording, verbatim.
 */
const DRT: AgencyDescriptor = {
  id: 'drt',
  name: 'Durham Region Transit',
  tz: 'America/Toronto',
  staticSource: { kind: 'direct', url: 'https://maps.durham.ca/OpenDataGTFS/GTFS_Durham_TXT.zip' },
  rt: {
    vehicles: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/VehiclePositions',
    trips: 'https://drtonline.durhamregiontransit.com/gtfsrealtime/TripUpdates',
    alerts: 'https://maps.durham.ca/OpenDataGTFS/alerts.pb',
  },
  rtNamespace: 'identity',
  licence: {
    name: 'Durham Region Transit GTFS and GTFS-Realtime',
    via: 'Durham Region Open Data · Region of Durham Open Data Licence v.1.0',
    attribution:
      "Contains public sector information made available under The Regional Municipality of Durham's Open Data Licence",
  },
};

/**
 * Brampton Transit. Verified 2026-07-26: RT identity (300/300 stops, 37/37 routes).
 *
 * MID-MIGRATION, AND THESE URLS SAY SO. The `merged_*` filenames on the bt-cadavl.com
 * host are transitional artifacts of Brampton's move to Equans/Ineo NAVINEO, and the old
 * brampton.ca / nextride URLs the aggregators still list are already dead (404 / refused).
 * This is the GTA feed most likely to move again — if it 404s, look for the post-NAVINEO
 * home before assuming an outage. The alerts feed is currently a 15-byte header-only
 * protobuf: empty is its normal state, not a failure.
 *
 * Licence: the City's ArcGIS item (a355aabd…) carries licenseInfo "CC BY", access
 * "City of Brampton". Attribution is therefore required; CC BY leaves the form flexible.
 */
const BRAMPTON: AgencyDescriptor = {
  id: 'brampton',
  name: 'Brampton Transit',
  tz: 'America/Toronto',
  staticSource: {
    kind: 'direct',
    url: 'https://www.arcgis.com/sharing/rest/content/items/a355aabd5a8c490186bdce559c9c75fb/data',
  },
  rt: {
    vehicles: 'https://gtfs-rt-merge.prod.bt-cadavl.com/BramptonTransit/GTFS/merged_VehiclePosition.pb',
    trips: 'https://gtfs-rt-merge.prod.bt-cadavl.com/BramptonTransit/GTFS/merged_TripUpdate.pb',
    alerts: 'https://gtfs-rt-merge.prod.bt-cadavl.com/BramptonTransit/GTFS/merged_Alert.pb',
  },
  rtNamespace: 'identity',
  licence: {
    name: 'Brampton Transit GTFS and GTFS-Realtime',
    via: 'City of Brampton Open Data · CC BY',
    attribution: 'Contains information licensed under CC BY, provided by the City of Brampton.',
  },
};

/**
 * Oakville Transit. NO REALTIME FEED EXISTS — searched five ways, 2026-07-26. The empty
 * `rt` is that fact, not an omission: Oakville is the schedule-only case §4.1 of the GTA
 * plan describes, and its boards render with bucket:'none' exactly like a demo instance.
 *
 * `rtNamespace` is inert with no feeds; 'learned' is the fail-safe default so that if a
 * feed ever appears it must be measured before anyone claims identity for it.
 *
 * Licence (read 2026-07-27): Open Government Licence – Town of Oakville. Attribution
 * below is the licence's own default statement, verbatim (em dash included).
 */
const OAKVILLE: AgencyDescriptor = {
  id: 'oakville',
  name: 'Oakville Transit',
  tz: 'America/Toronto',
  staticSource: {
    kind: 'direct',
    url: 'https://www.arcgis.com/sharing/rest/content/items/d78a1c1ad6a940009de8b68839a8f606/data',
  },
  rt: {},
  rtNamespace: 'learned',
  licence: {
    name: 'Oakville Transit GTFS',
    via: 'Town of Oakville Open Data · Open Government Licence — Town of Oakville',
    attribution: 'Contains information licensed under the Open Government Licence — Town of Oakville.',
  },
};

/**
 * Milton Transit — STATIC-ONLY, ON PURPOSE, AND NOT FOR LICENCE REASONS.
 *
 * Milton's licence is fine (read 2026-07-27: Open Government Licence – Milton, OGL-shaped,
 * attribution required with the default statement below). Milton also publishes realtime —
 * but through a SHARED MULTI-OPERATOR feed (metrolinx.tmix.se/gtfs-realtime-milton/…)
 * carrying 14 other operators: measured 2026-07-26, only 35 of 137 TripUpdate entities and
 * 384 of 1,551 stop_ids are Milton's. Wiring it unfiltered would put Belleville buses on a
 * Milton map, and the identityVerified gate's 0.95 membership floor would (correctly)
 * refuse the whole feed at 24.8%. Observing it requires Milton-prefix filter machinery
 * that does not exist yet — a separate wave. Until then the empty `rt` means "GhostBus
 * does not observe Milton's realtime", and the boards are schedule-only and say so.
 */
const MILTON: AgencyDescriptor = {
  id: 'milton',
  name: 'Milton Transit',
  tz: 'America/Toronto',
  staticSource: { kind: 'direct', url: 'https://metrolinx.tmix.se/gtfs/gtfs-milton.zip' },
  rt: {},
  rtNamespace: 'learned',
  licence: {
    name: 'Milton Transit GTFS',
    via: 'Discover Milton Open Data · Open Government Licence – Milton',
    attribution: 'Contains information licensed under the Open Government Licence – Milton.',
  },
};

/**
 * GO Transit — STATIC-ONLY UNTIL THE METROLINX KEY ARRIVES.
 *
 * The static zip is open; the realtime API (api.openmetrolinx.com) requires a free key the
 * operator has requested (up to 10 business days). When it arrives, RT joins as a
 * descriptor edit here — URLs plus the key's env-var name — not a rebuild. GO's RT
 * namespace is UNVERIFIED (the key gate blocked measurement), so 'learned' is the only
 * honest value until it is measured; do not flip it to 'identity' on documentation.
 *
 * Licence: Metrolinx Access and Use Agreement. The attribution below is the exact
 * sentence Metrolinx requires, verbatim.
 */
const GO: AgencyDescriptor = {
  id: 'go',
  name: 'GO Transit',
  tz: 'America/Toronto',
  staticSource: {
    kind: 'direct',
    url: 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip',
  },
  rt: {},
  rtNamespace: 'learned',
  licence: {
    name: 'GO Transit GTFS',
    via: 'Metrolinx Open Data · Metrolinx Access and Use Agreement',
    attribution: 'Data used in this product or service is provided with the permission of Metrolinx.',
  },
};

/**
 * UP Express. Same publisher, licence and key situation as GO (see above): static-only
 * until the Metrolinx key arrives, and the same required attribution sentence.
 */
const UPEXPRESS: AgencyDescriptor = {
  id: 'upexpress',
  name: 'UP Express',
  tz: 'America/Toronto',
  staticSource: {
    kind: 'direct',
    url: 'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/UP-GTFS.zip',
  },
  rt: {},
  rtNamespace: 'learned',
  licence: {
    name: 'UP Express GTFS',
    via: 'Metrolinx Open Data · Metrolinx Access and Use Agreement',
    attribution: 'Data used in this product or service is provided with the permission of Metrolinx.',
  },
};

const ALL: readonly AgencyDescriptor[] = [
  TTC, MIWAY, YRT, BURLINGTON, DRT, BRAMPTON, OAKVILLE, MILTON, GO, UPEXPRESS,
];
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
