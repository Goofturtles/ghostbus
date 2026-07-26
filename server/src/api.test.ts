// Phase-5 API tests: trust-grade derivation, Ghost-Forecast rate math, and the query /
// response shaping of /api/alerts and /api/ghosts/feed against fixtures.
//
// The endpoint tests drive the real Fastify app through `app.inject()` with a fake Db
// that answers by SQL substring and records every call, so they assert the SQL that is
// actually issued (parameterised, clamped) as well as the JSON that comes back.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gradeFor, spreadMinutes, GRADE_TIERS,
  ghostRiskFor, GHOST_RISK_MIN_N, GHOST_RISK_ELEVATED_RATE, GHOST_RISK_HIGH_RATE,
  buildForecast, agencyLocalStamp, buildApi, rankRideCandidates,
  type TripStartBucket, type ForecastDay, type RankableRide,
} from './api.ts';
import type { Db, Params, Result } from './db.ts';
import type { PollerHandle } from './poller.ts';
import type {
  AlertsResponse, GhostFeedResponse, PlanResponse, HealthResponse, StopsResponse,
} from '../../shared/types.ts';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// =====================================================================================
// trust grades
// =====================================================================================

test('spreadMinutes halves the P25..P75 seconds and rounds to whole minutes', () => {
  assert.equal(spreadMinutes(0, 0), 0);
  assert.equal(spreadMinutes(-120, 360), 4);   // 480s spread -> ±240s -> 4 min
  assert.equal(spreadMinutes(60, 200), 1);     // 140s spread -> ±70s  -> 1 min (rounded)
  assert.equal(spreadMinutes(0, 1800), 15);
});

test('spreadMinutes never returns a negative spread', () => {
  // Inverted percentiles would be a bug upstream; a grade must not encode a negative band.
  assert.equal(spreadMinutes(600, 0), 0);
});

test('gradeFor returns no grade at all when there is no evidence', () => {
  assert.equal(gradeFor('none', 0, 0), null);
  // Even a suspiciously good-looking sample cannot earn a letter without a bucket.
  assert.equal(gradeFor('none', 500, 0), null);
});

test('gradeFor A/B/C/D boundaries are inclusive on both dimensions', () => {
  for (const tier of GRADE_TIERS) {
    const exact = gradeFor('stop-hour', tier.minN, tier.maxSpreadMin);
    assert.equal(exact?.letter, tier.letter, `n=${tier.minN} spread=${tier.maxSpreadMin}`);
  }
  assert.equal(gradeFor('stop-hour', 40, 4)?.letter, 'A');
  assert.equal(gradeFor('stop-hour', 39, 4)?.letter, 'B');  // one observation short of A
  assert.equal(gradeFor('stop-hour', 40, 5)?.letter, 'B');  // one minute too wide for A
  assert.equal(gradeFor('stop-hour', 25, 6)?.letter, 'B');
  assert.equal(gradeFor('stop-hour', 24, 6)?.letter, 'C');
  assert.equal(gradeFor('stop-hour', 15, 9)?.letter, 'C');
  assert.equal(gradeFor('stop-hour', 14, 9)?.letter, 'D');
  assert.equal(gradeFor('stop-hour', 8, 14)?.letter, 'D');
});

test('gradeFor falls to E when a tier fails on either dimension', () => {
  assert.equal(gradeFor('stop-hour', 7, 1)?.letter, 'E');    // sample too thin for D
  assert.equal(gradeFor('route-hour', 400, 15)?.letter, 'E'); // huge sample, band too wide
  assert.equal(gradeFor('route-hour', 200, 60)?.letter, 'E');
});

test('a wide band is never bought with sample size, nor a thin sample with a tight band', () => {
  // 1000 observations spread over ±10 min is still only a D — never an A.
  assert.equal(gradeFor('route-hour', 1000, 10)?.letter, 'D');
  // A perfect ±0 band on 8 observations is still only a D — never an A.
  assert.equal(gradeFor('stop-hour', 8, 0)?.letter, 'D');
});

test('gradeFor carries the sample size and spread it graded on', () => {
  const g = gradeFor('stop-hour', 41, 4);
  assert.deepEqual(g, { letter: 'A', n: 41, spreadMin: 4 });
});

test('gradeFor withholds on nonsense inputs rather than inventing a letter', () => {
  assert.equal(gradeFor('stop-hour', 0, 3), null);
  assert.equal(gradeFor('stop-hour', Number.NaN, 3), null);
  assert.equal(gradeFor('stop-hour', 30, -1), null);
});

// =====================================================================================
// ghost-risk thresholds + n-gating
// =====================================================================================

test('ghostRiskFor gates on sample size before it ever computes a rate', () => {
  // 7 scheduled trips with 7 ghosts is a 100% rate — and still not enough to publish.
  assert.equal(ghostRiskFor(7, GHOST_RISK_MIN_N - 1, 14), null);
  assert.notEqual(ghostRiskFor(7, GHOST_RISK_MIN_N, 14), null);
});

test('ghostRiskFor is silent below the elevated threshold', () => {
  assert.equal(ghostRiskFor(0, 100, 14), null);        // nothing vanished
  assert.equal(ghostRiskFor(8, 100, 14), null);        // exactly 8% is NOT > 8%
  assert.equal(ghostRiskFor(1, 100, 14), null);
});

test('ghostRiskFor levels: elevated above 8%, high above 20%', () => {
  assert.equal(ghostRiskFor(9, 100, 14)?.level, 'elevated');
  assert.equal(ghostRiskFor(20, 100, 14)?.level, 'elevated'); // exactly 20% is NOT > 20%
  assert.equal(ghostRiskFor(21, 100, 14)?.level, 'high');
  assert.equal(ghostRiskFor(50, 100, 14)?.level, 'high');
});

test('ghostRiskFor reports the exact counts behind the rate', () => {
  const r = ghostRiskFor(3, 20, 14);
  assert.deepEqual(r, { level: 'elevated', rate: 0.15, n: 20, ghosts: 3, windowDays: 14 });
  assert.ok(r && r.rate > GHOST_RISK_ELEVATED_RATE && r.rate <= GHOST_RISK_HIGH_RATE);
});

test('ghostRiskFor withholds when the two sides disagree about the window', () => {
  // More ghosts than scheduled trips means the numerator and denominator were counted
  // over different cells; report nothing rather than a >100% rate.
  assert.equal(ghostRiskFor(30, 20, 14), null);
  assert.equal(ghostRiskFor(Number.NaN, 20, 14), null);
});

// =====================================================================================
// forecast denominator
// =====================================================================================

/** A deterministic UTC cell mapper so the forecast tests never depend on a real zone. */
const utcCell = (ms: number) => {
  const d = new Date(ms);
  return {
    ymd: d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate(),
    how: ((d.getUTCDay() + 6) % 7) * 24 + d.getUTCHours(), // Monday = 0, matching hourOfWeek
  };
};

