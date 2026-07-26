// Tests for Demo Mode WIRED INTO THE POLLER — the integration demo.test.ts deliberately
// does not cover, because until now there was nothing to integrate with.
//
// Three things are asserted here, and they are the three ways Demo Mode can be dishonest:
//
//   1. MODE HONESTY. A demo process must say `mode: 'demo'` and must NOT report its feeds
//      down. The first wiring sketch returned recorded frames instead of calling
//      fetchFeed, so `markOk` never ran, every feed aged into `down`, and /api/health
//      answered ok:false while the app was serving a complete recorded snapshot — an app
//      reporting itself dead while demonstrably alive. That regression is pinned below.
//   2. MODE ISOLATION. Demo rows are written under agency 'ttc-demo'. Live rows are not
//      touched, not updated, and not deleted — including by retention, which used to
//      prune trip_delay_obs with no agency filter at all.
//   3. DETERMINISM. The same fixture driven by the same scripted clock produces the same
//      distilled output twice, in two independent databases. Without that, "replay" is
//      just "a second live run with extra steps".
//
// These run against a real migrated PGlite database in a temp dir — real Postgres, real
// migrations, no static board. Without a board the delay engine is not ready, so the
// ghost/binding path is inert here by construction; patterns.test.ts and engine.test.ts
// own that half. What is exercised is everything the poller itself does with recorded
// bytes: decode, vehicle state, live predictions, alerts, health, namespacing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteDb, type Db } from './db.ts';
import { createDelayEngine } from './engine.ts';
import { createPoller, type PollerHandle, type VehicleState } from './poller.ts';
import { torontoDay, torontoMidnightEpoch } from './tz.ts';
import {
  parseFixture,
  createDemoSource,
  resolveFixturePath,
  __resetDemoModeForTests,
  DEMO_AGENCY,
  DEFAULT_SPEED,
  type DemoFixture,
} from './demo.ts';

const LIVE_AGENCY = 'ttc';

// ---------- shared fixture (loaded once; it is a few MB of real TTC protobuf) ----------

let cached: DemoFixture | null = null;
async function fixture(): Promise<DemoFixture | null> {
  if (cached) return cached;
  let path: string;
  try {
    path = await resolveFixturePath();
  } catch {
    return null; // no fixture committed — every test below skips, loudly
  }
  cached = parseFixture(await readFile(path));
  return cached;
}

/**
 * Run `cycles` poll cycles against a scripted WALL clock, in a fresh database.
 * The clock is scripted rather than real so replay position is a pure function of the
 * cycle number — which is what makes the determinism assertion meaningful.
 */
async function runReplay(
  fx: DemoFixture,
  cycles: number,
  opts: { seedLiveRows?: boolean } = {},
): Promise<{ db: Db; poller: PollerHandle; dir: string; wallAt: (i: number) => number }> {
  const dir = await mkdtemp(join(tmpdir(), 'gb-demo-'));
  const db = await createPgliteDb(join(dir, 'pg'));

  if (opts.seedLiveRows) {
    // A live process got here first. Nothing the demo does may disturb these.
    await db.query(
      `INSERT INTO service_alerts (agency, alert_id, effect, cause, header, description, informed, is_accessibility)
       VALUES ($1,'live-alert-1','DETOUR','CONSTRUCTION','live header','live body','[]'::jsonb,false)`, [LIVE_AGENCY]);
    await db.query(
      `INSERT INTO ghosts (agency, trip_id, route_id, scheduled_start, kind)
       VALUES ($1,'live-trip-1','501','2026-07-01T12:00:00.000Z','ghost')`, [LIVE_AGENCY]);
    // Deliberately older than the 14-day retention window: retention must not reach it.
    await db.query(
      `INSERT INTO trip_delay_obs (agency, route_id, stop_id, trip_id, service_date, ts, delay_s, hour_of_week)
       VALUES ($1,'501','s1','live-trip-1',20260101,'2026-01-01T12:00:00.000Z',42,12)`, [LIVE_AGENCY]);
  }

  // Start replay at wall 0 and step one recorded frame per cycle.
  const startedAtMs = 0;
  let clock = startedAtMs;
  const stepMs = fx.manifest.cadenceMs / DEFAULT_SPEED;
  const wallAt = (i: number): number => startedAtMs + i * stepMs;

  __resetDemoModeForTests();
  const source = createDemoSource(fx, {
    speed: DEFAULT_SPEED,
    loop: true,
    startedAtMs,
    now: () => clock,
    fixturePath: '<test>',
  });
  const poller = createPoller(db, { source });

  for (let i = 0; i < cycles; i++) {
    clock = wallAt(i);
    await poller.runOnce(i + 1);
  }
  return { db, poller, dir, wallAt };
}

