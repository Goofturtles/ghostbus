// agencies.test — the registry, and the guard that stops a future change buying coverage
// by lowering the bar for evidence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agency, allAgencies, enabledAgencies, feedIdsFor, isKnownAgency, isScheduleOnly,
  demoAgencyFor, USER_AGENT,
} from './agencies.ts';
import {
  MIN_XWALK_OCCURRENCE_COVERAGE, MIN_CROSS_ROUTE_AGREEMENT,
  MAX_MONOTONICITY_VIOLATION_RATE, MAX_BOARD_AGREEMENT_RESID_S,
} from './gates.ts';
import { XWALK_MIN_CONFIDENCE } from './xwalk.ts';
import { boardSpan, type CalendarRow, type CalendarDateRow } from './gtfs.ts';

// ---------------------------------------------------------------------------------
// THE GUARD. This is the most important test in the file and it is deliberately dumb.
// ---------------------------------------------------------------------------------

/**
 * THE HONESTY GATES DO NOT MOVE TO MAKE A NEW AGENCY WORK.
 *
 * Every one of these numbers has a measured justification in METHODS.md §3.6, and
 * BLOCKERS.md entry 10 is the record of the last time crosswalk coverage sat below its
 * gate: the conclusion was "the gate was not the problem" — the crosswalk was fixed
 * (47.3% -> 68.5%) and the threshold stayed at 0.50.
 *
 * Multi-agency creates a specific new temptation. A newly-seeded agency publishes nothing
 * for many cycles while its crosswalk warms (METHODS §9.3), which looks broken and is not.
 * Lowering a gate to make that go away would retroactively invalidate every observation
 * GhostBus has ever published — TTC's included — because the published percentiles would no
 * longer all be backed by the same standard of evidence.
 *
 * The legitimate ways to make a new agency publish are: supply better evidence (an EARNED
 * and AUDITED identity crosswalk, for a feed whose RT ids really are its static ids), or
 * ship it schedule-only and say so. Both leave these numbers alone. Adding a NEW gate is
 * also fine — gates are a ratchet in one direction.
 *
 * If you are reading this because the test failed: the number you changed is not a tuning
 * knob. Change the evidence, not the bar.
 */
test('GUARD: the honesty gate constants are unchanged', () => {
  assert.equal(MIN_XWALK_OCCURRENCE_COVERAGE, 0.50, 'xwalk occurrence coverage gate moved');
  assert.equal(MIN_CROSS_ROUTE_AGREEMENT, 0.85, 'cross-route agreement gate moved');
  assert.equal(MAX_MONOTONICITY_VIOLATION_RATE, 0.05, 'monotonicity violation gate moved');
  assert.equal(MAX_BOARD_AGREEMENT_RESID_S, 300, 'board agreement residual gate moved');
  assert.equal(XWALK_MIN_CONFIDENCE, 0.60, 'crosswalk minimum confidence moved');
});

// ---------------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------------

test('the TTC descriptor still carries exactly the constants it replaced', () => {
  const ttc = agency('ttc');
  assert.equal(ttc.id, 'ttc');
  assert.equal(ttc.tz, 'America/Toronto');
  assert.equal(ttc.rt.vehicles, 'https://bustime.ttc.ca/gtfsrt/vehicles');
  assert.equal(ttc.rt.trips, 'https://bustime.ttc.ca/gtfsrt/trips');
  assert.equal(ttc.rt.alerts, 'https://bustime.ttc.ca/gtfsrt/alerts');
  assert.equal(ttc.staticSource.kind, 'ckan');
  // The learned crosswalk exists because of THIS feed. Flipping it to 'identity' would
  // switch off the machinery METHODS §3.2's measurements demanded.
  assert.equal(ttc.rtNamespace, 'learned');
});