const DAY_MS = 86_400_000;
/** Mon 2026-01-05 00:00 UTC. */
const MON = Date.UTC(2026, 0, 5);

function day(offsetDays: number, serviceIds: string[]): ForecastDay {
  const midnightMs = MON + offsetDays * DAY_MS;
  return { ymd: utcCell(midnightMs).ymd, midnightMs, serviceIds };
}

test('buildForecast counts scheduled trips only in hours the collector actually watched', () => {
  const byService = new Map<string, TripStartBucket[]>([
    ['WEEKDAY', [
      { routeId: '501', startS: 8 * 3600, n: 6 },   // 08:00 — watched
      { routeId: '501', startS: 12 * 3600, n: 4 },  // 12:00 — NOT watched
    ]],
  ]);
  const watched = new Set([`${utcCell(MON).ymd}|${8}`]); // Monday 08:00 only
  const f = buildForecast({
    watched, days: [day(0, ['WEEKDAY'])], byService, ghosts: [], cellOf: utcCell,
  });
  assert.equal(f.get('501|8')?.scheduled, 6);
  assert.equal(f.get('501|12'), undefined, 'an unwatched hour must contribute no denominator');
});

test('buildForecast accumulates the denominator across every watched day', () => {
  const byService = new Map<string, TripStartBucket[]>([
    ['WEEKDAY', [{ routeId: '501', startS: 8 * 3600, n: 5 }]],
  ]);
  // Mon + Tue + Wed, all watched at 08:00 local.
  const days = [day(0, ['WEEKDAY']), day(1, ['WEEKDAY']), day(2, ['WEEKDAY'])];
  const watched = new Set(days.map((d) => `${d.ymd}|${utcCell(d.midnightMs + 8 * 3_600_000).how}`));
  const f = buildForecast({ watched, days, byService, ghosts: [], cellOf: utcCell });
  // Monday 08:00 = how 8, Tuesday = 32, Wednesday = 56 — three distinct cells, 5 each.
  assert.equal(f.get('501|8')?.scheduled, 5);
  assert.equal(f.get('501|32')?.scheduled, 5);
  assert.equal(f.get('501|56')?.scheduled, 5);
});

test('buildForecast ignores service ids that are not active on a day', () => {
  const byService = new Map<string, TripStartBucket[]>([
    ['WEEKDAY', [{ routeId: '501', startS: 8 * 3600, n: 5 }]],
    ['SUNDAY', [{ routeId: '501', startS: 8 * 3600, n: 99 }]],
  ]);
  const watched = new Set([`${utcCell(MON).ymd}|8`]);
  const f = buildForecast({
    watched, days: [day(0, ['WEEKDAY'])], byService, ghosts: [], cellOf: utcCell,
  });
  assert.equal(f.get('501|8')?.scheduled, 5, 'a service that does not run today adds nothing');
});

test('buildForecast places a past-midnight GTFS time on the day it actually runs', () => {
  // 25:30:00 on Monday is Tuesday 01:30 in the real world, so it belongs to Tuesday's cell.
  const byService = new Map<string, TripStartBucket[]>([
    ['OWL', [{ routeId: '300', startS: 25 * 3600 + 1800, n: 3 }]],
  ]);
  const tueOne = `${utcCell(MON + DAY_MS).ymd}|${24 + 1}`;
  const f = buildForecast({
    watched: new Set([tueOne]), days: [day(0, ['OWL'])], byService, ghosts: [], cellOf: utcCell,
  });
  assert.equal(f.get('300|25')?.scheduled, 3, 'a 25:30 trip counts in Tuesday 01:00');
  assert.equal(f.get('300|1'), undefined);
});

test('buildForecast counts ghosts only in the same watched cells as the denominator', () => {
  const byService = new Map<string, TripStartBucket[]>([
    ['WEEKDAY', [{ routeId: '501', startS: 8 * 3600, n: 10 }]],
  ]);
  const watched = new Set([`${utcCell(MON).ymd}|8`]);
  const f = buildForecast({
    watched,
    days: [day(0, ['WEEKDAY'])],
    byService,
    ghosts: [
      { routeId: '501', scheduledStartMs: MON + 8 * 3_600_000 },       // watched -> counts
      { routeId: '501', scheduledStartMs: MON + 8 * 3_600_000 + 60_000 }, // same hour -> counts
      { routeId: '501', scheduledStartMs: MON + 12 * 3_600_000 },      // unwatched -> dropped
    ],
    cellOf: utcCell,
  });
  assert.deepEqual(f.get('501|8'), { ghosts: 2, scheduled: 10 });
  assert.equal(f.get('501|12'), undefined, 'a ghost in an unwatched hour must not inflate any rate');
});

test('forecast cell + threshold together produce the rate the UI is allowed to show', () => {
  const byService = new Map<string, TripStartBucket[]>([
    ['WEEKDAY', [{ routeId: '501', startS: 8 * 3600, n: 20 }]],
  ]);
  const watched = new Set([`${utcCell(MON).ymd}|8`]);
  const f = buildForecast({
    watched,
    days: [day(0, ['WEEKDAY'])],
    byService,
    ghosts: Array.from({ length: 5 }, (_, i) => ({ routeId: '501', scheduledStartMs: MON + 8 * 3_600_000 + i * 1000 })),
    cellOf: utcCell,
  });
  const cell = f.get('501|8');
  assert.deepEqual(cell, { ghosts: 5, scheduled: 20 });
  const risk = ghostRiskFor(cell!.ghosts, cell!.scheduled, 14);
  assert.equal(risk?.level, 'high'); // 25% > 20%
  assert.equal(risk?.rate, 0.25);
});

test('an empty forecast produces no risk at all — no data, no chip', () => {
  const f = buildForecast({
    watched: new Set(), days: [day(0, ['WEEKDAY'])],
    byService: new Map([['WEEKDAY', [{ routeId: '501', startS: 8 * 3600, n: 40 }]]]),
    ghosts: [{ routeId: '501', scheduledStartMs: MON + 8 * 3_600_000 }],
    cellOf: utcCell,
  });
  assert.equal(f.size, 0);
});

test('agencyLocalStamp renders the agency wall clock, not UTC', () => {
  // 2026-07-24T23:26:00Z is 19:26 in Toronto (EDT, UTC-4).
  assert.equal(agencyLocalStamp(Date.parse('2026-07-24T23:26:00Z')), '2026-07-24 19:26');
  // 2026-01-05T05:30:00Z is 00:30 the previous day in Toronto (EST, UTC-5).
  assert.equal(agencyLocalStamp(Date.parse('2026-01-05T05:30:00Z')), '2026-01-05 00:30');
  assert.equal(agencyLocalStamp(Date.parse('2026-01-05T04:30:00Z')), '2026-01-04 23:30');
});