async function teardown(h: { db: Db; poller: PollerHandle; dir: string }): Promise<void> {
  await h.poller.stop();
  await h.db.close();
  await rm(h.dir, { recursive: true, force: true });
  __resetDemoModeForTests();
}

/**
 * The distilled output of a replay: everything the poller publishes, reduced to a stable,
 * comparable shape. Sorted, because Map iteration order is an implementation detail and a
 * determinism test that depends on it would be testing the wrong thing.
 */
function distill(poller: PollerHandle, vehicles: VehicleState[]): string {
  const v = vehicles
    .map((s) => [s.id, s.tripId, s.routeId, s.seq, s.lat, s.lon, s.heading, s.speedMs, s.ts].join('|'))
    .sort();
  const h = poller.getFeedHealth();
  const j = poller.getJoinStats();
  return JSON.stringify({
    count: v.length,
    vehicles: v,
    feeds: Object.entries(h.feeds).sort().map(([k, f]) => `${k}:${f.status}`),
    mode: h.mode,
    joinRate: j.lastJoinRate,
    due: j.lastDueTrips,
    ghosts: j.lastGhosts,
    cancelled: j.lastCancelled,
    indexReady: j.indexReady,
  });
}

/**
 * EVERY table a poll cycle can write, counted per agency.
 *
 * The list is exhaustive by intent: an isolation assertion that only checks the tables you
 * remembered passes vacuously on the one you forgot. `pattern_index_cache` is excluded and
 * asserted separately — it is the single deliberate exception, being a pure function of the
 * static board with nothing realtime-derived in it.
 */
const WRITTEN_TABLES = [
  'service_alerts', 'ghosts', 'trip_delay_obs',
  'rt_stop_anchor', 'rt_stop_xwalk_votes', 'rt_stop_xwalk',
  'rt_pattern', 'rt_trip_binding', 'sched_slot_claim',
  'agg_delay', 'agg_delay_route',
];

async function rowCensus(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of WRITTEN_TABLES) {
    const r = await db.query<{ agency: string; n: string }>(
      `SELECT agency, COUNT(*)::text AS n FROM ${table} GROUP BY agency`);
    for (const row of r.rows) out[`${table}/${row.agency}`] = Number(row.n);
  }
  return out;
}

// ---------- 1. mode honesty ----------

