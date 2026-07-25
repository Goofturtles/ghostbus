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
  buildForecast, agencyLocalStamp, buildApi,
  type TripStartBucket, type ForecastDay,
} from './api.ts';
import type { Db, Params, Result } from './db.ts';
import type { PollerHandle } from './poller.ts';
import type { AlertsResponse, GhostFeedResponse } from '../../shared/types.ts';

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

/** A Db that answers by SQL substring and records every call it received. */
function fakeDb(fixtures: ReadonlyArray<{ when: string; rows: unknown[] }>): Db & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  const query = async <T>(sql: string, params?: Params): Promise<Result<T>> => {
    calls.push({ sql, params: params ? [...params] : [] });
    const hit = fixtures.find((f) => sql.includes(f.when));
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

const fakePoller = {
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
  }),
  getLivePredictionMs: () => null,
  getJoinStats: () => ({ boardCoverage: '20260726..20260905' }),
  isIndexReady: () => true,
} as unknown as PollerHandle;

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
    assert.equal(call.params[0], 'ttc');
    assert.equal(call.params[2], 200, 'the row cap is bound, not interpolated');
    assert.ok(call.sql.includes('$2') && call.sql.includes('$3'));

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