// =====================================================================================
// endpoint shaping against fixtures
// =====================================================================================

interface Recorded { sql: string; params: unknown[] }

/**
 * A Db that answers by SQL substring and records every call it received.
 *
 * `whenParams` additionally gates a fixture on the bound PARAMETERS, which is what lets a
 * test model a real seeded database: rows exist under one agency namespace and genuinely do
 * not exist under another. Without it every query gets its fixture regardless of scoping,
 * and a namespace bug is invisible to the suite — which is exactly how the demo-mode static
 * table bug reached a tester.
 */
function fakeDb(
  fixtures: ReadonlyArray<{ when: string; rows: unknown[]; whenParams?: (params: unknown[]) => boolean }>,
): Db & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const query = async <T>(sql: string, params?: Params): Promise<Result<T>> => {
    const bound = params ? [...params] : [];
    calls.push({ sql, params: bound });
    const hit = fixtures.find((f) => sql.includes(f.when) && (f.whenParams ? f.whenParams(bound) : true));
    const rows = (hit?.rows ?? []) as T[];
    return { rows, rowCount: rows.length };
  };
  return {
    driver: 'pg',
    query,
    async transaction(fn) { return fn({ query }); },
    async close() { /* nothing to close */ },
    calls,
  } as Db & { calls: Recorded[] };
}

/**
 * A poller test double that satisfies `PollerHandle` STRUCTURALLY.
 *
 * It used to end in `as unknown as PollerHandle`, which is a cast that asserts nothing:
 * it let the double drift from the interface silently, and it is how `now()` and
 * `getMode()` came to be missing here while api.ts was being changed to depend on them.
 * The annotation is a plain `satisfies`-style type now, so the compiler is the thing that
 * proves the double is complete — add a method to `PollerHandle` and this file fails to
 * typecheck until the double grows it too.
 */
const fakePoller: PollerHandle = {
  start() { /* not started in tests */ },
  async stop() { /* nothing running */ },
  async runOnce() { /* nothing running */ },
  getVehicleStates: () => [],
  getFeedHealth: () => ({
    feeds: {
      vehicles: { status: 'ok', lastOkMs: 1_700_000_000_000, sinceMs: null },
      trips: { status: 'ok', lastOkMs: 1_700_000_000_000, sinceMs: null },
      alerts: { status: 'ok', lastOkMs: 1_700_000_000_000, sinceMs: null },
    },
    lastPollAtMs: 1_700_000_000_000,
    mode: 'live',
  }),
  getLivePredictionMs: () => null,
  /**
   * `JoinStats` is a ~20-field diagnostic blob with a nested `DelayEngineStats` inside it,
   * and api.ts reads exactly one field off it: `boardCoverage`. The cast is scoped to this
   * one return value rather than to the whole double on purpose — the double itself stays
   * strictly typed, so the compiler still proves every METHOD of `PollerHandle` exists
   * here, which is the property that was missing when `now()`/`getMode()` went absent.
   */
  getJoinStats: () => ({ boardCoverage: '20260726..20260905' } as ReturnType<PollerHandle['getJoinStats']>),
  isIndexReady: () => true,
  /** The DATA clock. Live it is the wall clock, and these tests are a live instance. */
  now: () => Date.now(),
  /** A LIVE instance under the default agency — the mode every test below assumes. */
  getMode: () => ({
    mode: 'live',
    agency: 'ttc',
    dataNowMs: Date.now(),
    wallNowMs: Date.now(),
    demo: null,
  }),
};

const ROUTE_ROWS = [
  { route_id: '501', short_name: '501', long_name: 'Queen', route_type: 0, color: 'DA291C' },
  { route_id: '39', short_name: '39', long_name: 'Finch East', route_type: 3, color: null },
];

test('/api/alerts shapes real rows, resolves route names, and normalises blank ids', async () => {
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    {
      when: 'FROM service_alerts',
      rows: [{
        alert_id: 'DevAPI-1', effect: 'UNKNOWN_EFFECT', cause: 'UNKNOWN_CAUSE',
        header: '501 Queen: No service between',
        description: '501 Queen: No service between Dufferin and Bathurst due to a collision.',
        active_start: null, active_end: null,
        // The TTC feed ships empty-string stop ids; they must land as null, not "".
        informed: [{ routeId: '501', stopId: '', tripId: null }, { routeId: '999', stopId: '4197', tripId: null }],
        is_accessibility: false,
      }],
    },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/alerts' });
    assert.equal(res.statusCode, 200);
    const body = res.json<AlertsResponse>();
    assert.equal(body.count, 1);
    const a = body.alerts[0];
    assert.equal(a.alertId, 'DevAPI-1');
    assert.equal(a.effect, 'UNKNOWN_EFFECT');
    assert.equal(a.isAccessibility, false);
    assert.deepEqual(a.informed[0], { routeId: '501', routeShortName: '501', stopId: null, tripId: null });
    // An informed route we have no static row for resolves to null, never a guessed name.
    assert.deepEqual(a.informed[1], { routeId: '999', routeShortName: null, stopId: '4197', tripId: null });
    // No activePeriod anywhere -> the response says so instead of implying recency order.
    assert.equal(body.meta.publishesActivePeriod, false);
    assert.equal(body.meta.ordering, 'stable-id');
    assert.equal(body.feedUpdatedMs, 1_700_000_000_000);
  } finally {
    await app.close();
  }
});

test('/api/alerts reports an activePeriod-carrying feed as recency-ordered', async () => {
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    {
      when: 'FROM service_alerts',
      rows: [{
        alert_id: 'A', effect: 'NO_SERVICE', cause: 'MAINTENANCE', header: 'h', description: 'd',
        active_start: '2026-07-24T18:00:00.000Z', active_end: null,
        informed: [], is_accessibility: true,
      }],
    },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/alerts' })).json<AlertsResponse>();
    assert.equal(body.meta.ordering, 'active-start');
    assert.equal(body.meta.publishesActivePeriod, true);
    assert.equal(body.alerts[0].activeStartMs, Date.parse('2026-07-24T18:00:00.000Z'));
    assert.equal(body.alerts[0].isAccessibility, true);
  } finally {
    await app.close();
  }
});