test('a demo poller reports mode:demo and does NOT report its feeds down', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture in fixtures/ — run: npm run record:demo'); return; }
  const h = await runReplay(fx, 2);
  try {
    const health = h.poller.getFeedHealth();

    // THE REGRESSION. Recorded frames arrive through the same door the live ones do, so
    // the health bookkeeping runs and the app does not declare itself dead.
    assert.equal(health.mode, 'demo');
    assert.equal(health.feeds.vehicles.status, 'ok', 'vehicles feed reported not-ok while replaying a good frame');
    assert.equal(health.feeds.trips.status, 'ok');
    assert.equal(health.feeds.alerts.status, 'ok');
    assert.ok(health.lastPollAtMs != null, 'lastPollAtMs never set — /api/health would answer ok:false');
    // `ok` in /api/health is `some feed is ok`. Prove that expression is true here.
    assert.equal(Object.values(health.feeds).some((f) => f.status === 'ok'), true);

    // ...and it says, in the same breath, that this is a recording.
    const m = h.poller.getMode();
    assert.equal(m.mode, 'demo');
    assert.equal(m.agency, DEMO_AGENCY);
    assert.ok(m.demo, 'demo provenance missing');
    assert.match(m.demo.recordedNotice, /RECORDING/);
    assert.match(m.demo.attribution, /Toronto Transit Commission/);
    assert.equal(m.demo.speed, DEFAULT_SPEED);
    assert.ok(m.demo.captureEndMs > m.demo.captureStartMs);
  } finally {
    await teardown(h);
  }
});

test('the data clock is the recording\'s clock, not the wall clock', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }
  const h = await runReplay(fx, 3);
  try {
    const m = h.poller.getMode();
    // "now", to every downstream consumer, is an instant inside the capture window.
    assert.ok(m.dataNowMs >= fx.manifest.captureStartMs, 'data clock is before the recording started');
    assert.ok(m.dataNowMs <= fx.manifest.captureStartMs + fx.timelineMs, 'data clock ran off the end of the recording');
    assert.equal(h.poller.now(), m.dataNowMs);
    // The wall clock is genuinely elsewhere — that is the whole point, and it is reported
    // separately rather than quietly substituted.
    assert.ok(Math.abs(m.wallNowMs - m.dataNowMs) > 60_000, 'wall and data clocks were not distinguishable in this run');

    // Vehicle pings are dated from the recording too, so the map is internally coherent.
    const vs = h.poller.getVehicleStates();
    assert.ok(vs.length > 0, 'replay produced no vehicles — the fixture is not real service');
    const tolerance = 30 * 60_000; // TTC pings can lag the capture instant by minutes
    for (const v of vs.slice(0, 200)) {
      assert.ok(
        v.ts > fx.manifest.captureStartMs - tolerance && v.ts < fx.manifest.captureEndMs + tolerance,
        `vehicle ${v.id} is dated ${new Date(v.ts).toISOString()}, outside the capture window`,
      );
    }
  } finally {
    await teardown(h);
  }
});

test('replaying real recorded bytes drives the real pipeline', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }
  const h = await runReplay(fx, 3);
  try {
    const vs = h.poller.getVehicleStates();
    // Real service: hundreds of buses, with positions and route ids, decoded from the
    // recorded protobuf through the identical binding the live fetch layer uses.
    assert.ok(vs.length > 100, `expected real service, got ${vs.length} vehicles`);
    assert.ok(vs.every((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon)));
    assert.ok(vs.filter((v) => v.routeId).length > 50, 'almost no vehicles carried a route id');
    // Toronto, not the null island.
    assert.ok(vs.every((v) => v.lat > 43 && v.lat < 44.5 && v.lon > -80.5 && v.lon < -78.5));

    // Alerts were decoded and persisted — a real feature, working, off recorded bytes.
    const alerts = await h.db.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM service_alerts WHERE agency=$1', [DEMO_AGENCY]);
    assert.ok(Number(alerts.rows[0].n) > 0, 'no service_alerts written from the recording');
  } finally {
    await teardown(h);
  }
});

// ---------- 2. mode isolation ----------