test('MiWay is an identity-namespace agency with all three feeds', () => {
  const mi = agency('miway');
  assert.equal(mi.rtNamespace, 'identity');
  assert.deepEqual(feedIdsFor(mi).sort(), ['alerts', 'trips', 'vehicles']);
  assert.equal(isScheduleOnly(mi), false);
  // The publisher's own casing inconsistency: /gtfs_rt/Alerts/ where the others are
  // /GTFS_RT/. "Correcting" it to match returns 404, so it is pinned here.
  assert.match(mi.rt.alerts!, /\/gtfs_rt\/Alerts\//);
});

test('YRT is identity with exactly two feeds — the absent alerts key IS the fact', () => {
  // rtu.york.ca/gtfsrealtime/Alerts is a 404: YRT publishes no alerts feed. Two keys is
  // the honest count; "completing" the set would report a nonexistent feed as down forever.
  const y = agency('yrt');
  assert.equal(y.rtNamespace, 'identity');
  assert.deepEqual(feedIdsFor(y).sort(), ['trips', 'vehicles']);
  assert.equal(isScheduleOnly(y), false);
});

test('Burlington is identity with all three feeds on its one host', () => {
  const b = agency('burlington');
  assert.equal(b.rtNamespace, 'identity');
  assert.deepEqual(feedIdsFor(b).sort(), ['alerts', 'trips', 'vehicles']);
  for (const url of Object.values(b.rt)) assert.match(url!, /opendata\.burlington\.ca\/gtfs-rt\//);
});

test('DRT: alerts live on a DIFFERENT host than trips/vehicles, deliberately', () => {
  // TripUpdates/VehiclePositions on drtonline.durhamregiontransit.com; the alerts protobuf
  // is published beside the static zip on maps.durham.ca. That is where DRT puts it —
  // "normalising" the host breaks the feed. Pinned exactly like MiWay's lowercase path.
  const d = agency('drt');
  assert.equal(d.rtNamespace, 'identity');
  assert.match(d.rt.trips!, /drtonline\.durhamregiontransit\.com/);
  assert.match(d.rt.vehicles!, /drtonline\.durhamregiontransit\.com/);
  assert.match(d.rt.alerts!, /maps\.durham\.ca/);
  // DRT's required attribution, verbatim from the Region of Durham Open Data Licence v.1.0.
  assert.equal(d.licence.attribution,
    "Contains public sector information made available under The Regional Municipality of Durham's Open Data Licence");
});

test('Brampton: the transitional merged_* NAVINEO paths are pinned as-published', () => {
  const b = agency('brampton');
  assert.equal(b.rtNamespace, 'identity');
  assert.match(b.rt.trips!, /BramptonTransit\/GTFS\/merged_TripUpdate\.pb$/);
  assert.match(b.rt.vehicles!, /merged_VehiclePosition\.pb$/);
  assert.match(b.rt.alerts!, /merged_Alert\.pb$/);
});

test('Oakville and Milton are schedule-only, for two different reasons', () => {
  // Oakville: no realtime feed exists (searched five ways, 2026-07-26).
  // Milton: realtime exists but is a shared 15-operator feed (only 384 of 1,551 stop_ids
  // are Milton's) — unwired ON PURPOSE until filter machinery exists; see the descriptor.
  // Both carry 'learned' as the inert fail-safe: if a feed appears it must be measured
  // before anyone claims identity for it.
  for (const id of ['oakville', 'milton']) {
    const a = agency(id);
    assert.equal(isScheduleOnly(a), true, `${id} should be schedule-only`);
    assert.deepEqual(feedIdsFor(a), []);
    assert.equal(a.rtNamespace, 'learned', `${id} must stay 'learned' until measured`);
  }
});

test('GO and UP Express are static-only until the Metrolinx key arrives, with the required credit', () => {
  // The static zips are open; the RT API is key-gated and GO's RT namespace is UNVERIFIED
  // (the key gate blocked measurement) — so 'learned' is the only honest value, and the
  // Metrolinx Access and Use Agreement's attribution sentence is carried verbatim.
  for (const id of ['go', 'upexpress']) {
    const a = agency(id);
    assert.equal(isScheduleOnly(a), true, `${id} should be schedule-only until the key arrives`);
    assert.equal(a.rtNamespace, 'learned', `${id} RT namespace is unverified — must stay 'learned'`);
    assert.match(a.staticSource.kind === 'direct' ? a.staticSource.url : '', /assets\.metrolinx\.com/);
    assert.equal(a.licence.attribution,
      'Data used in this product or service is provided with the permission of Metrolinx.');
  }
});

test('every registry agency has a credit slot in the About sheet, and its strings exist in every locale', async () => {
  // Several licences REQUIRE attribution wherever their data is shown. The About sheet
  // renders credits from CREDITED_AGENCIES (web/src/components/agencyCredits.ts), keyed to
  // /api/health's seeded list — so a future descriptor added HERE without a slot THERE
  // would ship coverage without its legally required credit. This test makes that a
  // failure instead of a launch-day discovery, and it checks the three i18n strings each
  // slot renders actually exist in every locale, since a missing key renders as its own
  // name rather than throwing.
  const { CREDITED_AGENCIES } = await import('../../web/src/components/agencyCredits.ts');
  const credited = new Set<string>(CREDITED_AGENCIES);
  for (const a of allAgencies()) {
    if (a.id === 'ttc') continue; // rendered unconditionally, above the mapped list
    assert.ok(credited.has(a.id), `agency '${a.id}' has no About-sheet credit slot — add it to CREDITED_AGENCIES and its about.* strings`);
  }
  const locales = {
    en: (await import('../../web/src/i18n/en.ts')).default as unknown as Record<string, Record<string, unknown>>,
    frCA: (await import('../../web/src/i18n/frCA.ts')).default as unknown as Record<string, Record<string, unknown>>,
    es: (await import('../../web/src/i18n/es.ts')).default as unknown as Record<string, Record<string, unknown>>,
  };
  for (const [loc, dict] of Object.entries(locales)) {
    const about = dict.about as Record<string, unknown>;
    for (const id of ['ttc', ...credited]) {
      for (const suffix of ['Name', 'Via', 'Attribution']) {
        const key = `${id}${suffix}`;
        assert.equal(typeof about[key], 'string', `${loc} is missing about.${key}`);
      }
    }
    assert.equal(typeof about.agencyDisclaimer, 'string', `${loc} is missing about.agencyDisclaimer`);
    // The attribution the rider actually reads is the i18n copy, not the descriptor — so
    // the two must be BYTE-IDENTICAL in every locale (licence text is never translated).
    // Without this, a retranslation pass could quietly reword a legally required sentence.
    for (const a of allAgencies()) {
      if (a.licence.attribution === null) continue;
      assert.equal(about[`${a.id}Attribution`], a.licence.attribution,
        `${loc} about.${a.id}Attribution has drifted from the descriptor's licence.attribution`);
    }
  }
});

test('the verbatim-required attribution sentences match the licences as read', () => {
  // Recorded from the terms themselves, 2026-07-27 (.data/r5gta-plan.md §1.6 addendum).
  assert.equal(agency('oakville').licence.attribution,
    'Contains information licensed under the Open Government Licence — Town of Oakville.');
  assert.equal(agency('milton').licence.attribution,
    'Contains information licensed under the Open Government Licence – Milton.');
  // Burlington's obligation is that the terms' URL travels with the data.
  assert.match(agency('burlington').licence.attribution!, /opendata\.burlington\.ca\/opendata-terms-of-use/);
});

test('every descriptor states a licence, and attribution is stated or explicitly none', () => {
  for (const a of allAgencies()) {
    assert.ok(a.licence.name.length > 0, `${a.id} has no licence name`);
    assert.ok(a.licence.via.length > 0, `${a.id} has no licence source`);
    // `null` is allowed and means "the terms were read and require no attribution".
    // `undefined` is not a value the type permits, so an unread licence cannot pass.
    assert.ok(a.licence.attribution === null || a.licence.attribution.length > 0,
      `${a.id} has an empty attribution string — say null if none is required`);
  }
});

test('every agency in the registry uses America/Toronto', () => {
  // tz.ts does all its time math in America/Toronto. An agency in another zone would need
  // that generalised first, so this asserts the assumption rather than leaving it implicit.
  for (const a of allAgencies()) assert.equal(a.tz, 'America/Toronto', `${a.id} is not America/Toronto`);
});

test('an unknown agency id throws instead of returning undefined', () => {
  assert.throws(() => agency('mississauga'), /unknown agency 'mississauga'/);
  assert.equal(isKnownAgency('mississauga'), false);
  assert.equal(isKnownAgency('miway'), true);
});

test('the demo namespace is derived, so a second agency cannot collide with ttc-demo', () => {
  assert.equal(demoAgencyFor('ttc'), 'ttc-demo');
  assert.equal(demoAgencyFor('miway'), 'miway-demo');
  assert.notEqual(demoAgencyFor('miway'), demoAgencyFor('ttc'));
});

test('feedIdsFor reports only what an agency publishes, and none is a real answer', () => {
  // Not every agency has three feeds: YRT publishes no alerts feed (404) and Oakville
  // publishes no realtime at all. `{}` must read as "none", never as three down feeds.
  const noRt = { ...agency('miway'), rt: {} };
  assert.deepEqual(feedIdsFor(noRt), []);
  assert.equal(isScheduleOnly(noRt), true);
  const vehiclesOnly = { ...agency('miway'), rt: { vehicles: 'https://example.invalid/v.pb' } };
  assert.deepEqual(feedIdsFor(vehiclesOnly), ['vehicles']);
  assert.equal(isScheduleOnly(vehiclesOnly), false);
});

// ---------------------------------------------------------------------------------
// enabledAgencies — the opt-in, and why a typo must not be survivable
// ---------------------------------------------------------------------------------

function withEnv(value: string | undefined, fn: () => void): void {
  const prev = process.env.GHOSTBUS_AGENCIES;
  if (value === undefined) delete process.env.GHOSTBUS_AGENCIES;
  else process.env.GHOSTBUS_AGENCIES = value;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.GHOSTBUS_AGENCIES;
    else process.env.GHOSTBUS_AGENCIES = prev;
  }
}

test('with nothing configured, exactly one agency is enabled and it is the TTC', () => {
  // The whole Phase 0 claim rests on this: introducing the registry changes no behaviour
  // until somebody opts in.
  withEnv(undefined, () => {
    const on = enabledAgencies();
    assert.equal(on.length, 1);
    assert.equal(on[0].id, 'ttc');
  });
  withEnv('', () => assert.deepEqual(enabledAgencies().map((a) => a.id), ['ttc']));
  withEnv('   ', () => assert.deepEqual(enabledAgencies().map((a) => a.id), ['ttc']));
});

test('GHOSTBUS_AGENCIES widens coverage, in order, ignoring duplicates and blanks', () => {
  withEnv('ttc,miway', () => assert.deepEqual(enabledAgencies().map((a) => a.id), ['ttc', 'miway']));
  withEnv('miway,ttc', () => assert.deepEqual(enabledAgencies().map((a) => a.id), ['miway', 'ttc']));
  withEnv(' ttc , miway , ttc ', () => assert.deepEqual(enabledAgencies().map((a) => a.id), ['ttc', 'miway']));
  withEnv('miway,,ttc', () => assert.deepEqual(enabledAgencies().map((a) => a.id), ['miway', 'ttc']));
});

test('a typo in GHOSTBUS_AGENCIES fails loudly rather than silently halving coverage', () => {
  // Silently skipping an unknown id would mean an operator who typed `miwya` gets an app
  // that looks fine and covers half of what they asked for — a quiet zero, which is
  // precisely what this project refuses to let pass.
  withEnv('ttc,miwya', () => assert.throws(() => enabledAgencies(), /unknown agency 'miwya'/));
});

test('the User-Agent identifies the project and is not a browser impersonation', () => {
  // DRT and HSR 403 an unidentified client; the fix is to say who we are, not to pretend
  // to be Chrome.
  assert.match(USER_AGENT, /^GhostBus\//);
  assert.doesNotMatch(USER_AGENT, /Mozilla|Chrome|Safari/);
});

// ---------------------------------------------------------------------------------
// boardSpan — the shared board-tag arithmetic (gtfs.ts)
// ---------------------------------------------------------------------------------
//
// This used to be duplicated inline in the seeder and the poller. It is shared now because
// `boardCoverage` IS the `board_tag` that scopes the learned crosswalk (migration 004): if
// the span the seeder loads and the span the poller tags disagree, a board change stops
// invalidating the crosswalk and realtime stops get mapped onto a schedule they were never
// learned from — the failure ARCHITECTURE.md §6 exists to prevent.

test('boardSpan covers calendar and calendar_dates together', () => {
  const cal: CalendarRow[] = [
    { service_id: '1', days: [true, true, true, true, true, false, false], start_date: 20260726, end_date: 20260905 },
  ];
  // An exception OUTSIDE the calendar window must widen the span, not be ignored.
  const dates: CalendarDateRow[] = [{ service_id: '9', date: 20260910, exception_type: 1 }];
  assert.deepEqual(boardSpan(cal, []), { first: 20260726, last: 20260905 });
  assert.deepEqual(boardSpan(cal, dates), { first: 20260726, last: 20260910 });
});

test('a calendar_dates-only feed still yields a REAL tag, never the "?..?" sentinel', () => {
  // The regression this fixes: MiWay/GO/Milton ship no calendar.txt, so the calendar-only
  // derivation left boardCoverage as the literal '?..?' — a constant tag, meaning a board
  // change would NOT invalidate that agency's crosswalk.
  const dates: CalendarDateRow[] = [
    { service_id: '26AU03-CPBlock-Weekday-11', date: 20260804, exception_type: 1 },
    { service_id: '26AU03-CPBlock-Sunday-13', date: 20260809, exception_type: 1 },
  ];
  const span = boardSpan([], dates);
  assert.notEqual(span, null, 'a calendar_dates-only feed must still produce a span');
  assert.deepEqual(span, { first: 20260804, last: 20260809 });

  // And the tag must actually MOVE when the board does — that is the whole point.
  const nextBoard: CalendarDateRow[] = [
    { service_id: '26SE07-CPBlock-Weekday-11', date: 20260907, exception_type: 1 },
  ];
  assert.notDeepEqual(boardSpan([], nextBoard), span);
});

test('boardSpan is null only when there is genuinely no usable date', () => {
  assert.equal(boardSpan([], []), null);
  // A blank date column parses as 0, not NaN. One empty cell must not drag the span to 1899.
  assert.equal(boardSpan([], [{ service_id: 'x', date: 0, exception_type: 1 }]), null);
  const withJunk: CalendarDateRow[] = [
    { service_id: 'x', date: 0, exception_type: 1 },
    { service_id: 'y', date: 20260804, exception_type: 1 },
  ];
  assert.deepEqual(boardSpan([], withJunk), { first: 20260804, last: 20260804 });
});

test('feedIdsFor treats an explicitly-undefined feed as absent', () => {
  // The `!= null` filter exists for this shape, which a spread or a partial config can
  // produce even though the type says the key is optional.
  const weird = { ...agency('miway'), rt: { vehicles: 'https://example.invalid/v.pb', trips: undefined } };
  assert.deepEqual(feedIdsFor(weird), ['vehicles']);
});