test('/api/alerts issues parameterised SQL and caps limit at 100', async () => {
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    await app.inject({ method: 'GET', url: '/api/alerts?limit=5000' });
    const call = db.calls.find((c) => c.sql.includes('FROM service_alerts'));
    assert.ok(call, 'the alerts query ran');
    assert.equal(call.params[0], 'ttc');
    assert.equal(call.params[2], 100, 'limit is clamped to the documented maximum');
    assert.ok(call.sql.includes('$1') && call.sql.includes('$3'), 'values are bound, never interpolated');
    assert.ok(!call.sql.includes('5000'), 'the raw query value never reaches the SQL text');

    await app.inject({ method: 'GET', url: '/api/alerts?limit=7' });
    const seven = db.calls.filter((c) => c.sql.includes('FROM service_alerts')).at(-1);
    assert.equal(seven?.params[2], 7);
  } finally {
    await app.close();
  }
});

test('/api/alerts rejects a nonsense limit rather than silently defaulting', async () => {
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    for (const bad of ['0', '-3', 'abc']) {
      const res = await app.inject({ method: 'GET', url: `/api/alerts?limit=${bad}` });
      assert.equal(res.statusCode, 400, `limit=${bad}`);
      assert.equal(res.json<{ error: string }>().error, 'limit must be a positive number');
    }
  } finally {
    await app.close();
  }
});

const GHOST_ROWS = [
  {
    trip_id: 't-ghost', kind: 'ghost', route_id: '501',
    scheduled_start: '2026-07-24T23:26:00.000Z', detected_at: '2026-07-24T23:31:00.000Z',
    headsign: 'Distillery Loop',
  },
  {
    trip_id: 't-cancelled', kind: 'cancelled', route_id: '39',
    scheduled_start: '2026-07-24T23:40:00.000Z', detected_at: '2026-07-24T23:41:00.000Z',
    headsign: 'Finch Station',
  },
];

test('/api/ghosts/feed shapes events, keeps kinds distinct, and stamps agency-local time', async () => {
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    { when: 'FROM ghosts g LEFT JOIN trips', rows: GHOST_ROWS },
    { when: 'COUNT(*) FILTER', rows: [{ kind: 'ghost', today: 3, week: 11 }, { kind: 'cancelled', today: 1, week: 2 }] },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/ghosts/feed' });
    assert.equal(res.statusCode, 200);
    const body = res.json<GhostFeedResponse>();
    assert.equal(body.hours, 24);
    assert.equal(body.count, 2);

    const ghost = body.events[0];
    assert.equal(ghost.kind, 'ghost');
    assert.equal(ghost.shortName, '501');
    assert.equal(ghost.headsign, 'Distillery Loop');
    assert.equal(ghost.color, 'DA291C');
    assert.equal(ghost.scheduledStartLocal, '2026-07-24 19:26', 'rendered in America/Toronto');
    assert.equal(ghost.scheduledStartMs, Date.parse('2026-07-24T23:26:00.000Z'));

    const cancelled = body.events[1];
    assert.equal(cancelled.kind, 'cancelled');
    // routes.color is blank for a bus, so the documented route_type fallback applies.
    assert.equal(cancelled.color, '3C4A5B');

    assert.deepEqual(body.counters, { todayGhosts: 3, todayCancelled: 1, weekGhosts: 11, weekCancelled: 2 });
    assert.equal(body.meta.retractedAreDeleted, true);
    assert.equal(body.meta.timezone, 'America/Toronto');
  } finally {
    await app.close();
  }
});

test('/api/ghosts/feed counters default to zero when a kind has no rows', async () => {
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    { when: 'FROM ghosts g LEFT JOIN trips', rows: [] },
    { when: 'COUNT(*) FILTER', rows: [] },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/ghosts/feed' })).json<GhostFeedResponse>();
    assert.deepEqual(body.counters, { todayGhosts: 0, todayCancelled: 0, weekGhosts: 0, weekCancelled: 0 });
    assert.deepEqual(body.events, []);
  } finally {
    await app.close();
  }
});

test('/api/ghosts/feed clamps hours, binds them, and rejects nonsense', async () => {
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const wide = await app.inject({ method: 'GET', url: '/api/ghosts/feed?hours=99999' });
    assert.equal(wide.json<GhostFeedResponse>().hours, 168, 'clamped to one week');

    const call = db.calls.find((c) => c.sql.includes('FROM ghosts g LEFT JOIN trips'));
    assert.ok(call);
    // $1 observation agency, $2 STATIC agency (the join crosses the seam), $3 since, $4 cap.
    assert.equal(call.params[0], 'ttc');
    assert.equal(call.params[1], 'ttc');
    assert.equal(call.params[3], 200, 'the row cap is bound, not interpolated');
    assert.ok(call.sql.includes('$3') && call.sql.includes('$4'));

    const res = await app.inject({ method: 'GET', url: '/api/ghosts/feed?hours=-1' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json<{ error: string }>().error, 'hours must be a positive number');
  } finally {
    await app.close();
  }
});

test('unknown /api/ routes still answer JSON, not the SPA shell', async () => {
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const res = await app.inject({ method: 'GET', url: '/api/ghosts/nope' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'not found' });
  } finally {
    await app.close();
  }
});

// =====================================================================================
// honest attribution + the agency seam (DECISIONS §45)
// =====================================================================================
//
// These four tests exist because of one rider's bug report — "when I allow it to use my
// location it kept saying can't reach the live TTC feed right now" — and the reading of
// api.ts that followed it. Each asserts a fact the client's error copy depends on.

test('/api/health states its MODE and carries demo provenance only when demo', async () => {
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>();
    // Without `mode` on the wire a recording and a live feed are indistinguishable, and
    // the DEMO badge has nothing honest to key off.
    assert.equal(body.mode, 'live');
    assert.equal(body.demo, null, 'a live instance must never carry demo provenance');
  } finally {
    await app.close();
  }
});

test('/api/health on a DEMO poller reports demo, and its provenance survives the wire', async () => {
  const provenance = {
    fixturePath: 'fixtures/ttc-demo-20260726-1040.json.gz',
    recordedNotice: 'RECORDING of live TTC data captured 2026-07-26 10:40 through 2026-07-26 10:50.',
    attribution: 'Real-time data from the Toronto Transit Commission.',
    captureStartMs: 1_785_000_000_000, captureEndMs: 1_785_000_585_000,
    captureStartToronto: '2026-07-26 10:40:43 America/Toronto',
    captureEndToronto: '2026-07-26 10:50:28 America/Toronto',
    cadenceMs: 45_000, speed: 1, loop: true, positionMs: 120_000, loops: 0,
  };
  // A demo poller writes under its OWN namespace and reads a DATA clock in the past.
  const demoPoller: PollerHandle = {
    ...fakePoller,
    now: () => provenance.captureStartMs,
    getMode: () => ({
      mode: 'demo', agency: 'ttc-demo',
      dataNowMs: provenance.captureStartMs, wallNowMs: Date.now(), demo: provenance,
    }),
  };
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: demoPoller });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json<HealthResponse>();
    assert.equal(body.mode, 'demo');
    assert.equal(body.demo?.recordedNotice, provenance.recordedNotice);
    // The DATA clock, not the wall clock: replayed departures have to be counted down
    // against the moment their bytes were captured.
    assert.equal(body.serverNowMs, provenance.captureStartMs);
  } finally {
    await app.close();
  }
});