test('demo writes only into its own namespace and never touches live rows', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }
  const h = await runReplay(fx, 3, { seedLiveRows: true });
  try {
    const census = await rowCensus(h.db);

    // The demo wrote something...
    assert.ok((census[`service_alerts/${DEMO_AGENCY}`] ?? 0) > 0, 'demo wrote no alerts at all');

    // ...and every row it wrote is in its own namespace. Nothing new appeared under 'ttc'.
    assert.equal(census[`service_alerts/${LIVE_AGENCY}`], 1, 'live alerts were added to or removed');
    assert.equal(census[`ghosts/${LIVE_AGENCY}`], 1, 'live ghosts were added to or removed');
    // Retention runs every cycle and this row is ~7 months old. Before the agency filter
    // was added to the DELETE, a demo process would have pruned it.
    assert.equal(census[`trip_delay_obs/${LIVE_AGENCY}`], 1, 'RETENTION DELETED A LIVE OBSERVATION FROM A DEMO PROCESS');

    // The live rows are byte-identical, not merely present.
    const live = await h.db.query<{ header: string; description: string }>(
      'SELECT header, description FROM service_alerts WHERE agency=$1', [LIVE_AGENCY]);
    assert.equal(live.rows[0].header, 'live header');
    assert.equal(live.rows[0].description, 'live body');

    // And no row anywhere carries an agency we did not intend.
    for (const key of Object.keys(census)) {
      const agency = key.split('/')[1];
      assert.ok(agency === LIVE_AGENCY || agency === DEMO_AGENCY, `unexpected agency namespace: ${key}`);
    }
  } finally {
    await teardown(h);
  }
});

test('a live poller is completely unchanged: it writes under ttc and uses the wall clock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-live-'));
  const db = await createPgliteDb(join(dir, 'pg'));
  try {
    __resetDemoModeForTests();
    // No source => live. Constructed but never started, so no network call is made.
    const poller = createPoller(db);
    const m = poller.getMode();
    assert.equal(m.mode, 'live');
    assert.equal(m.agency, LIVE_AGENCY);
    assert.equal(m.demo, null);
    // Live, the two clocks are the same clock.
    assert.ok(Math.abs(m.dataNowMs - m.wallNowMs) < 1_000);
    assert.ok(Math.abs(poller.now() - Date.now()) < 1_000);
    assert.equal(poller.getFeedHealth().mode, 'live');
    await poller.stop();
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- 3. determinism ----------

test('two runs of the same fixture produce identical distilled output', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }
  const CYCLES = 4;

  const a = await runReplay(fx, CYCLES);
  const snapA = distill(a.poller, a.poller.getVehicleStates());
  const censusA = await rowCensus(a.db);
  await teardown(a);

  const b = await runReplay(fx, CYCLES);
  const snapB = distill(b.poller, b.poller.getVehicleStates());
  const censusB = await rowCensus(b.db);
  await teardown(b);

  assert.equal(snapA, snapB, 'the same recording replayed differently on a second run');
  assert.deepEqual(censusA, censusB, 'the same recording wrote a different number of rows on a second run');
  // Guard against a vacuously-equal comparison of two empty runs.
  assert.ok(JSON.parse(snapA).count > 100, 'determinism was asserted over an empty replay');
});

test('replay position is a pure function of elapsed time, so cycle N is always frame N', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }
  const step = fx.manifest.cadenceMs / DEFAULT_SPEED;

  const seqs = (): number[] => {
    let clock = 0;
    const src = createDemoSource(fx, { speed: DEFAULT_SPEED, loop: true, startedAtMs: 0, now: () => clock });
    const out: number[] = [];
    for (let i = 0; i < fx.byFeed.vehicles.length; i++) {
      clock = i * step;
      out.push(src.currentFrame('vehicles')?.seq ?? -1);
    }
    return out;
  };
  const first = seqs();
  assert.deepEqual(first, seqs());
  // One recorded frame per poll: 0,1,2,… not 0,8,16,…
  assert.deepEqual(first, fx.byFeed.vehicles.map((_, i) => i));
});

// ---------- the source's own contract ----------

test('the demo source polls once per recorded frame, at the spec\'s 8x', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }
  const src = createDemoSource(fx, { startedAtMs: 0, now: () => 0 });
  assert.equal(src.speed, 8);
  assert.equal(src.mode, 'demo');
  assert.equal(src.agency, DEMO_AGENCY);
  assert.equal(src.pollMs, Math.round(fx.manifest.cadenceMs / 8));
  // A 45s capture cadence replayed at 8x is a 5.625s poll — one frame each, no skipping.
  assert.equal(src.pollMs, 5_625);
  __resetDemoModeForTests();
});