/**
 * THE AGENCY SEAM HAS TWO SIDES, and this suite has now been wrong about it in both
 * directions — so it is pinned per TABLE rather than per response.
 *
 * The test that used to live here asserted that EVERY agency-scoped query binds the
 * poller's agency. It only ever exercised `/api/alerts` (an observation table), and it
 * actively enshrined the bug testers later found: under it, a demo instance read the static
 * schedule under `'ttc-demo'`, where `seed_toronto.ts` never writes anything, so every
 * stop/route/trip query returned zero rows. A demo instance told a rider standing at King &
 * Spadina there were no stops near them, and search and the planner were both dead.
 *
 * The contract (DECISIONS §44, demo.ts rule 5, poller.ts's own STATIC_AGENCY):
 *
 *   STATIC tables      stops, routes, trips, stop_times, shapes, calendar, calendar_dates
 *                      -> always 'ttc'. One published board; a recording is a recording OF it.
 *   OBSERVATION tables trip_delay_obs, ghosts, agg_delay, agg_delay_route, service_alerts
 *                      -> the poller's agency, so replayed rows can never pass as live.
 */
const STATIC_TABLES = ['FROM stops', 'FROM routes', 'FROM trips', 'FROM stop_times', 'FROM shapes', 'FROM calendar', 'FROM calendar_dates'];
const OBSERVATION_TABLES = ['FROM trip_delay_obs', 'FROM ghosts', 'FROM agg_delay', 'FROM agg_delay_route', 'FROM service_alerts'];

/** Which side of the seam a SQL string belongs to, by the first table it names. */
function seamSideOf(sql: string): 'static' | 'observation' | null {
  const hits: Array<{ at: number; side: 'static' | 'observation' }> = [];
  for (const t of STATIC_TABLES) { const at = sql.indexOf(t); if (at >= 0) hits.push({ at, side: 'static' }); }
  for (const t of OBSERVATION_TABLES) { const at = sql.indexOf(t); if (at >= 0) hits.push({ at, side: 'observation' }); }
  if (hits.length === 0) return null;
  // `FROM agg_delay_route` also matches `FROM agg_delay`; both are observation, so the
  // earliest match is the driving table either way.
  hits.sort((a, b) => a.at - b.at);
  return hits[0].side;
}

const demoPoller: PollerHandle = {
  ...fakePoller,
  getMode: () => ({ mode: 'demo', agency: 'ttc-demo', dataNowMs: Date.now(), wallNowMs: Date.now(), demo: null }),
};

test('DEMO MODE reads the static schedule under "ttc" and observations under "ttc-demo"', async () => {
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    { when: 'lat BETWEEN', rows: [{ stop_id: '15647', name: 'King St West at Spadina Ave', lat: 43.6453, lon: -79.3956, wheelchair_boarding: 1 }] },
    { when: 'FROM stops WHERE agency=$1 AND stop_id=$2', rows: [{ stop_id: '15647', name: 'King St West at Spadina Ave', lat: 43.6453, lon: -79.3956, wheelchair_boarding: 1 }] },
  ]);
  const app = await buildApi({ db, poller: demoPoller });
  try {
    // Every surface a rider touches, including the ones that were silently empty.
    for (const url of [
      '/api/stops?q=King',
      '/api/stops/nearby?lat=43.64354&lon=-79.39699&radius=800',
      '/api/stops/15647/arrivals',
      '/api/routes/501/shape',
      '/api/alerts',
      '/api/ghosts/feed',
      '/api/stats',
      '/api/plan?fromLat=43.64&fromLon=-79.39&toLat=43.65&toLon=-79.40',
    ]) {
      await app.inject({ method: 'GET', url });
    }

    const scoped = db.calls.filter((c) => c.params[0] === 'ttc' || c.params[0] === 'ttc-demo');
    assert.ok(scoped.length >= 10, `expected many agency-bound queries, saw ${scoped.length}`);

    let statics = 0, observations = 0;
    for (const call of scoped) {
      const side = seamSideOf(call.sql);
      if (side == null) continue;
      const oneLine = call.sql.replace(/\s+/g, ' ').slice(0, 64);
      if (side === 'static') {
        statics++;
        assert.equal(call.params[0], 'ttc',
          `STATIC query bound '${call.params[0]}' — nothing is ever seeded there: "${oneLine}…"`);
      } else {
        observations++;
        assert.equal(call.params[0], 'ttc-demo',
          `OBSERVATION query bound '${call.params[0]}' — replayed rows would pass as live: "${oneLine}…"`);
      }
    }
    // Both sides must actually have been exercised, or the assertions above proved nothing.
    assert.ok(statics >= 6, `expected the static side to be exercised, saw ${statics}`);
    assert.ok(observations >= 3, `expected the observation side to be exercised, saw ${observations}`);
  } finally {
    await app.close();
  }
});

test('a DEMO instance still finds the stops around a rider — the bug that made it useless', async () => {
  // The regression in the form a rider met it: /api/stops/nearby at King & Spadina returned
  // zero rows in demo mode, so the app said "No TTC stops within 800 m of you" in the middle
  // of downtown Toronto. The fixture is seeded under 'ttc' only, exactly like the real DB.
  const SEEDED = [{ stop_id: '15647', name: 'King St West at Spadina Ave', lat: 43.64537, lon: -79.395811, wheelchair_boarding: 1 }];
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    // Answers ONLY when the query is scoped to 'ttc' — mirroring a real seeded database.
    { when: 'lat BETWEEN', rows: SEEDED, whenParams: (p) => p[0] === 'ttc' },
  ]);
  const app = await buildApi({ db, poller: demoPoller });
  try {
    const body = (await app.inject({
      method: 'GET', url: '/api/stops/nearby?lat=43.64354&lon=-79.39699&radius=800',
    })).json<StopsResponse>();
    assert.equal(body.count, 1, 'demo mode must see the same board a live instance sees');
    assert.equal(body.stops[0].stopId, '15647');
    assert.equal(body.nearest, undefined, 'stops were in range, so no out-of-coverage fallback');
  } finally {
    await app.close();
  }
});

test('the ghost feed keeps its headsigns in demo mode — the one join that crosses the seam', async () => {
  // `ghosts` is an observation, `trips` is the published schedule. Joining them on a single
  // agency bound the static side to 'ttc-demo', where nothing is seeded, so every ghost lost
  // its headsign and read as a bare trip id. The two sides are separate parameters now.
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    {
      when: 'FROM ghosts g LEFT JOIN trips',
      rows: [{
        trip_id: 'T1', kind: 'ghost', route_id: '501',
        scheduled_start: '2026-07-26T14:00:00.000Z', detected_at: '2026-07-26T14:05:00.000Z',
        headsign: '501 West to Long Branch',
      }],
      // Only answers when the STATIC side of the join is scoped to 'ttc'.
      whenParams: (p) => p[1] === 'ttc',
    },
    { when: 'COUNT(*) FILTER', rows: [] },
  ]);
  const app = await buildApi({ db, poller: demoPoller });
  try {
    const body = (await app.inject({ method: 'GET', url: '/api/ghosts/feed' })).json<GhostFeedResponse>();
    assert.equal(body.count, 1);
    assert.equal(body.events[0].headsign, '501 West to Long Branch',
      'a demo ghost must still name its trip, not fall back to a bare id');
    const call = db.calls.find((c) => c.sql.includes('FROM ghosts g LEFT JOIN trips'))!;
    assert.equal(call.params[0], 'ttc-demo', 'the observation side follows the poller');
    assert.equal(call.params[1], 'ttc', 'the schedule side is always the published board');
  } finally {
    await app.close();
  }
});

test('LIVE mode binds one agency on both sides of the seam', async () => {
  // The mirror: with a live poller the two constants collapse to the same value, so nothing
  // above can be satisfied by accidentally hardcoding 'ttc' everywhere again.
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    await app.inject({ method: 'GET', url: '/api/alerts' });
    await app.inject({ method: 'GET', url: '/api/stops?q=King' });
    const scoped = db.calls.filter((c) => seamSideOf(c.sql) != null && typeof c.params[0] === 'string');
    assert.ok(scoped.length > 0);
    for (const call of scoped) assert.equal(call.params[0], 'ttc');
  } finally {
    await app.close();
  }
});

test('a 429 body names ITSELF as the culprit, never the agency feed', async () => {
  // The client keys its error copy off `kind`. If a 429 arrived as bare prose the UI had
  // to guess, and it guessed "can't reach the live TTC feed" — blaming the TTC for our own
  // rate limiter. `kind: 'rateLimited'` is what makes the honest copy possible.
  const db = fakeDb([{ when: 'FROM routes', rows: ROUTE_ROWS }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    // The limiter's own responder is exercised by overrunning the tightest budget: /api/plan.
    let throttled: { kind?: string; error?: string; retryAfterSec?: number } | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/plan?fromLat=43.64&fromLon=-79.39&toLat=43.65&toLon=-79.40' });
      if (res.statusCode === 429) { throttled = res.json(); break; }
    }
    assert.ok(throttled, 'expected the per-route budget to refuse eventually');
    assert.equal(throttled.kind, 'rateLimited');
    assert.ok(typeof throttled.retryAfterSec === 'number' && throttled.retryAfterSec >= 1);
    // The exact regression: our own throttling must not mention the agency or its feed.
    assert.doesNotMatch(String(throttled.error), /ttc|feed/i);
  } finally {
    await app.close();
  }
});

test('/api/stops/nearby answers an out-of-coverage fix with the nearest stop AND its distance', async () => {
  // The reported bug: a rider in Mississauga (MiWay territory) granted location, /nearby
  // came back empty, and the client silently kept showing a downtown Toronto stop as if it
  // were theirs. An empty list now carries the measurement that makes an honest message
  // possible — and the client is what decides whether 25 km is worth offering.
  const UNION = { stop_id: '14000', name: 'Union Station', lat: 43.6453, lon: -79.3806, wheelchair_boarding: 1 };
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    // The radius query returns nothing; the unbounded nearest-one query returns Union.
    { when: 'ORDER BY ((lat - $2)', rows: [UNION] },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({
      method: 'GET', url: '/api/stops/nearby?lat=43.5890&lon=-79.6441&radius=800',
    })).json<StopsResponse>();
    assert.equal(body.count, 0, 'nothing is in range, and that is the honest answer');
    assert.equal(body.searchedRadiusM, 800, 'the radius actually applied is stated');
    assert.equal(body.nearest?.stopId, '14000');
    // A real measurement, not a placeholder: Mississauga to Union is ~21-23 km.
    assert.ok(body.nearest!.distanceM! > 20_000 && body.nearest!.distanceM! < 25_000,
      `expected ~22 km, got ${body.nearest!.distanceM}`);
  } finally {
    await app.close();
  }
});

test('/api/stops/nearby does NOT pay for the nearest-stop query when something is in range', async () => {
  // The extra query is on the empty path only — the case where we did no work anyway.
  const INRANGE = { stop_id: '15647', name: 'King St West at Spadina Ave', lat: 43.6453, lon: -79.3956, wheelchair_boarding: 1 };
  const db = fakeDb([
    { when: 'FROM routes', rows: ROUTE_ROWS },
    { when: 'lat BETWEEN', rows: [INRANGE] },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({
      method: 'GET', url: '/api/stops/nearby?lat=43.64354&lon=-79.39699&radius=800',
    })).json<StopsResponse>();
    assert.equal(body.count, 1);
    assert.equal(body.nearest, undefined, 'no nearest field when the radius found stops');
    assert.equal(db.calls.filter((c) => c.sql.includes('ORDER BY ((lat - $2)')).length, 0);
  } finally {
    await app.close();
  }
});

// =====================================================================================
// static / SPA fallback (DECISIONS §28)
// =====================================================================================
//
// The handler used to answer every non-/api/ miss with index.html at HTTP 200. That is
// how a missing maplibre worker chunk masqueraded as a healthy response for several
// phases, and it is what would let the service worker cache an HTML document under an
// immutable hashed .js URL. These assertions are cheap; the bug they guard was not.
//
// Whether the SPA shell can be served at all depends on a built bundle being present,
// so the navigation cases are asserted against that fact rather than assuming a build.
const HAS_BUNDLE = existsSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'index.html'));

test('a missing asset 404s instead of being answered with the SPA shell', async () => {
  const app = await buildApi({ db: fakeDb([]), poller: fakePoller });
  try {
    for (const url of [
      '/assets/nonexistent-abc123.js',
      '/assets/maplibre-gl-worker.mjs',   // the exact URL maplibre used to guess
      '/assets/index-DEADBEEF.css',
      '/missing.mjs',
      '/missing.webmanifest',
      '/nope.png',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, `${url} must 404`);
      assert.ok(!/text\/html/.test(res.headers['content-type'] as string), `${url} must not return HTML`);
    }
  } finally {
    await app.close();
  }
});