// ---------- the clock, proven decisively, against a real board ----------
//
// Everything above runs with no static board, so the ghost/engine half of poll() is
// skipped. This one seeds a one-trip board positioned relative to the RECORDING's clock
// and asserts the poller finds that trip due — which is only possible if `now` is the
// capture instant. Under the wall clock the trip is hours outside the 6..30 minute due
// window, the whole board reads as absent, and the mass-ghost breaker fires on 100% of
// due trips: the "Demo Mode makes the app report itself dead" failure, exactly.

async function waitFor(what: string, ok: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('the ghost due-window is computed on the recording\'s clock, so the board is not declared dead', async (t) => {
  const fx = await fixture();
  if (!fx) { t.skip('no fixture'); return; }

  const capture = fx.manifest.captureStartMs;
  const day = torontoDay(capture);
  const midnight = torontoMidnightEpoch(Math.floor(day.ymd / 10000), Math.floor((day.ymd % 10000) / 100), day.ymd % 100);
  // A trip scheduled to start 10 minutes before the recording began: squarely inside the
  // 6..30 minute due window as far as the recording is concerned.
  const startS = Math.round((capture - midnight) / 1000) - 600;
  if (startS < 0) { t.skip('capture window is within 10 minutes of midnight'); return; }

  const dir = await mkdtemp(join(tmpdir(), 'gb-board-'));
  const db = await createPgliteDb(join(dir, 'pg'));
  const cacheDir = join(dir, 'cache');
  const prevCache = process.env.PATTERN_CACHE_DIR;
  process.env.PATTERN_CACHE_DIR = cacheDir;
  __resetDemoModeForTests();
  // Declared out here so the finally block can always stop it: a poller left running holds
  // a pending timer, which keeps the test runner's event loop alive long after the
  // assertion that failed.
  let poller: PollerHandle | null = null;

  try {
    // All seven days true, so this stays valid whenever the fixture is re-recorded.
    await db.query(
      `INSERT INTO calendar (agency, service_id, mon, tue, wed, thu, fri, sat, sun, start_date, end_date)
       VALUES ($1,'SVC',true,true,true,true,true,true,true,$2,$3)`,
      [LIVE_AGENCY, day.ymd - 10000, day.ymd + 10000]);
    await db.query(
      `INSERT INTO routes (agency, route_id, short_name, long_name, route_type, color)
       VALUES ($1,'R1','1','Test','3','FF0000')`, [LIVE_AGENCY]);
    for (const [stopId, lat] of [['S1', 43.70], ['S2', 43.71], ['S3', 43.72]] as Array<[string, number]>) {
      await db.query(
        'INSERT INTO stops (agency, stop_id, name, lat, lon) VALUES ($1,$2,$3,$4,$5)',
        [LIVE_AGENCY, stopId, `stop ${stopId}`, lat, -79.40]);
    }
    await db.query(
      `INSERT INTO trips (agency, trip_id, route_id, service_id, direction_id) VALUES ($1,'T1','R1','SVC',0)`,
      [LIVE_AGENCY]);
    for (const [i, stopId] of ['S1', 'S2', 'S3'].entries()) {
      await db.query(
        `INSERT INTO stop_times (agency, trip_id, stop_sequence, stop_id, arrival_s, departure_s)
         VALUES ($1,'T1',$2,$3,$4,$4)`, [LIVE_AGENCY, i + 1, stopId, startS + i * 300]);
    }

    const source = createDemoSource(fx, { speed: DEFAULT_SPEED, loop: true, fixturePath: '<test>' });
    // A long pollMs so the poller's own loop fires exactly once; the rest is driven by
    // hand, and stop() clears the pending timer.
    const p = createPoller(db, { source, pollMs: 600_000 });
    poller = p;
    p.start();
    await waitFor('the first poll cycle', () => p.getFeedHealth().lastPollAtMs != null);
    await waitFor('the pattern index', () => p.isIndexReady());

    // GHOST_CONFIRM_MISSES = 2, so run enough cycles for the confirm/breaker path to run.
    for (let i = 2; i <= 4; i++) await p.runOnce(i);
    const stats = p.getJoinStats();

    // THE ASSERTION. The seeded trip is due — measured against the recording, not the
    // wall clock, which by now is well over 30 minutes past the capture window.
    assert.ok(stats.lastDueTrips > 0,
      `no trips were due: the poller judged a ${fx.manifest.captureStartToronto} recording against some other clock`);
    assert.ok(Date.now() - capture > 30 * 60_000,
      'this run happened too close to the capture to be decisive — re-run later, or re-record');

    // The engine really ran, on the demo clock, and everything it learned is namespaced.
    assert.equal(stats.indexReady, true);
    const census = await rowCensus(db);
    assert.ok(Object.keys(census).length > 0, 'the engine ran but wrote nothing — nothing was proven');
    for (const key of Object.keys(census)) {
      assert.equal(key.split('/')[1], DEMO_AGENCY, `a demo cycle wrote outside its namespace: ${key}`);
    }

    // THE ONE DELIBERATE EXCEPTION, asserted rather than omitted. The pattern-index cache
    // is derived purely from the static board — no realtime data reaches it — and it is
    // keyed by board fingerprint, so a demo process shares it under 'ttc' on purpose and
    // skips a rebuild measured at 109 s. If that ever stops being true, this fails loudly.
    const cache = await db.query<{ agency: string }>('SELECT agency FROM pattern_index_cache');
    for (const row of cache.rows) {
      assert.equal(row.agency, LIVE_AGENCY,
        'the pattern-index cache is meant to be shared under the live agency; see DECISIONS §44');
    }

    // The seeded trip is absent from a real TTC recording, so it is a due-but-absent trip
    // and 1/1 of the board — the global mass-ghost breaker must swallow it rather than
    // publishing a ghost. That breaker firing here is the correct answer, not a bug.
    assert.equal(stats.lastGhosts, 0, 'a synthetic trip was published as a real ghost');
    assert.ok(stats.massGhostTrippedCycles > 0, 'the mass-ghost breaker did not evaluate at all');

  } finally {
    if (poller) await poller.stop();
    if (prevCache === undefined) delete process.env.PATTERN_CACHE_DIR;
    else process.env.PATTERN_CACHE_DIR = prevCache;
    await db.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    __resetDemoModeForTests();
  }
});

// ---------- the engine's half of the namespace split ----------
//
// The poller reads the static board under 'ttc' and writes observations under 'ttc-demo',
// and it needs the delay engine to make the same distinction — the engine owns the
// crosswalk, the bindings and every delay row. Driven here against a recording stub Db so
// the split is proven without seeding a 2.15M-row board.

test('the delay engine reads the static board under ttc and writes under the demo namespace', async () => {
  const seen: Array<{ sql: string; params: unknown[] }> = [];
  const stub: Db = {
    driver: 'pglite',
    closed: false,
    async query<T>(sql: string, params?: readonly unknown[]) {
      seen.push({ sql, params: [...(params ?? [])] });
      return { rows: [] as T[], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: { query: Db['query'] }) => Promise<T>) { return fn(stub); },
    async close() { /* nothing to close */ },
  };

  const cacheDir = await mkdtemp(join(tmpdir(), 'gb-cache-'));
  const before = process.env.PATTERN_CACHE_DIR;
  process.env.PATTERN_CACHE_DIR = cacheDir;
  try {
    const engine = createDelayEngine(stub, LIVE_AGENCY, DEMO_AGENCY);
    await engine.reloadStatic('20260726..20260905');

    const paramsOf = (re: RegExp): unknown[][] =>
      seen.filter((q) => re.test(q.sql)).map((q) => q.params);

    // The schedule is read under the live agency: there is one published board and a
    // recording is a recording OF it.
    const staticReads = paramsOf(/FROM\s+stop_times/i);
    assert.ok(staticReads.length > 0, 'the engine never read the static board');
    for (const p of staticReads) {
      assert.ok(p.includes(LIVE_AGENCY), `a static read did not use '${LIVE_AGENCY}': ${JSON.stringify(p)}`);
      assert.ok(!p.includes(DEMO_AGENCY), `a static read leaked the demo namespace: ${JSON.stringify(p)}`);
    }

    // Learned realtime state is read back under the demo namespace, so a demo process can
    // never inherit the crosswalk a live process learned from live buses.
    const xwalkReads = paramsOf(/FROM\s+rt_stop_xwalk/i);
    assert.ok(xwalkReads.length > 0, 'the engine never touched rt_stop_xwalk');
    for (const p of xwalkReads) {
      assert.ok(p.includes(DEMO_AGENCY), `a crosswalk read did not use '${DEMO_AGENCY}': ${JSON.stringify(p)}`);
    }

    // And nothing anywhere was parameterised with an agency we did not intend.
    for (const q of seen) {
      for (const p of q.params) {
        if (typeof p === 'string' && p.startsWith('ttc')) {
          assert.ok(p === LIVE_AGENCY || p === DEMO_AGENCY, `unexpected agency '${p}' in: ${q.sql.slice(0, 80)}`);
        }
      }
    }
  } finally {
    if (before === undefined) delete process.env.PATTERN_CACHE_DIR;
    else process.env.PATTERN_CACHE_DIR = before;
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('createDelayEngine defaults its write namespace to its read namespace (live is unchanged)', async () => {
  const seen: unknown[][] = [];
  const stub: Db = {
    driver: 'pglite',
    closed: false,
    async query<T>(_sql: string, params?: readonly unknown[]) {
      seen.push([...(params ?? [])]);
      return { rows: [] as T[], rowCount: 0 };
    },
    async transaction<T>(fn: (tx: { query: Db['query'] }) => Promise<T>) { return fn(stub); },
    async close() { /* nothing to close */ },
  };
  const cacheDir = await mkdtemp(join(tmpdir(), 'gb-cache-'));
  const before = process.env.PATTERN_CACHE_DIR;
  process.env.PATTERN_CACHE_DIR = cacheDir;
  try {
    // Two-argument form — exactly how the live poller constructs it.
    await createDelayEngine(stub, LIVE_AGENCY).reloadStatic('20260726..20260905');
    for (const p of seen) {
      assert.ok(!p.includes(DEMO_AGENCY), `a LIVE engine used the demo namespace: ${JSON.stringify(p)}`);
    }
  } finally {
    if (before === undefined) delete process.env.PATTERN_CACHE_DIR;
    else process.env.PATTERN_CACHE_DIR = before;
    await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }
});

test('resolveFixturePath prefers GHOSTBUS_DEMO_FIXTURE, else the newest bundled fixture', async () => {
  const before = process.env.GHOSTBUS_DEMO_FIXTURE;
  try {
    process.env.GHOSTBUS_DEMO_FIXTURE = fileURLToPath(new URL('./demo.ts', import.meta.url));
    assert.match(await resolveFixturePath(), /demo\.ts$/);

    delete process.env.GHOSTBUS_DEMO_FIXTURE;
    const auto = await resolveFixturePath();
    assert.match(auto, /ttc-demo-.*\.json\.gz$/);
  } finally {
    if (before === undefined) delete process.env.GHOSTBUS_DEMO_FIXTURE;
    else process.env.GHOSTBUS_DEMO_FIXTURE = before;
  }
});