test('an asset 404 survives a browser-style Accept: text/html', async () => {
  // A human pasting a dead bundle URL into the address bar must still see the failure,
  // so asset-ness is judged before Accept.
  const app = await buildApi({ db: fakeDb([]), poller: fakePoller });
  try {
    const res = await app.inject({
      method: 'GET', url: '/assets/nonexistent-abc123.js',
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
  }
});

test('bare /api answers JSON, not the SPA shell', async () => {
  // It carries no file extension, so it would otherwise read as a navigation.
  const app = await buildApi({ db: fakeDb([]), poller: fakePoller });
  try {
    const res = await app.inject({ method: 'GET', url: '/api' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { error: 'not found' });
  } finally {
    await app.close();
  }
});

test('a client-side route is still served the SPA shell', async () => {
  const app = await buildApi({ db: fakeDb([]), poller: fakePoller });
  try {
    const res = await app.inject({ method: 'GET', url: '/nearby', headers: { accept: 'text/html' } });
    if (HAS_BUNDLE) {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /text\/html/);
    } else {
      // No bundle on disk: there is no shell to serve, and inventing one would be a lie.
      assert.equal(res.statusCode, 404);
    }
  } finally {
    await app.close();
  }
});

// =====================================================================================
// single-ride plan — ranking (pure) and /api/plan shaping
// =====================================================================================

const ride = (o: Partial<RankableRide> & { tripId: string; departureS: number }): RankableRide => ({
  boardDistanceM: 100, alightDistanceM: 100, alightStopSequence: 10, ...o,
});

test('rankRideCandidates puts the soonest departure first', () => {
  const out = rankRideCandidates([
    ride({ tripId: 'late', departureS: 900 }),
    ride({ tripId: 'soon', departureS: 100 }),
    ride({ tripId: 'mid', departureS: 500 }),
  ]);
  assert.deepEqual(out.map((r) => r.tripId), ['soon', 'mid', 'late']);
});

test('rankRideCandidates breaks a departure tie on total walking distance', () => {
  const out = rankRideCandidates([
    ride({ tripId: 'far', departureS: 100, boardDistanceM: 400, alightDistanceM: 400 }),
    ride({ tripId: 'near', departureS: 100, boardDistanceM: 50, alightDistanceM: 60 }),
  ]);
  assert.deepEqual(out.map((r) => r.tripId), ['near', 'far']);
});

test('rankRideCandidates prefers the short way round a loop, not the long one', () => {
  // A loop route calls at the same stop twice on ONE trip, so both rows agree on the
  // departure AND on both distances. Without the sequence tie-break the planner could
  // hand a rider the ride that goes all the way around.
  const short = ride({ tripId: 'loop', departureS: 100, alightStopSequence: 8 });
  const long = ride({ tripId: 'loop', departureS: 100, alightStopSequence: 44 });
  assert.deepEqual(rankRideCandidates([long, short]).map((r) => r.alightStopSequence), [8, 44]);
});

test('rankRideCandidates caps the pairs kept per trip', () => {
  const rows = [0, 1, 2, 3, 4, 5].map((i) => ride({ tripId: 'T', departureS: 100 + i, alightStopSequence: i }));
  assert.equal(rankRideCandidates(rows, 2, 10).length, 2);
});

test('rankRideCandidates caps how many distinct trips get in, keeping the soonest', () => {
  const rows = [5, 1, 3, 9, 7].map((s) => ride({ tripId: `T${s}`, departureS: s }));
  const out = rankRideCandidates(rows, 3, 2);
  assert.deepEqual(out.map((r) => r.tripId), ['T1', 'T3']);
});

test('rankRideCandidates is a pure filter — it never invents or mutates a row', () => {
  const rows = [ride({ tripId: 'a', departureS: 2 }), ride({ tripId: 'b', departureS: 1 })];
  const snapshot = JSON.parse(JSON.stringify(rows));
  const out = rankRideCandidates(rows);
  assert.deepEqual(rows, snapshot);                 // input untouched
  assert.equal(out.length, 2);
  for (const r of out) assert.ok(rows.includes(r)); // every output row is an input row
});

// ---- /api/plan ----------------------------------------------------------------------

// 2026-07-27 09:00 America/Toronto (EDT, UTC-4) — a Monday, so `mon` decides service.
const PLAN_AT_MS = Date.parse('2026-07-27T13:00:00Z');
const KING_SPADINA = { lat: 43.64354, lon: -79.39699 };
const DUNDAS_WEST = { lat: 43.656862, lon: -79.453415 };

const CALENDAR_ROWS = [{
  service_id: 'S1', mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true,
  start_date: 20260101, end_date: 20261231,
}];

/** Stops for BOTH endpoints. The fake Db answers by SQL substring, so the board and the
 *  alight query see the same list — and the endpoint's own haversine filter is what
 *  splits them, which is exactly the code under test. */
const PLAN_STOP_ROWS = [
  { stop_id: 'B1', name: 'King St West at Spadina Ave', lat: 43.64537, lon: -79.395811, wheelchair_boarding: 1 },
  { stop_id: 'B2', name: 'King St West at Portland St', lat: 43.644458, lon: -79.399504, wheelchair_boarding: 1 },
  { stop_id: 'A1', name: 'Dundas West Station', lat: 43.656862, lon: -79.453415, wheelchair_boarding: 1 },
];

const planUrl = (o: Record<string, string | number> = {}) => {
  const p = new URLSearchParams({
    fromLat: String(KING_SPADINA.lat), fromLon: String(KING_SPADINA.lon),
    toLat: String(DUNDAS_WEST.lat), toLon: String(DUNDAS_WEST.lon),
    at: String(PLAN_AT_MS),
    ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])),
  });
  return `/api/plan?${p}`;
};

function planDb(extra: ReadonlyArray<{ when: string; rows: unknown[] }> = []) {
  return fakeDb([
    ...extra,
    { when: 'FROM routes', rows: ROUTE_ROWS },
    { when: 'FROM calendar WHERE', rows: CALENDAR_ROWS },
    { when: 'FROM stops', rows: PLAN_STOP_ROWS },
  ]);
}

/** The windowed plan join — the only statement carrying a bound service-id array. */
const PLAN_JOIN = 't.service_id = ANY($4';

test('/api/plan returns a real single-ride plan built from one trip', async () => {
  const db = planDb([{
    when: PLAN_JOIN,
    rows: [{
      trip_id: 'TRIP-1', route_id: '501', headsign: 'West - 501 Queen towards Long Branch', direction_id: 1,
      board_stop: 'B1', board_seq: 14, board_s: 33_000,    // 09:10 local
      alight_stop: 'A1', alight_seq: 38, alight_s: 34_500, // 09:35 local
    }],
  }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const res = await app.inject({ method: 'GET', url: planUrl() });
    assert.equal(res.statusCode, 200);
    const body = res.json() as PlanResponse;
    assert.equal(body.outcome, 'ride');
    assert.equal(body.candidates.length, 1);
    const c = body.candidates[0];
    assert.equal(c.tripId, 'TRIP-1');
    assert.equal(c.routeId, '501');
    assert.equal(c.shortName, '501');
    assert.equal(c.board.stopId, 'B1');
    assert.equal(c.alight.stopId, 'A1');
    assert.equal(c.stopsRidden, 24);
    // 25 minutes of real schedule, and it arrives after it departs.
    assert.equal(c.arrivalMs - c.departureMs, 1500 * 1000);
    // The boarding stop's distance is measured from the RIDER, the alighting stop's
    // from the DESTINATION — never the other way round.
    assert.ok(c.board.distanceM < 400, `board ${c.board.distanceM} m from the rider`);
    assert.ok(c.alight.distanceM < 50, `alight ${c.alight.distanceM} m from the destination`);
    // No aggregate rows exist, so there is no evidence and therefore no grade — ever.
    assert.equal(c.evidence.bucket, 'none');
    assert.equal(c.grade, undefined);
    assert.equal(c.honest.estimateMs, null);
  } finally {
    await app.close();
  }
});

test('/api/plan says a journey needs a transfer when NO trip links the two stop sets', async () => {
  // Nothing from the windowed join and nothing from the exists-ever probe: no trip in
  // the published schedule rides from one end to the other. That is a transfer, not a gap.
  const app = await buildApi({ db: planDb(), poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: planUrl() })).json() as PlanResponse;
    assert.equal(body.outcome, 'transfer');
    assert.deepEqual(body.candidates, []);
  } finally {
    await app.close();
  }
});

test('/api/plan distinguishes "nothing running now" from "needs a transfer"', async () => {
  // The windowed join is empty but a direct connection DOES exist somewhere in the
  // schedule. That is a timing fact, and it must not be reported as a transfer.
  const db = planDb([{ when: 'SELECT 1 AS ok', rows: [{ ok: 1 }] }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: planUrl() })).json() as PlanResponse;
    assert.equal(body.outcome, 'noService');
    assert.deepEqual(body.candidates, []);
  } finally {
    await app.close();
  }
});

test('/api/plan reports which END has no stops, and asks the database nothing further', async () => {
  const db = planDb();
  const app = await buildApi({ db, poller: fakePoller });
  try {
    // Ottawa: real coordinates, no TTC stop within any allowed radius.
    const body = (await app.inject({
      method: 'GET', url: planUrl({ toLat: 45.4215, toLon: -75.6972 }),
    })).json() as PlanResponse;
    assert.equal(body.outcome, 'noStopsNearDestination');
    // An empty id array can only ever return nothing, so the join is never issued.
    assert.equal(db.calls.some((c) => c.sql.includes('a.stop_sequence > b.stop_sequence')), false);
  } finally {
    await app.close();
  }
});

test('/api/plan validates every coordinate and clamps radius + window', async () => {
  const app = await buildApi({ db: planDb(), poller: fakePoller });
  try {
    const brokenCases: Array<Record<string, string | number>> = [
      { fromLat: 'nope' }, { fromLat: 91 }, { fromLon: 181 },
      { toLat: -91 }, { toLon: -181 }, { radius: 0 }, { radius: -5 },
      { windowMin: 0 }, { at: 'not-a-time' },
    ];
    for (const broken of brokenCases) {
      const res = await app.inject({ method: 'GET', url: planUrl(broken) });
      assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(broken)}`);
      assert.ok((res.json() as { error: string }).error);
    }
    const body = (await app.inject({
      method: 'GET', url: planUrl({ radius: 99_999, windowMin: 99_999 }),
    })).json() as PlanResponse;
    assert.equal(body.radiusM, 1500);
    assert.equal(body.windowMinutes, 4320);
  } finally {
    await app.close();
  }
});

test('/api/plan issues only parameterised SQL — no rider coordinate is ever interpolated', async () => {
  const db = planDb([{
    when: PLAN_JOIN,
    rows: [{
      trip_id: 'TRIP-1', route_id: '501', headsign: 'West', direction_id: 1,
      board_stop: 'B1', board_seq: 1, board_s: 33_000,
      alight_stop: 'A1', alight_seq: 9, alight_s: 34_500,
    }],
  }]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    await app.inject({ method: 'GET', url: planUrl() });
    const joins = db.calls.filter((c) => c.sql.includes('a.stop_sequence > b.stop_sequence'));
    assert.ok(joins.length > 0, 'the plan join ran');
    for (const call of db.calls) {
      assert.ok(!call.sql.includes('43.6'), 'a rider coordinate reached the SQL text');
      assert.ok(!call.sql.includes('-79.'), 'a rider coordinate reached the SQL text');
    }
    // Stop-id arrays and service ids all travel as bound parameters.
    for (const call of joins) {
      assert.ok(Array.isArray(call.params[1]) && Array.isArray(call.params[2]));
      assert.ok(Array.isArray(call.params[3]));
    }
  } finally {
    await app.close();
  }
});

test('/api/plan drops a feed row whose arrival is not after its departure', async () => {
  const db = planDb([
    {
      when: PLAN_JOIN,
      rows: [{
        trip_id: 'BROKEN', route_id: '501', headsign: 'West', direction_id: 1,
        board_stop: 'B1', board_seq: 14, board_s: 34_500,
        alight_stop: 'A1', alight_seq: 38, alight_s: 33_000, // arrives BEFORE it departs
      }],
    },
    { when: 'SELECT 1 AS ok', rows: [{ ok: 1 }] },
  ]);
  const app = await buildApi({ db, poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: planUrl() })).json() as PlanResponse;
    assert.equal(body.outcome, 'noService');
    assert.deepEqual(body.candidates, []);
  } finally {
    await app.close();
  }
});

test('/api/plan keeps a departure inside the window and drops one outside it', async () => {
  // The per-day second range is a superset at the edges, so the endpoint re-filters
  // against the real [at, at+window]. 09:10 is in; 23:10 the same evening is not.
  const rows = [
    { trip_id: 'IN', route_id: '501', headsign: 'W', direction_id: 1, board_stop: 'B1', board_seq: 1, board_s: 33_000, alight_stop: 'A1', alight_seq: 9, alight_s: 34_500 },
    { trip_id: 'OUT', route_id: '501', headsign: 'W', direction_id: 1, board_stop: 'B1', board_seq: 1, board_s: 83_400, alight_stop: 'A1', alight_seq: 9, alight_s: 84_900 },
  ];
  const app = await buildApi({ db: planDb([{ when: PLAN_JOIN, rows }]), poller: fakePoller });
  try {
    const body = (await app.inject({ method: 'GET', url: planUrl() })).json() as PlanResponse;
    assert.equal(body.outcome, 'ride');
    assert.deepEqual(body.candidates.map((c) => c.tripId), ['IN']);
  } finally {
    await app.close();
  }
});
